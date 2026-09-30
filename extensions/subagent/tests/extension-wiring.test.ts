/**
 * Extension wiring smoke test for the background subagent tool.
 *
 * Stays consistent with the rest of the suite (agents.test.ts, mode.test.ts,
 * runner-args.test.ts, ...): no real `pi` subprocess is spawned here. This
 * covers tool/shortcut/renderer registration and the synchronous preflight
 * checks (unknown agent, invalid mode) that must fail fast, before anything
 * is handed to the background job store. The background-job contract itself
 * (returns immediately, completion fires via onExit, kill aborts the signal)
 * is covered by agent-store.test.ts and orchestrate.test.ts using an injected
 * fake runner.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import subagentExtension from "../index.ts";

before(() => initTheme());

interface RegisteredTool {
	name: string;
	renderShell?: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<{ content: { type: string; text: string }[]; details?: Record<string, unknown> }>;
}

interface SentMessage {
	customType: string;
	content: string;
	details?: Record<string, unknown>;
	options: { deliverAs?: string; triggerTurn?: boolean };
}

function createHarness(cwd = "/tmp/pi-subagent-test") {
	const tools = new Map<string, RegisteredTool>();
	const shortcuts = new Map<string, unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const events = new Map<string, ((event: unknown, ctx: unknown) => Promise<unknown>)[]>();
	const messages: SentMessage[] = [];
	const messageRenderers = new Map<string, (message: unknown, options: unknown, theme: unknown) => unknown>();

	const ctx = {
		cwd,
		mode: "print",
		hasUI: true,
		ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (t: string) => t },
			setStatus: () => {},
			notify: () => {},
			confirm: async () => true,
		},
	};

	const pi = {
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, options),
		registerShortcut: (key: string, options: unknown) => shortcuts.set(key, options),
		registerMessageRenderer: (
			customType: string,
			renderer: (message: unknown, options: unknown, theme: unknown) => unknown,
		) => messageRenderers.set(customType, renderer),
		sendMessage: (message: { customType: string; content: string; details?: Record<string, unknown> }, options: Record<string, unknown>) =>
			messages.push({ ...message, options: options ?? {} }),
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
			const list = events.get(event) ?? [];
			list.push(handler);
			events.set(event, list);
		},
	};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	subagentExtension(pi as any);

	const fire = async (event: string) => {
		for (const handler of events.get(event) ?? []) await handler({}, ctx);
	};

	return { tools, shortcuts, commands, events, messages, messageRenderers, ctx, start: () => fire("session_start"), shutdown: () => fire("session_shutdown") };
}

describe("subagent extension wiring", () => {
	it("registers the tool, shortcut, and completion message renderer", () => {
		const harness = createHarness();
		assert.ok(harness.tools.has("subagent"));
		assert.ok(harness.shortcuts.has("ctrl+alt+a"), "expected the ctrl+alt+a shortcut");
		assert.ok(harness.messageRenderers.has("subagent-finished"));
		assert.ok(harness.commands.has("subagents"));
	});

	it("rejects an unknown agent name before spawning anything, synchronously fast", async () => {
		const harness = createHarness();
		await harness.start();
		const tool = harness.tools.get("subagent")!;

		const startedAt = Date.now();
		await assert.rejects(
			() => tool.execute("call-1", { agent: "does-not-exist", task: "x" }, undefined, undefined, harness.ctx),
			/Unknown agent/,
		);
		const elapsed = Date.now() - startedAt;
		assert.ok(elapsed < 500, `preflight validation took ${elapsed}ms; it must fail before any process spawn`);

		await harness.shutdown();
	});

	it("rejects an invalid mode (neither single, tasks, nor chain) synchronously", async () => {
		const harness = createHarness();
		await harness.start();
		const tool = harness.tools.get("subagent")!;

		await assert.rejects(() => tool.execute("call-1", {}, undefined, undefined, harness.ctx), /Provide exactly one mode/);

		await harness.shutdown();
	});
});
