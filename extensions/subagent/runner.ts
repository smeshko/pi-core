import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatAvailableAgents, normalizeTools } from "./agents.ts";
import { buildChildEnv, buildRuntimeArgs } from "./config.ts";
import { applyJsonEventLine, getFinalOutput } from "./json-events.ts";
import type { AgentConfig, ChildRuntimePolicy, SingleResult, SubagentConfig, SubagentDetails, UsageStats } from "./types.ts";

/**
 * package-mcp stubs `/mcp` in children that cannot reach MCP tools, so the built-in MCP steps
 * aside and warns about it. That warning is expected; keep it out of progress and error text.
 */
export function stripExpectedChildWarnings(text: string): string {
	return text
		.split("\n")
		.filter((line) => !/^Warning: Extension package "builtin:mcp": .*package-mcp\.ts registers command `\/mcp`/.test(line))
		.join("\n")
		.replace(/^\n+/, "");
}

export const PER_TASK_OUTPUT_CAP_BYTES = 50 * 1024;

export type ToolContent = { type: "text"; text: string };
export type SubagentToolResult = { content: ToolContent[]; details: SubagentDetails };
export type OnUpdateCallback = (partial: SubagentToolResult) => void;

export interface BuildChildArgsOptions {
	agent: AgentConfig;
	task: string;
	config: SubagentConfig;
	promptPath?: string;
	taskTools?: string[];
	runtime?: ChildRuntimePolicy;
}

export interface RunSingleAgentOptions {
	defaultCwd: string;
	agents: AgentConfig[];
	agentName: string;
	task: string;
	cwd?: string;
	step?: number;
	config: SubagentConfig;
	taskTools?: string[];
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function createBaseResult(
	agent: string,
	task: string,
	agentSource: SingleResult["agentSource"] = "unknown",
	step?: number,
	cwd?: string,
): SingleResult {
	return {
		agent,
		agentSource,
		task,
		cwd,
		exitCode: -1,
		messages: [],
		activity: [],
		partialText: "",
		stderr: "",
		usage: emptyUsage(),
		step,
	};
}

export function makeUnknownAgentResult(agentName: string, task: string, agents: AgentConfig[], step?: number, cwd?: string): SingleResult {
	return {
		...createBaseResult(agentName, task, "unknown", step, cwd),
		exitCode: 1,
		failureKind: "unknown_agent",
		errorMessage: `Unknown agent: "${agentName}". Available agents: ${formatAvailableAgents(agents)}.`,
	};
}

export function selectChildTools(agent: AgentConfig, config: SubagentConfig, taskTools?: string[]): string[] | undefined {
	const selected = taskTools !== undefined ? (normalizeTools(taskTools) ?? []) : agent.tools !== undefined ? agent.tools : config.defaultTools;
	if (selected === undefined || config.recursion.allow) return selected;
	return selected.filter((tool) => tool !== "subagent");
}

export function buildChildArgs(options: BuildChildArgsOptions): string[] {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const { agent, config, promptPath, task, taskTools } = options;
	if (agent.model) args.push("--model", agent.model);

	const tools = selectChildTools(agent, config, taskTools);
	if (tools !== undefined) {
		if (tools.length === 0) args.push("--no-tools");
		else args.push("--tools", tools.join(","));
	}

	args.push(...buildRuntimeArgs(options.runtime ?? config.runtime));
	if (promptPath) args.push("--append-system-prompt", promptPath);
	args.push(`Task: ${task}`);
	return args;
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

export async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

async function cleanupTempPrompt(tmpDir: string | null): Promise<void> {
	if (!tmpDir) return;
	try {
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup.
	}
}

function appendBounded(current: string, chunk: string, maxBytes: number): string {
	const combined = current + chunk;
	const bytes = Buffer.byteLength(combined, "utf8");
	if (bytes <= maxBytes) return combined;
	const marker = "[stderr truncated to last bytes]\n";
	const markerBytes = Buffer.byteLength(marker, "utf8");
	const buffer = Buffer.from(combined, "utf8");
	return marker + buffer.subarray(Math.max(0, buffer.length - Math.max(1, maxBytes - markerBytes))).toString("utf8");
}

export function isFailedResult(result: SingleResult): boolean {
	return (
		result.failureKind !== undefined ||
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted"
	);
}

/**
 * True when a run finished cleanly (no error/abort) but produced no assistant
 * output. Some providers/models intermittently return an empty completion — no
 * tool calls, no text — which surfaces to the parent as "(no output)". These are
 * safe and cheap to retry.
 */
export function producedEmptyOutput(result: SingleResult): boolean {
	if (isFailedResult(result)) return false;
	return getFinalOutput(result.messages).trim() === "";
}

export function isRuntimeFailure(result: SingleResult): boolean {
	if (result.failureKind === "unknown_agent" || result.failureKind === "invalid_params") return false;
	return isFailedResult(result);
}

export function getStreamingOutput(result: SingleResult): string {
	return getFinalOutput(result.messages) || result.partialText || result.errorMessage || result.stderr || "(running...)";
}

export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

export function truncateParallelOutput(output: string, capBytes = PER_TASK_OUTPUT_CAP_BYTES): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= capBytes) return output;
	let truncated = output.slice(0, capBytes);
	while (Buffer.byteLength(truncated, "utf8") > capBytes) truncated = truncated.slice(0, -1);
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

export function aggregateUsage(results: SingleResult[]): UsageStats {
	const total = emptyUsage();
	for (const result of results) {
		total.input += result.usage.input;
		total.output += result.usage.output;
		total.cacheRead += result.usage.cacheRead;
		total.cacheWrite += result.usage.cacheWrite;
		total.cost += result.usage.cost;
		total.turns += result.usage.turns;
		total.contextTokens = Math.max(total.contextTokens, result.usage.contextTokens);
	}
	return total;
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
	signal?: AbortSignal,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;

	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			if (signal?.aborted) throw new Error("Subagent execution aborted.");
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

function markPostRunFailure(result: SingleResult, exitCode: number, spawnError: Error | undefined, aborted: boolean): void {
	result.exitCode = exitCode;
	if (spawnError) {
		result.failureKind = "spawn_error";
		result.errorMessage = `Failed to start subagent process: ${spawnError.message}`;
		return;
	}
	if (aborted || result.stopReason === "aborted") {
		result.failureKind = "aborted";
		result.stopReason = "aborted";
		result.errorMessage = result.errorMessage || "Subagent was aborted.";
		return;
	}
	if (result.stopReason === "error") {
		result.failureKind = "child_error";
		result.errorMessage = result.errorMessage || result.stderr || "Subagent stopped with stopReason=error.";
		return;
	}
	if (exitCode !== 0) {
		result.failureKind = "child_error";
		result.errorMessage = result.errorMessage || result.stderr || `Subagent exited with code ${exitCode}.`;
	}
}

export async function runSingleAgent(options: RunSingleAgentOptions): Promise<SingleResult> {
	const { agents, agentName, task, cwd, step, config, taskTools, signal, onUpdate, makeDetails } = options;
	const agent = agents.find((candidate) => candidate.name === agentName);
	if (!agent) return makeUnknownAgentResult(agentName, task, agents, step, cwd);
	if (signal?.aborted) throw new Error("Subagent execution aborted before start.");

	let tmpPromptDir: string | null = null;
	let promptPath: string | undefined;
	const currentResult = createBaseResult(agentName, task, agent.source, step, cwd);
	currentResult.exitCode = -1;
	currentResult.model = agent.model;

	const emitUpdate = () => {
		onUpdate?.({
			content: [{ type: "text", text: getStreamingOutput(currentResult) }],
			details: makeDetails([currentResult]),
		});
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			promptPath = tmp.filePath;
		}

		const args = buildChildArgs({ agent, task, config, taskTools, promptPath });
		const invocation = getPiInvocation(args);
		let wasAborted = false;
		let spawnError: Error | undefined;
		let buffer = "";

		const exitCode = await new Promise<number>((resolve) => {
			let closed = false;
			let settled = false;
			let killTimer: NodeJS.Timeout | undefined;
			let abortHandler: (() => void) | undefined;

			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				closed = true;
				if (killTimer) clearTimeout(killTimer);
				if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
				if (buffer.trim()) {
					applyJsonEventLine(buffer, currentResult);
					buffer = "";
				}
				resolve(code);
			};

			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? options.defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: buildChildEnv(process.env, config),
			});

			const killProc = () => {
				wasAborted = true;
				currentResult.stopReason = "aborted";
				currentResult.errorMessage = "Subagent was aborted by the parent session.";
				if (!closed) proc.kill("SIGTERM");
				killTimer = setTimeout(() => {
					if (!closed) proc.kill("SIGKILL");
				}, config.killTimeoutMs);
			};

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString("utf8");
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				let changed = false;
				for (const line of lines) changed = applyJsonEventLine(line, currentResult) || changed;
				if (changed) emitUpdate();
			});

			proc.stderr.on("data", (data: Buffer) => {
				const text = stripExpectedChildWarnings(data.toString("utf8"));
				if (text) currentResult.stderr = appendBounded(currentResult.stderr, text, config.stderrMaxBytes);
			});

			proc.on("error", (error) => {
				spawnError = error instanceof Error ? error : new Error(String(error));
				finish(1);
			});

			proc.on("close", (code) => finish(code ?? 0));

			if (signal) {
				abortHandler = killProc;
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		markPostRunFailure(currentResult, exitCode, spawnError, wasAborted);
		emitUpdate();
		if (wasAborted || signal?.aborted) throw new Error("Subagent execution aborted.");
		return currentResult;
	} finally {
		await cleanupTempPrompt(tmpPromptDir);
	}
}

