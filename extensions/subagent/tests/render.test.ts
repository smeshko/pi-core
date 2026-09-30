import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createBaseResult } from "../runner.ts";
import { renderSubagentCall, renderSubagentResult } from "../render.ts";
import type { SubagentDetails } from "../types.ts";

// keyHint() reads the global theme, so the collapsed renderers need one initialised.
initTheme();

const theme = {
	fg(_color: string, text: string) {
		return text;
	},
	bg(_color: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
};

function detailsFor(results: any[], mode: SubagentDetails["mode"] = "single"): SubagentDetails {
	return {
		mode,
		agentScope: "both",
		projectAgentsDir: null,
		configFiles: [],
		runtimePolicy: {
			extensions: { mode: "inherit", allow: [] },
			skills: { mode: "inherit", allow: [] },
			promptTemplates: { mode: "inherit", allow: [] },
			contextFiles: "inherit",
		},
		recursion: { allow: false, maxDepth: 4 },
		diagnostics: [],
		results,
		hadRuntimeFailure: false,
	};
}

test("compact render is a one-line summary with an expand hint", () => {
	const result = createBaseResult("scout", "inspect files", "user");
	result.exitCode = 0;
	result.messages.push({
		role: "assistant",
		content: [{ type: "text", text: "Found important files." }],
	});
	result.usage.turns = 1;
	result.usage.input = 1000;
	const component = renderSubagentResult({ content: [], details: detailsFor([result]) }, { expanded: false }, theme, {} as any);
	const output = component.render(100).join("\n");
	assert.match(output, /scout/);
	assert.match(output, /1 turn/);
	assert.match(output, /to expand/);
	// The agent's prose belongs to the expanded view only.
	assert.doesNotMatch(output, /Found important files/);
	assert.equal(output.split("\n").length, 1);
});

test("running render keeps one live progress line", () => {
	const result = createBaseResult("scout", "inspect files", "user");
	result.exitCode = -1;
	result.messages.push({
		role: "assistant",
		content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "ls -la" } }],
	});
	const component = renderSubagentResult({ content: [], details: detailsFor([result]) }, { expanded: false }, theme, {} as any);
	const output = component.render(100).join("\n");
	assert.match(output, /running/);
	assert.match(output, /ls -la/);
});

test("call render is a single header line", () => {
	const component = renderSubagentCall({ agent: "scout", task: "inspect files" } as any, theme, {} as any);
	const output = component.render(100).join("\n");
	assert.match(output, /Subagent/);
	assert.match(output, /scout/);
	assert.equal(output.split("\n").length, 1);
});

test("expanded render includes error details", () => {
	const result = createBaseResult("worker", "do work", "project");
	result.exitCode = 1;
	result.failureKind = "child_error";
	result.errorMessage = "boom";
	const component = renderSubagentResult({ content: [], details: detailsFor([result]) }, { expanded: true }, theme, {} as any);
	const output = component.render(100).join("\n");
	assert.match(output, /Error: boom/);
	assert.match(output, /Task/);
});

test("tool metadata includes promptSnippet and promptGuidelines", async () => {
	const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
	assert.match(source, /promptSnippet:/);
	assert.match(source, /promptGuidelines:/);
	assert.match(source, /Use subagent/);
});
