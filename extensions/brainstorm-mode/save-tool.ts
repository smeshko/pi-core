/**
 * `brainstorm_save` - the single write primitive available in brainstorm mode.
 *
 * The model never gets a general write tool. It gets this: a path-clamped writer
 * that can only produce `.agents/brainstorms/<date>-<slug>.md`. Path resolution
 * and the actual `writeFile` happen here, in extension code, from a sanitized
 * slug - the model supplies content and a name, never a path.
 *
 * It is an *upsert*. The first call in a brainstorm segment pins the file; every
 * later call rewrites that same file, so the document grows with the discussion
 * instead of littering the directory with snapshots.
 *
 * Rendering follows the house style from shared/tool-render-style.ts:
 *   ● BrainstormSave(2026-06-11-tab-modes.md)
 *   └─ Updated · 5 sections · 82 lines (ctrl+o to expand)
 */

import { keyHint, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import {
	callHeader,
	clippedLines,
	displayPath,
	lineCount,
	plural,
	textComponent,
	treeLines,
	type RenderContext,
	type ToolResult,
} from "../shared/tool-render-style.ts";

export const BRAINSTORM_DIR = path.join(".agents", "brainstorms");

const ParamsSchema = Type.Object({
	slug: Type.String({
		description:
			"Short kebab-case name for this brainstorm, e.g. 'tab-mode-switching'. Only used for the first call; later calls rewrite the same file.",
	}),
	markdown: Type.String({
		description:
			"The COMPLETE current state of the brainstorm document as markdown - not a diff or an appendix. Include: problem framing, options considered with trade-offs, decisions settled so far, discarded ideas and why, open questions.",
	}),
});

export interface BrainstormSaveDetails {
	file?: string;
	relPath?: string;
	sections?: string[];
	lines?: number;
	created?: boolean;
	error?: string;
}

/** kebab-case, filesystem-safe, length-capped. The model cannot escape the directory. */
export function sanitizeSlug(raw: string): string {
	const slug = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return slug || "brainstorm";
}

export function todayStamp(now = new Date()): string {
	return now.toISOString().slice(0, 10);
}

/** Top-level markdown headings, for the collapsed summary. */
function extractSections(markdown: string): string[] {
	return markdown
		.split("\n")
		.filter((line) => /^#{1,3}\s+\S/.test(line))
		.map((line) => line.replace(/^#+\s+/, "").trim())
		.slice(0, 12);
}

export interface SaveHooks {
	/**
	 * The file already pinned for this brainstorm segment, if any. Returning a path
	 * here makes the tool an upsert; returning undefined starts a new document.
	 */
	getPinnedFile?: () => { absPath: string; relPath: string } | undefined;
	/** Called after a successful save so the mode can pin and track the artifact. */
	onSaved?: (file: { absPath: string; relPath: string }) => void;
}

export function registerBrainstormSaveTool(pi: ExtensionAPI, hooks: SaveHooks = {}): void {
	pi.registerTool({
		name: "brainstorm_save",
		label: "Brainstorm Save",
		description:
			`Create or update the running brainstorm document at ${BRAINSTORM_DIR}/<date>-<slug>.md. ` +
			"This is the only way to persist anything from brainstorm mode. Call it early - as soon as " +
			"the problem is framed - and again after every round of questions or whenever a decision " +
			"settles, passing the complete updated document each time. The first call fixes the " +
			"filename; later calls overwrite that same file.",
		promptSnippet: "Create or update the running brainstorm document (brainstorm mode only).",
		parameters: ParamsSchema,
		renderShell: "self",
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const pinned = hooks.getPinnedFile?.();
			const fileName = `${todayStamp()}-${sanitizeSlug(params.slug)}.md`;
			const absPath = pinned?.absPath ?? path.join(ctx.cwd, BRAINSTORM_DIR, fileName);
			const relPath = pinned?.relPath ?? path.join(BRAINSTORM_DIR, fileName);

			try {
				await mkdir(path.dirname(absPath), { recursive: true });
				const body = params.markdown.endsWith("\n") ? params.markdown : `${params.markdown}\n`;
				await writeFile(absPath, body, "utf8");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Failed to save brainstorm: ${message}` }],
					isError: true,
					details: { error: message } satisfies BrainstormSaveDetails,
				};
			}

			hooks.onSaved?.({ absPath, relPath });

			return {
				content: [
					{ type: "text", text: `${pinned ? "Updated" : "Created"} brainstorm document at ${relPath}` },
				],
				details: {
					file: absPath,
					relPath,
					sections: extractSections(params.markdown),
					lines: lineCount(params.markdown),
					created: pinned === undefined,
				} satisfies BrainstormSaveDetails,
			};
		},

		renderCall(args, theme, context) {
			const renderContext = context as unknown as RenderContext;
			const pinned = hooks.getPinnedFile?.();
			const slug = typeof args.slug === "string" ? sanitizeSlug(args.slug) : "";
			const name = pinned ? path.basename(pinned.relPath) : slug ? `${todayStamp()}-${slug}.md` : "…";
			return textComponent(renderContext, callHeader(theme, renderContext, "BrainstormSave", name));
		},

		renderResult(result, options, theme, context) {
			const renderContext = context as unknown as RenderContext;
			const details = result.details as BrainstormSaveDetails | undefined;

			if (renderContext.isError || details?.error) {
				return textComponent(
					renderContext,
					treeLines(theme, "Error saving brainstorm", [theme.fg("toolOutput", details?.error ?? "Unknown error")], {
						error: true,
					}),
				);
			}

			return textComponent(
				renderContext,
				treeLines(
					theme,
					summary(theme, details, options.expanded),
					options.expanded ? body(theme, details, renderContext) : [],
				),
			);
		},
	});
}

function summary(theme: Theme, details: BrainstormSaveDetails | undefined, expanded: boolean): string {
	const parts = [details?.created === false ? "Updated" : "Created"];
	const sections = details?.sections?.length ?? 0;
	if (sections > 0) parts.push(plural(sections, "section"));
	if (details?.lines) parts.push(plural(details.lines, "line"));

	const text = parts.join(theme.fg("muted", " · "));
	return expanded || sections === 0 ? text : `${text} (${keyHint("app.tools.expand", "to expand")})`;
}

function body(
	theme: Theme,
	details: BrainstormSaveDetails | undefined,
	context: RenderContext,
): string[] {
	const lines: string[] = [];
	if (details?.relPath) {
		lines.push(theme.fg("accent", displayPath(details.file ?? details.relPath, context.cwd)));
	}
	const sections = (details?.sections ?? []).map((section) => theme.fg("toolOutput", section));
	lines.push(...clippedLines(sections, 12, theme, true));
	return lines;
}
