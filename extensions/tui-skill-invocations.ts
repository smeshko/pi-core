import { formatSize, keyHint, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { clippedLines, treeLines } from "./shared/tool-render-style.ts";

/**
 * Renders skill invocations (`/skill:name`) with the same visual language as tool calls
 * instead of the built-in highlighted `[skill]` block.
 *
 * The `input` event is intercepted before pi's own skill expansion, the skill body is
 * expanded here, and the result is injected as a custom message with a tool-style renderer.
 */

const CUSTOM_TYPE = "skill-invocation";
const EXPANDED_BODY_LINES = 400;

interface SkillInvocationDetails {
	name: string;
	filePath: string;
	baseDir: string;
	args?: string;
	body: string;
}

function stripFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
	return match ? content.slice(match[0].length) : content;
}

function bodyLines(body: string): string[] {
	const lines = body.replace(/\r\n/g, "\n").split("\n");
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function skillHeader(theme: Theme, name: string): string {
	return [
		theme.fg("success", "●"),
		" ",
		theme.fg("toolTitle", theme.bold("Skill")),
		theme.fg("muted", "("),
		theme.fg("accent", name),
		theme.fg("muted", ")"),
	].join("");
}

function renderSkillMessage(details: SkillInvocationDetails, expanded: boolean, theme: Theme): string {
	const lines = bodyLines(details.body);
	const summaryParts = [
		`${lines.length} ${lines.length === 1 ? "line" : "lines"}`,
		formatSize(Buffer.byteLength(details.body, "utf-8")),
	];
	if (details.args) summaryParts.push(theme.fg("muted", details.args.replace(/\s+/g, " ").trim().slice(0, 60)));
	const summary = summaryParts.join(" · ");
	const hint = expanded ? "" : ` (${keyHint("app.tools.expand", "to expand")})`;

	const body = expanded ? clippedLines(lines.map((line) => theme.fg("muted", line)), EXPANDED_BODY_LINES, theme, false) : [];

	return [skillHeader(theme, details.name), treeLines(theme, `${summary}${hint}`, body)].join("\n");
}

export default function skillRenderExtension(pi: ExtensionAPI) {
	pi.registerMessageRenderer<SkillInvocationDetails>(CUSTOM_TYPE, (message, options, theme) => {
		const details = message.details;
		if (!details) return undefined;
		return new Text(renderSkillMessage(details, options.expanded, theme), options.outputPad ?? 0, 0);
	});

	pi.on("input", async (event, ctx) => {
		const text = event.text ?? "";
		// Only the TUI renders messages; print/rpc modes keep pi's own expansion.
		if (ctx.mode !== "tui" || !ctx.hasUI) return { action: "continue" as const };
		if (!text.startsWith("/skill:")) return { action: "continue" as const };

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
		if (!skillName) return { action: "continue" as const };

		const command = pi.getCommands().find((entry) => entry.source === "skill" && entry.name === `skill:${skillName}`);
		if (!command) return { action: "continue" as const }; // Unknown skill: let pi handle it.

		const filePath = command.sourceInfo.path;
		const baseDir = command.sourceInfo.baseDir ?? dirname(filePath);

		let body: string;
		try {
			body = stripFrontmatter(await readFile(filePath, "utf-8")).trim();
		} catch {
			return { action: "continue" as const }; // Fall back to pi's expansion (and its error reporting).
		}

		const skillBlock = `<skill name="${skillName}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
		const content = args ? `${skillBlock}\n\n${args}` : skillBlock;

		pi.sendMessage(
			{
				customType: CUSTOM_TYPE,
				content,
				display: true,
				details: { name: skillName || basename(baseDir), filePath, baseDir, args: args || undefined, body },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);

		return { action: "handled" as const };
	});
}
