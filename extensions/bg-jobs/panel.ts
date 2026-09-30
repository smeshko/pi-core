/**
 * Panel chrome for the bg-jobs overlays.
 *
 * Thick double-line borders in bold
 * borderAccent plus horizontal padding and a panel background, so an overlay
 * reads as a distinct surface rather than blending into the terminal.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const PANEL_PADDING_X = 2;

export interface Panel {
	/** Width between the two vertical borders. */
	innerWidth: number;
	/** Usable width for content, after horizontal padding. */
	contentWidth: number;
	top: (title?: string) => string;
	divider: () => string;
	bottom: () => string;
	line: (content?: string) => string;
}

export function createPanel(theme: Theme, width: number): Panel {
	const safeWidth = Math.max(4, width);
	const innerWidth = safeWidth - 2;
	const contentWidth = Math.max(1, innerWidth - PANEL_PADDING_X * 2);
	const border = (text: string) => theme.fg("borderAccent", theme.bold(text));
	const gutter = " ".repeat(PANEL_PADDING_X);

	return {
		innerWidth,
		contentWidth,

		top(title?: string): string {
			if (!title) return border(`╔${"═".repeat(innerWidth)}╗`);
			const label = truncateToWidth(` ${title} `, Math.max(1, innerWidth - 2));
			const fill = Math.max(0, innerWidth - visibleWidth(label) - 1);
			return border("╔═") + theme.fg("accent", theme.bold(label)) + border(`${"═".repeat(fill)}╗`);
		},

		divider(): string {
			return border(`╠${"═".repeat(innerWidth)}╣`);
		},

		bottom(): string {
			return border(`╚${"═".repeat(innerWidth)}╝`);
		},

		line(content = ""): string {
			const clipped = truncateToWidth(content, contentWidth, "…", false);
			const trailing = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
			return (
				border("║") + theme.bg("customMessageBg", `${gutter}${clipped}${trailing}${gutter}`) + border("║")
			);
		},
	};
}
