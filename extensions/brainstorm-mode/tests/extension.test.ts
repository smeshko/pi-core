import assert from "node:assert/strict";
import { test } from "node:test";
import brainstormMode from "../index.ts";

/** Minimal ExtensionAPI stub: records registrations and lets us fire handlers. */
function createStubApi() {
	const handlers = new Map<string, Function[]>();
	const tools: string[] = [];
	let active = ["read", "bash", "edit", "write", "grep", "find", "ls", "askUserQuestion", "subagent"];
	const entries: { customType: string; data: unknown }[] = [];
	const messages: Array<{ msg: unknown; options?: unknown }> = [];
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();

	const api = {
		registerTool: (tool: { name: string }) => tools.push(tool.name),
		on: (event: string, handler: Function) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
		sendMessage: (msg: unknown, options?: unknown) => messages.push({ msg, options }),
		registerCommand: (_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(_name, def.handler);
		},
		registerShortcut: () => {},
		registerFlag: () => {},
	};

	const emit = async (event: string, payload: unknown, ctx?: unknown) => {
		const results = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
		return results;
	};

	return { api, emit, tools, entries, messages, commands, getActive: () => active, handlers };
}

function createStubCtx() {
	return {
		hasUI: false,
		cwd: process.cwd(),
		isIdle: () => true,
		ui: {
			notify: () => {},
			select: async () => "Skip",
			theme: { fg: (_c: string, t: string) => t },
			setEditorComponent: () => {},
			setStatus: () => {},
		},
		sessionManager: { getEntries: () => [] },
	};
}

test("extension loads and registers brainstorm_save", () => {
	const stub = createStubApi();
	brainstormMode(stub.api as never);
	assert.deepEqual(stub.tools, ["brainstorm_save"]);
});

test("starts in normal mode: no tools removed, no system prompt added", async () => {
	const stub = createStubApi();
	brainstormMode(stub.api as never);
	await stub.emit("session_start", { type: "session_start", reason: "startup" }, createStubCtx());

	assert.ok(stub.getActive().includes("write"), "normal mode must not strip tools");

	const [result] = await stub.emit("before_agent_start", { systemPrompt: "BASE" });
	assert.equal(result, undefined, "normal mode must not touch the system prompt");

	const [verdict] = await stub.emit("tool_call", { toolName: "write", input: {} });
	assert.equal(verdict, undefined, "normal mode must not block anything");
});

test("restored brainstorm session narrows the active tool set", async () => {
	const stub = createStubApi();
	brainstormMode(stub.api as never);

	const ctx = createStubCtx();
	ctx.sessionManager.getEntries = () =>
		[
			{
				type: "custom",
				customType: "brainstorm-mode",
				data: {
					modeId: "brainstorm",
					toolsBeforeMode: ["read", "bash", "edit", "write", "grep", "find", "ls", "askUserQuestion", "subagent"],
					artifact: undefined,
				},
			},
		] as never;

	await stub.emit("session_start", { type: "session_start", reason: "resume" }, ctx);

	const active = stub.getActive();
	assert.ok(!active.includes("write"));
	assert.ok(!active.includes("edit"));
	assert.ok(!active.includes("bash"));
	assert.ok(active.includes("read"));
	assert.ok(active.includes("subagent"));
	assert.ok(active.includes("brainstorm_save"));

	const [result] = (await stub.emit("before_agent_start", { systemPrompt: "BASE" })) as [
		{ systemPrompt: string },
	];
	assert.ok(result.systemPrompt.startsWith("BASE"));
	assert.ok(result.systemPrompt.includes("BRAINSTORM MODE (ACTIVE)"));
	assert.ok(result.systemPrompt.includes("askUserQuestion"));

	const [blocked] = (await stub.emit("tool_call", { toolName: "write", input: {} })) as [
		{ block: boolean } | undefined,
	];
	assert.equal(blocked?.block, true);

	const [allowed] = await stub.emit("tool_call", { toolName: "read", input: {} });
	assert.equal(allowed, undefined);
});

test("MCP loader additions are re-narrowed after search_mcp_tools", async () => {
	const stub = createStubApi();
	brainstormMode(stub.api as never);

	const ctx = createStubCtx();
	ctx.sessionManager.getEntries = () =>
		[
			{
				type: "custom",
				customType: "brainstorm-mode",
				data: { modeId: "brainstorm", toolsBeforeMode: ["read", "grep"] },
			},
		] as never;
	await stub.emit("session_start", { type: "session_start", reason: "resume" }, ctx);

	// Simulate the MCP loader widening the active set mid-turn.
	stub.api.setActiveTools([
		...stub.getActive(),
		"mcp__ado__wit_get_work_item",
		"mcp__ado__wit_create_work_item",
	]);
	await stub.emit("tool_result", { toolName: "search_mcp_tools" });

	const active = stub.getActive();
	assert.ok(active.includes("mcp__ado__wit_get_work_item"), "read-only MCP tool should survive");
	assert.ok(!active.includes("mcp__ado__wit_create_work_item"), "mutating MCP tool must be dropped");
});

const BRAINSTORM_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "askUserQuestion", "subagent"];

function brainstormSessionCtx() {
	const ctx = createStubCtx();
	ctx.sessionManager.getEntries = () =>
		[
			{
				type: "custom",
				customType: "brainstorm-mode",
				data: { modeId: "brainstorm", toolsBeforeMode: BRAINSTORM_TOOLS, artifact: undefined },
			},
		] as never;
	return ctx;
}

test("Tab→Tab without any interaction skips the exit-save turn", async () => {
	const stub = createStubApi();
	brainstormMode(stub.api as never);

	const ctx = brainstormSessionCtx();
	await stub.emit("session_start", { type: "session_start", reason: "resume" }, ctx);

	// Exit brainstorm immediately, without any before_agent_start having fired.
	const cycle = stub.commands.get("brainstorm");
	assert.ok(cycle, "brainstorm command must be registered");
	await cycle!("", ctx);

	assert.equal(stub.messages.length, 0, "no exit-save turn should be triggered");
	assert.ok(stub.getActive().includes("write"), "should have returned to normal mode");
});

test("leaving brainstorm after interaction triggers the exit-save turn", async () => {
	const stub = createStubApi();
	brainstormMode(stub.api as never);

	const ctx = brainstormSessionCtx();
	await stub.emit("session_start", { type: "session_start", reason: "resume" }, ctx);

	// Simulate the user sending at least one message to the LLM.
	await stub.emit("before_agent_start", { systemPrompt: "BASE" }, ctx);

	const cycle = stub.commands.get("brainstorm");
	assert.ok(cycle, "brainstorm command must be registered");
	await cycle!("", ctx);

	assert.equal(stub.messages.length, 1, "exit-save turn must be triggered when there was interaction");
});
