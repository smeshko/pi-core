import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { discoverAgents } from "./agents.ts";
import { openListDetailOverlay } from "../shared/overlay.ts";
import type { RenderContext } from "../shared/tool-render-style.ts";
import { showAgentJobDetail } from "./agent-detail.ts";
import { showAgentJobPicker } from "./agent-picker.ts";
import { jobRuntime, jobStatusLabel, summarizeJobForWidget } from "./agent-format.ts";
import { type AgentJobRecord, AgentJobStore } from "./agent-store.ts";
import {
	applyToolParamOverrides,
	getSubagentDepth,
	loadSubagentConfig,
	recursionBlockMessage,
	shouldRegisterSubagentTool,
} from "./config.ts";
import { resolveMode } from "./mode.ts";
import { requestedAgentNames, runOrchestration, unknownAgentNames } from "./orchestrate.ts";
import { renderSubagentCall, renderSubagentResult, renderSubagentStarted } from "./render.ts";
import { isRuntimeFailure } from "./runner.ts";
import { SubagentParamsSchema } from "./schema.ts";
import { formatAvailableAgents } from "./agents.ts";
import type { AgentConfig, ChildRuntimePolicy, SingleResult, SubagentDetails, SubagentParams } from "./types.ts";

const WIDGET_ID = "subagents";
const SHORTCUT_LABEL = "ctrl+alt+a";
const WIDGET_TICK_MS = 1000;
const MAX_WIDGET_JOBS = 3;
const SUBAGENT_FINISHED = "subagent-finished";

function hasRuntimeFailure(results: SingleResult[]): boolean {
	return results.some(isRuntimeFailure);
}

function jobDisplayName(mode: "single" | "parallel" | "chain", params: SubagentParams): string {
	if (mode === "single") return params.agent!;
	if (mode === "parallel") return `parallel(${params.tasks?.length ?? 0})`;
	return `chain(${params.chain?.length ?? 0})`;
}

async function maybeConfirmProjectAgents(
	params: SubagentParams,
	agents: AgentConfig[],
	projectAgentsDir: string | null,
	confirm: boolean,
	ctx: ExtensionContext,
): Promise<boolean> {
	if (!confirm || !ctx.hasUI) return true;
	const projectAgentsRequested = requestedAgentNames(params)
		.map((name) => agents.find((agent) => agent.name === name))
		.filter((agent): agent is AgentConfig => agent?.source === "project");
	if (projectAgentsRequested.length === 0) return true;
	const names = projectAgentsRequested.map((agent) => agent.name).join(", ");
	return ctx.ui.confirm(
		"Run project-local subagents?",
		`Agents: ${names}\nSource: ${projectAgentsDir ?? "(unknown)"}\n\nProject agents are repo-controlled prompts and load by default in this extension. Continue only for trusted repositories.`,
	);
}

function runtimeSummary(policy: ChildRuntimePolicy): string {
	const resource = (name: string, mode: string, allow: string[]) =>
		mode === "allowlist" ? `${name}=allowlist(${allow.length})` : `${name}=${mode}`;
	return [
		resource("extensions", policy.extensions.mode, policy.extensions.allow),
		resource("skills", policy.skills.mode, policy.skills.allow),
		resource("prompts", policy.promptTemplates.mode, policy.promptTemplates.allow),
		`context=${policy.contextFiles}`,
	].join(", ");
}

function agentToolPolicy(agent: AgentConfig, defaultTools: string[] | undefined): string {
	if (agent.tools) return agent.tools.length > 0 ? agent.tools.join(",") : "no tools";
	if (defaultTools !== undefined) return defaultTools.length > 0 ? `${defaultTools.join(",")} (config)` : "no tools (config)";
	return "child defaults";
}

