/**
 * Background job store for subagent runs — the "process layer" for the
 * `subagent` tool, mirroring bg-jobs' `BackgroundJobStore` shape so both
 * surfaces feel like the same feature.
 *
 * A "job" here is one whole `subagent` tool call (single, parallel, or
 * chain) running to completion. Individual child `pi` processes are an
 * implementation detail of the injected `run()` callback; the store only
 * tracks the envelope: id, name, status, latest streamed details, and an
 * abort controller for cancellation.
 */

import type { SingleResult, SubagentDetails } from "./types.ts";

export interface AgentJobRecord {
	jobId: string;
	name: string;
	mode: SubagentDetails["mode"];
	cwd: string;
	startedAt: number;
	finishedAt: number | null;
	/** null while running, true/false once settled. */
	ok: boolean | null;
	details: SubagentDetails;
	summaryText: string;
	killRequested: boolean;
}

interface InternalJob extends AgentJobRecord {
	controller: AbortController;
	waiters: Set<() => void>;
}

export interface RunHandle {
	signal: AbortSignal;
	onUpdate: (results: SingleResult[]) => void;
}

export interface RunResult {
	text: string;
	results: SingleResult[];
	isError: boolean;
}

export interface StartOptions {
	name: string;
	mode: SubagentDetails["mode"];
	cwd: string;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	run: (handle: RunHandle) => Promise<RunResult>;
}

export interface KillResult {
	ok: boolean;
	message: string;
}

const DEFAULT_KILL_TIMEOUT_MS = 5_000;

export function isJobRunning(job: AgentJobRecord): boolean {
	return job.finishedAt === null;
}

export class AgentJobStore {
	private jobs = new Map<string, InternalJob>();
	private listeners = new Set<() => void>();
	private exitListeners = new Set<(job: AgentJobRecord) => void>();
	private seq = 0;

	list(): AgentJobRecord[] {
		return [...this.jobs.values()];
	}

	running(): AgentJobRecord[] {
		return this.list().filter(isJobRunning);
	}

	/** Resolve by job id first, then by name. */
	get(idOrName: string): AgentJobRecord | undefined {
		const key = idOrName.trim();
		const byId = this.jobs.get(key);
		if (byId) return byId;
		return this.list().find((job) => job.name === key);
	}

	/** Subscribe to any job state change (progress, completion). Returns an unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Subscribe to job completion (success, failure, or abort). */
	onExit(listener: (job: AgentJobRecord) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
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

	private notifyExit(job: AgentJobRecord): void {
		for (const listener of this.exitListeners) {
			try {
				listener(job);
			} catch {
				// A broken listener must not take down job bookkeeping.
			}
		}
	}

	start(options: StartOptions): AgentJobRecord {
		this.seq += 1;
		const jobId = `agent-${this.seq}`;
		const name = this.uniqueName(options.name);
		const controller = new AbortController();

		const job: InternalJob = {
			jobId,
			name,
			mode: options.mode,
			cwd: options.cwd,
			startedAt: Date.now(),
			finishedAt: null,
			ok: null,
			details: options.makeDetails([]),
			summaryText: "",
			killRequested: false,
			controller,
			waiters: new Set(),
		};
		this.jobs.set(jobId, job);

		const onUpdate = (results: SingleResult[]) => {
			if (job.finishedAt !== null) return;
			job.details = options.makeDetails(results);
			this.notify();
		};

		const settle = (patch: Partial<Pick<InternalJob, "ok" | "summaryText" | "details">>) => {
			if (job.finishedAt !== null) return;
			job.finishedAt = Date.now();
			Object.assign(job, patch);
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
		};

		options
			.run({ signal: controller.signal, onUpdate })
			.then((result) => {
				settle({ ok: !result.isError, summaryText: result.text, details: options.makeDetails(result.results) });
			})
			.catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				settle({ ok: false, summaryText: message, details: options.makeDetails(job.details.results) });
			});

		this.notify();
		return job;
	}

	async kill(idOrName: string, timeoutMs = DEFAULT_KILL_TIMEOUT_MS): Promise<KillResult> {
		const job = this.get(idOrName) as InternalJob | undefined;
		if (!job) return { ok: false, message: `No such agent job: ${idOrName}` };
		if (!isJobRunning(job)) return { ok: false, message: `${job.jobId} (${job.name}) has already finished` };

		job.killRequested = true;
		this.notify();
		job.controller.abort();

		const exited = await this.waitForExit(job, timeoutMs);
		return exited
			? { ok: true, message: `${job.jobId} (${job.name}) cancelled` }
			: { ok: false, message: `${job.jobId} (${job.name}) did not stop within ${timeoutMs}ms` };
	}

	/** Resolves when the job exits, the timeout elapses, or it has already exited. */
	waitForExit(job: AgentJobRecord, timeoutMs?: number): Promise<boolean> {
		const internal = this.jobs.get(job.jobId);
		if (!internal || !isJobRunning(internal)) return Promise.resolve(true);

		return new Promise<boolean>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const settle = (exited: boolean) => {
				internal.waiters.delete(waiter);
				if (timer) clearTimeout(timer);
				resolve(exited);
			};
			const waiter = () => settle(true);
			internal.waiters.add(waiter);
			if (timeoutMs !== undefined && timeoutMs > 0) timer = setTimeout(() => settle(false), timeoutMs);
		});
	}

	/** Abort every running job. Used on session shutdown; completion listeners should be detached first if a toast storm is undesired. */
	async dispose(): Promise<void> {
		const running = this.running();
		await Promise.all(running.map((job) => this.kill(job.jobId).catch(() => undefined)));
		this.jobs.clear();
		this.listeners.clear();
		this.exitListeners.clear();
		this.seq = 0;
	}

	private uniqueName(candidate: string): string {
		const taken = new Set(this.list().map((job) => job.name));
		if (!taken.has(candidate)) return candidate;
		let suffix = 2;
		while (taken.has(`${candidate}-${suffix}`)) suffix += 1;
		return `${candidate}-${suffix}`;
	}
}
