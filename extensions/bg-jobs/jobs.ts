/**
 * Background job store — the process layer.
 *
 * Owns spawning, output capture, exit detection, killing, and temp-dir
 * lifecycle. Deliberately free of any TUI or ExtensionAPI dependency so it can
 * be unit-tested on its own.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
	type WriteStream,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Lines kept in memory per job, for the detail view's scrollback. */
const MAX_MEMORY_LINES = 1000;

/** Lines handed to the LLM by bg_status / bg_wait. */
export const TAIL_LINES = 100;

/** SIGTERM, then this long, then SIGKILL. */
const KILL_GRACE_MS = 3000;

/** How long to wait for death after SIGKILL before giving up. */
const SIGKILL_TIMEOUT_MS = 2000;

/** Ownerless temp dirs older than this are considered abandoned. */
const STALE_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const TEMP_DIR_PREFIX = "pi-bg-";
const OWNER_FILE = "owner.pid";

/**
 * CSI sequences (colours), OSC sequences (titles, OSC 8 hyperlinks), and other
 * Fe escapes.
 *
 * Shell output is full of these. They must not reach the TUI: components fill
 * rows with a background colour, and an embedded SGR reset tears that fill
 * mid-line. They are also pure token noise in the LLM's context. The raw bytes
 * are still written verbatim to the log file.
 */
const ANSI_PATTERN = /\u001B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

export function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

export interface JobRecord {
	jobId: string;
	name: string;
	command: string;
	cwd: string;
	pid: number;
	logFile: string;
	startedAt: number;
	finishedAt: number | null;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	/** True once a kill was requested through bg_kill / the detail view. */
	killRequested: boolean;
	/** Total bytes written to the log file. */
	bytes: number;
	/** Total lines produced, including ones evicted from the ring buffer. */
	totalLines: number;
	/** Ring buffer of the most recent output lines (stdout and stderr merged). */
	lines: string[];
}

interface InternalJob extends JobRecord {
	child: ChildProcess;
	stream: WriteStream | null;
	pendingChunk: string;
	finalized: boolean;
	waiters: Set<() => void>;
}

export interface KillResult {
	ok: boolean;
	message: string;
}

export function isRunning(job: JobRecord): boolean {
	return job.finishedAt === null;
}

export interface RunOptions {
	command: string;
	name?: string;
	cwd?: string;
}

export class BackgroundJobStore {
	private jobs = new Map<string, InternalJob>();
	private listeners = new Set<() => void>();
	private exitListeners = new Set<(job: JobRecord) => void>();
	private seq = 0;
	private dir: string | null = null;
	private defaultCwd: string;

	constructor(defaultCwd: string) {
		this.defaultCwd = defaultCwd;
	}

	/**
	 * Create this session's temp dir and reclaim dirs left behind by pi
	 * processes that died without running session_shutdown.
	 */
	init(sessionId: string, defaultCwd?: string): void {
		if (defaultCwd) this.defaultCwd = defaultCwd;
		const dir = join(tmpdir(), `${TEMP_DIR_PREFIX}${sessionId}`);
		mkdirSync(dir, { recursive: true });
		try {
			writeFileSync(join(dir, OWNER_FILE), String(process.pid), "utf8");
		} catch {
			// Non-fatal: the dir just won't be sweepable by pid, only by age.
		}
		this.dir = dir;
		this.sweepStaleDirs(dir);
	}

