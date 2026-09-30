import assert from "node:assert/strict";
import { test } from "node:test";
import { guardToolCall, isReadOnlyMcpTool, isToolNameAllowed, parseMcpToolName } from "../guards.ts";
import { sanitizeSlug, todayStamp } from "../save-tool.ts";

const NO_EXTRA = new Set<string>();
const guard = (name: string, input: Record<string, unknown> = {}) =>
	guardToolCall(name, input, { extraAllow: NO_EXTRA });

test("read-only tools are allowed", () => {
	for (const name of ["read", "grep", "find", "ls", "askUserQuestion", "websearch", "webfetch", "brainstorm_save"]) {
		assert.equal(guard(name).reason, undefined, name);
	}
});

test("write tools are blocked", () => {
	for (const name of ["write", "edit", "bash", "apply_patch", "some_unknown_tool"]) {
		assert.ok(guard(name).reason, name);
	}
});

test("unknown tools fail closed", () => {
	assert.ok(guard("totally_new_tool").reason);
});

test("MCP tool names parse into server and remote", () => {
	assert.deepEqual(parseMcpToolName("mcp__ado__wit_get_work_item"), {
		server: "ado",
		remote: "wit_get_work_item",
	});
	assert.equal(parseMcpToolName("read"), undefined);
});

test("MCP read verbs are allowed, write verbs are not", () => {
	assert.ok(isReadOnlyMcpTool("wit_get_work_item", NO_EXTRA));
	assert.ok(isReadOnlyMcpTool("repo_list_pull_requests", NO_EXTRA));
	assert.ok(isReadOnlyMcpTool("search_workitem", NO_EXTRA));

	assert.ok(!isReadOnlyMcpTool("wit_create_work_item", NO_EXTRA));
	assert.ok(!isReadOnlyMcpTool("repo_create_pull_request", NO_EXTRA));
	assert.ok(!isReadOnlyMcpTool("wit_update_work_item", NO_EXTRA));
	assert.ok(!isReadOnlyMcpTool("work_item_add_comment", NO_EXTRA));
});

test("a write verb anywhere beats a read verb", () => {
	// "get_or_create" reads and writes; it must fail closed.
	assert.ok(!isReadOnlyMcpTool("wit_get_or_create_work_item", NO_EXTRA));
});

test("ambiguous MCP names are denied but can be force-allowed", () => {
	assert.ok(!isReadOnlyMcpTool("wit_my_work_items", NO_EXTRA));
	assert.ok(isReadOnlyMcpTool("wit_my_work_items", new Set(["wit_my_work_items"])));
});

test("MCP guard blocks mutating tools with an actionable reason", () => {
	const verdict = guard("mcp__ado__wit_create_work_item");
	assert.ok(verdict.reason?.includes("wit_create_work_item"));
	assert.ok(verdict.reason?.includes("extraAllowedMcpTools"));
});

test("subagent: model-supplied tools override is discarded", () => {
	const input: Record<string, unknown> = {
		agent: "explore",
		task: "find things",
		tools: ["write", "bash", "edit"],
	};
	assert.equal(guard("subagent", input).reason, undefined);
	assert.deepEqual(input.tools, ["read", "grep", "find", "ls"]);
});

test("subagent: tools are forced even when absent", () => {
	const input: Record<string, unknown> = { agent: "webfetch", task: "research" };
	assert.equal(guard("subagent", input).reason, undefined);
	assert.deepEqual(input.tools, ["websearch", "webfetch"]);
});

test("subagent: non-read-only agents are rejected", () => {
	const verdict = guard("subagent", { agent: "implementer", task: "write code" });
	assert.ok(verdict.reason?.includes("implementer"));
});

test("subagent: parallel tasks are each coerced", () => {
	const input: Record<string, unknown> = {
		tasks: [
			{ agent: "explore", task: "a", tools: ["write"] },
			{ agent: "webfetch", task: "b" },
		],
		tools: ["bash"],
	};
	assert.equal(guard("subagent", input).reason, undefined);
	const tasks = input.tasks as { tools: string[] }[];
	assert.deepEqual(tasks[0]!.tools, ["read", "grep", "find", "ls"]);
	assert.deepEqual(tasks[1]!.tools, ["websearch", "webfetch"]);
	assert.equal(input.tools, undefined, "top-level default must not survive");
});

test("subagent: chain entries are coerced and one bad agent rejects the call", () => {
	const ok: Record<string, unknown> = {
		chain: [
			{ agent: "explore", task: "a" },
			{ agent: "webfetch", task: "b" },
		],
	};
	assert.equal(guard("subagent", ok).reason, undefined);

	const bad: Record<string, unknown> = {
		chain: [
			{ agent: "explore", task: "a" },
			{ agent: "coder", task: "b" },
		],
	};
	assert.ok(guard("subagent", bad).reason?.includes("coder"));
});

test("subagent: runtime overrides are stripped", () => {
	const input: Record<string, unknown> = {
		agent: "explore",
		task: "a",
		runtime: { extensions: { mode: "inherit" } },
	};
	assert.equal(guard("subagent", input).reason, undefined);
	assert.equal(input.runtime, undefined);
});

test("subagent: an unnamed agent is rejected", () => {
	assert.ok(guard("subagent", { task: "do something" }).reason);
});

test("isToolNameAllowed permits subagent by name", () => {
	// The name-level check builds the active tool set; argument checks happen later.
	assert.ok(isToolNameAllowed("subagent", NO_EXTRA));
	assert.ok(!isToolNameAllowed("bash", NO_EXTRA));
	assert.ok(isToolNameAllowed("mcp__ado__wit_get_work_item", NO_EXTRA));
	assert.ok(!isToolNameAllowed("mcp__ado__wit_create_work_item", NO_EXTRA));
});

test("slugs cannot escape the brainstorm directory", () => {
	assert.equal(sanitizeSlug("../../etc/passwd"), "etc-passwd");
	assert.equal(sanitizeSlug("/absolute/path"), "absolute-path");
	assert.equal(sanitizeSlug("Tab Mode Switching!"), "tab-mode-switching");
	assert.equal(sanitizeSlug("   "), "brainstorm");
	assert.ok(sanitizeSlug("x".repeat(200)).length <= 60);
});

test("date stamp is ISO yyyy-mm-dd", () => {
	assert.match(todayStamp(new Date("2026-06-11T09:30:00Z")), /^2026-06-11$/);
});
