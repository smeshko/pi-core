/**
 * Shared "list of running things -> detail view" overlay plumbing.
 *
 * Used by bg-jobs (background bash) and subagent (background agent runs), and
 * intended for any future extension that needs the same shape: a picker when
 * there are 2+ items, straight to detail when there is exactly 1, silent
 * no-op at 0, and a scrollable detail view with live updates while the
 * underlying thing is still running.
 *
 * Kept framework-light: only pi-tui primitives, no ExtensionContext coupling
 * beyond the `ctx.ui.custom` call itself, so the pure pieces (key
 * classification, scroll math) are unit-testable without a TUI.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, SelectList, type SelectItem, truncateToWidth } from "@earendil-works/pi-tui";

// ─────────────────────────────────────────────── list <-> detail navigation

export interface ListDetailController<T> {
	list(): T[];
	get(id: string): T | undefined;
	getId(item: T): string;
}

/**
 * Drives the standard navigation: 0 items is a silent no-op, exactly 1 item
 * skips straight to its detail view (nothing to go "back" to), 2+ items show
 * the picker first. `showDetail` returning "back" only re-opens the picker
 * when more than one item exists.
 */
export async function openListDetailOverlay<T>(
	ctx: ExtensionContext,
	controller: ListDetailController<T>,
	showPicker: (ctx: ExtensionContext, items: T[]) => Promise<string | null>,
	showDetail: (ctx: ExtensionContext, item: T, canGoBack: boolean) => Promise<"close" | "back">,
): Promise<void> {
	const items = controller.list();
	if (items.length === 0) return;

	const canGoBack = items.length > 1;
	let currentId: string | null = canGoBack ? null : controller.getId(items[0]!);

	for (;;) {
		if (currentId === null) {
			currentId = await showPicker(ctx, controller.list());
			if (currentId === null) return;
		}

		const item = controller.get(currentId);
		if (!item) return;

		const result = await showDetail(ctx, item, canGoBack);
		if (result === "back" && canGoBack) {
			currentId = null;
			continue;
		}
		return;
	}
}

// ────────────────────────────────────────────────────────── generic picker

export interface PickerRow {
	value: string;
	label: string;
	description?: string;
	/** Status glyph shown before the label, e.g. "●" or "✓". */
	icon?: string;
	/** Theme colour name applied to `icon`. */
	iconColor?: string;
}

class SelectPickerPanel implements Component {
	private readonly theme: Theme;
	private readonly title: string;
	private readonly footerHint: string;
	private readonly selectList: SelectList;

	constructor(theme: Theme, title: string, rows: PickerRow[], footerHint: string, done: (value: string | null) => void) {
		this.theme = theme;
		this.title = title;
		this.footerHint = footerHint;

		const items: SelectItem[] = rows.map((row) => ({
			value: row.value,
			label: row.icon ? `${theme.fg((row.iconColor ?? "muted") as any, row.icon)} ${row.label}` : row.label,
			description: row.description,
		}));

		this.selectList = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (t: string) => theme.fg("accent", t),
			selectedText: (t: string) => theme.fg("accent", t),
			description: (t: string) => theme.fg("muted", t),
			scrollInfo: (t: string) => theme.fg("dim", t),
			noMatch: (t: string) => theme.fg("warning", t),
		});
		this.selectList.onSelect = (item: SelectItem) => done(item.value);
		this.selectList.onCancel = () => done(null);
	}

	handleInput(data: string): void {
		if (data === "q") {
			this.selectList.onCancel?.();
			return;
		}
		this.selectList.handleInput(data);
	}

	render(width: number): string[] {
		const th = this.theme;
		const divider = th.fg("dim", "─".repeat(width));
		return [
			th.fg("accent", th.bold(` ${this.title}`)),
			divider,
			...this.selectList.render(width),
			divider,
			th.fg("dim", ` ${this.footerHint}`),
		];
	}

	invalidate(): void {
		this.selectList.invalidate();
	}
}

/** Show a titled, single-select picker. Resolves with the chosen value, or null if cancelled. */
export async function showSelectPicker(
	ctx: ExtensionContext,
	title: string,
	rows: PickerRow[],
	footerHint = "↑↓ navigate • enter open • q/esc close",
): Promise<string | null> {
	if (rows.length === 0) return null;

	return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const panel = new SelectPickerPanel(theme, title, rows, footerHint, done);
		return {
			render: (width: number) => panel.render(width),
			invalidate: () => panel.invalidate(),
			handleInput: (data: string) => {
				panel.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

// ─────────────────────────────────────────────────────── detail view pieces

export type OverlayKeyAction = "close" | "back" | "kill" | "scrollUp" | "scrollDown" | "pageUp" | "pageDown" | null;

/**
 * Classifies a detail-view keypress. `canGoBack`/`canKill` gate whether the
 * corresponding raw key is honoured at all (callers still decide what "back"
 * means when nothing recognizes it, e.g. re-showing the picker).
 */
export function classifyOverlayKey(data: string, options: { canGoBack: boolean; canKill: boolean }): OverlayKeyAction {
	if (matchesKey(data, "left")) return options.canGoBack ? "back" : "close";
	if (matchesKey(data, "escape") || matchesKey(data, "return") || matchesKey(data, "space") || data === "q") return "close";
	if (matchesKey(data, "ctrl+c")) return "close";
	if (options.canKill && data === "x") return "kill";
	if (matchesKey(data, "up")) return "scrollUp";
	if (matchesKey(data, "down")) return "scrollDown";
	if (matchesKey(data, "pageUp")) return "pageUp";
	if (matchesKey(data, "pageDown")) return "pageDown";
	return null;
}

export interface ScrollState {
	/** Line index of the first visible row. */
	offset: number;
	/** True when the view should stick to the bottom as new content arrives. */
	follow: boolean;
}

/** Pure scroll math: clamps `offset`, and re-arms `follow` once back at the bottom. */
export function computeScrollWindow(totalLines: number, visibleLines: number, state: ScrollState, delta: number): ScrollState {
	const maxOffset = Math.max(0, totalLines - visibleLines);
	const current = state.follow ? maxOffset : state.offset;
	const next = Math.min(maxOffset, Math.max(0, current + delta));
	return { offset: next, follow: next >= maxOffset };
}

/** The currently visible slice, honouring `follow`. */
export function visibleSlice<T>(items: T[], visibleLines: number, state: ScrollState): T[] {
	const maxOffset = Math.max(0, items.length - visibleLines);
	const offset = state.follow ? maxOffset : Math.min(state.offset, maxOffset);
	return items.slice(offset, offset + visibleLines);
}

/** `└─` style ticker: runs `onTick` on an interval only while `isLive()` is true, and stops itself once it flips false. */
export function createLiveTicker(intervalMs: number, isLive: () => boolean, onTick: () => void): { stop(): void } {
	let timer: ReturnType<typeof setInterval> | null = null;

	const stop = () => {
		if (timer) clearInterval(timer);
		timer = null;
	};

	if (isLive()) {
		timer = setInterval(() => {
			onTick();
			if (!isLive()) stop();
		}, intervalMs);
	}

	return { stop };
}

/** `" " + content` clipped to `width - 1`, matching the detail-view row style used across overlays. */
export function overlayRow(width: number, content: string): string {
	return ` ${truncateToWidth(content, Math.max(0, width - 1), "…")}`;
}

/** Full-width dim divider line. */
export function overlayDivider(theme: Theme, width: number): string {
	return theme.fg("dim", "─".repeat(Math.max(0, width)));
}
