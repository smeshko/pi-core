/**
 * Panel chrome tests.
 *
 * The TUI contract is strict: every line returned by render() must be exactly
 * the requested width, or borders tear and overlays corrupt the screen. These
 * tests use an identity theme so visibleWidth() reflects real geometry.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createPanel } from "../panel.ts";

/** Identity theme: no ANSI, so widths are directly measurable. */
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Parameters<typeof createPanel>[0];

describe("panel chrome", () => {
	for (const width of [20, 40, 64, 80, 120]) {
		it(`fills exactly ${width} columns on every line`, () => {
			const panel = createPanel(theme, width);
			const lines = [
				panel.top(),
				panel.top("A Title"),
				panel.divider(),
				panel.line(),
				panel.line("short"),
				panel.line("x".repeat(width * 3)),
				panel.bottom(),
			];

			for (const [index, line] of lines.entries()) {
				assert.equal(visibleWidth(line), width, `line ${index} is ${visibleWidth(line)} wide, expected ${width}`);
			}
		});
	}

	it("uses thick double-line borders", () => {
		const panel = createPanel(theme, 40);
		assert.match(panel.top(), /^╔═+╗$/);
		assert.match(panel.divider(), /^╠═+╣$/);
		assert.match(panel.bottom(), /^╚═+╝$/);
		assert.match(panel.line("hi"), /^║.*║$/);
	});

	it("pads content horizontally", () => {
		const panel = createPanel(theme, 40);
		// Two spaces of gutter inside the border on each side.
		assert.match(panel.line("hi"), /^║ {2}hi/);
		assert.match(panel.line("hi"), / {2}║$/);
	});

	it("embeds a title in the top border", () => {
		const panel = createPanel(theme, 40);
		assert.match(panel.top("Jobs"), /^╔═ Jobs ═+╗$/);
	});

	it("survives absurdly small widths", () => {
		for (const width of [1, 2, 3, 4]) {
			const panel = createPanel(theme, width);
			assert.doesNotThrow(() => panel.line("content"));
			assert.doesNotThrow(() => panel.top("title"));
		}
	});
});
