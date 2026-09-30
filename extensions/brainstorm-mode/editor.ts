/**
 * Editor subclass that owns the Tab key and the mode headline.
 *
 * Two subtleties:
 *
 * 1. Tab is claimed only when the base editor would have had nothing useful to
 *    complete, so `@path` and `/command` completion keep working while still
 *    letting you switch modes with a half-written prompt in the buffer.
 *    Registering "tab" via `pi.registerShortcut()` was never an option:
 *    `CustomEditor.handleInput` consults extension shortcuts first and returns
 *    as soon as one matches, with no fall-through.
 *
 * 2. `borderColor` is a *live* property on the app side - interactive-mode
 *    reassigns it whenever the thinking level or bash mode changes. So we
 *    intercept assignment rather than snapshotting it: the app keeps writing
 *    whatever it wants, and normal mode reads back exactly that.
 */

import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { Mode } from "./modes.ts";

/** Matches the scroll indicator the base Editor renders into the top border. */
const SCROLL_INDICATOR = /(↑ \d+ more)/;

const ANSI = /\u001b\[[0-9;]*m/g;

export interface BrainstormEditorOptions {
	getMode: () => Mode;
	onCycle: () => void;
	/** Returns true while the entry grace period is counting down. */
	isGracePeriodActive: () => boolean;
	/** Called when the user presses Esc during the grace period to revert. */
	onGraceCancel: () => void;
	appTheme: Theme;
	/** Hands a render trigger back to the extension, so mode flips repaint immediately. */
	registerRenderer: (render: () => void) => void;
}

export class BrainstormEditor extends CustomEditor {
	private readonly getMode: () => Mode;
	private readonly onCycle: () => void;
	private readonly isGracePeriodActive: () => boolean;
	private readonly onGraceCancel: () => void;
	private readonly appTheme: Theme;
	/** Whatever the app last assigned to `borderColor`. Never stale. */
	private appBorderColor: (str: string) => string;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options: BrainstormEditorOptions) {
		super(tui, theme, keybindings);
		this.getMode = options.getMode;
		this.onCycle = options.onCycle;
		this.isGracePeriodActive = options.isGracePeriodActive;
		this.onGraceCancel = options.onGraceCancel;
		this.appTheme = options.appTheme;
		this.appBorderColor = this.borderColor ?? theme.borderColor;

		// Intercept `editor.borderColor = ...` from interactive-mode (thinking level,
		// bash mode) so leaving brainstorm mode restores the *current* app color
		// rather than one captured at construction time.
		Object.defineProperty(this, "borderColor", {
			configurable: true,
			enumerable: true,
			get: (): ((str: string) => string) => {
				const mode = this.getMode();
				if (mode.id === "normal") return this.appBorderColor;
				return (str: string) => this.appTheme.fg(mode.color, str);
			},
			set: (value: (str: string) => string) => {
				this.appBorderColor = value;
			},
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, "tab") && this.shouldClaimTab()) {
			this.onCycle();
			return;
		}
		// During the grace period Esc cancels the mode switch instead of propagating
		// to the app's abort handler.
		if (matchesKey(data, "escape") && this.isGracePeriodActive()) {
			this.onGraceCancel();
			return;
		}
		super.handleInput(data);
	}

	/**
	 * Claim Tab unless the base editor could plausibly complete something.
	 *
	 * The base editor routes Tab to `handleTabCompletion()`, which either completes
	 * a slash command or force-triggers file completion at the cursor. Neither does
	 * anything useful when the token before the cursor is not path-like, so taking
	 * Tab in that case costs nothing and buys mode switching with text in the buffer.
	 */
	private shouldClaimTab(): boolean {
		if (this.isShowingAutocomplete()) return false;

		const { line, col } = this.getCursor();
		const currentLine = this.getLines()[line] ?? "";
		const beforeCursor = currentLine.slice(0, col);

		if (beforeCursor.trim().length === 0) return true;

		// Slash command still being typed: `/re`, but not `/reload something`.
		const trimmed = beforeCursor.trimStart();
		if (trimmed.startsWith("/") && !trimmed.includes(" ")) return false;

		// Path-like token immediately before the cursor.
		const token = beforeCursor.split(/\s/).pop() ?? "";
		if (token.length === 0) return true;
		return !/^[@~.]|\//.test(token);
	}

	render(width: number): string[] {
		const mode = this.getMode();
		const lines = super.render(width);
		if (mode.id === "normal" || lines.length === 0 || width <= 0) return lines;

		lines[0] = this.appTheme.fg(mode.color, this.headline(lines[0] ?? "", mode, width));
		return lines;
	}

	/**
	 * `─── BRAINSTORM ────────────────────────────────────`
	 *
	 * If the editor is scrolled, the base class put a `↑ N more` indicator in the
	 * top border. Keep it rather than clobbering it.
	 */
	private headline(originalTop: string, mode: Mode, width: number): string {
		const scroll = originalTop.replace(ANSI, "").match(SCROLL_INDICATOR)?.[1];
		const modeLabel = this.isGracePeriodActive() ? `${mode.label} · Esc to cancel` : mode.label;
		const label = scroll ? `─── ${modeLabel} ── ${scroll} ` : `─── ${modeLabel} `;
		if (visibleWidth(label) >= width) return "─".repeat(width);
		return label + "─".repeat(width - visibleWidth(label));
	}
}