export interface EmptyOutputRetryOptions {
	retries: number;
	agentName: string;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
}

/**
 * Runs `runOnce` and retries, up to `retries` extra times, whenever the result
 * completed cleanly but produced no output (see `producedEmptyOutput`). Failed
 * or aborted runs are returned immediately — retrying a misconfig or a crash
 * would just waste attempts. Aborts between attempts short-circuit the loop.
 */
export async function runWithEmptyOutputRetry(
	runOnce: (attempt: number) => Promise<SingleResult>,
	options: EmptyOutputRetryOptions,
): Promise<SingleResult> {
	const maxRetries = Math.max(0, Math.floor(options.retries));
	let result = await runOnce(0);
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		if (!producedEmptyOutput(result)) return result;
		if (options.signal?.aborted) return result;
		options.onUpdate?.({
			content: [{ type: "text", text: `${options.agentName} returned no output — retrying (${attempt}/${maxRetries})...` }],
			details: options.makeDetails([result]),
		});
		result = await runOnce(attempt);
	}
	return result;
}

/** `runSingleAgent` wrapped with empty-output retries driven by config. */
export async function runSingleAgentWithRetry(options: RunSingleAgentOptions, retries: number): Promise<SingleResult> {
	return runWithEmptyOutputRetry(() => runSingleAgent(options), {
		retries,
		agentName: options.agentName,
		signal: options.signal,
		onUpdate: options.onUpdate,
		makeDetails: options.makeDetails,
	});
}
