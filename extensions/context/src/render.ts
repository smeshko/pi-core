import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { CategoryKey, ContextReport } from "./collect.ts";

const GRID_COLS = 26;
const GRID_ROWS = 12;
const GRID_CELLS = GRID_COLS * GRID_ROWS;
const FILLED = "■";
const EMPTY = "□";

type ColorName = Parameters<Theme["fg"]>[0];

const CATEGORY_COLOR: Record<CategoryKey, ColorName> = {
	system: "accent",
	tools: "success",
	mcp: "warning",
	files: "mdLink",
	skills: "syntaxKeyword",
	messages: "userMessageText",
};

export function formatTokens(value: number): string {
	if (!Number.isFinite(value)) return "?";
	if (value < 1000) return `${Math.round(value)}`;
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(2)}M`;
}

function percent(part: number, whole: number): string {
	if (whole <= 0) return "0.0%";
	return `${((part / whole) * 100).toFixed(1)}%`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

const SCOPE_LABELS: Record<string, string> = {
	project: "Project",
	user: "User",
	temporary: "Temporary",
};
const SCOPE_ORDER = ["project", "user", "temporary"];

/** `name: ~120 tokens` with the amount muted, matching the extensions section. */
function labelledAmount(theme: Theme, label: string, amount: string): string {
	return `${theme.fg("text", label)}${theme.fg("dim", ":")} ${theme.fg("muted", amount)}`;
}

/** Drop the `.ts` suffix / trailing `/` so file- and directory-backed extensions read the same. */
function extensionDisplayName(name: string): string {
	return name.replace(/\/$/, "").replace(/\.ts$/, "");
}

type ExtensionRow = { name: string; capability: string; commands: string; weight: number; tools: number };

function extensionRow(extension: ContextReport["extensions"][number]): ExtensionRow {
	const capabilityParts: string[] = [];
	if (extension.tools > 0) capabilityParts.push(plural(extension.tools, "tool"));
	if (extension.mcpTools > 0) capabilityParts.push(`${extension.mcpTools} MCP`);
	const hasCapability = capabilityParts.length > 0;
	// Sort by what an extension contributes: tools first, then command-only, then hook-only.
	const weight = hasCapability ? 2 : extension.commands.length > 0 ? 1 : 0;
	return {
		name: extensionDisplayName(extension.name),
		capability: hasCapability ? capabilityParts.join(" · ") : weight === 0 ? "hooks" : "",
		commands: extension.commands.map((command) => `/${command}`).join(" "),
		weight,
		tools: extension.tools + extension.mcpTools,
	};
}

type ExtensionWidths = { name: number; capability: number };

function extensionWidths(rows: ExtensionRow[]): ExtensionWidths {
	return {
		name: Math.max(...rows.map((row) => visibleWidth(row.name))),
		capability: Math.max(...rows.map((row) => visibleWidth(row.capability))),
	};
}

function extensionColumns(theme: Theme, rows: ExtensionRow[], widths: ExtensionWidths): string[] {
	return rows.map((row) => {
		const name = theme.fg("text", row.name.padEnd(widths.name));
		if (!row.capability && !row.commands) return name.trimEnd();
		// Pad whenever a command follows so every command lines up across scope groups.
		const capability = row.commands
			? theme.fg("dim", row.capability.padEnd(widths.capability))
			: theme.fg("dim", row.capability);
		const commands = row.commands ? `  ${theme.fg("muted", row.commands)}` : "";
		return `${name}  ${capability}${commands}`.trimEnd();
	});
}

function buildGrid(report: ContextReport, theme: Theme): string[] {
	const window = report.model.contextWindow || report.totalTokens || 1;
	const cells: string[] = [];

	for (const category of report.categories) {
		if (category.tokens <= 0) continue;
		// Keep small-but-present categories visible instead of rounding them away.
		const count = Math.max(1, Math.round((category.tokens / window) * GRID_CELLS));
		const color = CATEGORY_COLOR[category.key];
		for (let index = 0; index < count && cells.length < GRID_CELLS; index++) {
			cells.push(theme.fg(color, FILLED));
		}
	}

	while (cells.length < GRID_CELLS) {
		cells.push(theme.fg("dim", EMPTY));
	}

	const rows: string[] = [];
	for (let row = 0; row < GRID_ROWS; row++) {
		rows.push(cells.slice(row * GRID_COLS, (row + 1) * GRID_COLS).join(""));
	}
	return rows;
}

function buildLegend(report: ContextReport, theme: Theme): string[] {
	const window = report.model.contextWindow || report.totalTokens || 1;
	const lines: string[] = [
		`${theme.fg("accent", theme.bold(report.model.name))}  ${theme.fg("dim", `· ${report.model.thinking}`)}`,
		theme.fg("muted", `${report.model.provider}/${report.model.id}`),
		theme.fg("text", `${formatTokens(report.totalTokens)}/${formatTokens(window)} tokens (${percent(report.totalTokens, window)})`),
		"",
		theme.fg("dim", report.measured ? "Estimated usage by category" : "Estimated usage (no provider total yet)"),
	];

	const labelWidth = Math.max(...report.categories.map((category) => category.label?.length ?? 0), 11) + 3;
	for (const category of report.categories) {
		const color = CATEGORY_COLOR[category.key];
		const label = `${category.label}:`.padEnd(labelWidth);
		const amount = `${formatTokens(category.tokens)} tokens`.padEnd(14);
		lines.push(`${theme.fg(color, FILLED)} ${theme.fg("text", label)}${amount}${theme.fg("dim", `(${percent(category.tokens, window)})`)}`);
	}

	const freeLabel = "Free space:".padEnd(labelWidth);
	const freeAmount = `${formatTokens(report.free)} tokens`.padEnd(14);
	lines.push(`${theme.fg("dim", EMPTY)} ${theme.fg("text", freeLabel)}${freeAmount}${theme.fg("dim", `(${percent(report.free, window)})`)}`);

	if (report.measured) {
		const drift = report.totalTokens - report.estimatedTotal;
		lines.push("");
		lines.push(
			theme.fg(
				"dim",
				`measured ${report.totalTokens.toLocaleString("en-US")} · estimated ${report.estimatedTotal.toLocaleString("en-US")} · Δ ${drift >= 0 ? "+" : ""}${drift.toLocaleString("en-US")}`,
			),
		);
	}

	return lines;
}

function joinColumns(left: string[], right: string[], gap: number, width: number): string[] {
	const leftWidth = Math.max(...left.map(visibleWidth), 0);
	const rows = Math.max(left.length, right.length);
	const lines: string[] = [];

	for (let index = 0; index < rows; index++) {
		const leftCell = left[index] ?? "";
		const rightCell = right[index] ?? "";
		const padding = " ".repeat(Math.max(0, leftWidth - visibleWidth(leftCell) + gap));
		lines.push(truncateToWidth(`${leftCell}${padding}${rightCell}`, width, "…", true));
	}
	return lines;
}

function section(theme: Theme, title: string, hint?: string): string[] {
	const heading = theme.fg("accent", theme.bold(title));
	return ["", hint ? `${heading} ${theme.fg("dim", `· ${hint}`)}` : heading];
}

function tree(theme: Theme, items: string[]): string[] {
	return items.map((item, index) => {
		const branch = index === items.length - 1 ? "└ " : "├ ";
		return `${theme.fg("dim", branch)}${item}`;
	});
}

function wrapItems(items: string[], width: number, separator = "  "): string[] {
	const lines: string[] = [];
	let current = "";
	for (const item of items) {
		const candidate = current ? `${current}${separator}${item}` : item;
		if (visibleWidth(candidate) > width && current) {
			lines.push(current);
			current = item;
		} else {
			current = candidate;
		}
	}
	if (current) lines.push(current);
	return lines;
}

function array<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Entries persisted by older versions of this extension can be missing fields that
 * newer render code expects, so fill in defaults instead of crashing the TUI.
 */
function normalizeReport(input: ContextReport): ContextReport {
	const raw = (input ?? {}) as Partial<ContextReport>;
	const mcp = raw.mcp ?? ({} as Partial<ContextReport["mcp"]>);
	const commands = raw.commands ?? ({} as Partial<ContextReport["commands"]>);
	const keybindings = raw.keybindings ?? ({} as Partial<ContextReport["keybindings"]>);

	return {
		model: {
			name: raw.model?.name ?? "unknown",
			id: raw.model?.id ?? "unknown",
			provider: raw.model?.provider ?? "unknown",
			contextWindow: raw.model?.contextWindow ?? 0,
			thinking: raw.model?.thinking ?? "",
		},
		measured: raw.measured ?? false,
		totalTokens: raw.totalTokens ?? 0,
		estimatedTotal: raw.estimatedTotal ?? 0,
		categories: array(raw.categories),
		free: raw.free ?? 0,
		mcp: {
			loaded: array(mcp.loaded),
			servers: array(mcp.servers),
			savedTokens: mcp.savedTokens ?? 0,
		},
		contextFiles: array(raw.contextFiles),
		memoryFiles: array(raw.memoryFiles),
		skills: array(raw.skills),
		extensions: array(raw.extensions),
		commands: {
			extension: array(commands.extension),
			skill: array(commands.skill),
			prompt: array(commands.prompt),
		},
		agents: array(raw.agents),
		keybindings: {
			total: keybindings.total,
			overrides: array(keybindings.overrides),
			configPath: keybindings.configPath ?? "keybindings config",
			exists: keybindings.exists ?? false,
			extensionShortcuts: array(keybindings.extensionShortcuts),
		},
		themes: array(raw.themes),
	};
}

export function renderReport(input: ContextReport, theme: Theme, width: number): string[] {
	const report = normalizeReport(input);
	const safeWidth = Math.max(40, width);
	const lines: string[] = [theme.fg("accent", theme.bold("Context Usage"))];

	const grid = buildGrid(report, theme);
	const legend = buildLegend(report, theme);
	lines.push(
		...(safeWidth >= GRID_COLS + 46
			? joinColumns(grid, legend, 3, safeWidth)
			: [...grid, "", ...legend.map((line) => truncateToWidth(line, safeWidth, "…", true))]),
	);

	// MCP
	if (report.mcp.loaded.length > 0 || report.mcp.servers.length > 0) {
		lines.push(...section(theme, "MCP tools", "/mcp (loaded on demand)"));

		if (report.mcp.loaded.length > 0) {
			lines.push("", theme.fg("muted", "Loaded"));
			lines.push(
				...tree(
					theme,
					report.mcp.loaded.map((tool) => labelledAmount(theme, tool.name, `${formatTokens(tool.tokens)} tokens`)),
				),
			);
		}

		if (report.mcp.servers.length > 0) {
			lines.push("", theme.fg("muted", "Available"));
			lines.push(
				...tree(
					theme,
					report.mcp.servers.map((server) => {
						const meta = theme.fg("dim", `(${server.type}, ${server.scope})`);
						if (server.status !== "connected") {
							const reason = server.status === "disabled" ? "disabled" : (server.error ?? "unavailable");
							return `${theme.fg("error", server.name)} ${meta} ${theme.fg("error", reason)}`;
						}
						return `${theme.fg("text", server.name)} ${meta}${theme.fg("dim", ":")} ${theme.fg("muted", `${plural(server.availableCount, "tool")} · ~${formatTokens(server.availableTokens)} tokens if loaded`)}`;
					}),
				),
			);
		}

		if (report.mcp.savedTokens > 0) {
			const window = report.model.contextWindow || 1;
			lines.push(
				"",
				theme.fg(
					"dim",
					`Lazy loading is saving ~${formatTokens(report.mcp.savedTokens)} tokens (${percent(report.mcp.savedTokens, window)} of window)`,
				),
			);
		}
	}

	// Memory files
	if (report.memoryFiles.length > 0) {
		const loaded = report.memoryFiles.filter((file) => file.loaded);
		const nested = report.memoryFiles.filter((file) => !file.loaded);
		lines.push(...section(theme, "Memory files", `${plural(report.memoryFiles.length, "file")} · AGENTS.md / CLAUDE.md`));

		if (loaded.length > 0) {
			lines.push("", theme.fg("muted", "In context"));
			lines.push(
				...tree(theme, loaded.map((file) => labelledAmount(theme, file.path, `${formatTokens(file.tokens)} tokens`))),
			);
		}

		if (nested.length > 0) {
			lines.push("", theme.fg("muted", "Nested (read on demand)"));
			lines.push(
				...tree(theme, nested.map((file) => labelledAmount(theme, file.path, `${formatTokens(file.tokens)} tokens`))),
			);
		}
	}

	// Extensions, grouped by scope
	if (report.extensions.length > 0) {
		const scopes = [...new Set(report.extensions.map((extension) => extension.scope))].sort(
			(a, b) => SCOPE_ORDER.indexOf(a) - SCOPE_ORDER.indexOf(b),
		);
		const counts = scopes.map((scope) => {
			const total = report.extensions.filter((extension) => extension.scope === scope).length;
			return `${total} ${(SCOPE_LABELS[scope] ?? scope).toLowerCase()}`;
		});
		lines.push(...section(theme, "Extensions", [`${report.extensions.length} loaded`, ...counts].join(" · ")));

		const allRows = report.extensions.map(extensionRow);
		const widths = extensionWidths(allRows);
		for (const scope of scopes) {
			const rows = report.extensions
				.filter((extension) => extension.scope === scope)
				.map(extensionRow)
				.sort((a, b) => b.weight - a.weight || b.tools - a.tools || a.name.localeCompare(b.name));
			lines.push("", theme.fg("muted", SCOPE_LABELS[scope] ?? scope));
			lines.push(...tree(theme, extensionColumns(theme, rows, widths)));
		}
	}

	// Skills, grouped by scope
	if (report.skills.length > 0) {
		lines.push(...section(theme, "Skills", `${plural(report.skills.length, "skill")} loaded`));
		const scopes = [...new Set(report.skills.map((skill) => skill.scope))].sort(
			(a, b) => SCOPE_ORDER.indexOf(a) - SCOPE_ORDER.indexOf(b),
		);

		for (const scope of scopes) {
			const group = report.skills.filter((skill) => skill.scope === scope);
			lines.push("", theme.fg("muted", SCOPE_LABELS[scope] ?? scope));
			lines.push(
				...tree(theme, group.map((skill) => labelledAmount(theme, skill.name, `~${formatTokens(skill.tokens)} tokens`))),
			);
		}
	}

	// Commands (skills have their own section)
	const commandTotal = report.commands.extension.length + report.commands.prompt.length;
	if (commandTotal > 0) {
		lines.push(
			...section(
				theme,
				"Commands",
				`${plural(report.commands.extension.length, "extension command")} · ${plural(report.commands.prompt.length, "prompt template")}`,
			),
		);
		const groups: string[] = [];
		if (report.commands.extension.length > 0) {
			groups.push(...wrapItems(report.commands.extension.map((name) => `/${name}`), safeWidth - 4));
		}
		if (report.commands.prompt.length > 0) {
			groups.push(...wrapItems(report.commands.prompt.map((name) => `/${name}`), safeWidth - 4));
		}
		lines.push(...tree(theme, groups.map((group) => theme.fg("text", group))));
	}

	// Agents, grouped by scope
	if (report.agents.length > 0) {
		lines.push(...section(theme, "Agents", `${plural(report.agents.length, "agent")} · subagent extension`));
		const scopes = [...new Set(report.agents.map((agent) => agent.scope))].sort(
			(a, b) => SCOPE_ORDER.indexOf(a) - SCOPE_ORDER.indexOf(b),
		);

		for (const scope of scopes) {
			const group = report.agents.filter((agent) => agent.scope === scope);
			lines.push("", theme.fg("muted", SCOPE_LABELS[scope] ?? scope));
			lines.push(
				...tree(
					theme,
					group.map(
						(agent) =>
							`${theme.fg("text", agent.name)}  ${theme.fg("dim", truncateToWidth(agent.description, Math.max(10, safeWidth - 30), "…", true))}`,
					),
				),
			);
		}
	}

	// Keybindings + themes
	const bindingSummary = report.keybindings.total
		? `${report.keybindings.total} active · ${plural(report.keybindings.overrides.length, "user override")}`
		: plural(report.keybindings.overrides.length, "user override");
	lines.push(...section(theme, "Keybindings", bindingSummary));
	const bindingItems =
		report.keybindings.overrides.length > 0
			? report.keybindings.overrides.map((line) => theme.fg("text", line))
			: [theme.fg("dim", `${report.keybindings.configPath}: not present (all defaults)`)];
	for (const shortcut of report.keybindings.extensionShortcuts) {
		const detail = shortcut.description ? `${shortcut.description} · ${shortcut.extension}` : shortcut.extension;
		bindingItems.push(`${theme.fg("text", shortcut.key.padEnd(12))}${theme.fg("muted", detail)}`);
	}
	if (report.themes.length > 0) {
		bindingItems.push(theme.fg("dim", `Themes: ${report.themes.join(", ")}`));
	}
	lines.push(...tree(theme, bindingItems));

	return lines.map((line) => truncateToWidth(line, safeWidth, "…", true));
}