function buildSubagentPrompt(cwd: string): string | undefined {
	const loaded = loadSubagentConfig(cwd);
	const discovery = discoverAgents(cwd, loaded.config.agentScope);
	if (discovery.agents.length === 0) return undefined;

	const preferredAgents = discovery.agents.filter((agent) => agent.name === "explore" || agent.name === "webfetch");
	const agentsToList = preferredAgents.length > 0 ? preferredAgents : discovery.agents;
	const hasExplore = agentsToList.some((agent) => agent.name === "explore");
	const hasWebfetch = agentsToList.some((agent) => agent.name === "webfetch");

	const rules = [
		"All built-in subagents are read-only.",
		...(hasExplore
			? [
				"Delegate any medium-or-larger codebase exploration to `explore` first.",
				"If the task needs more than a trivial single-file lookup or one simple grep, call `explore` before doing manual file reads.",
			]
			: []),
		...(hasWebfetch ? ["Use `webfetch` for public web research and current external documentation."] : []),
		"Keep direct `read`/`grep`/`find`/`ls` work for quick confirmation only.",
		"subagent runs in the background and returns a job id immediately; end your turn instead of waiting, pi delivers the result automatically when it finishes.",
	];

	return [
		"## Subagent usage policy",
		"",
		"Available subagents:",
		...agentsToList.map((agent) => `- ${agent.name}: ${agent.description}`),
		"",
		"Rules:",
		...rules.map((rule) => `- ${rule}`),
	].join("\n");
}

function makeSubagentsListing(cwd: string): string[] {
	const loaded = loadSubagentConfig(cwd);
	const config = loaded.config;
	const discovery = discoverAgents(cwd, config.agentScope);
	const lines: string[] = [];
	lines.push("Subagents");
	lines.push("=========");
	lines.push(`Scope: ${config.agentScope}`);
	lines.push(`Project agents: ${discovery.projectAgentsDir ?? "none found"}`);
	lines.push(`Runtime: ${runtimeSummary(config.runtime)}`);
	lines.push(`Recursion: ${config.recursion.allow ? `allowed (maxDepth ${config.recursion.maxDepth})` : "blocked"}`);
	lines.push("");
	if (discovery.agents.length === 0) lines.push("No agents discovered. Add Markdown files to ~/.pi/agent/agents, a package agents/ dir, or .pi/agents.");
	else {
		for (const agent of discovery.agents) {
			lines.push(`- ${agent.name} [${agent.source}]`);
			lines.push(`  ${agent.description}`);
			lines.push(`  model: ${agent.model ?? "current/default"}; tools: ${agentToolPolicy(agent, config.defaultTools)}`);
			lines.push(`  file: ${agent.filePath}`);
		}
	}
	const diagnostics = [...loaded.diagnostics, ...discovery.diagnostics];
	if (diagnostics.length > 0) {
		lines.push("");
		lines.push("Diagnostics:");
		for (const diagnostic of diagnostics) lines.push(`- ${diagnostic.level}: ${diagnostic.filePath ? `${diagnostic.filePath}: ` : ""}${diagnostic.message}`);
	}
	return lines;
}

async function showSubagentsCommand(cwd: string, ctx: any): Promise<void> {
	const lines = makeSubagentsListing(cwd);
	if (!ctx.hasUI) {
		console.log(lines.join("\n"));
		return;
	}
	await ctx.ui.custom((_tui: any, theme: any, _keybindings: any, done: (value: void) => void) => ({
		render(width: number) {
			return [
				...lines.map((line, index) => {
					const styled = index === 0 ? theme.fg("accent", theme.bold(line)) : line.startsWith("- ") ? theme.fg("accent", line) : line;
					return truncateToWidth(styled, Math.max(1, width));
				}),
				"",
				theme.fg("dim", "Enter/Esc/q to close"),
			];
		},
		invalidate() {},
		handleInput(data: string) {
			if (data === "\r" || data === "\n" || data === "q" || data === "\x1b" || data === "\u0003") done(undefined);
		},
	}));
}

