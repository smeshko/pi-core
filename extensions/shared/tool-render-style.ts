import * as os from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

export type RenderContext = {
	args: Record<string, unknown>;
	lastComponent?: unknown;
	state: Record<string, unknown>;
	isPartial: boolean;
	isError: boolean;
	executionStarted: boolean;
	expanded: boolean;
	showImages: boolean;
	cwd?: string;
};

export type ToolResult = {
	content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: Record<string, unknown>;
};

export type RenderOptions = {
	expanded: boolean;
	isPartial: boolean;
};

const HOME = os.homedir();

export function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function shortenPath(value: string): string {
	if (!value) return "...";
	return value.startsWith(HOME) ? `~${value.slice(HOME.length)}` : value;
}

export function compactPath(value: string, maxLength = 72): string {
	if (value.length <= maxLength) return value;

	const parts = value.split("/").filter(Boolean);
	if (parts.length <= 2) return value.length <= maxLength ? value : `…${value.slice(-(maxLength - 1))}`;

	const prefix = value.startsWith("~/") ? "~" : value.startsWith("/") ? "/" : parts[0] ?? "";
	const suffixParts: string[] = [];
	for (let index = parts.length - 1; index >= 0; index--) {
		suffixParts.unshift(parts[index] ?? "");
		const candidate = `${prefix}${prefix.endsWith("/") ? "" : "/"}…/${suffixParts.join("/")}`;
		if (candidate.length > maxLength) {
			suffixParts.shift();
			break;
		}
	}

	const compacted = `${prefix}${prefix.endsWith("/") ? "" : "/"}…/${suffixParts.join("/")}`;
	return compacted.length <= maxLength ? compacted : `…/${parts[parts.length - 1] ?? value.slice(-maxLength + 2)}`;
}

export function displayUrl(urlText: string, maxWidth = 72): string {
	try {
		const url = new URL(urlText);
		const path = `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
		return truncateToWidth(path, maxWidth);
	} catch {
		return truncateToWidth(urlText || "...", maxWidth);
	}
}

export function displayPath(rawPath: string, cwd?: string): string {
	if (!rawPath) return "...";
	let cleaned = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	if (cleaned === "~") cleaned = HOME;
	else if (cleaned.startsWith("~/")) cleaned = `${HOME}${cleaned.slice(1)}`;

	let display = cleaned;
	try {
		const absolute = isAbsolute(cleaned) ? cleaned : cwd ? resolve(cwd, cleaned) : undefined;
		if (absolute && cwd) {
			const rel = relative(cwd, absolute);
			if (rel === "") display = ".";
			else if (!rel.startsWith("..") && !isAbsolute(rel)) display = rel;
			else display = shortenPath(absolute);
		} else {
			display = shortenPath(cleaned);
		}
	} catch {
		display = shortenPath(cleaned);
	}

	return compactPath(display);
}

export function compactPathsInText(value: string, cwd?: string): string {
	return value.replace(/(^|[\s"'`(])((?:~|\/)[^\s"'`()]+)/g, (_match, prefix: string, candidate: string) => {
		const trailing = candidate.match(/[),.;:]+$/)?.[0] ?? "";
		const core = trailing ? candidate.slice(0, -trailing.length) : candidate;
		return `${prefix}${displayPath(core, cwd)}${trailing}`;
	});
}

export function plainTruncate(value: string, max = 116): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	if (singleLine.length <= max) return singleLine;
	const tailLength = Math.min(32, Math.floor(max / 3));
	const headLength = Math.max(1, max - tailLength - 1);
	return `${singleLine.slice(0, headLength)}…${singleLine.slice(-tailLength)}`;
}

export function textOutput(result: ToolResult | undefined): string {
	return (result?.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n")
		.replace(/\r/g, "");
}

export function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end--;
	return lines.slice(0, end);
}

export function lineCount(text: string): number {
	const lines = trimTrailingEmptyLines(text.split("\n"));
	return lines.length;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function statusDot(theme: Theme, context: Pick<RenderContext, "isError" | "isPartial" | "executionStarted">): string {
	if (context.isError) return theme.fg("error", "●");
	if (context.isPartial && context.executionStarted) return theme.fg("warning", "●");
	if (context.isPartial) return theme.fg("dim", "●");
	return theme.fg("success", "●");
}

export function callHeader(theme: Theme, context: RenderContext, label: string, arg?: string, argKind: "path" | "command" | "text" = "text") {
	const styledArg = !arg
		? ""
		: argKind === "path"
			? theme.fg("accent", displayPath(arg, context.cwd))
			: argKind === "command"
				? theme.fg("text", plainTruncate(compactPathsInText(arg, context.cwd)))
				: theme.fg("accent", arg);

	return [
		statusDot(theme, context),
		" ",
		theme.fg("toolTitle", theme.bold(label)),
		theme.fg("muted", "("),
		styledArg,
		theme.fg("muted", ")"),
	].join("");
}

export function textComponent(context: Pick<RenderContext, "lastComponent">, text: string): Text {
	const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	component.setText(text);
	return component;
}

export function treeLines(theme: Theme, summary: string, body: string[] = [], options?: { error?: boolean; warning?: boolean }): string {
	const color = options?.error ? "error" : options?.warning ? "warning" : "text";
	const lines = [`${theme.fg("dim", "└─ ")}${theme.fg(color, summary)}`];
	for (const line of body) lines.push(`${theme.fg("dim", "   ")}${line}`);
	return lines.join("\n");
}

/**
 * Appends a `└─ Loaded <path>` line for every module rule file the nested-agents
 * extension attached to this result. Kept in the shared helper so all tool rows
 * report it identically.
 */
export function withLoadedRules(theme: Theme, result: ToolResult | undefined, rendered: string): string {
	const loadedRules = result?.details?.loadedRules;
	if (!Array.isArray(loadedRules) || loadedRules.length === 0) return rendered;

	const lines = loadedRules
		.filter((value): value is string => typeof value === "string")
		.map((relPath) => `${theme.fg("dim", "└─ ")}${theme.fg("success", `Loaded ${theme.bold(relPath)}`)}`);

	return [rendered, ...lines].join("\n");
}

export function clippedLines(lines: string[], maxLines: number, theme: Theme, expanded: boolean): string[] {
	const limit = expanded ? lines.length : maxLines;
	const display = lines.slice(0, limit);
	const remaining = lines.length - display.length;
	if (remaining > 0) display.push(theme.fg("dim", `… +${remaining} ${remaining === 1 ? "line" : "lines"}`));
	return display;
}

export function formatDuration(ms: number): string {
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
