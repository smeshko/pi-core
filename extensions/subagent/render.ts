import * as os from "node:os";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, TruncatedText, truncateToWidth } from "@earendil-works/pi-tui";
import { callHeader, plainTruncate, plural, textComponent, treeLines, type RenderContext } from "../shared/tool-render-style.ts";
import { getDisplayItems, getFinalOutput } from "./json-events.ts";
import { aggregateUsage, getResultOutput, isFailedResult } from "./runner.ts";
import type { DisplayItem, SingleResult, SubagentDetails, SubagentParams, UsageStats } from "./types.ts";

const COLLAPSED_TEXT_WIDTH = 96;

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: Partial<UsageStats>, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function formatToolCall(toolName: string, args: Record<string, unknown>, themeFg: (color: any, text: string) => string): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 80 ? `${command.slice(0, 80)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", shortenPath(rawPath));
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 72 ? `${argsStr.slice(0, 72)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

function renderDisplayItems(items: DisplayItem[], expanded: boolean, theme: any, limit?: number): string {
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	let text = "";
	if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
	for (const item of toShow) {
		if (item.type === "text") {
			const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
			text += `${theme.fg("toolOutput", preview)}\n`;
		} else if (item.type === "toolCall") {
			text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
		} else if (item.type === "toolResult" && item.isError) {
			text += `${theme.fg("error", `✗ ${item.name ?? "tool"} failed`)}\n`;
		} else if (item.type === "stderr") {
			text += `${theme.fg("warning", item.text)}\n`;
		}
	}
	return text.trimEnd();
}

function resultIcon(result: SingleResult, theme: any): string {
	if (result.exitCode === -1) return theme.fg("warning", "⏳");
	return isFailedResult(result) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

function resultHeader(result: SingleResult, theme: any): string {
	let header = `${resultIcon(result, theme)} ${theme.fg("toolTitle", theme.bold(result.agent))}${theme.fg("muted", ` (${result.agentSource})`)}`;
	if (result.stopReason && result.stopReason !== "end") header += ` ${theme.fg("warning", `[${result.stopReason}]`)}`;
	return header;
}

function addExpandedSingle(container: Container, result: SingleResult, theme: any): void {
	const mdTheme = getMarkdownTheme();
	const finalOutput = getFinalOutput(result.messages);
	const displayItems = getDisplayItems(result.messages, result.activity);
	container.addChild(new Text(resultHeader(result, theme), 0, 0));
	if (result.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${result.errorMessage}`), 0, 0));
	if (result.stderr && isFailedResult(result)) container.addChild(new Text(theme.fg("warning", result.stderr.trim()), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
	container.addChild(new Text(theme.fg("dim", result.task), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Activity ───"), 0, 0));
	const toolItems = displayItems.filter((item) => item.type !== "text");
	if (toolItems.length === 0) container.addChild(new Text(theme.fg("muted", "(no tool activity)"), 0, 0));
	else container.addChild(new Text(renderDisplayItems(toolItems, true, theme), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Final Output ───"), 0, 0));
	container.addChild(finalOutput ? new Markdown(finalOutput.trim(), 0, 0, mdTheme) : new Text(theme.fg("muted", "(no output)"), 0, 0));
	const usage = formatUsageStats(result.usage, result.model);
	if (usage) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", usage), 0, 0));
	}
}

/** Collapsed rows are a single summary line; the expand hint only appears when there is more to reveal. */
function withHint(summary: string, expanded: boolean, hasHiddenBody = true): string {
	return expanded || !hasHiddenBody ? summary : `${summary} (${keyHint("app.tools.expand", "to expand")})`;
}

function toolCallCount(result: SingleResult): number {
	return getDisplayItems(result.messages, result.activity).filter((item) => item.type === "toolCall").length;
}

function singleSummary(result: SingleResult, theme: any): string {
	const running = result.exitCode === -1;
	const failed = !running && isFailedResult(result);
	const parts = [theme.fg("accent", result.agent)];
	if (running) parts.push(theme.fg("warning", "running…"));
	else if (failed) parts.push(theme.fg("error", `failed${result.stopReason && result.stopReason !== "end" ? ` (${result.stopReason})` : ""}`));
	const tools = toolCallCount(result);
	if (tools > 0) parts.push(plural(tools, "tool call"));
	if (running) {
		// Running: show turns only — no token/cost/ctx breakdown
		if (result.usage.turns > 0) parts.push(theme.fg("dim", plural(result.usage.turns, "turn")));
	} else {
		// Done: compact single figure — context window size (falls back to input+output)
		const ctx = result.usage.contextTokens > 0
			? result.usage.contextTokens
			: result.usage.input + result.usage.output;
		if (ctx > 0) parts.push(theme.fg("dim", `${formatTokens(ctx)} tokens`));
	}
	if (result.model) parts.push(theme.fg("dim", result.model));
	return parts.join(theme.fg("muted", " · "));
}

/** While a child agent is still working, one live line of context beats a frozen summary. */
function progressLine(result: SingleResult, theme: any): string[] {
	if (result.errorMessage) return [theme.fg("error", truncateToWidth(result.errorMessage, 160))];
	if (result.exitCode !== -1) return [];
	const items = getDisplayItems(result.messages, result.activity);
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.type === "toolCall") return [theme.fg("dim", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))];
		if (item.type === "text") return [theme.fg("toolOutput", plainTruncate(item.text, COLLAPSED_TEXT_WIDTH))];
	}
	return [];
}

/** Config, agent, and parameter diagnostics used to be details-only; the expanded view is where they belong. */
function addDiagnostics(container: Container, details: SubagentDetails, theme: any): void {
	const diagnostics = details.diagnostics ?? [];
	if (diagnostics.length === 0) return;
	for (const diagnostic of diagnostics) {
		const filePath = "filePath" in diagnostic && diagnostic.filePath ? theme.fg("dim", ` (${diagnostic.filePath})`) : "";
		const icon = diagnostic.level === "error" ? "✗" : "⚠";
		container.addChild(new Text(theme.fg(diagnostic.level === "error" ? "error" : "warning", `${icon} ${diagnostic.message}`) + filePath, 0, 0));
	}
	container.addChild(new Spacer(1));
}

function diagnosticsSuffix(details: SubagentDetails, theme: any): string[] {
	const count = (details.diagnostics ?? []).length;
	return count > 0 ? [theme.fg("warning", `⚠ ${count}`)] : [];
}

/**
 * The tool call now returns immediately (fire-and-forget), so its own result
 * row only ever shows a "started" stub. The rich per-agent rendering below
 * (`renderSubagentResult`) is reused by the completion message instead.
 */
export function renderSubagentStarted(theme: any, context: RenderContext, jobId: string, label: string, mode: string) {
	return textComponent(
		context,
		treeLines(theme, `Started ${jobId} (${label}) [${mode}] — running in background`, [
			theme.fg("dim", "You will be told when it finishes. Do not wait on it."),
		]),
	);
}

export function renderSubagentCall(args: SubagentParams, theme: any, context: RenderContext) {
	const scope = args.agentScope ?? "both";
	const scopeSuffix = scope === "both" ? "" : ` [${scope}]`;

	let label: string;
	if (args.chain && args.chain.length > 0) label = `chain: ${args.chain.map((step) => step.agent).join(" → ")}`;
	else if (args.tasks && args.tasks.length > 0) label = `parallel: ${args.tasks.map((task) => task.agent).join(", ")}`;
	else label = `${args.agent || "..."}: ${(args.task ?? "...").replace(/\s+/g, " ").trim()}`;

	// Don't pre-truncate to a fixed column count here: TruncatedText clips to the real
	// terminal width at render time (with a trailing ellipsis), instead of guessing a
	// fixed 96-col width and cutting the task text out of the middle.
	return new TruncatedText(callHeader(theme, context, "Subagent", `${label}${scopeSuffix}`), 0, 0);
}

export function renderSubagentResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	options: { expanded?: boolean; isPartial?: boolean },
	theme: any,
	context: RenderContext,
) {
	const details = result.details as SubagentDetails | undefined;
	const expanded = Boolean(options.expanded);

	if (!details || !Array.isArray(details.results) || details.results.length === 0) {
		const first = result.content[0];
		const text = first?.type === "text" ? (first.text ?? "") : "";
		return textComponent(context, treeLines(theme, text ? plainTruncate(text) : "Starting…", [], { warning: !text }));
	}

	if (details.mode === "single" && details.results.length === 1) {
		const single = details.results[0];
		if (expanded) {
			const container = new Container();
			addDiagnostics(container, details, theme);
			addExpandedSingle(container, single, theme);
			return container;
		}
		return textComponent(
			context,
			treeLines(theme, withHint([singleSummary(single, theme), ...diagnosticsSuffix(details, theme)].join(theme.fg("muted", " · ")), expanded), progressLine(single, theme), {
				error: single.exitCode !== -1 && isFailedResult(single),
				warning: single.exitCode === -1,
			}),
		);
	}

	const running = details.results.filter((item) => item.exitCode === -1).length;
	const successCount = details.results.filter((item) => item.exitCode !== -1 && !isFailedResult(item)).length;
	const failCount = details.results.filter((item) => item.exitCode !== -1 && isFailedResult(item)).length;
	const label = details.mode === "chain" ? "chain" : "parallel";
	const status =
		running > 0
			? `${successCount + failCount}/${details.results.length} done, ${running} running`
			: `${successCount}/${details.results.length} ${details.mode === "chain" ? "steps" : "tasks"}${failCount > 0 ? `, ${failCount} failed` : ""}`;

	if (expanded && running === 0) {
		const container = new Container();
		addDiagnostics(container, details, theme);
		container.addChild(new Text(`${theme.fg("toolTitle", theme.bold(`${label} `))}${theme.fg("accent", status)}`, 0, 0));
		for (const item of details.results) {
			container.addChild(new Spacer(1));
			addExpandedSingle(container, item, theme);
		}
		const usage = formatUsageStats(aggregateUsage(details.results));
		if (usage) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", `Total: ${usage}`), 0, 0));
		}
		return container;
	}

	const summaryParts = [`${label} · ${status}`];
	summaryParts.push(...diagnosticsSuffix(details, theme));
	if (running === 0) {
		const totalTools = details.results.reduce((sum, r) => sum + toolCallCount(r), 0);
		const agg = aggregateUsage(details.results);
		const ctx = agg.contextTokens > 0 ? agg.contextTokens : agg.input + agg.output;
		const statParts: string[] = [];
		if (totalTools > 0) statParts.push(plural(totalTools, "tool call"));
		if (ctx > 0) statParts.push(`${formatTokens(ctx)} tokens`);
		if (statParts.length > 0) summaryParts.push(theme.fg("dim", statParts.join(" · ")));
	}
	// Collapsed multi-runs stay one line once settled; while agents are live, one line each is the progress view.
	const body = running > 0 ? details.results.flatMap((item) => [`${theme.fg("accent", item.agent)} ${resultIcon(item, theme)}`, ...progressLine(item, theme)]) : [];

	return textComponent(context, treeLines(theme, withHint(summaryParts.join(theme.fg("muted", " · ")), expanded), body, { warning: running > 0, error: running === 0 && failCount > 0 }));
}

export function summarizeResultForModel(result: SingleResult): string {
	const status = isFailedResult(result) ? `failed${result.stopReason ? ` (${result.stopReason})` : ""}` : "completed";
	return `### [${result.agent}] ${status}\n\n${getResultOutput(result)}`;
}