export default function subagentExtension(pi: ExtensionAPI) {
	const startupConfig = loadSubagentConfig(process.cwd()).config;
	const startupDepth = getSubagentDepth();
	if (!shouldRegisterSubagentTool(startupConfig, startupDepth)) return;

	const store = new AgentJobStore();
	let uiCtx: ExtensionContext | null = null;
	let ticker: ReturnType<typeof setInterval> | null = null;
	let shuttingDown = false;

	// ---------------------------------------------------------------- widget

	function updateWidget(): void {
		if (!uiCtx?.hasUI) return;
		const running = store.running();
		if (running.length === 0) {
			uiCtx.ui.setStatus(WIDGET_ID, undefined);
			return;
		}

		const theme = uiCtx.ui.theme;
		const label = running.length === 1 ? "1 subagent running" : `${running.length} subagents running`;
		const shown = running.slice(0, MAX_WIDGET_JOBS).map(summarizeJobForWidget);
		const overflow = running.length > MAX_WIDGET_JOBS ? ` +${running.length - MAX_WIDGET_JOBS}` : "";

		uiCtx.ui.setStatus(
			WIDGET_ID,
			`${theme.fg("warning", "●")} ${theme.fg("muted", `${label} (${shown.join(", ")}${overflow})`)}  ${theme.fg("dim", SHORTCUT_LABEL)}`,
		);
	}

	function stopTicker(): void {
		if (!ticker) return;
		clearInterval(ticker);
		ticker = null;
	}

	function startTicker(): void {
		if (ticker) return;
		ticker = setInterval(() => {
			updateWidget();
			if (store.running().length === 0) stopTicker();
		}, WIDGET_TICK_MS);
	}

	// ------------------------------------------------------------ completion

	function handleJobExit(job: AgentJobRecord): void {
		if (shuttingDown) return;

		const outcome = `${job.jobId} (${job.name}) ${jobStatusLabel(job)} after ${jobRuntime(job)}`;
		try {
			pi.sendMessage<SubagentDetails>(
				{
					customType: SUBAGENT_FINISHED,
					content: `Subagent ${outcome}.\n\n${job.summaryText || "(no output)"}`,
					display: true,
					details: job.details,
				},
				{ triggerTurn: true },
			);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			console.error(`Could not deliver subagent completion for ${job.jobId}: ${reason}`);
		}

		updateWidget();
	}

	// --------------------------------------------------------------- overlay

	async function openOverlay(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Subagent job UI requires the interactive TUI", "warning");
			return;
		}

		await openListDetailOverlay(
			ctx,
			{ list: () => store.list(), get: (id) => store.get(id), getId: (job) => job.jobId },
			(pickerCtx) => showAgentJobPicker(pickerCtx, store.list()),
			(detailCtx, job, canGoBack) =>
				showAgentJobDetail(
					detailCtx,
					job,
					canGoBack,
					() => store.get(job.jobId),
					(listener) => store.onChange(listener),
					(id) => store.kill(id),
				),
		);
	}

	// ---------------------------------------------------------------- hooks

	pi.on("before_agent_start", async (event, ctx) => {
		const prompt = buildSubagentPrompt(ctx.cwd);
		if (!prompt) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});

	pi.registerMessageRenderer<SubagentDetails>(SUBAGENT_FINISHED, (message, options, theme) => {
		const details = message.details;
		if (!details) return undefined;
		const text = typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		const fakeContext: RenderContext = {
			args: {},
			lastComponent: undefined,
			state: {},
			isPartial: false,
			isError: details.hadRuntimeFailure,
			executionStarted: true,
			expanded: Boolean(options.expanded),
			showImages: false,
			cwd: undefined,
		};
		return renderSubagentResult({ content: [{ type: "text", text }], details }, { expanded: options.expanded }, theme, fakeContext);
	});

	pi.registerCommand("subagents", {
		description: "List discovered subagents, source, model, tool policy, and child runtime policy",
		handler: async (_args, ctx) => showSubagentsCommand(ctx.cwd, ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("a"), {
		description: "Show subagent jobs",
		handler: async (ctx) => {
			await openOverlay(ctx);
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context windows.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"By default this extension loads user agents from ~/.pi/agent/agents (plus agents/ in pi packages) and nearest project agents from .pi/agents; project agents override user agents.",
			"Agents without tools frontmatter use normal child Pi default tools; explicit tools restrict child tools.",
			"Runs in the background: returns a job id immediately and delivers the result as a message when the run finishes.",
		].join(" "),
		promptSnippet:
			"Delegate isolated work to named subagents (single, parallel tasks, or chain with {previous}) using agents from ~/.pi/agent/agents, pi packages, and .pi/agents.",
		promptGuidelines: [
			"Use subagent when a task benefits from an isolated context window, specialized role prompt, or delegated codebase reconnaissance/review.",
			"Use subagent parallel mode only for independent tasks; keep parallel requests within the configured limit (default 8 tasks, 4 concurrent).",
			"Use subagent chain mode when later steps depend on earlier output; include the literal {previous} placeholder in later step tasks.",
			"Do not use subagent recursively unless the user's subagent config explicitly allows recursion.",
			"subagent returns immediately with a job id; end the turn instead of polling, pi delivers the result automatically when it finishes.",
		],
		parameters: SubagentParamsSchema,

		async execute(_toolCallId, rawParams: SubagentParams, _signal, _onUpdate, ctx) {
			const { params, diagnostics: paramDiagnostics, decision: modeDecision } = resolveMode(rawParams);
			const loaded = loadSubagentConfig(ctx.cwd);
			const config = applyToolParamOverrides(loaded.config, params, ctx.cwd);
			const depth = getSubagentDepth();
			if (!shouldRegisterSubagentTool(config, depth)) throw new Error(recursionBlockMessage(config, depth));

			const discovery = discoverAgents(ctx.cwd, config.agentScope);
			const agents = discovery.agents;
			const diagnostics = [...loaded.diagnostics, ...discovery.diagnostics, ...paramDiagnostics];
			const mode = modeDecision.mode ?? "single";

			if (modeDecision.error) {
				const available = agents.map((agent) => `${agent.name} (${agent.source})`).join(", ") || "none";
				throw new Error(`${modeDecision.error}\nAvailable agents: ${available}`);
			}

			// Fail fast on typos before spawning anything in the background.
			const unknown = unknownAgentNames(params, agents);
			if (unknown.length > 0) {
				throw new Error(
					`Unknown agent(s): ${unknown.map((name) => `"${name}"`).join(", ")}. Available agents: ${formatAvailableAgents(agents)}.`,
				);
			}

			const confirmed = await maybeConfirmProjectAgents(params, agents, discovery.projectAgentsDir, config.confirmProjectAgents, ctx);
			if (!confirmed) throw new Error("Canceled: project-local subagents were not approved.");

			const makeDetails = (results: SingleResult[]): SubagentDetails => ({
				mode,
				agentScope: config.agentScope,
				projectAgentsDir: discovery.projectAgentsDir,
				configFiles: loaded.loadedPaths,
				runtimePolicy: config.runtime,
				recursion: config.recursion,
				diagnostics,
				results,
				hadRuntimeFailure: hasRuntimeFailure(results),
			});

			const name = jobDisplayName(mode, params);
			const job = store.start({
				name,
				mode,
				cwd: ctx.cwd,
				makeDetails,
				run: ({ signal, onUpdate }) => runOrchestration({ mode, params, agents, config, cwd: ctx.cwd, signal, onUpdate }),
			});

			startTicker();
			updateWidget();

			return {
				content: [
					{
						type: "text",
						text:
							`Started ${job.jobId} (${job.name}) [${mode}].\n\n` +
							"Running in the background — you will be told when it finishes. Do not wait on it.",
					},
				],
				details: { jobId: job.jobId, mode, status: "running" },
			};
		},

		renderShell: "self",
		renderCall(args, theme, context) {
			return renderSubagentCall(args as SubagentParams, theme, context as unknown as RenderContext);
		},

		renderResult(result, _options, theme, context) {
			const ctx = context as unknown as RenderContext;
			const details = result.details as { jobId?: string; mode?: string } | undefined;
			if (ctx.isError || !details?.jobId) {
				return renderSubagentResult(result, { expanded: ctx.expanded }, theme, ctx);
			}
			const args = ctx.args as SubagentParams;
			const label = args?.agent ?? (args?.chain ? `${args.chain.length} steps` : args?.tasks ? `${args.tasks.length} tasks` : "");
			return renderSubagentStarted(theme, ctx, details.jobId, label, details.mode ?? "single");
		},
	});

	// --------------------------------------------------------------- session

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		shuttingDown = false;
		updateWidget();
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		stopTicker();
		if (uiCtx?.hasUI) uiCtx.ui.setStatus(WIDGET_ID, undefined);
		await store.dispose();
		uiCtx = null;
	});

	store.onExit(handleJobExit);
}

export { makeSubagentsListing };
