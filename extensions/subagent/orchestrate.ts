/**
 * Mode orchestration (single / parallel / chain), extracted from the tool's
 * `execute()` so it can run as one background job instead of blocking the
 * tool call.
 *
 * `runAgent` is injected (defaults to `runSingleAgentWithRetry`) so tests can
 * drive the chain/parallel control flow without spawning real `pi`
 * subprocesses.
 */

import {
	createBaseResult,
	getResultOutput,
	isFailedResult,
	mapWithConcurrencyLimit,
	runSingleAgentWithRetry,
	truncateParallelOutput,
	type RunSingleAgentOptions,
} from "./runner.ts";
import { summarizeResultForModel as defaultSummarize } from "./render.ts";
import { getFinalOutput } from "./json-events.ts";
import type { AgentConfig, SingleResult, SubagentConfig, SubagentDetails, SubagentParams, TaskParams } from "./types.ts";

export type RunAgentFn = (options: RunSingleAgentOptions, retries: number) => Promise<SingleResult>;

export interface OrchestrationInput {
	mode: "single" | "parallel" | "chain";
	params: SubagentParams;
	agents: AgentConfig[];
	config: SubagentConfig;
	cwd: string;
	signal: AbortSignal;
	/** Called with the latest partial results as the run progresses. */
	onUpdate: (results: SingleResult[]) => void;
	/** Injection point for tests; defaults to the real subprocess-spawning runner. */
	runAgent?: RunAgentFn;
}

export interface OrchestrationOutput {
	text: string;
	results: SingleResult[];
	isError: boolean;
}

/** Every agent name referenced anywhere in `params`, for the unknown-agent preflight check. */
export function requestedAgentNames(params: SubagentParams): string[] {
	const names = new Set<string>();
	if (params.agent) names.add(params.agent);
	for (const task of params.tasks ?? []) names.add(task.agent);
	for (const step of params.chain ?? []) names.add(step.agent);
	return [...names];
}

/** Names in `requestedAgentNames` that are not in `agents`. Checked before backgrounding so typos fail fast. */
export function unknownAgentNames(params: SubagentParams, agents: AgentConfig[]): string[] {
	const known = new Set(agents.map((agent) => agent.name));
	return requestedAgentNames(params).filter((name) => !known.has(name));
}

async function runChain(input: OrchestrationInput): Promise<OrchestrationOutput> {
	const runAgent = input.runAgent ?? runSingleAgentWithRetry;
	const chain = input.params.chain ?? [];
	const results: SingleResult[] = [];
	let previousOutput = "";

	for (let i = 0; i < chain.length; i++) {
		if (input.signal.aborted) throw new Error("Subagent chain aborted.");
		const step = chain[i]!;
		const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

		const result = await runAgent(
			{
				defaultCwd: input.cwd,
				agents: input.agents,
				agentName: step.agent,
				task: taskWithContext,
				cwd: step.cwd,
				step: i + 1,
				config: input.config,
				taskTools: step.tools,
				signal: input.signal,
				onUpdate: (partial) => {
					const current = partial.details.results[0];
					if (current) input.onUpdate([...results, current]);
				},
				makeDetails: (partialResults) => ({ results: partialResults }) as SubagentDetails,
			},
			input.config.emptyOutputRetries,
		);
		results.push(result);
		input.onUpdate([...results]);

		if (isFailedResult(result)) {
			return {
				text: `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(result)}`,
				results,
				isError: true,
			};
		}
		previousOutput = getFinalOutput(result.messages);
	}

	const last = results[results.length - 1];
	return { text: last ? getFinalOutput(last.messages) || "(no output)" : "(no output)", results, isError: false };
}

async function runParallel(input: OrchestrationInput): Promise<OrchestrationOutput> {
	const runAgent = input.runAgent ?? runSingleAgentWithRetry;
	const tasks = input.params.tasks ?? [];

	if (tasks.length > input.config.maxParallelTasks) {
		return {
			text: `Too many parallel tasks (${tasks.length}). Max is ${input.config.maxParallelTasks}.`,
			results: [],
			isError: true,
		};
	}

	const allResults: SingleResult[] = tasks.map((task: TaskParams) => {
		const agent = input.agents.find((candidate) => candidate.name === task.agent);
		return createBaseResult(task.agent, task.task, agent?.source ?? "unknown", undefined, task.cwd);
	});
	input.onUpdate([...allResults]);

	const results = await mapWithConcurrencyLimit(
		tasks,
		input.config.maxConcurrency,
		async (task: TaskParams, index: number) => {
			const result = await runAgent(
				{
					defaultCwd: input.cwd,
					agents: input.agents,
					agentName: task.agent,
					task: task.task,
					cwd: task.cwd,
					config: input.config,
					taskTools: task.tools,
					signal: input.signal,
					onUpdate: (partial) => {
						const current = partial.details.results[0];
						if (current) {
							allResults[index] = current;
							input.onUpdate([...allResults]);
						}
					},
					makeDetails: (partialResults) => ({ results: partialResults }) as SubagentDetails,
				},
				input.config.emptyOutputRetries,
			);
			allResults[index] = result;
			input.onUpdate([...allResults]);
			return result;
		},
		input.signal,
	);

	const successCount = results.filter((result) => !isFailedResult(result)).length;
	const summaries = results.map((result) =>
		truncateParallelOutput(
			defaultSummarize({ ...result, errorMessage: result.errorMessage && truncateParallelOutput(result.errorMessage) }),
		),
	);
	return {
		text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
		results,
		isError: successCount === 0 && results.length > 0,
	};
}

async function runSingle(input: OrchestrationInput): Promise<OrchestrationOutput> {
	const runAgent = input.runAgent ?? runSingleAgentWithRetry;
	const result = await runAgent(
		{
			defaultCwd: input.cwd,
			agents: input.agents,
			agentName: input.params.agent!,
			task: input.params.task!,
			cwd: input.params.cwd,
			config: input.config,
			taskTools: input.params.tools,
			signal: input.signal,
			onUpdate: (partial) => {
				const current = partial.details.results[0];
				if (current) input.onUpdate([current]);
			},
			makeDetails: (partialResults) => ({ results: partialResults }) as SubagentDetails,
		},
		input.config.emptyOutputRetries,
	);

	if (isFailedResult(result)) {
		return { text: `Agent ${result.agent} failed: ${getResultOutput(result)}`, results: [result], isError: true };
	}
	return { text: getFinalOutput(result.messages) || "(no output)", results: [result], isError: false };
}

/** Runs the requested mode to completion. Never rejects for job failures — only for signal aborts before start. */
export async function runOrchestration(input: OrchestrationInput): Promise<OrchestrationOutput> {
	if (input.mode === "chain") return runChain(input);
	if (input.mode === "parallel") return runParallel(input);
	return runSingle(input);
}
