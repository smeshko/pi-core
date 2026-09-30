import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../config.ts";
import { buildChildArgs, mapWithConcurrencyLimit } from "../runner.ts";
import type { AgentConfig } from "../types.ts";

const baseAgent: AgentConfig = {
	name: "worker",
	description: "Worker",
	systemPrompt: "Prompt",
	source: "user",
	filePath: "/agents/worker.md",
};

test("absent tools emits no --tools argument so child uses normal defaults", () => {
	const args = buildChildArgs({ agent: baseAgent, task: "Do work", config: DEFAULT_CONFIG });
	assert.equal(args.includes("--tools"), false);
	assert.equal(args.includes("--no-tools"), false);
});

test("explicit agent tools emits comma-separated --tools", () => {
	const args = buildChildArgs({ agent: { ...baseAgent, tools: ["read", "grep"] }, task: "Do work", config: DEFAULT_CONFIG });
	assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", "read,grep"]);
});

test("explicit empty config tools emits --no-tools", () => {
	const args = buildChildArgs({ agent: baseAgent, task: "Do work", config: { ...DEFAULT_CONFIG, defaultTools: [] } });
	assert.equal(args.includes("--no-tools"), true);
});

test("runtime allowlist emits --no-extensions and explicit --extension flags", () => {
	const args = buildChildArgs({
		agent: baseAgent,
		task: "Do work",
		config: {
			...DEFAULT_CONFIG,
			runtime: {
				...DEFAULT_CONFIG.runtime,
				extensions: { mode: "allowlist", allow: ["/provider.ts"] },
			},
		},
	});
	assert.ok(args.includes("--no-extensions"));
	assert.deepEqual(args.slice(args.indexOf("--extension"), args.indexOf("--extension") + 2), ["--extension", "/provider.ts"]);
});

test("explicit subagent tool is filtered unless recursion is allowed", () => {
	const blocked = buildChildArgs({
		agent: { ...baseAgent, tools: ["read", "subagent"] },
		task: "Do work",
		config: DEFAULT_CONFIG,
	});
	assert.deepEqual(blocked.slice(blocked.indexOf("--tools"), blocked.indexOf("--tools") + 2), ["--tools", "read"]);

	const allowed = buildChildArgs({
		agent: { ...baseAgent, tools: ["read", "subagent"] },
		task: "Do work",
		config: { ...DEFAULT_CONFIG, recursion: { allow: true, maxDepth: 3 } },
	});
	assert.deepEqual(allowed.slice(allowed.indexOf("--tools"), allowed.indexOf("--tools") + 2), ["--tools", "read,subagent"]);
});

test("concurrency limiter never exceeds configured concurrency", async () => {
	let active = 0;
	let maxActive = 0;
	const result = await mapWithConcurrencyLimit([1, 2, 3, 4, 5, 6], 3, async (item) => {
		active += 1;
		maxActive = Math.max(maxActive, active);
		await new Promise((resolve) => setTimeout(resolve, 10));
		active -= 1;
		return item * 2;
	});
	assert.deepEqual(result, [2, 4, 6, 8, 10, 12]);
	assert.equal(maxActive, 3);
});
