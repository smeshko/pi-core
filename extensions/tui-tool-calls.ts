import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	formatSize,
	getLanguageFromPath,
	highlightCode,
	keyHint,
	renderDiff,
	withFileMutationQueue,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Type } from "typebox";
import os from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import {
	asNumber,
	asString,
	callHeader,
	displayPath,
	formatDuration,
	lineCount,
	plural,
	shortenPath,
	textComponent,
	textOutput,
	treeLines,
	trimTrailingEmptyLines,
	withLoadedRules,
	type RenderContext,
	type RenderOptions,
	type ToolResult,
} from "./shared/tool-render-style.ts";

const HOME = os.homedir();
const DEFAULT_TEXT_LIMIT = 12;
const SEARCH_TEXT_LIMIT = 18;
const DIFF_TEXT_LIMIT = 90;
const BASH_DESCRIPTION_MIN_LENGTH = 100;

const bashParameters = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	description: Type.String({
		description: "Concise imperative summary of what the command does, at most 12 words",
	}),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

/** Split pipe, semicolon, and && stages while preserving quoted and escaped characters. */
function splitBashPipeline(command: string): string[] | undefined {
	const stages: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;

	for (let index = 0; index < command.length; index++) {
		const char = command[index] ?? "";

		if (char === "\\" && quote !== "'" && index + 1 < command.length) {
			current += char + command[index + 1];
			index++;
			continue;
		}

		if ((char === "'" || char === '"') && (!quote || quote === char)) {
			quote = quote ? undefined : char;
			current += char;
			continue;
		}

		if (!quote && char === "|" && command[index - 1] !== "|" && command[index + 1] !== "|") {
			const stage = current.trim();
			if (stage) stages.push(stage);
			current = "";
			continue;
		}

		if (!quote && char === ";" && command[index - 1] !== ";" && command[index + 1] !== ";") {
			const stage = current.trim();
			if (stage) stages.push(stage);
			current = "";
			continue;
		}

		if (!quote && char === "&" && command[index + 1] === "&") {
			const stage = current.trim();
			if (stage) stages.push(stage);
			current = "";
			index++; // skip second &
			continue;
		}

		current += char;
	}

	const finalStage = current.trim();
	if (finalStage) stages.push(finalStage);
	return stages.length > 1 ? stages : undefined;
}

function isComplexBashCommand(command: string): boolean {
	return command.length >= BASH_DESCRIPTION_MIN_LENGTH || splitBashPipeline(command) !== undefined;
}

