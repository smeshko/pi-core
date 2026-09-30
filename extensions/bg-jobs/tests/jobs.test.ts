/**
 * Process-layer tests. jobs.ts has no TUI or ExtensionAPI dependency, so it can
 * be exercised directly.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { BackgroundJobStore, isRunning, stripAnsi } from "../jobs.ts";

function createStore(): BackgroundJobStore {
	const store = new BackgroundJobStore(process.cwd());
	store.init(`test-${randomUUID()}`);
	return store;
}

/** Stores created by tests, disposed collectively so nothing leaks. */
const stores: BackgroundJobStore[] = [];

function trackedStore(): BackgroundJobStore {
	const store = createStore();
	stores.push(store);
	return store;
}

after(async () => {
	await Promise.all(stores.map((store) => store.dispose().catch(() => undefined)));
});

describe("BackgroundJobStore", () => {
	it("strips ANSI escapes from captured output", async () => {
		const store = trackedStore();
		// Colours, bold, and an OSC 8 hyperlink - all common in real tool output.
		const job = store.run({
			command: String.raw`printf '\033[0;32m\xe2\x9c\x93 passed\033[0m\n\033[1;34mSummary\033[0m\n'; printf '\033]8;;file:///tmp/x\007link\033]8;;\007\n'`,
		});

		await store.waitForExit(job, 5000);

		assert.deepEqual(job.lines, ["✓ passed", "Summary", "link"]);
		for (const line of job.lines) {
			assert.ok(!line.includes("\u001B"), `line still contains an escape: ${JSON.stringify(line)}`);
		}
	});

	it("keeps raw escapes in the log file", async () => {
		const store = trackedStore();
		const job = store.run({ command: String.raw`printf '\033[0;32mgreen\033[0m\n'` });

		await store.waitForExit(job, 5000);

		// The log file is the fidelity fallback: less -R should still show colour.
		assert.match(readFileSync(job.logFile, "utf8"), /\u001B\[0;32m/);
	});

	it("captures stdout lines and a zero exit code", async () => {
		const store = trackedStore();
		const job = store.run({ command: "echo hello; echo world" });

		assert.equal(await store.waitForExit(job, 5000), true);
		assert.equal(job.exitCode, 0);
		assert.deepEqual(job.lines, ["hello", "world"]);
		assert.equal(isRunning(job), false);
	});

	it("merges stderr into the same stream", async () => {
		const store = trackedStore();
		const job = store.run({ command: "echo out; echo err >&2" });

		await store.waitForExit(job, 5000);
		assert.deepEqual([...job.lines].sort(), ["err", "out"]);
	});

	it("records a non-zero exit code", async () => {
		const store = trackedStore();
		const job = store.run({ command: "exit 3" });

		await store.waitForExit(job, 5000);
		assert.equal(job.exitCode, 3);
	});

	it("preserves a trailing line with no newline", async () => {
		const store = trackedStore();
		const job = store.run({ command: "printf 'no-trailing-newline'" });

		await store.waitForExit(job, 5000);
		assert.deepEqual(job.lines, ["no-trailing-newline"]);
	});

	it("writes full output to the log file", async () => {
		const store = trackedStore();
		const job = store.run({ command: "echo persisted" });

		await store.waitForExit(job, 5000);
		assert.equal(existsSync(job.logFile), true);
		assert.match(readFileSync(job.logFile, "utf8"), /persisted/);
	});

	it("times out without killing the job", async () => {
		const store = trackedStore();
		const job = store.run({ command: "sleep 5" });

		assert.equal(await store.waitForExit(job, 100), false);
		assert.equal(isRunning(job), true);

		await store.kill(job.jobId);
	});

	it("kills a running job", async () => {
		const store = trackedStore();
		const job = store.run({ command: "sleep 30" });

		const result = await store.kill(job.jobId);
		assert.equal(result.ok, true);
		assert.equal(isRunning(job), false);
		assert.equal(job.killRequested, true);
	});

	it("refuses to kill an already-exited job", async () => {
		const store = trackedStore();
		const job = store.run({ command: "true" });
		await store.waitForExit(job, 5000);

		const result = await store.kill(job.jobId);
		assert.equal(result.ok, false);
		assert.match(result.message, /already exited/);
	});

	it("caps the in-memory buffer but keeps the true line count", async () => {
		const store = trackedStore();
		const job = store.run({ command: "seq 1 1500" });

		await store.waitForExit(job, 10_000);
		assert.equal(job.totalLines, 1500);
		assert.equal(job.lines.length, 1000);
		// Oldest lines are evicted, newest retained.
		assert.equal(job.lines.at(-1), "1500");
		assert.equal(job.lines[0], "501");
	});

	it("tails the most recent lines", async () => {
		const store = trackedStore();
		const job = store.run({ command: "seq 1 200" });

		await store.waitForExit(job, 10_000);
		const tail = store.tail(job, 50);
		assert.equal(tail.length, 50);
		assert.equal(tail.at(-1), "200");
		assert.equal(tail[0], "151");
	});

	it("resolves jobs by id and by name", async () => {
		const store = trackedStore();
		const job = store.run({ command: "true", name: "builder" });

		assert.equal(store.get(job.jobId)?.jobId, job.jobId);
		assert.equal(store.get("builder")?.jobId, job.jobId);
		assert.equal(store.get("nope"), undefined);
	});

	it("disambiguates duplicate names", async () => {
		const store = trackedStore();
		const first = store.run({ command: "true", name: "dup" });
		const second = store.run({ command: "true", name: "dup" });

		assert.equal(first.name, "dup");
		assert.equal(second.name, "dup-2");
	});

	it("rejects an empty command", () => {
		const store = trackedStore();
		assert.throws(() => store.run({ command: "   " }), /must not be empty/);
	});

	it("strips every escape class from a string", () => {
		assert.equal(stripAnsi("\u001B[0;32mgreen\u001B[0m"), "green");
		assert.equal(stripAnsi("\u001B[1;34;47mx\u001B[m"), "x");
		assert.equal(stripAnsi("\u001B]0;title\u0007body"), "body");
		assert.equal(stripAnsi("\u001B]8;;http://a\u0007text\u001B]8;;\u0007"), "text");
		assert.equal(stripAnsi("plain"), "plain");
		assert.equal(stripAnsi(""), "");
	});

	it("reports a failed spawn instead of throwing", async () => {
		const store = trackedStore();
		const job = store.run({ command: "this-command-does-not-exist-xyz" });

		await store.waitForExit(job, 5000);
		assert.equal(isRunning(job), false);
		assert.notEqual(job.exitCode, 0);
	});

	it("notifies change listeners", async () => {
		const store = trackedStore();
		let calls = 0;
		const unsubscribe = store.onChange(() => {
			calls += 1;
		});

		const job = store.run({ command: "echo ping" });
		await store.waitForExit(job, 5000);
		unsubscribe();

		assert.ok(calls > 0, "expected at least one change notification");
	});

	it("aborts a wait when the signal fires", async () => {
		const store = trackedStore();
		const job = store.run({ command: "sleep 5" });
		const controller = new AbortController();

		setTimeout(() => controller.abort(), 50);
		assert.equal(await store.waitForExit(job, 0, controller.signal), false);
		assert.equal(isRunning(job), true);

		await store.kill(job.jobId);
	});

	it("kills running jobs and removes the temp dir on dispose", async () => {
		const store = createStore();
		const job = store.run({ command: "sleep 30" });
		const logFile = job.logFile;

		await store.dispose();

		assert.equal(isRunning(job), false);
		assert.equal(existsSync(logFile), false);
		assert.equal(store.list().length, 0);
	});
});