	/** Subscribe to any job state change. Returns an unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// A broken listener must not take down job bookkeeping.
			}
		}
	}

	/**
	 * Subscribe to job completion. This is what lets the agent find out a job
	 * finished without blocking a turn on bg_wait.
	 */
	onExit(listener: (job: JobRecord) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	private notifyExit(job: JobRecord): void {
		for (const listener of this.exitListeners) {
			try {
				listener(job);
			} catch {
				// A broken listener must not take down job bookkeeping.
			}
		}
	}

	list(): JobRecord[] {
		return [...this.jobs.values()];
	}

	running(): JobRecord[] {
		return this.list().filter(isRunning);
	}

	/** Resolve by job id first, then by name. */
	get(idOrName: string): JobRecord | undefined {
		const key = idOrName.trim();
		const byId = this.jobs.get(key);
		if (byId) return byId;
		return this.list().find((job) => job.name === key);
	}

	tail(job: JobRecord, count = TAIL_LINES): string[] {
		return job.lines.slice(-count);
	}

	run({ command, name, cwd }: RunOptions): JobRecord {
		if (!this.dir) throw new Error("Background job store is not initialised");

		const trimmed = command.trim();
		if (!trimmed) throw new Error("command must not be empty");

		this.seq += 1;
		const jobId = `job-${this.seq}`;
		const jobName = this.uniqueName(name?.trim() || jobId);
		const workingDir = cwd?.trim() || this.defaultCwd;
		const logFile = join(this.dir, `${jobId}.log`);

		let stream: WriteStream | null = null;
		try {
			stream = createWriteStream(logFile, { flags: "a" });
			stream.on("error", () => {
				// Losing the log file must not kill the job or the session.
			});
		} catch {
			stream = null;
		}

		// detached:false keeps the child in pi's process group so a clean
		// shutdown reliably reaps it. Trade-off: for pipelines, `sh` may not
		// exec-replace itself, so a kill can leave grandchildren behind.
		const child = spawn("/bin/sh", ["-c", trimmed], {
			cwd: workingDir,
			detached: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const job: InternalJob = {
			jobId,
			name: jobName,
			command: trimmed,
			cwd: workingDir,
			pid: child.pid ?? -1,
			logFile,
			startedAt: Date.now(),
			finishedAt: null,
			exitCode: null,
			signal: null,
			killRequested: false,
			bytes: 0,
			totalLines: 0,
			lines: [],
			child,
			stream,
			pendingChunk: "",
			finalized: false,
			waiters: new Set(),
		};
		this.jobs.set(jobId, job);

		child.stdout?.on("data", (chunk: Buffer) => this.ingest(job, chunk));
		child.stderr?.on("data", (chunk: Buffer) => this.ingest(job, chunk));

		child.on("error", (error: Error) => {
			this.pushLine(job, `[pi-bg] failed to start: ${error.message}`);
			this.finalize(job, null, null);
		});

		child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
			this.finalize(job, code, signal);
		});

		this.notify();
		return job;
	}

	async kill(idOrName: string): Promise<KillResult> {
		const job = this.get(idOrName) as InternalJob | undefined;
		if (!job) return { ok: false, message: `No such job: ${idOrName}` };
		if (!isRunning(job)) {
			return { ok: false, message: `${job.jobId} (${job.name}) has already exited` };
		}

		job.killRequested = true;
		this.notify();

		job.child.kill("SIGTERM");
		if (await this.waitForExit(job, KILL_GRACE_MS)) {
			return { ok: true, message: `${job.jobId} (${job.name}) terminated` };
		}

		job.child.kill("SIGKILL");
		if (await this.waitForExit(job, SIGKILL_TIMEOUT_MS)) {
			return { ok: true, message: `${job.jobId} (${job.name}) killed after ${KILL_GRACE_MS}ms grace` };
		}

		return { ok: false, message: `${job.jobId} (${job.name}) did not die after SIGKILL` };
	}

	/**
	 * Resolve when the job exits, the timeout elapses, or the signal aborts.
	 * Returns true only if the job actually exited.
	 */
	waitForExit(job: JobRecord, timeoutMs?: number, signal?: AbortSignal): Promise<boolean> {
		const internal = this.jobs.get(job.jobId);
		if (!internal || !isRunning(internal)) return Promise.resolve(true);
		if (signal?.aborted) return Promise.resolve(false);

		return new Promise<boolean>((resolve) => {
			let timer: NodeJS.Timeout | undefined;
			let onAbort: (() => void) | undefined;

			const settle = (exited: boolean) => {
				internal.waiters.delete(waiter);
				if (timer) clearTimeout(timer);
				if (onAbort && signal) signal.removeEventListener("abort", onAbort);
				resolve(exited);
			};

			const waiter = () => settle(true);
			internal.waiters.add(waiter);

			if (timeoutMs !== undefined && timeoutMs > 0) {
				timer = setTimeout(() => settle(false), timeoutMs);
			}
			if (signal) {
				onAbort = () => settle(false);
				signal.addEventListener("abort", onAbort, { once: true });
			}
		});
	}

	/** Kill every running job, then remove this session's temp dir. */
	async dispose(): Promise<void> {
		const running = this.running();
		await Promise.all(running.map((job) => this.kill(job.jobId).catch(() => undefined)));

		for (const job of this.jobs.values()) {
			try {
				job.stream?.end();
			} catch {
				// Already closed.
			}
		}

		if (this.dir) {
			try {
				rmSync(this.dir, { recursive: true, force: true });
			} catch {
				// Best effort; the next session's sweep will retry.
			}
		}

		this.jobs.clear();
		this.listeners.clear();
		this.exitListeners.clear();
		this.dir = null;
		this.seq = 0;
	}

	private uniqueName(candidate: string): string {
		const taken = new Set(this.list().map((job) => job.name));
		if (!taken.has(candidate)) return candidate;
		let suffix = 2;
		while (taken.has(`${candidate}-${suffix}`)) suffix += 1;
		return `${candidate}-${suffix}`;
	}

	private ingest(job: InternalJob, chunk: Buffer): void {
		if (job.finalized) return;
		const text = chunk.toString("utf8");
		job.bytes += chunk.byteLength;

		try {
			job.stream?.write(chunk);
		} catch {
			// Log file is best-effort; in-memory buffer is the source of truth.
		}

		job.pendingChunk += text;
		const parts = job.pendingChunk.split("\n");
		job.pendingChunk = parts.pop() ?? "";
		for (const line of parts) this.pushLine(job, line);

		this.notify();
	}

	private pushLine(job: InternalJob, line: string): void {
		job.totalLines += 1;
		job.lines.push(stripAnsi(line).replace(/\r$/, ""));
		if (job.lines.length > MAX_MEMORY_LINES) {
			job.lines.splice(0, job.lines.length - MAX_MEMORY_LINES);
		}
	}

	private finalize(job: InternalJob, code: number | null, signal: NodeJS.Signals | null): void {
		if (job.finalized) return;
		job.finalized = true;

		if (job.pendingChunk.length > 0) {
			this.pushLine(job, job.pendingChunk);
			job.pendingChunk = "";
		}

		job.finishedAt = Date.now();
		job.exitCode = code;
		job.signal = signal;

		try {
			job.stream?.end();
		} catch {
			// Already closed.
		}
		job.stream = null;

		for (const waiter of [...job.waiters]) {
			try {
				waiter();
			} catch {
				// Ignore; other waiters must still run.
			}
		}
		job.waiters.clear();

		this.notify();
		this.notifyExit(job);
	}

	/**
	 * Remove temp dirs belonging to pi processes that are gone. Liveness is
	 * checked via the owner pid so concurrent pi sessions are never disturbed.
	 */
	private sweepStaleDirs(currentDir: string): void {
		let entries: string[];
		try {
			entries = readdirSync(tmpdir());
		} catch {
			return;
		}

		for (const entry of entries) {
			if (!entry.startsWith(TEMP_DIR_PREFIX)) continue;
			const full = join(tmpdir(), entry);
			if (full === currentDir) continue;

			try {
				if (!statSync(full).isDirectory()) continue;
				if (this.isDirOwnerAlive(full)) continue;
				rmSync(full, { recursive: true, force: true });
			} catch {
				// Racing with another sweeper, or not ours to delete.
			}
		}
	}

	private isDirOwnerAlive(dir: string): boolean {
		const ownerFile = join(dir, OWNER_FILE);

		if (!existsSync(ownerFile)) {
			// No owner marker: fall back to age so we never delete a fresh dir.
			try {
				return Date.now() - statSync(dir).mtimeMs < STALE_DIR_MAX_AGE_MS;
			} catch {
				return false;
			}
		}

		let pid: number;
		try {
			pid = Number.parseInt(readFileSync(ownerFile, "utf8").trim(), 10);
		} catch {
			return false;
		}
		if (!Number.isFinite(pid) || pid <= 0) return false;
		if (pid === process.pid) return true;

		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			// EPERM means the pid exists but belongs to another user.
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	}
}