function normalizeBashDescription(raw: string): string | undefined {
	const firstLine = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean)
		?.replace(/^description:\s*/i, "")
		.replace(/^["'`]+|["'`.]+$/g, "")
		.trim();
	if (!firstLine) return undefined;
	return firstLine[0]?.toUpperCase() + firstLine.slice(1);
}

function renderComplexBashCall(command: string, description: string | undefined, theme: Theme, context: RenderContext): string {
	const stages = splitBashPipeline(command) ?? [command];
	const lines = [
		callHeader(theme, context, "Bash", description ?? command, description ? "text" : "command"),
		`    ${theme.fg("muted", stages[0] ?? command)}`,
	];
	for (const stage of stages.slice(1)) {
		lines.push(`      ${theme.fg("dim", "→ ")}${theme.fg("muted", stage)}`);
	}
	return lines.join("\n");
}

function pathArg(args: Record<string, unknown> | undefined): string {
	return asString(args?.file_path) ?? asString(args?.path) ?? "";
}

function resolveToolPath(cwd: string, rawPath: string): string {
	let expanded = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	if (expanded === "~") expanded = HOME;
	else if (expanded.startsWith("~/")) expanded = `${HOME}${expanded.slice(1)}`;
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function splitContentLines(text: string): string[] {
	if (!text) return [];
	const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function makeWholeFileDiff(oldContent: string | undefined, newContent: string): string {
	if (oldContent === newContent) return "";
	const oldLines = splitContentLines(oldContent ?? "");
	const newLines = splitContentLines(newContent);
	const width = String(Math.max(oldLines.length, newLines.length, 1)).length;
	const output: string[] = [];
	for (let index = 0; index < oldLines.length; index++) {
		output.push(`-${String(index + 1).padStart(width, " ")} ${oldLines[index]}`);
	}
	for (let index = 0; index < newLines.length; index++) {
		output.push(`+${String(index + 1).padStart(width, " ")} ${newLines[index]}`);
	}
	return output.join("\n");
}


function clippedLines(lines: string[], maxLines: number, theme: Theme, expanded: boolean): string[] {
	const limit = expanded ? lines.length : maxLines;
	const display = lines.slice(0, limit);
	const remaining = lines.length - display.length;
	if (remaining > 0) {
		display.push(theme.fg("dim", `… +${remaining} ${remaining === 1 ? "line" : "lines"} (${keyHint("app.tools.expand", "to expand")})`));
	}
	return display;
}

function highlightedPreview(rawText: string, rawPath: string | undefined, theme: Theme, options: RenderOptions, maxLines = DEFAULT_TEXT_LIMIT, startLine = 1): string[] {
	const normalized = rawText.replace(/\t/g, "   ");
	const rawLines = trimTrailingEmptyLines(normalized.split("\n"));
	if (rawLines.length === 0) return [];

	const limit = options.expanded ? rawLines.length : maxLines;
	const sourceLines = rawLines.slice(0, limit);
	const remaining = rawLines.length - sourceLines.length;
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	const rendered = lang ? highlightCode(sourceLines.join("\n"), lang) : sourceLines.map((line) => theme.fg("toolOutput", line));
	const lastLine = sourceLines.length > 0 ? startLine + sourceLines.length - 1 : startLine;
	const numberWidth = Math.max(String(lastLine).length, 1);
	const numbered = rendered.map((line, index) => {
		const lineNo = String(startLine + index).padStart(numberWidth, " ");
		return `${theme.fg("dim", `${lineNo} │ `)}${line}`;
	});
	if (remaining > 0) {
		numbered.push(theme.fg("dim", `… +${remaining} ${remaining === 1 ? "line" : "lines"} (${keyHint("app.tools.expand", "to expand")})`));
	}
	return numbered;
}

function plainPreview(rawText: string, theme: Theme, options: RenderOptions, maxLines = DEFAULT_TEXT_LIMIT): string[] {
	const rawLines = trimTrailingEmptyLines(rawText.split("\n"));
	return clippedLines(rawLines.map((line) => theme.fg("toolOutput", line)), maxLines, theme, options.expanded);
}

function errorResult(context: RenderContext, result: ToolResult, theme: Theme, action: string): Text {
	const output = textOutput(result).trim() || "Unknown error";
	return textComponent(context, treeLines(theme, `Error ${action}`, plainPreview(output, theme, { expanded: true, isPartial: false }, 50), { error: true }));
}

/** Collapsed rows are a single summary line; the expand hint is only useful when there is a body to reveal. */
function summaryWithHint(parts: string[], hasHiddenBody: boolean, expanded: boolean): string {
	const summary = parts.filter(Boolean).join(" · ");
	return expanded || !hasHiddenBody ? summary : `${summary} (${keyHint("app.tools.expand", "to expand")})`;
}

function isTruncated(result: ToolResult | undefined): boolean {
	return (result?.details?.truncation as Record<string, unknown> | undefined)?.truncated === true;
}

function truncationWarnings(result: ToolResult | undefined, theme: Theme): string[] {
	const details = result?.details ?? {};
	const warnings: string[] = [];
	const truncation = details.truncation as Record<string, unknown> | undefined;
	if (truncation?.truncated === true) {
		const outputLines = asNumber(truncation.outputLines);
		const totalLines = asNumber(truncation.totalLines);
		warnings.push(totalLines && outputLines ? `truncated: showing ${outputLines} of ${totalLines} lines` : "truncated output");
	}
	const fullOutputPath = asString(details.fullOutputPath);
	if (fullOutputPath) warnings.push(`full output: ${displayPath(fullOutputPath)}`);
	return warnings.map((warning) => theme.fg("warning", warning));
}


function renderBashResult(result: ToolResult, options: RenderOptions, theme: Theme, context: RenderContext): Text {
	if (context.isError) return errorResult(context, result, theme, "running command");

	if (context.state.startedAt !== undefined && options.isPartial && !context.state.interval) {
		context.state.interval = setInterval(() => context.state.invalidate?.(), 1000);
	}
	if ((!options.isPartial || context.isError) && context.state.interval) {
		clearInterval(context.state.interval as ReturnType<typeof setInterval>);
		context.state.interval = undefined;
	}
	if (!options.isPartial && context.state.startedAt !== undefined && context.state.endedAt === undefined) {
		context.state.endedAt = Date.now();
	}

	const output = textOutput(result).trim();
	const hasOutput = Boolean(output) && output !== "(no output)";

	const summaryParts: string[] = hasOutput
		? [plural(lineCount(output), "line"), formatSize(Buffer.byteLength(output, "utf8"))]
		: ["No output"];
	const startedAt = asNumber(context.state.startedAt);
	if (startedAt !== undefined) {
		const end = asNumber(context.state.endedAt) ?? Date.now();
		summaryParts.push(`${options.isPartial ? "elapsed " : ""}${formatDuration(end - startedAt)}`);
	}
	if (isTruncated(result)) summaryParts.push(theme.fg("warning", "truncated"));

	const body = options.expanded
		? [...(hasOutput ? plainPreview(output, theme, options, DEFAULT_TEXT_LIMIT) : []), ...truncationWarnings(result, theme)]
		: [];

	return textComponent(context, withLoadedRules(theme, result, treeLines(theme, summaryWithHint(summaryParts, hasOutput, options.expanded), body)));
}

function renderReadResult(result: ToolResult, options: RenderOptions, theme: Theme, context: RenderContext): Text {
	if (context.isError) return errorResult(context, result, theme, "reading file");
	const output = textOutput(result).trimEnd();
	const rawPath = pathArg(context.args);
	if (!output) return textComponent(context, withLoadedRules(theme, result, treeLines(theme, "Read complete")));

	const firstLine = output.split("\n", 1)[0] ?? "";
	const isImage = firstLine.startsWith("Read image file");
	const startLine = asNumber(context.args.offset) ?? 1;

	const body = options.expanded
		? [
				...(isImage
					? plainPreview(output, theme, options, DEFAULT_TEXT_LIMIT)
					: highlightedPreview(output, rawPath, theme, options, DEFAULT_TEXT_LIMIT, startLine)),
				...truncationWarnings(result, theme),
			]
		: [];

	const summaryParts = isImage
		? [firstLine]
		: [plural(lineCount(output), "line"), formatSize(Buffer.byteLength(output, "utf8"))];
	if (isTruncated(result)) summaryParts.push(theme.fg("warning", "truncated"));

	return textComponent(context, withLoadedRules(theme, result, treeLines(theme, summaryWithHint(summaryParts, !isImage, options.expanded), body)));
}

async function executeWriteWithDiff(
	_toolCallId: string,
	params: { path: string; content: string },
	signal: AbortSignal | undefined,
	_onUpdate: unknown,
	ctx: { cwd: string },
) {
	const absolutePath = resolveToolPath(ctx.cwd, params.path);
	const throwIfAborted = () => {
		if (signal?.aborted) throw new Error("Operation aborted");
	};

	return withFileMutationQueue(absolutePath, async () => {
		throwIfAborted();
		let previousContent: string | undefined;
		let existed = false;
		try {
			previousContent = await readFile(absolutePath, "utf8");
			existed = true;
		} catch {
			previousContent = undefined;
		}

		throwIfAborted();
		await mkdir(dirname(absolutePath), { recursive: true });
		throwIfAborted();
		await writeFile(absolutePath, params.content, "utf8");
		throwIfAborted();

		return {
			content: [{ type: "text", text: `Successfully wrote ${params.content.length} bytes to ${params.path}` }],
			details: {
				diff: makeWholeFileDiff(previousContent, params.content),
				existed,
				bytes: Buffer.byteLength(params.content, "utf8"),
				lines: splitContentLines(params.content).length,
			},
		};
	});
}

function renderWriteResult(result: ToolResult, options: RenderOptions, theme: Theme, context: RenderContext): Text {
	if (context.isError) return errorResult(context, result, theme, "writing file");
	const rawPath = pathArg(context.args);
	const content = asString(context.args.content) ?? "";
	const lines = splitContentLines(content).length;
	const byteCount = Buffer.byteLength(content, "utf8");
	const diff = asString(result.details?.diff);
	if (diff) {
		const { added, removed } = countDiffChanges(diff);
		const mode = result.details?.existed === true ? "Updated" : "Created";
		const rendered = renderDiff(diff, { filePath: rawPath || undefined });
		const diffLines = clippedLines(rendered.split("\n"), DIFF_TEXT_LIMIT, theme, options.expanded);
		const changeText = [added > 0 ? `added ${plural(added, "line")}` : undefined, removed > 0 ? `removed ${plural(removed, "line")}` : undefined]
			.filter(Boolean)
			.join(", ");
		return textComponent(context, withLoadedRules(theme, result, treeLines(theme, `${mode} file${changeText ? ` — ${changeText}` : ""}`, diffLines)));
	}

	const body = content ? highlightedPreview(content, rawPath, theme, options, DEFAULT_TEXT_LIMIT, 1) : [];
	const summary = `Wrote ${lines === 0 ? "empty file" : plural(lines, "line")} (${byteCount} bytes)`;
	return textComponent(context, withLoadedRules(theme, result, treeLines(theme, summary, body)));
}

function countDiffChanges(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

function renderEditResult(result: ToolResult, options: RenderOptions, theme: Theme, context: RenderContext): Text {
	if (context.isError) return errorResult(context, result, theme, "editing file");
	const rawPath = pathArg(context.args);
	const diff = asString(result.details?.diff);
	if (!diff) {
		const output = textOutput(result).trim();
		return textComponent(context, withLoadedRules(theme, result, treeLines(theme, output || `Updated ${shortenPath(rawPath)}`)));
	}

	const { added, removed } = countDiffChanges(diff);
	const summaryParts: string[] = [];
	if (added > 0) summaryParts.push(`added ${plural(added, "line")}`);
	if (removed > 0) summaryParts.push(`removed ${plural(removed, "line")}`);
	const summary = summaryParts.length > 0 ? summaryParts.join(", ") : "Updated file";
	const rendered = renderDiff(diff, { filePath: rawPath || undefined });
	const diffLines = clippedLines(rendered.split("\n"), DIFF_TEXT_LIMIT, theme, options.expanded);
	return textComponent(context, withLoadedRules(theme, result, treeLines(theme, summary[0]?.toUpperCase() + summary.slice(1), diffLines)));
}

function renderSearchLikeResult(
	result: ToolResult,
	options: RenderOptions,
	theme: Theme,
	context: RenderContext,
	kind: "search" | "find" | "list",
): Text {
	if (context.isError) return errorResult(context, result, theme, kind === "search" ? "searching" : kind === "find" ? "finding files" : "listing directory");
	const output = textOutput(result).trim();
	const count = output ? lineCount(output) : 0;

	let summary: string;
	let hasBody = count > 0;
	if (/^no (matches|files)/i.test(output)) {
		summary = output;
		hasBody = false;
	} else if (/empty directory/i.test(output)) {
		summary = "Empty directory";
		hasBody = false;
	} else if (kind === "search") summary = `Found ${plural(count, "match", "matches")}`;
	else if (kind === "find") summary = `Found ${plural(count, "path")}`;
	else summary = `Listed ${plural(count, "entry", "entries")}`;

	const summaryParts = [summary];
	if (isTruncated(result)) summaryParts.push(theme.fg("warning", "truncated"));

	const body = options.expanded
		? [...(output ? plainPreview(output, theme, options, SEARCH_TEXT_LIMIT) : []), ...truncationWarnings(result, theme)]
		: [];

	return textComponent(context, withLoadedRules(theme, result, treeLines(theme, summaryWithHint(summaryParts, hasBody, options.expanded), body)));
}

function registerClaudeToolRenderers(pi: ExtensionAPI) {
	const cwd = process.cwd();
	const bash = createBashToolDefinition(cwd);
	const read = createReadToolDefinition(cwd);
	const write = createWriteToolDefinition(cwd);
	const edit = createEditToolDefinition(cwd);
	const grep = createGrepToolDefinition(cwd);
	const find = createFindToolDefinition(cwd);
	const ls = createLsToolDefinition(cwd);

	pi.registerTool({
		...bash,
		label: "Bash",
		parameters: bashParameters,
		promptGuidelines: [
			...(bash.promptGuidelines ?? []),
			"For every bash call, provide a concise imperative description of at most 12 words.",
		],
		renderShell: "self",
		renderCall(args, theme, context) {
			const renderContext = context as unknown as RenderContext;
			renderContext.state.invalidate = context.invalidate;
			if (context.executionStarted && renderContext.state.startedAt === undefined) {
				renderContext.state.startedAt = Date.now();
				renderContext.state.endedAt = undefined;
			}

			const command = asString(args.command) ?? "";
			const description = normalizeBashDescription(asString(args.description) ?? "");
			const rendered = isComplexBashCommand(command)
				? renderComplexBashCall(command, description, theme, renderContext)
				: callHeader(theme, renderContext, "Bash", command, "command");
			return textComponent(renderContext, rendered);
		},
		renderResult(result, options, theme, context) {
			return renderBashResult(result as ToolResult, options, theme, context as unknown as RenderContext);
		},
	});

	pi.registerTool({
		...read,
		label: "Read",
		renderShell: "self",
		renderCall(args, theme, context) {
			const rawPath = pathArg(args as Record<string, unknown>);
			const offset = asNumber((args as Record<string, unknown>).offset);
			const limit = asNumber((args as Record<string, unknown>).limit);
			const range = offset !== undefined || limit !== undefined ? `:${offset ?? 1}${limit ? `-${(offset ?? 1) + limit - 1}` : ""}` : "";
			const renderContext = context as unknown as RenderContext;
			return textComponent(renderContext, callHeader(theme, renderContext, "Read", `${displayPath(rawPath, renderContext.cwd)}${range}`, "text"));
		},
		renderResult(result, options, theme, context) {
			return renderReadResult(result as ToolResult, options, theme, context as unknown as RenderContext);
		},
	});

	pi.registerTool({
		...write,
		label: "Write",
		renderShell: "self",
		execute: executeWriteWithDiff as typeof write.execute,
		renderCall(args, theme, context) {
			return textComponent(context as unknown as RenderContext, callHeader(theme, context as unknown as RenderContext, "Write", pathArg(args as Record<string, unknown>), "path"));
		},
		renderResult(result, options, theme, context) {
			return renderWriteResult(result as ToolResult, options, theme, context as unknown as RenderContext);
		},
	});

	pi.registerTool({
		...edit,
		label: "Update",
		renderShell: "self",
		renderCall(args, theme, context) {
			return textComponent(context as unknown as RenderContext, callHeader(theme, context as unknown as RenderContext, "Update", pathArg(args as Record<string, unknown>), "path"));
		},
		renderResult(result, options, theme, context) {
			return renderEditResult(result as ToolResult, options, theme, context as unknown as RenderContext);
		},
	});

	pi.registerTool({
		...grep,
		label: "Search",
		renderShell: "self",
		renderCall(args, theme, context) {
			const renderContext = context as unknown as RenderContext;
			const pattern = asString(args.pattern) ?? "";
			const path = displayPath(asString(args.path) || ".", renderContext.cwd);
			return textComponent(renderContext, callHeader(theme, renderContext, "Search", `${pattern} in ${path}`, "text"));
		},
		renderResult(result, options, theme, context) {
			return renderSearchLikeResult(result as ToolResult, options, theme, context as unknown as RenderContext, "search");
		},
	});

	pi.registerTool({
		...find,
		label: "Find",
		renderShell: "self",
		renderCall(args, theme, context) {
			const renderContext = context as unknown as RenderContext;
			const pattern = asString(args.pattern) ?? "";
			const path = displayPath(asString(args.path) || ".", renderContext.cwd);
			return textComponent(renderContext, callHeader(theme, renderContext, "Find", `${pattern} in ${path}`, "text"));
		},
		renderResult(result, options, theme, context) {
			return renderSearchLikeResult(result as ToolResult, options, theme, context as unknown as RenderContext, "find");
		},
	});

	pi.registerTool({
		...ls,
		label: "List",
		renderShell: "self",
		renderCall(args, theme, context) {
			return textComponent(context as unknown as RenderContext, callHeader(theme, context as unknown as RenderContext, "List", asString(args.path) || ".", "path"));
		},
		renderResult(result, options, theme, context) {
			return renderSearchLikeResult(result as ToolResult, options, theme, context as unknown as RenderContext, "list");
		},
	});
}

export default function claudeToolCalls(pi: ExtensionAPI) {
	registerClaudeToolRenderers(pi);
}
