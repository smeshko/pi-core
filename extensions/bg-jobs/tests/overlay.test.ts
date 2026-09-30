/**
 * Pure-function tests for the shared overlay plumbing (key classification and
 * scroll math). No TUI required.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyOverlayKey, computeScrollWindow, visibleSlice } from "../../shared/overlay.ts";

describe("classifyOverlayKey", () => {
	it("maps close keys", () => {
		for (const key of ["\x1b", "\r", " ", "q", "\x03"]) {
			assert.equal(classifyOverlayKey(key, { canGoBack: false, canKill: false }), "close");
		}
	});

	it("maps left to back only when canGoBack", () => {
		assert.equal(classifyOverlayKey("\x1b[D", { canGoBack: true, canKill: false }), "back");
		assert.equal(classifyOverlayKey("\x1b[D", { canGoBack: false, canKill: false }), "close");
	});

	it("maps x to kill only when canKill", () => {
		assert.equal(classifyOverlayKey("x", { canGoBack: false, canKill: true }), "kill");
		assert.equal(classifyOverlayKey("x", { canGoBack: false, canKill: false }), null);
	});

	it("maps arrow/page keys to scroll actions", () => {
		assert.equal(classifyOverlayKey("\x1b[A", { canGoBack: false, canKill: false }), "scrollUp");
		assert.equal(classifyOverlayKey("\x1b[B", { canGoBack: false, canKill: false }), "scrollDown");
	});
});

describe("computeScrollWindow", () => {
	it("clamps to [0, maxOffset]", () => {
		const state = computeScrollWindow(100, 20, { offset: 0, follow: false }, -50);
		assert.equal(state.offset, 0);
	});

	it("re-arms follow once scrolled back to the bottom", () => {
		const scrolledUp = computeScrollWindow(100, 20, { offset: 0, follow: true }, -10);
		assert.equal(scrolledUp.follow, false);
		assert.equal(scrolledUp.offset, 70);

		const scrolledBack = computeScrollWindow(100, 20, scrolledUp, 999);
		assert.equal(scrolledBack.follow, true);
		assert.equal(scrolledBack.offset, 80);
	});

	it("follows growth in total lines while follow is on", () => {
		let state = { offset: 0, follow: true };
		state = computeScrollWindow(20, 20, state, 0);
		assert.equal(state.offset, 0);
		state = computeScrollWindow(30, 20, state, 0);
		assert.equal(state.offset, 10);
	});
});

describe("visibleSlice", () => {
	it("returns the trailing window while following", () => {
		const items = Array.from({ length: 50 }, (_, i) => i);
		const slice = visibleSlice(items, 10, { offset: 0, follow: true });
		assert.deepEqual(slice, items.slice(40, 50));
	});

	it("returns the scrolled window when not following", () => {
		const items = Array.from({ length: 50 }, (_, i) => i);
		const slice = visibleSlice(items, 10, { offset: 5, follow: false });
		assert.deepEqual(slice, items.slice(5, 15));
	});
});
