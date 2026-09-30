import test from "node:test";
import assert from "node:assert/strict";
import { createBaseResult, producedEmptyOutput, runWithEmptyOutputRetry } from "../runner.ts";
import type { PiMessage, SingleResult } from "../types.ts";

function assistant(text: string): PiMessage {
	return { role: "assistant", content: text ? [{ type: "text", text }] : [] };
}

function cleanResult(text: string): SingleResult {
	const result = createBaseResult("explore", "task", "user");
	result.exitCode = 0;
	result.stopReason = "stop";
	if (text) result.messages.push(assistant(text));
	return result;
}

function failedResult(): SingleResult {
	const result = createBaseResult("explore", "task", "user");
	result.exitCode = 1;
	result.failureKind = "child_error";
	result.errorMessage = "boom";
	return result;
}

test("producedEmptyOutput flags clean runs with no assistant text", () => {
	assert.equal(producedEmptyOutput(cleanResult("")), true);
	assert.equal(producedEmptyOutput(cleanResult("   ")), true);
	assert.equal(producedEmptyOutput(cleanResult("Found it at foo.ts:12")), false);
});

test("producedEmptyOutput never flags failed or aborted runs", () => {
	assert.equal(producedEmptyOutput(failedResult()), false);
	const aborted = createBaseResult("explore", "task", "user");
	aborted.exitCode = 0;
	aborted.stopReason = "aborted";
	assert.equal(producedEmptyOutput(aborted), false);
});

test("retries empty output up to the configured number of extra attempts", async () => {
	let calls = 0;
	const result = await runWithEmptyOutputRetry(
		() => {
			calls += 1;
			return Promise.resolve(cleanResult(""));
		},
		{ retries: 3, agentName: "explore", makeDetails: () => ({}) as any },
	);
	// 1 initial attempt + 3 retries = 4 total.
	assert.equal(calls, 4);
	assert.equal(producedEmptyOutput(result), true);
});

test("stops retrying as soon as output is produced", async () => {
	let calls = 0;
	const result = await runWithEmptyOutputRetry(
		() => {
			calls += 1;
			return Promise.resolve(calls < 2 ? cleanResult("") : cleanResult("done"));
		},
		{ retries: 3, agentName: "explore", makeDetails: () => ({}) as any },
	);
	assert.equal(calls, 2);
	assert.equal(result.messages.length, 1);
});

test("does not retry failed runs", async () => {
	let calls = 0;
	await runWithEmptyOutputRetry(
		() => {
			calls += 1;
			return Promise.resolve(failedResult());
		},
		{ retries: 3, agentName: "explore", makeDetails: () => ({}) as any },
	);
	assert.equal(calls, 1);
});

test("retries=0 disables retrying", async () => {
	let calls = 0;
	await runWithEmptyOutputRetry(
		() => {
			calls += 1;
			return Promise.resolve(cleanResult(""));
		},
		{ retries: 0, agentName: "explore", makeDetails: () => ({}) as any },
	);
	assert.equal(calls, 1);
});

test("an abort between attempts short-circuits further retries", async () => {
	let calls = 0;
	const controller = new AbortController();
	await runWithEmptyOutputRetry(
		() => {
			calls += 1;
			controller.abort();
			return Promise.resolve(cleanResult(""));
		},
		{ retries: 3, agentName: "explore", signal: controller.signal, makeDetails: () => ({}) as any },
	);
	assert.equal(calls, 1);
});

test("emits an onUpdate notice before each retry", async () => {
	const notices: string[] = [];
	await runWithEmptyOutputRetry(() => Promise.resolve(cleanResult("")), {
		retries: 2,
		agentName: "explore",
		onUpdate: (partial) => notices.push(partial.content[0]?.text ?? ""),
		makeDetails: () => ({}) as any,
	});
	assert.equal(notices.length, 2);
	assert.match(notices[0], /explore returned no output — retrying \(1\/2\)/);
	assert.match(notices[1], /retrying \(2\/2\)/);
});
