import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { basename, join } from "node:path";
import { readFile, stat } from "node:fs/promises";

type GitState = {
	projectName: string;
	added: number;
	deleted: number;
};

type BranchStat = {
	files: number;
	added: number;
	deleted: number;
};

type QuotaWindow = {
	percent?: number;
	resetAt?: number;
};

type QuotaState = {
	short?: QuotaWindow;
	long?: QuotaWindow;
};

const ESC = "\x1b[";
const RESET_FG = `${ESC}39m`;

const color = (rgb: [number, number, number], text: string) =>
	`${ESC}38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}${RESET_FG}`;

const palette = {
	model: (text: string) => color([0, 175, 255], text),
	provider: (text: string) => color([175, 135, 255], text),
	project: (text: string) => color([0, 170, 170], text),
	green: (text: string) => color([0, 215, 0], text),
	red: (text: string) => color([255, 80, 80], text),
	yellow: (text: string) => color([255, 175, 0], text),
	cyan: (text: string) => color([0, 200, 220], text),
	dim: (text: string) => color([96, 96, 96], text),
	text: (text: string) => color([230, 230, 230], text),
	textDark: (text: string) => color([60, 60, 60], text),
};

// The statusline uses hardcoded truecolor values, so pick a legible foreground
// for light themes instead of the near-white default.
function isLightTheme(theme: { name?: string } | undefined) {
	return /light/i.test(theme?.name ?? "");
}

function textColor(theme: { name?: string } | undefined) {
	return isLightTheme(theme) ? palette.textDark : palette.text;
}

function separator() {
	return palette.dim(" | ");
}

function clampPercent(value: number) {
	return Math.max(0, Math.min(100, value));
}

