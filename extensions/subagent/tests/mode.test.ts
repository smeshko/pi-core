import test from "node:test";
import assert from "node:assert/strict";
import { determineMode, NO_TOOLS_SENTINEL, normalizeParams, resolveMode } from "../mode.ts";
import { applyToolParamOverrides, DEFAULT_CONFIG } from "../config.ts";
import { buildChildArgs } from "../runner.ts";
import type { AgentConfig, SubagentParams } from "../types.ts";

// Models that emit every schema property fill the unused modes with "" and [].
const filler = {
	agentScope: "both" as const,
	confirmProjectAgents: false,
	runtime: { contextFiles: "inherit" as const },
};

test("parallel call with blank single fields resolves to parallel", () => {
	const params: SubagentParams = {
		...filler,
		agent: "",
		task: "",
		tasks: [
			{ agent: "explore", task: "find things" },
			{ agent: "webfetch", task: "research things" },
		],
		chain: [],
	};
	const { decision } = resolveMode(params);
	assert.equal(decision.error, undefined);
	assert.equal(decision.mode, "parallel");
});

test("single call with empty tasks and chain arrays resolves to single", () => {
	const params: SubagentParams = { ...filler, agent: "explore", task: "find things", tasks: [], chain: [] };
	const { params: normalized, decision } = resolveMode(params);
	assert.equal(decision.error, undefined);
	assert.equal(decision.mode, "single");
	assert.equal(normalized.tasks, undefined);
	assert.equal(normalized.chain, undefined);
});

test("chain call with empty tasks array resolves to chain", () => {
	const params: SubagentParams = { ...filler, agent: "", task: "", tasks: [], chain: [{ agent: "explore", task: "step one" }] };
	const { decision } = resolveMode(params);
	assert.equal(decision.mode, "chain");
});

test("leftover single fields do not block a real tasks array", () => {
	const params: SubagentParams = {
		agent: "explore",
		task: "Delegate the following in parallel mode.",
		tasks: [{ agent: "explore", task: "find things" }],
	};
	assert.equal(resolveMode(params).decision.mode, "parallel");
});

test("blank task entries are dropped instead of failing the call", () => {
	const params: SubagentParams = { tasks: [{ agent: "", task: "" }, { agent: "explore", task: "find things" }] };
	const { params: normalized, decision } = resolveMode(params);
	assert.equal(decision.mode, "parallel");
	assert.equal(normalized.tasks?.length, 1);
	assert.equal(normalized.tasks?.[0].agent, "explore");
});

test("half filled task entries are reported by position", () => {
	const { decision } = resolveMode({ tasks: [{ agent: "explore", task: "" }, { agent: "explore", task: "find things" }] });
	assert.match(decision.error ?? "", /tasks entry needs both agent and task.*1/s);
});

test("half filled chain entries are reported by position", () => {
	const { decision } = resolveMode({ chain: [{ agent: "", task: "step one" }] });
	assert.match(decision.error ?? "", /chain entry needs both agent and task.*1/s);
});

test("agent without task still reports the single mode requirement", () => {
	const { decision } = resolveMode({ ...filler, agent: "explore", task: "   ", tasks: [], chain: [] });
	assert.equal(decision.mode, undefined);
	assert.equal(decision.error, "Single mode requires both agent and task.");
});

test("empty call asks for exactly one mode", () => {
	const { decision } = resolveMode({ ...filler, agent: "", task: "", tasks: [], chain: [] });
	assert.match(decision.error ?? "", /exactly one mode/);
});

test("tasks and chain together are rejected", () => {
	const { decision } = resolveMode({
		tasks: [{ agent: "explore", task: "find things" }],
		chain: [{ agent: "explore", task: "step one" }],
	});
	assert.match(decision.error ?? "", /either tasks \(parallel\) or chain \(sequential\)/);
});

test("whitespace is trimmed off single mode fields", () => {
	const { params } = normalizeParams({ agent: "  explore  ", task: "  find things  ", cwd: "   " });
	assert.equal(params.agent, "explore");
	assert.equal(params.task, "find things");
	assert.equal(params.cwd, undefined);
	assert.equal(determineMode(params).mode, "single");
});

const toolAgent: AgentConfig = {
	name: "explore",
	description: "Explore",
	systemPrompt: "Prompt",
	source: "user",
	tools: ["read", "grep"],
	filePath: "/agents/explore.md",
};

test("empty tools array is ignored and reported instead of disabling every child tool", () => {
	const { params, diagnostics } = normalizeParams({ agent: "explore", task: "find things", tools: [] });
	assert.equal(params.tools, undefined);
	assert.equal(diagnostics.length, 1);
	assert.match(diagnostics[0].message, /Ignored empty tools/);
	assert.match(diagnostics[0].message, /"none"/);

	// The child must fall back to the agent's own policy, not --no-tools.
	const config = applyToolParamOverrides(DEFAULT_CONFIG, params, "/repo");
	const args = buildChildArgs({ agent: toolAgent, task: "find things", config, taskTools: params.tools });
	assert.equal(args.includes("--no-tools"), false);
	assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", "read,grep"]);
});

test('tools: ["none"] still disables every child tool', () => {
	const { params, diagnostics } = normalizeParams({ agent: "explore", task: "think", tools: [NO_TOOLS_SENTINEL] });
	assert.deepEqual(params.tools, []);
	assert.deepEqual(diagnostics, []);

	const config = applyToolParamOverrides(DEFAULT_CONFIG, params, "/repo");
	const args = buildChildArgs({ agent: toolAgent, task: "think", config, taskTools: params.tools });
	assert.equal(args.includes("--no-tools"), true);
});

test('"none" alongside real tools wins and is reported', () => {
	const { params, diagnostics } = normalizeParams({ agent: "explore", task: "think", tools: ["read", "None"] });
	assert.deepEqual(params.tools, []);
	assert.match(diagnostics[0].message, /"none" wins/);
});

test("real tool lists survive normalization, trimmed and deduped", () => {
	const { params, diagnostics } = normalizeParams({ agent: "explore", task: "find", tools: [" read ", "grep", "read", ""] });
	assert.deepEqual(params.tools, ["read", "grep"]);
	assert.deepEqual(diagnostics, []);
});

test("per-task empty tools arrays are ignored and labeled by position", () => {
	const { params, diagnostics } = normalizeParams({
		tasks: [
			{ agent: "explore", task: "find things", tools: [] },
			{ agent: "webfetch", task: "research", tools: ["websearch"] },
		],
	});
	assert.equal(params.tasks?.[0].tools, undefined);
	assert.deepEqual(params.tasks?.[1].tools, ["websearch"]);
	assert.equal(diagnostics.length, 1);
	assert.match(diagnostics[0].message, /tasks\[1\]\.tools/);
});

test("chain entry tools are normalized with chain labels", () => {
	const { diagnostics } = normalizeParams({ chain: [{ agent: "explore", task: "step one", tools: [] }] });
	assert.match(diagnostics[0].message, /chain\[1\]\.tools/);
});

test("diagnostics are returned even when the call is rejected", () => {
	const { diagnostics, decision } = resolveMode({ tools: [], tasks: [{ agent: "explore", task: "" }] });
	assert.ok(decision.error);
	assert.equal(diagnostics.length, 1);
});
