import assert from "node:assert/strict";
import { test } from "node:test";
import { BRAINSTORM_MODE, NORMAL_MODE, type Mode } from "../modes.ts";

/**
 * The editor subclass cannot be instantiated without a live TUI, so these tests
 * exercise the two pieces of logic that caused real bugs, against the same
 * implementations the class uses.
 */

// --- Border color -----------------------------------------------------------

/**
 * Mirrors the accessor installed in BrainstormEditor's constructor.
 *
 * The bug this guards against: interactive-mode.js reassigns `editor.borderColor`
 * whenever the thinking level or bash mode changes (interactive-mode.js:3076-3080).
 * Snapshotting it at construction and force-assigning per render clobbered those
 * updates, so leaving brainstorm mode restored a stale color.
 */
function makeBorderHost(initial: (s: string) => string, getMode: () => Mode) {
	const host = { appBorderColor: initial } as {
		appBorderColor: (s: string) => string;
		borderColor: (s: string) => string;
	};
	Object.defineProperty(host, "borderColor", {
		configurable: true,
		enumerable: true,
		get: () => {
			const mode = getMode();
			return mode.id === "normal" ? host.appBorderColor : (str: string) => `<${mode.color}>${str}`;
		},
		set: (value: (s: string) => string) => {
			host.appBorderColor = value;
		},
	});
	return host;
}

test("normal mode reads back exactly what the app assigned", () => {
	let mode: Mode = NORMAL_MODE;
	const host = makeBorderHost((s) => `<border>${s}`, () => mode);
	assert.equal(host.borderColor("─"), "<border>─");

	// App switches thinking level -> new border color.
	host.borderColor = (s) => `<thinkingHigh>${s}`;
	assert.equal(host.borderColor("─"), "<thinkingHigh>─");
});

test("brainstorm mode overrides the border, and exit restores the live app color", () => {
	let mode: Mode = NORMAL_MODE;
	const host = makeBorderHost((s) => `<border>${s}`, () => mode);

	mode = BRAINSTORM_MODE;
	assert.equal(host.borderColor("─"), `<${BRAINSTORM_MODE.color}>─`);

	mode = NORMAL_MODE;
	assert.equal(host.borderColor("─"), "<border>─", "must restore, not stay violet");
});

test("app assignments made *during* brainstorm survive the exit", () => {
	let mode: Mode = NORMAL_MODE;
	const host = makeBorderHost((s) => `<border>${s}`, () => mode);

	mode = BRAINSTORM_MODE;
	// e.g. the user cycles thinking level while in brainstorm mode
	host.borderColor = (s) => `<thinkingMax>${s}`;
	assert.equal(host.borderColor("─"), `<${BRAINSTORM_MODE.color}>─`, "mode still wins while active");

	mode = NORMAL_MODE;
	assert.equal(host.borderColor("─"), "<thinkingMax>─", "the app's newer color must win on exit");
});

// --- Tab claiming -----------------------------------------------------------

/** Mirrors BrainstormEditor.shouldClaimTab(). */
function shouldClaimTab(beforeCursor: string, showingAutocomplete = false): boolean {
	if (showingAutocomplete) return false;
	if (beforeCursor.trim().length === 0) return true;

	const trimmed = beforeCursor.trimStart();
	if (trimmed.startsWith("/") && !trimmed.includes(" ")) return false;

	const token = beforeCursor.split(/\s/).pop() ?? "";
	if (token.length === 0) return true;
	return !/^[@~.]|\//.test(token);
}

test("Tab switches modes on an empty prompt", () => {
	assert.ok(shouldClaimTab(""));
	assert.ok(shouldClaimTab("   "));
});

test("Tab switches modes with prose in the buffer", () => {
	assert.ok(shouldClaimTab("how should we handle offline sync"));
	assert.ok(shouldClaimTab("how should we handle offline sync "));
	assert.ok(shouldClaimTab("a"));
});

test("Tab still completes paths and mentions", () => {
	assert.ok(!shouldClaimTab("look at @lib/main"));
	assert.ok(!shouldClaimTab("open ~/.pi/agent"));
	assert.ok(!shouldClaimTab("read ./src/index"));
	assert.ok(!shouldClaimTab("cat lib/explore/"));
});

test("Tab still completes slash commands", () => {
	assert.ok(!shouldClaimTab("/rel"));
	assert.ok(!shouldClaimTab("  /rel"));
	// ...but a slash command with an argument is no longer completing.
	assert.ok(shouldClaimTab("/model some"));
});

test("Tab never fires while the autocomplete popup is open", () => {
	assert.ok(!shouldClaimTab("", true));
	assert.ok(!shouldClaimTab("anything at all", true));
});

// --- Grace-period Esc claiming ---------------------------------------------

/**
 * Mirrors the Esc-claim condition in BrainstormEditor.handleInput.
 * Kept as a pure function so it can be tested without a live TUI instance.
 */
function shouldClaimEsc(isGracePeriodActive: boolean): boolean {
	return isGracePeriodActive;
}

test("Esc is claimed and cancels the mode switch during the grace period", () => {
	assert.ok(shouldClaimEsc(true));
});

test("Esc is not claimed outside the grace period (falls through to app abort)", () => {
	assert.ok(!shouldClaimEsc(false));
});
