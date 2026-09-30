/**
 * Agent job detail overlay — live status, streaming activity, and inline
 * kill. Mirrors bg-jobs' JobDetailView, built on the same shared scroll/key
 * plumbing, with agent-specific body content (tool calls + final output per
 * agent instead of raw log lines).
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	classifyOverlayKey,
	computeScrollWindow,
	createLiveTicker,
	overlayDivider,
	overlayRow,
	type ScrollState,
	visibleSlice,
} from "../shared/overlay.ts";
import { formatJobDuration, isFailedResult, jobRuntime, jobStatusColor, jobStatusIcon, jobStatusLabel, totalToolCalls } from "./agent-format.ts";
import { type AgentJobRecord, isJobRunning } from "./agent-store.ts";
import { getDisplayItems, getFinalOutput } from "./json-events.ts";
import { formatToolCall, formatUsageStats } from "./render.ts";
import { aggregateUsage } from "./runner.ts";
import type { SingleResult } from "./types.ts";

const VISIBLE_LINES = 20;
const TICK_MS = 1000;

export type AgentDetailResult = "close" | "back";

interface DetailOptions {
	tui: TUI;
	theme: Theme;
	job: AgentJobRecord;
	onChange: (listener: () => void) => () => void;
	canGoBack: boolean;
	done: (result: AgentDetailResult) => void;
}

function resultLines(result: SingleResult, theme: Theme): string[] {
	const lines: string[] = [];
	const items = getDisplayItems(result.messages, result.activity);
	for (const item of items) {
		if (item.type === "toolCall") lines.push(theme.fg("dim", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)));
		else if (item.type === "text") lines.push(theme.fg("toolOutput", item.text.split("\n")[0] ?? ""));
		else if (item.type === "toolResult" && item.isError) lines.push(theme.fg("error", `✗ ${item.name ?? "tool"} failed`));
	}

	const finalOutput = getFinalOutput(result.messages);
	if (finalOutput) {
		lines.push("");
		for (const line of finalOutput.trim().split("\n")) lines.push(line);
	} else if (result.errorMessage) {
		lines.push(theme.fg("error", `Error: ${result.errorMessage}`));
	} else if (result.exitCode === -1) {
		lines.push(theme.fg("dim", "(running…)"));
	}

	const usage = formatUsageStats(result.usage, result.model);
	if (usage) lines.push(theme.fg("dim", usage));
	return lines;
}

function buildBodyLines(job: AgentJobRecord, theme: Theme): string[] {
	const results = job.details.results;
	if (results.length === 0) return [theme.fg("dim", "(starting…)")];

	if (job.mode === "single") return resultLines(results[0]!, theme);

	const lines: string[] = [];
	for (const result of results) {
		const icon = result.exitCode === -1 ? theme.fg("warning", "●") : isFailedResult(result) ? theme.fg("error", "✗") : theme.fg("success", "✓");
		lines.push(`${icon} ${theme.fg("accent", theme.bold(result.agent))} ${theme.fg("dim", result.task)}`);
		for (const line of resultLines(result, theme)) lines.push(`  ${line}`);
		lines.push("");
	}
	return lines;
}

export class AgentDetailView implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private job: AgentJobRecord;
	private readonly canGoBack: boolean;
	private readonly done: (result: AgentDetailResult) => void;
	private readonly getJob: () => AgentJobRecord;

	private unsubscribe: (() => void) | null = null;
	private ticker: { stop(): void } | null = null;
	private disposed = false;
	private scroll: ScrollState = { offset: 0, follow: true };
	private killing = false;
	private readonly killFn: () => Promise<void>;

	constructor(options: DetailOptions, getJob: () => AgentJobRecord, kill: () => Promise<void>) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.job = options.job;
		this.canGoBack = options.canGoBack;
		this.done = options.done;
		this.getJob = getJob;
		this.killFn = kill;

		this.unsubscribe = options.onChange(() => {
			this.job = this.getJob();
			if (!this.disposed) this.tui.requestRender();
		});

		this.ticker = createLiveTicker(
			TICK_MS,
			() => isJobRunning(this.job),
			() => this.tui.requestRender(),
		);
	}

	handleInput(data: string): void {
		const action = classifyOverlayKey(data, { canGoBack: this.canGoBack, canKill: isJobRunning(this.job) });
		switch (action) {
			case "back":
				this.close("back");
				return;
			case "close":
				this.close("close");
				return;
			case "kill":
				this.requestKill();
				return;
			case "scrollUp":
				this.scrollBy(-1);
				return;
			case "scrollDown":
				this.scrollBy(1);
				return;
			case "pageUp":
				this.scrollBy(-VISIBLE_LINES);
				return;
			case "pageDown":
				this.scrollBy(VISIBLE_LINES);
				return;
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const divider = overlayDivider(th, width);
		const row = (content: string) => overlayRow(width, content);
		const lines: string[] = [];

		lines.push(row(`${th.fg("accent", th.bold(this.job.name))} ${th.fg("muted", `[${this.job.mode}]`)}`));
		lines.push(divider);

		const statusText = `${jobStatusIcon(this.job)} ${jobStatusLabel(this.job)}`;
		const status = this.killing && isJobRunning(this.job) ? th.fg("warning", "■ cancelling…") : th.fg(jobStatusColor(this.job), statusText);
		lines.push(row(`${th.fg("muted", "Status ")} ${status}`));
		lines.push(row(`${th.fg("muted", "Runtime")} ${jobRuntime(this.job)}   ${th.fg("muted", "Tools")} ${totalToolCalls(this.job)} calls`));
		lines.push(row(`${th.fg("muted", "Cwd")}     ${th.fg("dim", this.job.cwd)}`));

		lines.push(divider);

		const body = buildBodyLines(this.job, th);
		const visible = this.visibleLines(body);
		for (const line of visible) lines.push(row(line));
		for (let i = visible.length; i < VISIBLE_LINES; i += 1) lines.push("");

		lines.push(divider);
		lines.push(row(th.fg("dim", this.footerStats(body))));
		lines.push(row(th.fg("dim", this.footerHints())));

		return lines;
	}

	invalidate(): void {
		// Nothing is cached; theme colours are applied fresh on every render.
	}

	dispose(): void {
		this.disposed = true;
		this.ticker?.stop();
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	private close(result: AgentDetailResult): void {
		this.dispose();
		this.done(result);
	}

	private requestKill(): void {
		if (this.killing || !isJobRunning(this.job)) return;
		this.killing = true;
		this.tui.requestRender();
		void this.killFn().finally(() => {
			this.killing = false;
			if (!this.disposed) this.tui.requestRender();
		});
	}

	private scrollBy(delta: number): void {
		const body = buildBodyLines(this.job, this.theme);
		this.scroll = computeScrollWindow(body.length, VISIBLE_LINES, this.scroll, delta);
		this.tui.requestRender();
	}

	private visibleLines(body: string[]): string[] {
		return visibleSlice(body, VISIBLE_LINES, this.scroll);
	}

	private footerStats(body: string[]): string {
		const shown = this.visibleLines(body).length;
		const usage = formatUsageStats(aggregateUsage(this.job.details.results));
		const parts = [`Showing ${shown} of ${body.length} lines`, usage].filter(Boolean);
		if (!this.scroll.follow) parts.push("scrolled — ↓ to resume follow");
		return parts.join(" · ");
	}

	private footerHints(): string {
		const hints: string[] = ["↑↓ scroll"];
		if (this.canGoBack) hints.push("← back");
		if (isJobRunning(this.job)) hints.push("x cancel");
		hints.push("q/esc close");
		return hints.join(" • ");
	}
}

/** Show the detail overlay for one agent job. `getJob`/`onChange`/`kill` come from the live store. */
export async function showAgentJobDetail(
	ctx: ExtensionContext,
	job: AgentJobRecord,
	canGoBack: boolean,
	getJob: () => AgentJobRecord | undefined,
	onChange: (listener: () => void) => () => void,
	kill: (jobId: string) => Promise<unknown>,
): Promise<AgentDetailResult> {
	const result = await ctx.ui.custom<AgentDetailResult>(
		(tui, theme, _keybindings, done) =>
			new AgentDetailView(
				{ tui, theme, job, onChange, canGoBack, done },
				() => getJob() ?? job,
				async () => {
					await kill(job.jobId);
				},
			),
	);
	return result ?? "close";
}