function formatTokens(count: number | null | undefined) {
	if (count === null || count === undefined || !Number.isFinite(count)) return "?";
	if (count < 1000) return `${Math.round(count)}`;
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}m`;
	return `${Math.round(count / 1000000)}m`;
}

function formatAgentDuration(ms: number) {
	const totalSeconds = Math.max(1, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;

	const hours = Math.floor(totalMinutes / 60);
	const remainingMinutes = totalMinutes % 60;
	return remainingMinutes === 0
		? `${hours}hr ${seconds}s`
		: `${hours}hr ${remainingMinutes}m ${seconds}s`;
}

function formatCost(ctx: ExtensionContext) {
	let total = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		if (usage?.cost?.total && Number.isFinite(usage.cost.total)) {
			total += usage.cost.total;
		}
	}
	return `$${total.toFixed(2)}`;
}

function formatContext(ctx: ExtensionContext) {
	const usage = ctx.getContextUsage();
	const tokens = usage?.tokens;
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
	const percent = usage?.percent ?? (tokens && contextWindow ? (tokens / contextWindow) * 100 : undefined);
	const percentText = percent === undefined || percent === null ? "?" : `${Math.round(percent)}`;

	return [
		palette.yellow(`${formatTokens(tokens)}/${formatTokens(contextWindow)}`),
		" ",
		palette.dim("("),
		palette.green(`${percentText}%`),
		palette.dim(")"),
	].join("");
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

function normalizeThinkingLevel(level: string | undefined): ThinkingLevel {
	return level === "minimal" || level === "low" || level === "medium" || level === "high" || level === "xhigh"
		? level
		: "off";
}

type AutocompleteAwareEditor = EditorComponent & { isShowingAutocomplete?: () => boolean };

function withThinkingBorderColor(
	editor: EditorComponent,
	ctx: ExtensionContext,
	getThinkingLevel: () => ThinkingLevel,
	onAutocompleteVisibility?: (visible: boolean) => void,
): EditorComponent {
	const originalRender = editor.render.bind(editor);

	editor.render = (width: number) => {
		editor.borderColor = ctx.ui.theme.getThinkingBorderColor(getThinkingLevel());
		const lines = originalRender(width);
		const autocompleteEditor = editor as AutocompleteAwareEditor;
		onAutocompleteVisibility?.(autocompleteEditor.isShowingAutocomplete?.() === true);
		return lines;
	};

	// Set it immediately too; pi copies the default border after factory creation,
	// so render() above is what fixes the initial grey frame.
	editor.borderColor = ctx.ui.theme.getThinkingBorderColor(getThinkingLevel());
	return editor;
}

function syncEditorBorderWithThinking(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	onAutocompleteVisibility?: (visible: boolean) => void,
) {
	const previousFactory = ctx.ui.getEditorComponent();

	ctx.ui.setEditorComponent((tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) => {
		const editor = previousFactory?.(tui, editorTheme, keybindings) ?? new CustomEditor(tui, editorTheme, keybindings);
		return withThinkingBorderColor(
			editor,
			ctx,
			() => normalizeThinkingLevel(pi.getThinkingLevel()),
			onAutocompleteVisibility,
		);
	});
}

function formatShortReset(ms: number | undefined) {
	if (!ms) return "?";
	return new Date(ms).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

function formatLongReset(ms: number | undefined) {
	if (!ms) return "?";
	return new Date(ms).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

function parseNumber(value: unknown) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return undefined;
	const match = value.match(/-?\d+(?:\.\d+)?/);
	if (!match) return undefined;
	const parsed = Number(match[0]);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseReset(value: unknown) {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "number" && Number.isFinite(value)) {
		if (value > 1_000_000_000_000) return value;
		if (value > 1_000_000_000) return value * 1000;
		if (value > 0) return Date.now() + value * 1000;
		return undefined;
	}
	if (typeof value !== "string") return undefined;

	const trimmed = value.trim();
	if (!trimmed) return undefined;

	const numeric = Number(trimmed);
	if (Number.isFinite(numeric)) return parseReset(numeric);

	const duration = parseDuration(trimmed);
	if (duration !== undefined) return Date.now() + duration;

	const parsed = Date.parse(trimmed);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function parseDuration(value: string) {
	const matches = [...value.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/gi)];
	if (matches.length === 0) return undefined;

	let total = 0;
	for (const match of matches) {
		const amount = Number(match[1]);
		const unit = match[2].toLowerCase();
		if (!Number.isFinite(amount)) continue;
		if (unit === "ms") total += amount;
		else if (unit.startsWith("s")) total += amount * 1000;
		else if (unit.startsWith("m")) total += amount * 60_000;
		else if (unit.startsWith("h")) total += amount * 3_600_000;
		else if (unit.startsWith("d")) total += amount * 86_400_000;
	}
	return total || undefined;
}

function detectWindow(text: string): "short" | "long" | undefined {
	const normalized = text.toLowerCase();
	if (/\b(5\s*h|5[-_ ]?hour|five[-_ ]?hour|short|short[-_ ]?term)\b/.test(normalized)) return "short";
	if (/\b(7\s*d|7[-_ ]?day|seven[-_ ]?day|week|weekly|long|long[-_ ]?term)\b/.test(normalized)) return "long";
	return undefined;
}

function applyQuotaWindow(target: QuotaState, window: "short" | "long", update: QuotaWindow) {
	const current = target[window] ?? {};
	target[window] = {
		percent: update.percent ?? current.percent,
		resetAt: update.resetAt ?? current.resetAt,
	};
}

function parseQuotaObject(value: unknown, path: string[], result: QuotaState) {
	if (!value || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	const pathText = [
		...path,
		record.window,
		record.label,
		record.name,
		record.type,
		record.duration,
	]
		.filter((part): part is string => typeof part === "string")
		.join(" ");
	const window = detectWindow(pathText);

	if (window) {
		const rawPercent =
			parseNumber(record.percent) ??
			parseNumber(record.used_percent) ??
			parseNumber(record.usage_percent) ??
			parseNumber(record.consumed_percent) ??
			parseNumber(record.usedPercentage) ??
			parseNumber(record.usagePercentage);
		const remainingPercent = parseNumber(record.remaining_percent) ?? parseNumber(record.remainingPercentage);
		const limit = parseNumber(record.limit) ?? parseNumber(record.total) ?? parseNumber(record.quota);
		const remaining = parseNumber(record.remaining) ?? parseNumber(record.available);
		const used = parseNumber(record.used) ?? parseNumber(record.consumed);

		let percent = rawPercent;
		if (percent === undefined && remainingPercent !== undefined) percent = 100 - remainingPercent;
		if (percent === undefined && limit !== undefined && remaining !== undefined && limit > 0) {
			percent = (1 - remaining / limit) * 100;
		}
		if (percent === undefined && limit !== undefined && used !== undefined && limit > 0) {
			percent = (used / limit) * 100;
		}

		const resetAt =
			parseReset(record.reset_at) ??
			parseReset(record.resets_at) ??
			parseReset(record.resetAt) ??
			parseReset(record.reset) ??
			parseReset(record.reset_time) ??
			parseReset(record.resetTime);

		if (percent !== undefined || resetAt !== undefined) {
			applyQuotaWindow(result, window, {
				percent: percent === undefined ? undefined : clampPercent(percent),
				resetAt,
			});
		}
	}

	for (const [key, child] of Object.entries(record)) {
		if (child && typeof child === "object") parseQuotaObject(child, [...path, key], result);
	}
}

function parseQuotaHeaders(headers: Record<string, string>): QuotaState | undefined {
	const result: QuotaState = {};
	const lowered = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
	const direct: Record<"short" | "long", QuotaWindow & { limit?: number; remaining?: number; used?: number }> = {
		short: {},
		long: {},
	};

	for (const [key, value] of Object.entries(lowered)) {
		const window = detectWindow(key);
		if (!window) continue;

		const number = parseNumber(value);
		if (/reset|resets|retry-after/.test(key)) {
			direct[window].resetAt = parseReset(value) ?? direct[window].resetAt;
		}

		if (number === undefined) continue;
		if (/(remaining|available).*(percent|pct)|(percent|pct).*(remaining|available)/.test(key)) {
			direct[window].percent = 100 - number;
		} else if (/(percent|pct)/.test(key)) {
			direct[window].percent = number;
		} else if (/(remaining|available)/.test(key)) {
			direct[window].remaining = number;
		} else if (/(^|[-_])(limit|total|quota)([-_]|$)/.test(key)) {
			direct[window].limit = number;
		} else if (/(used|consumed)/.test(key)) {
			direct[window].used = number;
		}
	}

	for (const window of ["short", "long"] as const) {
		const entry = direct[window];
		let percent = entry.percent;
		if (percent === undefined && entry.limit !== undefined && entry.remaining !== undefined && entry.limit > 0) {
			percent = (1 - entry.remaining / entry.limit) * 100;
		}
		if (percent === undefined && entry.limit !== undefined && entry.used !== undefined && entry.limit > 0) {
			percent = (entry.used / entry.limit) * 100;
		}
		if (percent !== undefined || entry.resetAt !== undefined) {
			applyQuotaWindow(result, window, {
				percent: percent === undefined ? undefined : clampPercent(percent),
				resetAt: entry.resetAt,
			});
		}
	}

	for (const [key, value] of Object.entries(lowered)) {
		const trimmed = value.trim();
		if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
		try {
			parseQuotaObject(JSON.parse(trimmed), [key], result);
		} catch {
			// Header is not JSON; ignore it.
		}
	}

	return result.short || result.long ? result : undefined;
}

function renderQuotaWindow(label: "5h" | "7d", window: QuotaWindow | undefined) {
	const percent = window?.percent;
	const resetAt = window?.resetAt;
	const percentText = percent === undefined ? "?" : `${Math.round(percent)}`;
	const resetText = label === "5h" ? formatShortReset(resetAt) : formatLongReset(resetAt);

	return [
		palette.text(label),
		" ",
		percent === undefined ? palette.dim(`${percentText}%`) : palette.green(`${percentText}%`),
		" ",
		palette.dim(`@${resetText}`),
	].join("");
}

function renderProject(git: GitState, branch: string | null, branchStat: BranchStat | null) {
	let output = palette.project(git.projectName);
	if (branch) output += palette.green(`@${branch}`);

	output += [
		palette.dim(" ("),
		palette.green(`+${git.added}`),
		" ",
		palette.red(`-${git.deleted}`),
		palette.dim(")"),
	].join("");

	if (branchStat && (branchStat.added > 0 || branchStat.deleted > 0 || branchStat.files > 0)) {
		output += [
			palette.dim("  ↑ "),
			palette.cyan(`+${branchStat.added}`),
			palette.dim(" "),
			palette.red(`-${branchStat.deleted}`),
			palette.dim(` ${branchStat.files}f`),
		].join("");
	}

	return output;
}

function parseNumstat(output: string) {
	let added = 0;
	let deleted = 0;
	for (const line of output.split("\n")) {
		const [rawAdded, rawDeleted] = line.trim().split(/\s+/, 3);
		const add = Number(rawAdded);
		const del = Number(rawDeleted);
		if (Number.isFinite(add)) added += add;
		if (Number.isFinite(del)) deleted += del;
	}
	return { added, deleted };
}

/** Caps so a repo full of untracked files can't stall the footer. */
const MAX_UNTRACKED_FILES = 200;
const MAX_UNTRACKED_BYTES = 1_000_000;

/** Line count of untracked, non-ignored files. Skips binaries and oversized files. */
async function countUntrackedLines(pi: ExtensionAPI, repoRoot: string) {
	const listed = await pi.exec("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
		cwd: repoRoot,
		timeout: 3000,
	});
	if (listed.code !== 0) return 0;

	const files = listed.stdout.split("\0").filter(Boolean).slice(0, MAX_UNTRACKED_FILES);
	let added = 0;

	for (const file of files) {
		try {
			const path = join(repoRoot, file);
			const info = await stat(path);
			if (!info.isFile() || info.size === 0 || info.size > MAX_UNTRACKED_BYTES) continue;

			const buf = await readFile(path);
			if (buf.includes(0)) continue; // binary

			let lines = 0;
			for (const byte of buf) if (byte === 10) lines++;
			if (buf[buf.length - 1] !== 10) lines++; // unterminated final line
			added += lines;
		} catch {
			// unreadable / raced deletion — ignore
		}
	}

	return added;
}

export default function (pi: ExtensionAPI) {
	let executionStartedAt: number | undefined;
	let activeTui: TUI | undefined;

	pi.registerEntryRenderer<{ durationMs: number }>("agent-duration", (entry, _options, theme) => {
		return new Text(theme.fg("muted", `✱ Worked for ${formatAgentDuration(entry.data.durationMs)}`), 1, 0);
	});

	pi.on("agent_start", () => {
		if (executionStartedAt === undefined) executionStartedAt = Date.now();
	});

	pi.on("agent_settled", () => {
		if (executionStartedAt !== undefined) {
			pi.appendEntry("agent-duration", { durationMs: Date.now() - executionStartedAt });
		}
		executionStartedAt = undefined;
	});

	let git: GitState = {
		projectName: basename(process.cwd()),
		added: 0,
		deleted: 0,
	};
	let branchStat: BranchStat | null = null;
	let quota: QuotaState = {};
	let statusLineHidden = false;
	let autocompleteShowing = false;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	let refreshInFlight = false;
	let refreshAgain = false;

	const requestRender = () => activeTui?.requestRender();

	const setAutocompleteShowing = (visible: boolean) => {
		if (autocompleteShowing === visible) return;
		autocompleteShowing = visible;
		requestRender();
	};

	pi.events.on("usage:visibility", (visible: unknown) => {
		statusLineHidden = visible === true;
		requestRender();
	});

	const refreshGit = async (ctx: ExtensionContext) => {
		if (refreshInFlight) {
			refreshAgain = true;
			return;
		}

		refreshInFlight = true;
		try {
			const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, timeout: 2000 });
			if (root.code !== 0) {
				git = { projectName: basename(ctx.cwd), added: 0, deleted: 0 };
				requestRender();
				return;
			}

			const repoRoot = root.stdout.trim();
			let diff = await pi.exec("git", ["diff", "--numstat", "HEAD", "--"], { cwd: repoRoot, timeout: 3000 });
			if (diff.code !== 0) {
				diff = await pi.exec("git", ["diff", "--numstat", "--"], { cwd: repoRoot, timeout: 3000 });
			}

			const [stats, untracked, branchDiff] = await Promise.all([
				Promise.resolve(diff.code === 0 ? parseNumstat(diff.stdout) : { added: 0, deleted: 0 }),
				countUntrackedLines(pi, repoRoot),
				pi.exec("git", ["diff", "--numstat", "master...HEAD", "--"], { cwd: repoRoot, timeout: 3000 })
					.then(r => r.code === 0 ? r : pi.exec("git", ["diff", "--numstat", "origin/master...HEAD", "--"], { cwd: repoRoot, timeout: 3000 }))
					.catch(() => ({ code: 1, stdout: "", stderr: "" })),
			]);
			git = {
				projectName: basename(repoRoot),
				added: stats.added + untracked,
				deleted: stats.deleted,
			};
			if (branchDiff.code === 0 && branchDiff.stdout.trim()) {
				const bs = parseNumstat(branchDiff.stdout);
				const files = branchDiff.stdout.trim().split("\n").filter(Boolean).length;
				branchStat = { files, added: bs.added, deleted: bs.deleted };
			} else {
				branchStat = null;
			}
			requestRender();
		} catch {
			git = { projectName: basename(ctx.cwd), added: 0, deleted: 0 };
			branchStat = null;
			requestRender();
		} finally {
			refreshInFlight = false;
			if (refreshAgain) {
				refreshAgain = false;
				void refreshGit(ctx);
			}
		}
	};

	const scheduleGitRefresh = (ctx: ExtensionContext, delayMs = 150) => {
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			void refreshGit(ctx);
		}, delayMs);
	};

	pi.on("session_start", (_event, ctx) => {
		git = { projectName: basename(ctx.cwd), added: 0, deleted: 0 };
		scheduleGitRefresh(ctx, 0);
		syncEditorBorderWithThinking(pi, ctx, setAutocompleteShowing);

		ctx.ui.setWidget("statusline", undefined);

		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;
			const unsubscribe = footerData.onBranchChange(() => {
				scheduleGitRefresh(ctx, 0);
				requestRender();
			});

			const component: Component & { dispose(): void } = {
				dispose() {
					unsubscribe();
					if (activeTui === tui) activeTui = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					if (statusLineHidden || autocompleteShowing) return [];

					const model = ctx.model?.name || ctx.model?.id || "no-model";
					const provider = ctx.model
						? ctx.modelRegistry.getProviderDisplayName(ctx.model.provider)
						: undefined;
					const thinking = normalizeThinkingLevel(pi.getThinkingLevel());
					const thinkingColor = theme.getThinkingBorderColor(thinking);
					const branch = footerData.getGitBranch();

					const line1 = [
						...(provider ? [palette.provider(provider), palette.dim("/")] : []),
						palette.model(model),
						" ",
						thinkingColor(thinking),
						separator(),
						formatContext(ctx),
						separator(),
						textColor(theme)(formatCost(ctx)),
					].join("");

					const line2 = renderProject(git, branch, branchStat);

					const statuses = footerData.getExtensionStatuses();
					const bgTasksStatus = statuses.get("bg-jobs");
					const subagentsStatus = statuses.get("subagents");
					const otherStatusParts = [...statuses.entries()]
						.filter(([id]) => id !== "bg-jobs" && id !== "subagents")
						.map(([, value]) => value)
						.filter(Boolean);
					const result: string[] = [
						"",
						truncateToWidth(line1, width, ""),
						truncateToWidth(line2, width, ""),
					];
					// bg tasks always come first when present; subagents follow right after,
					// so subagents land on line 3 instead of 4 when there are no bg tasks.
					if (bgTasksStatus) result.push(truncateToWidth(bgTasksStatus, width, ""));
					if (subagentsStatus) result.push(truncateToWidth(subagentsStatus, width, ""));
					if (otherStatusParts.length > 0) {
						result.push(truncateToWidth(otherStatusParts.join("  "), width, ""));
					}
					return result;
				},
			};

			return component;
		});
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		scheduleGitRefresh(ctx, 250);
	});

	pi.on("agent_end", (_event, ctx) => {
		scheduleGitRefresh(ctx, 100);
		requestRender();
	});

	pi.on("model_select", () => requestRender());
	pi.on("thinking_level_select", () => requestRender());
	pi.on("message_end", () => requestRender());

	pi.on("session_shutdown", () => {
		executionStartedAt = undefined;
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = undefined;
		activeTui = undefined;
		statusLineHidden = false;
		autocompleteShowing = false;
	});
}
