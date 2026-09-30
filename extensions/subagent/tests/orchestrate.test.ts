/**
 * Orchestration control-flow tests. `runAgent` is injected as a fake so chain
 * substitution, parallel fan-out, and the unknown-agent preflight can be
 * tested without spawning real `pi` subprocesses.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG } from "../config.ts";
import { requestedAgentNames, runOrchestration, unknownAgentNames } from "../orchestrate.ts";
import type { RunSingleAgentOptions } from "../runner.ts";
import type { AgentConfig, SingleResult, SubagentParams } from "../types.ts";

const scout: AgentConfig = { name: "scout", description: "Scout", systemPrompt: "", source: "user", filePath: "/a/scout.md" };
const planner: AgentConfig = { name: "planner", description: "Planner", systemPrompt: "", source: "user", filePath: "/a/planner.md" };

function okResult(agent: string, text: string): SingleResult {
	return {
		agent,
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text }] }],
		activity: [],
		partialText: "",
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
	};
}

function failResult(agent: string): SingleResult {
	return {
		agent,
		agentSource: "user",
		task: "task",
		exitCode: 1,
		messages: [],
		activity: [],
		partialText: "",
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		failureKind: "child_error",
		errorMessage: "boom",
	};
}

describe("requestedAgentNames / unknownAgentNames", () => {
	it("collects names across single/tasks/chain", () => {
		const params: SubagentParams = {
			tasks: [{ agent: "scout", task: "a" }],
			chain: [{ agent: "planner", task: "b" }],
		};
		assert.deepEqual(new Set(requestedAgentNames(params)), new Set(["scout", "planner"]));
	});

	it("flags names not present in the discovered agent list", () => {
		const params: SubagentParams = { agent: "ghost", task: "x" };
		assert.deepEqual(unknownAgentNames(params, [scout]), ["ghost"]);
		assert.deepEqual(unknownAgentNames({ agent: "scout", task: "x" }, [scout]), []);
	});
});

describe("runOrchestration", () => {
	it("single mode returns the agent's final text", async () => {
		const result = await runOrchestration({
			mode: "single",
			params: { agent: "scout", task: "find things" },
			agents: [scout],
			config: DEFAULT_CONFIG,
			cwd: "/tmp",
			signal: new AbortController().signal,
			onUpdate: () => {},
			runAgent: async (options: RunSingleAgentOptions) => okResult(options.agentName, "found it"),
		});
		assert.equal(result.isError, false);
		assert.equal(result.text, "found it");
		assert.equal(result.results.length, 1);
	});

	it("chain mode substitutes {previous} between steps", async () => {
		const seenTasks: string[] = [];
		const result = await runOrchestration({
			mode: "chain",
			params: {
				chain: [
					{ agent: "scout", task: "step one" },
					{ agent: "planner", task: "plan using: {previous}" },
				],
			},
			agents: [scout, planner],
			config: DEFAULT_CONFIG,
			cwd: "/tmp",
			signal: new AbortController().signal,
			onUpdate: () => {},
			runAgent: async (options: RunSingleAgentOptions) => {
				seenTasks.push(options.task);
				return okResult(options.agentName, `${options.agentName}-output`);
			},
		});
		assert.deepEqual(seenTasks, ["step one", "plan using: scout-output"]);
		assert.equal(result.text, "planner-output");
		assert.equal(result.isError, false);
	});

	it("chain mode stops at the first failing step", async () => {
		let calls = 0;
		const result = await runOrchestration({
			mode: "chain",
			params: {
				chain: [
					{ agent: "scout", task: "step one" },
					{ agent: "planner", task: "step two" },
				],
			},
			agents: [scout, planner],
			config: DEFAULT_CONFIG,
			cwd: "/tmp",
			signal: new AbortController().signal,
			onUpdate: () => {},
			runAgent: async (options: RunSingleAgentOptions) => {
				calls++;
				return failResult(options.agentName);
			},
		});
		assert.equal(calls, 1, "must not run step two after step one fails");
		assert.equal(result.isError, true);
		assert.match(result.text, /step 1 \(scout\)/);
	});

	it("parallel mode runs every task and reports the success count", async () => {
		const result = await runOrchestration({
			mode: "parallel",
			params: {
				tasks: [
					{ agent: "scout", task: "a" },
					{ agent: "planner", task: "b" },
				],
			},
			agents: [scout, planner],
			config: DEFAULT_CONFIG,
			cwd: "/tmp",
			signal: new AbortController().signal,
			onUpdate: () => {},
			runAgent: async (options: RunSingleAgentOptions) => okResult(options.agentName, `${options.agentName}-done`),
		});
		assert.equal(result.results.length, 2);
		assert.match(result.text, /2\/2 succeeded/);
		assert.equal(result.isError, false);
	});

	it("parallel mode rejects an oversized task list before running anything", async () => {
		let calls = 0;
		const tasks = Array.from({ length: DEFAULT_CONFIG.maxParallelTasks + 1 }, (_, i) => ({ agent: "scout", task: `t${i}` }));
		const result = await runOrchestration({
			mode: "parallel",
			params: { tasks },
			agents: [scout],
			config: DEFAULT_CONFIG,
			cwd: "/tmp",
			signal: new AbortController().signal,
			onUpdate: () => {},
			runAgent: async (options: RunSingleAgentOptions) => {
				calls++;
				return okResult(options.agentName, "x");
			},
		});
		assert.equal(calls, 0);
		assert.equal(result.isError, true);
		assert.match(result.text, /Too many parallel tasks/);
	});

	it("calls onUpdate with streaming partial results as each task progresses", async () => {
		const snapshots: number[] = [];
		await runOrchestration({
			mode: "parallel",
			params: { tasks: [{ agent: "scout", task: "a" }] },
			agents: [scout],
			config: DEFAULT_CONFIG,
			cwd: "/tmp",
			signal: new AbortController().signal,
			onUpdate: (results) => snapshots.push(results.length),
			runAgent: async (options: RunSingleAgentOptions) => okResult(options.agentName, "done"),
		});
		assert.ok(snapshots.length >= 1);
		assert.ok(snapshots.every((n) => n === 1));
	});
});
