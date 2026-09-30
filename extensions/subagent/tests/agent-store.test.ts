/**
 * AgentJobStore lifecycle tests. Uses an injected fake `run()` so nothing
 * spawns a real `pi` subprocess — mirrors how runner-args.test.ts avoids real
 * spawning for the single-agent path.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentJobStore, isJobRunning } from "../agent-store.ts";
import type { SingleResult, SubagentDetails } from "../types.ts";

function makeResult(agent: string): SingleResult {
	return {
		agent,
		agentSource: "user",
		task: "do work",
		exitCode: 0,
		messages: [],
		activity: [],
		partialText: "",
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
}

function makeDetails(results: SingleResult[]): SubagentDetails {
	return {
		mode: "single",
		agentScope: "both",
		projectAgentsDir: null,
		configFiles: [],
		runtimePolicy: {
			extensions: { mode: "inherit", allow: [] },
			skills: { mode: "inherit", allow: [] },
			promptTemplates: { mode: "inherit", allow: [] },
			contextFiles: "inherit",
		},
		recursion: { allow: false, maxDepth: 4 },
		diagnostics: [],
		results,
		hadRuntimeFailure: false,
	};
}

/** Resolves once `predicate()` is true, or throws after `timeoutMs`. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitUntil timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("AgentJobStore", () => {
	it("start() returns immediately, before the run promise settles", async () => {
		const store = new AgentJobStore();
		let resolveRun: (() => void) | undefined;
		const runPromise = new Promise<void>((resolve) => {
			resolveRun = resolve;
		});

		const startedAt = Date.now();
		const job = store.start({
			name: "scout",
			mode: "single",
			cwd: "/tmp",
			makeDetails,
			run: async () => {
				await runPromise;
				return { text: "done", results: [makeResult("scout")], isError: false };
			},
		});
		const elapsed = Date.now() - startedAt;

		assert.ok(elapsed < 100, `start() took ${elapsed}ms; it must not wait for run()`);
		assert.equal(job.finishedAt, null);
		assert.equal(isJobRunning(job), true);
		assert.equal(store.running().length, 1);

		resolveRun?.();
		await waitUntil(() => !isJobRunning(store.get(job.jobId)!));
	});

	it("resolves get() by id and by name, and running() excludes finished jobs", async () => {
		const store = new AgentJobStore();
		let release: (() => void) | undefined;
		const job = store.start({
			name: "scout",
			mode: "single",
			cwd: "/tmp",
			makeDetails,
			run: () => new Promise((resolve) => (release = () => resolve({ text: "ok", results: [], isError: false }))),
		});

		assert.equal(store.get(job.jobId)?.jobId, job.jobId);
		assert.equal(store.get("scout")?.jobId, job.jobId);
		assert.equal(store.running().length, 1);

		release?.();
		await waitUntil(() => store.running().length === 0);
		assert.equal(store.get(job.jobId)?.ok, true);
	});

	it("uniquifies duplicate names with a -2 suffix", () => {
		const store = new AgentJobStore();
		const run = () => new Promise<never>(() => {}); // never settles; fine for this test
		const first = store.start({ name: "scout", mode: "single", cwd: "/tmp", makeDetails, run });
		const second = store.start({ name: "scout", mode: "single", cwd: "/tmp", makeDetails, run });
		assert.equal(first.name, "scout");
		assert.equal(second.name, "scout-2");
	});

	it("fires onExit with ok=true on success and ok=false on failure", async () => {
		const store = new AgentJobStore();
		const exits: boolean[] = [];
		store.onExit((job) => exits.push(job.ok === true));

		store.start({
			name: "good",
			mode: "single",
			cwd: "/tmp",
			makeDetails,
			run: async () => ({ text: "ok", results: [makeResult("good")], isError: false }),
		});
		store.start({
			name: "bad",
			mode: "single",
			cwd: "/tmp",
			makeDetails,
			run: async () => ({ text: "boom", results: [makeResult("bad")], isError: true }),
		});

		await waitUntil(() => exits.length === 2);
		assert.deepEqual(exits.sort(), [false, true]);
	});

	it("fires onExit with ok=false when run() rejects", async () => {
		const store = new AgentJobStore();
		let exitJob: { ok: boolean | null; summaryText: string } | undefined;
		store.onExit((job) => {
			exitJob = job;
		});

		store.start({
			name: "throws",
			mode: "single",
			cwd: "/tmp",
			makeDetails,
			run: async () => {
				throw new Error("spawn failed");
			},
		});

		await waitUntil(() => exitJob !== undefined);
		assert.equal(exitJob?.ok, false);
		assert.match(exitJob?.summaryText ?? "", /spawn failed/);
	});

	it("onChange fires as onUpdate streams partial results", async () => {
		const store = new AgentJobStore();
		let changes = 0;
		store.onChange(() => changes++);

		let update: ((results: SingleResult[]) => void) | undefined;
		store.start({
			name: "scout",
			mode: "single",
			cwd: "/tmp",
			makeDetails,
			run: async ({ onUpdate }) => {
				update = onUpdate;
				return new Promise(() => {}); // never resolves in this test
			},
		});

		await waitUntil(() => update !== undefined);
		const before = changes;
		update?.([makeResult("scout")]);
		assert.ok(changes > before, "expected onChange to fire after onUpdate");
	});

	it("kill() aborts the signal and resolves once the run settles", async () => {
		const store = new AgentJobStore();
		const job = store.start({
			name: "sleeper",
			mode: "single",
			cwd: "/tmp",
			makeDetails,
			run: ({ signal }) =>
				new Promise((resolve) => {
					signal.addEventListener("abort", () => resolve({ text: "aborted", results: [], isError: true }));
				}),
		});

		const result = await store.kill(job.jobId);
		assert.equal(result.ok, true);
		assert.equal(isJobRunning(store.get(job.jobId)!), false);
	});

	it("kill() on an already-finished job reports failure without hanging", async () => {
		const store = new AgentJobStore();
		const job = store.start({
			name: "quick",
			mode: "single",
			cwd: "/tmp",
			makeDetails,
			run: async () => ({ text: "done", results: [], isError: false }),
		});
		await waitUntil(() => !isJobRunning(store.get(job.jobId)!));

		const result = await store.kill(job.jobId);
		assert.equal(result.ok, false);
	});

	it("dispose() aborts every running job", async () => {
		const store = new AgentJobStore();
		let aborted = false;
		store.start({
			name: "sleeper",
			mode: "single",
			cwd: "/tmp",
			makeDetails,
			run: ({ signal }) =>
				new Promise((resolve) => {
					signal.addEventListener("abort", () => {
						aborted = true;
						resolve({ text: "aborted", results: [], isError: true });
					});
				}),
		});

		await store.dispose();
		assert.equal(aborted, true);
		assert.equal(store.list().length, 0);
	});
});
