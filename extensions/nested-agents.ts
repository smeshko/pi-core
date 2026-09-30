/**
 * Loads AGENTS.md / CLAUDE.md files from subdirectories, which pi's own context
 * discovery (which only walks *up* from cwd) never sees.
 *
 * Rules are delivered through `tool_result`, appended to the result of the tool
 * call that touched the directory, so they arrive inside the same turn as the
 * decision. They deliberately are not added to the system prompt.
 *
 * Mutating tools additionally block once per module, so an edit can never be the
 * first thing that happens in a directory whose rules have not been read.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	announceOnce,
	blockReason,
	discoverRuleFiles,
	discoveredCount,
	discoveredPaths,
	injectedPaths,
	isReady,
	markInjected,
	pending,
	rulesForPath,
	rulesForText,
	rulesMessage,
	skipReason,
	type RuleFile,
} from "./shared/nested-agents.ts";

/** Tools whose `path` argument names a file. */
const FILE_PATH_TOOLS = new Set(["read", "write", "edit"]);
/** Tools whose `path` argument names a directory to search or list. */
const DIR_PATH_TOOLS = new Set(["grep", "find", "ls"]);
/** Tools that mutate the repo, where rules must arrive before execution. */
const MUTATION_TOOLS = new Set(["write", "edit"]);

/** Set `PI_NESTED_AGENTS_BLOCK=0` to make every delivery advisory. */
const BLOCK_ON_MUTATION = process.env.PI_NESTED_AGENTS_BLOCK !== "0";

function pathOf(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;
	const value = record.path ?? record.file_path;
	return typeof value === "string" && value ? value : undefined;
}

/**
 * Rule files relevant to a tool call.
 *
 * Path-carrying tools resolve exactly. Everything else (bash, subagent, MCP) is
 * matched by testing the small, known set of rule directories against the
 * serialised arguments.
 */
function rulesForCall(toolName: string, input: unknown): RuleFile[] {
	if (FILE_PATH_TOOLS.has(toolName) || DIR_PATH_TOOLS.has(toolName)) {
		const raw = pathOf(input);
		return raw ? rulesForPath(raw) : [];
	}

	try {
		return rulesForText(JSON.stringify(input ?? ""));
	} catch {
		return [];
	}
}

/** Reading a rule file is its own delivery; do not echo the content back. */
function isSelfRead(toolName: string, input: unknown, files: RuleFile[]): RuleFile[] {
	if (toolName !== "read") return [];
	const raw = pathOf(input);
	if (!raw) return [];
	return files.filter((file) => raw === file.absPath || raw.endsWith(file.relPath));
}

export default function nestedAgents(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const options = (ctx as { getSystemPromptOptions?: () => { contextFiles?: Array<{ path: string }> } }).getSystemPromptOptions?.();
		const loaded = (options?.contextFiles ?? []).map((file) => file.path);
		try {
			discoverRuleFiles(process.cwd(), loaded);
		} catch {
			// A failed walk must never stop the session from starting.
		}
	});

	// Mutations are the point where a missed rule turns into bad code, so the rules
	// are pushed in front of the model before the tool runs rather than after.
	pi.on("tool_call", async (event) => {
		if (!BLOCK_ON_MUTATION || !isReady()) return;
		if (!MUTATION_TOOLS.has(event.toolName)) return;

		const undelivered = pending(rulesForCall(event.toolName, event.input));
		if (undelivered.length === 0) return;

		const fresh = announceOnce(undelivered);
		if (fresh.length === 0) return;

		return { block: true, reason: blockReason(fresh) };
	});

	pi.on("tool_result", async (event) => {
		if (!isReady() || event.isError) return;

		const candidates = rulesForCall(event.toolName, event.input);
		if (candidates.length === 0) return;

		const undelivered = pending(candidates);
		if (undelivered.length === 0) return;

		// The agent just read the rule file itself: record it, but do not duplicate it.
		const selfRead = isSelfRead(event.toolName, event.input, undelivered);
		if (selfRead.length > 0) {
			markInjected(selfRead);
			const relPaths = selfRead.map((file) => file.relPath);
			return { details: { ...(event.details as Record<string, unknown>), loadedRules: relPaths } };
		}

		const delivered = markInjected(undelivered);
		if (delivered.length === 0) return;

		return {
			content: [...(event.content ?? []), { type: "text" as const, text: rulesMessage(delivered) }],
			details: { ...(event.details as Record<string, unknown>), loadedRules: delivered.map((file) => file.relPath) },
		};
	});


	pi.registerCommand("rules", {
		description: "Show module-scoped AGENTS.md files discovered below cwd and which are loaded",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const skipped = skipReason();
			if (skipped) {
				ctx.ui.notify(`Nested rule discovery skipped: ${skipped}.`, "info");
				return;
			}
			const loaded = new Set(injectedPaths());
			const lines = discoveredPaths().map((relPath) => `${loaded.has(relPath) ? "✓" : "·"} ${relPath}`);
			ctx.ui.notify([`${discoveredCount()} discovered, ${loaded.size} loaded`, ...lines].join("\n"), "info");
		},
	});
}
