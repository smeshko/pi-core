/**
 * Job detail overlay — live status, streaming output, and inline kill.
 *
 * Output is read from the store's in-memory ring buffer rather than the log
 * file, so a job that has already exited still renders its tail correctly.
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
import { formatBytes, jobRuntime, statusColor, statusIcon, statusLabel } from "./format.ts";
import { type BackgroundJobStore, isRunning, type JobRecord } from "./jobs.ts";

/** Output rows rendered inside the box. */
const VISIBLE_LINES = 20;

/** Runtime ticks once a second while the job is alive. */
const TICK_MS = 1000;

export type DetailResult = "close" | "back";

interface DetailOptions {
	tui: TUI;
	theme: Theme;
	store: BackgroundJobStore;
	job: JobRecord;
	/** False when opened directly (single job), so there is no list to return to. */
	canGoBack: boolean;
	done: (result: DetailResult) => void;
}

export class JobDetailView implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly store: BackgroundJobStore;
	private readonly job: JobRecord;
	private readonly canGoBack: boolean;
	private readonly done: (result: DetailResult) => void;

	private unsubscribe: (() => void) | null = null;
	private ticker: { stop(): void } | null = null;
	private disposed = false;

	private scroll: ScrollState = { offset: 0, follow: true };
	private killing = false;

	constructor({ tui, theme, store, job, canGoBack, done }: DetailOptions) {
		this.tui = tui;
		this.theme = theme;
		this.store = store;
		this.job = job;
		this.canGoBack = canGoBack;
		this.done = done;

		this.unsubscribe = store.onChange(() => {
			if (!this.disposed) this.tui.requestRender();
		});

		this.ticker = createLiveTicker(
			TICK_MS,
			() => isRunning(this.job),
			() => this.tui.requestRender(),
		);
	}

	handleInput(data: string): void {
		const action = classifyOverlayKey(data, { canGoBack: this.canGoBack, canKill: isRunning(this.job) });
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

		lines.push(row(th.fg("accent", th.bold(this.job.name))));
		lines.push(divider);

		const statusText = `${statusIcon(this.job)} ${statusLabel(this.job)}`;
		const status =
			this.killing && isRunning(this.job)
				? th.fg("warning", "■ killing…")
				: th.fg(statusColor(this.job), statusText);

		lines.push(row(`${th.fg("muted", "Status ")} ${status}`));
		lines.push(row(`${th.fg("muted", "Runtime")} ${jobRuntime(this.job)}   ${th.fg("muted", "PID")} ${this.job.pid}`));
		lines.push(row(`${th.fg("muted", "Command")} ${this.job.command}`));
		lines.push(row(`${th.fg("muted", "Cwd")}     ${th.fg("dim", this.job.cwd)}`));

		lines.push(divider);

		const visible = this.visibleLines();
		for (const line of visible) lines.push(row(th.fg("toolOutput", line)));
		for (let i = visible.length; i < VISIBLE_LINES; i += 1) lines.push("");

		lines.push(divider);
		lines.push(row(th.fg("dim", this.footerStats())));
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

	private close(result: DetailResult): void {
		this.dispose();
		this.done(result);
	}

	private requestKill(): void {
		if (this.killing || !isRunning(this.job)) return;
		this.killing = true;
		this.tui.requestRender();
		void this.store.kill(this.job.jobId).finally(() => {
			this.killing = false;
			if (!this.disposed) this.tui.requestRender();
		});
	}

	private scrollBy(delta: number): void {
		this.scroll = computeScrollWindow(this.job.lines.length, VISIBLE_LINES, this.scroll, delta);
		this.tui.requestRender();
	}

	private visibleLines(): string[] {
		return visibleSlice(this.job.lines, VISIBLE_LINES, this.scroll);
	}

	private footerStats(): string {
		const shown = this.visibleLines().length;
		const parts = [
			`Showing ${shown} of ${this.job.totalLines} lines`,
			formatBytes(this.job.bytes),
		];
		if (!this.scroll.follow) parts.push("scrolled — ↓ to resume follow");
		return parts.join(" · ");
	}

	private footerHints(): string {
		const hints: string[] = ["↑↓ scroll"];
		// Only advertise "back" when a list actually exists to go back to.
		if (this.canGoBack) hints.push("← back");
		if (isRunning(this.job)) hints.push("x kill");
		hints.push("q/esc close");
		return hints.join(" • ");
	}
}

/** Show the detail overlay for one job. */
export async function showJobDetail(
	ctx: ExtensionContext,
	store: BackgroundJobStore,
	job: JobRecord,
	canGoBack: boolean,
): Promise<DetailResult> {
	const result = await ctx.ui.custom<DetailResult>(
		(tui, theme, _keybindings, done) => new JobDetailView({ tui, theme, store, job, canGoBack, done }),
	);
	return result ?? "close";
}
