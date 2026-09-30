/**
 * Extension wiring tests.
 *
 * Imports the real module graph (index -> picker/detail/panel -> pi-tui,
 * pi-coding-agent, shared/tool-render-style) so a bad import or export surfaces
 * here rather than by breaking every pi session at startup. Then drives the
 * registered tools through their real execute() functions.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import backgroundJobsExtension from "../index.ts";

// keyHint() and theme.fg() read a process-global theme that only the TUI sets up.
before(() => initTheme());

interface RegisteredTool {
	name: string;
	label?: string;
	renderShell?: string;
	renderCall?: (args: Record<string, unknown>, theme: unknown, context: unknown) => unknown;
	renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => unknown;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<{ content: { type: string; text: string }[]; details?: Record<string, unknown> }>;
}

interface SentMessage {
	customType: string;
	content: string;
	details?: Record<string, unknown>;
	options: { deliverAs?: string; triggerTurn?: boolean };
}

interface Harness {
	tools: Map<string, RegisteredTool>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	shortcuts: Map<string, unknown>;
	events: Map<string, ((event: unknown, ctx: unknown) => Promise<void>)[]>;
	messageRenderers: Map<string, (message: unknown, options: unknown, theme: unknown) => unknown>;
	messages: SentMessage[];
	notifications: string[];
	ctx: unknown;
	start: () => Promise<void>;
	shutdown: () => Promise<void>;
}

function createHarness(): Harness {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const shortcuts = new Map<string, unknown>();
	const events = new Map<string, ((event: unknown, ctx: unknown) => Promise<void>)[]>();
	const messages: SentMessage[] = [];
	const notifications: string[] = [];
	const messageRenderers = new Map<string, (message: unknown, options: unknown, theme: unknown) => unknown>();

	const ctx = {
		cwd: process.cwd(),
		mode: "print",
		hasUI: true,
		sessionManager: { getSessionId: () => `test-${randomUUID()}` },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setWidget: () => {},
			setStatus: () => {},
			notify: (message: string) => notifications.push(message),
		},
	};

	const pi = {
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, options),
		registerShortcut: (key: string, options: unknown) => shortcuts.set(key, options),
		sendMessage: (message: { customType: string; content: string }, options: Record<string, unknown>) =>
			messages.push({ ...message, options: options ?? {} }),
		registerMessageRenderer: (
			customType: string,
			renderer: (message: unknown, options: unknown, theme: unknown) => unknown,
		) => messageRenderers.set(customType, renderer),
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
			const list = events.get(event) ?? [];
			list.push(handler);
			events.set(event, list);
		},
	};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	backgroundJobsExtension(pi as any);

	const fire = async (event: string) => {
		for (const handler of events.get(event) ?? []) await handler({}, ctx);
	};

	return {
		tools,
		commands,
		shortcuts,
		events,
		messageRenderers,
		messages,
		notifications,
		ctx,
		start: () => fire("session_start"),
		shutdown: () => fire("session_shutdown"),
	};
}

async function callTool(
	harness: Harness,
	name: string,
	params: Record<string, unknown> = {},
): Promise<{ text: string; details: Record<string, unknown> }> {
	const tool = harness.tools.get(name);
	assert.ok(tool, `tool ${name} is not registered`);
	const result = await tool.execute("call-1", params);
	return { text: result.content.map((part) => part.text).join("\n"), details: result.details ?? {} };
}

/** Poll bg_status until the job stops running. Never blocks a turn in real use. */
async function pollUntilFinished(harness: Harness, job: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const status = await callTool(harness, "bg_status", { job });
		if (status.details.running === false) return status.details;
		if (Date.now() > deadline) throw new Error(`job ${job} did not finish within ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("extension wiring", () => {
	it("opts every tool out of the default render shell", () => {
		const harness = createHarness();
		for (const [name, tool] of harness.tools) {
			// Without this, pi wraps the row in its own box and background,
			// which clashes with the house tool-call style.
			assert.equal(tool.renderShell, "self", `${name} must set renderShell: "self"`);
			assert.equal(typeof tool.renderCall, "function", `${name} must define renderCall`);
			assert.equal(typeof tool.renderResult, "function", `${name} must define renderResult`);
		}
	});

	it("renders completion messages in the house style", () => {
		const harness = createHarness();
		const renderer = harness.messageRenderers.get("bg-job-finished");
		assert.ok(renderer, "completion messages appear in the transcript and need a house-style renderer");

		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const details = {
			jobId: "job-1",
			name: "tests",
			status: "exited (0)",
			runtime: "2m 29s",
			ok: true,
			totalLines: 3390,
			bytes: 524_000,
			tail: ["All tests passed!"],
		};
		const message = { customType: "bg-job-finished", details };

		const render = (expanded: boolean): string => {
			const component = renderer(message, { expanded, outputPad: 0 }, theme) as {
				render: (width: number) => string[];
			};
			assert.ok(component, "renderer returned nothing");
			return component.render(120).join("\n");
		};

		const collapsed = render(false);
		assert.match(collapsed, /● BackgroundTask\(tests\)/, "expected the house ● Label(arg) header");
		assert.match(collapsed, /└─/, "expected the house tree line");
		assert.match(collapsed, /exited \(0\)/);
		assert.match(collapsed, /2m 29s/);
		assert.doesNotMatch(collapsed, /All tests passed!/, "tail belongs in the expanded view only");

		const expanded = render(true);
		assert.match(expanded, /All tests passed!/, "expanded view should include the tail");
	});

	it("registers the documented surface and no blocking wait tool", () => {
		const harness = createHarness();

		assert.deepEqual([...harness.tools.keys()].sort(), ["bg_kill", "bg_list", "bg_run", "bg_status"]);
		assert.equal(harness.tools.has("bg_wait"), false, "bg_wait must not exist: bg_* never blocks a turn");
		assert.ok(harness.commands.has("bg"));
		assert.ok(harness.shortcuts.has("ctrl+alt+b"), "expected the ctrl+alt+b shortcut");
		assert.ok(harness.events.has("session_start"));
		assert.ok(harness.events.has("session_shutdown"));
	});

	it("returns from bg_run immediately without waiting for the command", async () => {
		const harness = createHarness();
		await harness.start();

		try {
			const startedAt = Date.now();
			const started = await callTool(harness, "bg_run", { command: "sleep 30", name: "slow" });
			const elapsed = Date.now() - startedAt;

			assert.ok(elapsed < 1000, `bg_run took ${elapsed}ms; it must not wait for the command`);
			assert.equal(started.details.running, true);
			assert.match(started.text, /Do not wait on it/);
		} finally {
			await harness.shutdown();
		}
	});

	it("notifies the human and queues a message for the agent on completion", async () => {
		const harness = createHarness();
		await harness.start();

		try {
			await callTool(harness, "bg_run", { command: "echo integration", name: "demo" });
			await pollUntilFinished(harness, "demo");

			// The exit listener fires from the child's close event.
			await new Promise((resolve) => setTimeout(resolve, 50));

			assert.equal(
				harness.notifications.length,
				0,
				"completion must not add a duplicate grey ui.notify status line",
			);

			const finished = harness.messages.find((message) => message.customType === "bg-job-finished");
			assert.ok(finished, "expected a bg-job-finished message for the agent");
			assert.match(finished.content, /integration/);
			assert.equal(finished.options.triggerTurn, true, "completion must start a turn for the agent");
			assert.equal(finished.options.deliverAs, undefined, "completion should start/steer directly");
		} finally {
			await harness.shutdown();
		}
	});

	it("reports status and lists jobs", async () => {
		const harness = createHarness();
		await harness.start();

		try {
			await callTool(harness, "bg_run", { command: "echo hello", name: "demo" });
			const details = await pollUntilFinished(harness, "demo");
			assert.equal(details.exit_code, 0);

			const list = await callTool(harness, "bg_list");
			assert.match(list.text, /demo/);
		} finally {
			await harness.shutdown();
		}
	});

	it("kills a running job through the registered tool", async () => {
		const harness = createHarness();
		await harness.start();

		try {
			await callTool(harness, "bg_run", { command: "sleep 30", name: "sleeper" });
			const killed = await callTool(harness, "bg_kill", { job: "sleeper" });

			assert.equal(killed.details.ok, true);
			assert.equal(killed.details.running, false);
		} finally {
			await harness.shutdown();
		}
	});

	it("stays quiet about jobs killed by shutdown", async () => {
		const harness = createHarness();
		await harness.start();
		await callTool(harness, "bg_run", { command: "sleep 30", name: "doomed" });

		await harness.shutdown();
		await new Promise((resolve) => setTimeout(resolve, 50));

		const finished = harness.messages.filter((message) => message.customType === "bg-job-finished");
		assert.equal(finished.length, 0, "shutdown kills must not queue completion messages");
	});

	it("surfaces a helpful error for an unknown job", async () => {
		const harness = createHarness();
		await harness.start();

		try {
			await assert.rejects(() => callTool(harness, "bg_status", { job: "ghost" }), /No background job matching/);
		} finally {
			await harness.shutdown();
		}
	});

	it("kills via /bg kill and rejects unknown subcommands", async () => {
		const harness = createHarness();
		await harness.start();

		try {
			await callTool(harness, "bg_run", { command: "sleep 30", name: "viacmd" });
			const command = harness.commands.get("bg");
			assert.ok(command);

			await command.handler("kill viacmd", harness.ctx);
			const status = await callTool(harness, "bg_status", { job: "viacmd" });
			assert.equal(status.details.running, false);

			// Should not throw on bad input.
			await command.handler("bogus", harness.ctx);
		} finally {
			await harness.shutdown();
		}
	});
});
