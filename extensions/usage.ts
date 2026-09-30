import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── OpenAI Codex rate-limit config ─────────────────────────────────────────
const CODEX_BASE_URL = (process.env.CODEX_BASE_URL || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
const CODEX_USAGE_ENDPOINT = `${CODEX_BASE_URL}/wham/usage`;
const OPEN_DASHBOARD_OPTION_PREFIX = "open-dashboard:";

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";
const CODEX_ACCOUNT_ID_CLAIM = "https://api.openai.com/auth.chatgpt_account_id";

const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

// ─── Layout constants ────────────────────────────────────────────────────────
const PANEL_WIDTH = 76;
const BAR_WIDTH = 42;
const GLOBAL_USAGE_KEY = "piCodexLimit";

// ─── Provider dashboards ────────────────────────────────────────────────────
const PROVIDER_DASHBOARDS: Record<string, { url: string; label: string }> = {
	"openai-codex": { url: "https://chatgpt.com/codex/settings/usage", label: "Codex usage" },
	"openai": { url: "https://platform.openai.com/usage", label: "OpenAI usage" },
	"anthropic": { url: "https://console.anthropic.com/settings/usage", label: "Anthropic usage" },
	"google": { url: "https://console.cloud.google.com/billing", label: "Google Cloud billing" },
	"google-vertex": { url: "https://console.cloud.google.com/billing", label: "Vertex AI billing" },
	"zai": { url: "https://z.ai/manage-apikey/subscription", label: "Z.AI subscription" },
	"github-copilot": { url: "https://github.com/settings/copilot/features", label: "Copilot usage" },
	"deepseek": { url: "https://platform.deepseek.com/usage", label: "DeepSeek usage" },
	"openrouter": { url: "https://openrouter.ai/credits", label: "OpenRouter credits" },
	"groq": { url: "https://console.groq.com/settings/billing", label: "Groq billing" },
	"xai": { url: "https://console.x.ai/settings/billing", label: "xAI billing" },
	"mistral": { url: "https://console.mistral.ai/billing", label: "Mistral billing" },
};

function getDashboard(provider: string | undefined): { url: string; label: string } | undefined {
	if (!provider) return undefined;
	// Exact match first, then prefix match (e.g. openai-codex-2)
	if (PROVIDER_DASHBOARDS[provider]) return PROVIDER_DASHBOARDS[provider];
	for (const [key, val] of Object.entries(PROVIDER_DASHBOARDS)) {
		if (provider.startsWith(key)) return val;
	}
	return undefined;
}

// ─── OpenAI Codex types ──────────────────────────────────────────────────────
type UsageWindow = {
	usedPercent?: number;
	windowSeconds?: number;
	resetAt?: number;
};

type CodexSnapshot = {
	planType?: string;
	email?: string;
	fiveHour?: UsageWindow;
	weekly?: UsageWindow;
	fetchedAt: number;
};

type JwtMetadata = {
	accountId?: string;
	planType?: string;
	email?: string;
};

type GlobalCodexLimit = {
	provider?: string;
	fiveHour?: UsageWindow;
	weekly?: UsageWindow;
	fetchedAt?: number;
};

declare global {
	// eslint-disable-next-line no-var
	var piCodexLimit: GlobalCodexLimit | undefined;
}

// ─── Session identity (provider-agnostic) ────────────────────────────────────
type SessionStats = {
	provider: string;
	model: string;
};

let cachedCodexSnapshot: CodexSnapshot | undefined;

// ─── GitHub Copilot quota ────────────────────────────────────────────────────
// Undocumented endpoint used by the official Copilot editor extensions. It takes the
// GitHub OAuth token (ghu_…), not the short-lived Copilot session token.
const COPILOT_USER_ENDPOINT = "https://api.github.com/copilot_internal/user";
const COPILOT_API_VERSION = "2025-05-01";

type CopilotQuota = {
	id: string;
	label: string;
	unlimited: boolean;
	entitlement: number;
	remaining: number;
	percentRemaining: number;
	overagePermitted: boolean;
};

type CopilotSnapshot = {
	plan?: string;
	login?: string;
	resetDate?: string;
	quotas: CopilotQuota[];
	fetchedAt: number;
};

let cachedCopilotSnapshot: CopilotSnapshot | undefined;

function isGitHubCopilotProvider(provider: string | undefined): boolean {
	return /^github-copilot(-\d+)?$/.test(provider ?? "");
}

const COPILOT_QUOTA_LABELS: Record<string, string> = {
	premium_interactions: "Premium requests",
	chat: "Chat",
	completions: "Completions",
};

/** Reads the stored GitHub OAuth token; the runtime only exposes the derived session token. */
function readCopilotOAuthToken(): string | undefined {
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
		const entry = asRecord(parsed["github-copilot"]);
		const refresh = entry?.refresh;
		return typeof refresh === "string" && refresh.length > 0 ? refresh : undefined;
	} catch {
		return undefined;
	}
}

function parseCopilotSnapshot(data: unknown): CopilotSnapshot {
	const raw = asRecord(data);
	const snapshots = nestedRecord(raw, "quota_snapshots") ?? {};
	const quotas: CopilotQuota[] = [];

	for (const [id, value] of Object.entries(snapshots)) {
		const record = asRecord(value);
		if (!record) continue;
		quotas.push({
			id,
			label: COPILOT_QUOTA_LABELS[id] ?? id.replace(/_/g, " "),
			unlimited: record.unlimited === true,
			entitlement: typeof record.entitlement === "number" ? record.entitlement : 0,
			remaining: typeof record.remaining === "number" ? record.remaining : 0,
			percentRemaining: typeof record.percent_remaining === "number" ? record.percent_remaining : 100,
			overagePermitted: record.overage_permitted === true,
		});
	}

	// Metered quotas first, then unlimited ones.
	quotas.sort((a, b) => Number(a.unlimited) - Number(b.unlimited) || b.entitlement - a.entitlement);

	return {
		plan: typeof raw?.copilot_plan === "string" ? raw.copilot_plan : undefined,
		login: typeof raw?.login === "string" ? raw.login : undefined,
		resetDate: typeof raw?.quota_reset_date === "string" ? raw.quota_reset_date : undefined,
		quotas,
		fetchedAt: Date.now(),
	};
}

async function fetchCopilotUsage(ctx: ExtensionContext): Promise<CopilotSnapshot | undefined> {
	if (!isGitHubCopilotProvider(ctx.model?.provider)) {
		cachedCopilotSnapshot = undefined;
		return undefined;
	}

	const token = readCopilotOAuthToken();
	if (!token) {
		cachedCopilotSnapshot = undefined;
		return undefined;
	}

	try {
		const response = await fetch(COPILOT_USER_ENDPOINT, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
				"X-GitHub-Api-Version": COPILOT_API_VERSION,
				"User-Agent": "pi-usage-command",
			},
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) {
			cachedCopilotSnapshot = undefined;
			return undefined;
		}

		cachedCopilotSnapshot = parseCopilotSnapshot(await response.json());
		return cachedCopilotSnapshot;
	} catch {
		cachedCopilotSnapshot = undefined;
		return undefined;
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isOpenAICodexProvider(provider: string | undefined): boolean {
	return /^openai-codex(-\d+)?$/.test(provider ?? "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function nestedRecord(record: Record<string, unknown> | undefined, key: string) {
	return asRecord(record?.[key]);
}

function decodeJwtPayload(token: string): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length < 2) return {};
	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function getTokenMetadata(token: string): JwtMetadata {
	const payload = decodeJwtPayload(token);
	const auth = nestedRecord(payload, OPENAI_AUTH_CLAIM);
	const profile = nestedRecord(payload, OPENAI_PROFILE_CLAIM);
	return {
		accountId:
			(typeof payload[CODEX_ACCOUNT_ID_CLAIM] === "string" ? payload[CODEX_ACCOUNT_ID_CLAIM] : undefined) ??
			(typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined),
		planType: typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined,
		email: typeof profile?.email === "string" ? profile.email : undefined,
	};
}

function normalizeWindow(value: unknown): UsageWindow | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	return {
		usedPercent: typeof record.used_percent === "number" ? record.used_percent : undefined,
		windowSeconds: typeof record.limit_window_seconds === "number" ? record.limit_window_seconds : undefined,
		resetAt: typeof record.reset_at === "number" ? record.reset_at : undefined,
	};
}

function parseCodexSnapshot(data: unknown): CodexSnapshot {
	const raw = asRecord(data);
	const rateLimit = nestedRecord(raw, "rate_limit");
	const windows = [normalizeWindow(rateLimit?.primary_window), normalizeWindow(rateLimit?.secondary_window)].filter(
		(window): window is UsageWindow => Boolean(window),
	);
	return {
		planType: typeof raw?.plan_type === "string" ? raw.plan_type : undefined,
		email: typeof raw?.email === "string" ? raw.email : undefined,
		fiveHour: windows.find((w) => Math.abs((w.windowSeconds ?? 0) - FIVE_HOUR_SECONDS) <= 120),
		weekly: windows.find((w) => Math.abs((w.windowSeconds ?? 0) - WEEK_SECONDS) <= 120),
		fetchedAt: Date.now(),
	};
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function clampPercent(value: number | undefined): number | undefined {
	return value === undefined ? undefined : Math.max(0, Math.min(100, value));
}

function formatUsedPercent(window: UsageWindow | undefined): string {
	const used = clampPercent(window?.usedPercent);
	return used === undefined ? "?%" : `${Math.round(used)}%`;
}

function getLocalTimeZone() {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
}

function formatClock(date: Date) {
	const hasMinutes = date.getMinutes() !== 0;
	return new Intl.DateTimeFormat("en-US", {
		hour: "numeric",
		...(hasMinutes ? { minute: "2-digit" as const } : {}),
		hour12: true,
	})
		.format(date)
		.replace(/\s+/g, "")
		.toLowerCase();
}

function formatResetTime(resetAt: number | undefined, style: "clock" | "date") {
	if (!resetAt) return "unknown";
	const date = new Date(resetAt * 1000);
	const zone = getLocalTimeZone();
	const clock = formatClock(date);
	if (style === "clock") return `${clock} (${zone})`;
	const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
	return `${day} at ${clock} (${zone})`;
}

function maskEmail(email: string): string {
	const [rawLocal, rawDomain] = email.split("@");
	if (!rawLocal || !rawDomain) return "***";
	const local = rawLocal.length <= 2 ? `${rawLocal[0] ?? ""}***` : `${rawLocal.slice(0, 2)}***`;
	const [domainName, ...domainRest] = rawDomain.split(".");
	const maskedDomain = domainName
		? `${domainName[0] ?? ""}***${domainName.length > 1 ? domainName.slice(-1) : ""}`
		: "***";
	return `${local}@${maskedDomain}${domainRest.length > 0 ? `.${domainRest.join(".")}` : ""}`;
}

function formatFetchedAt(fetchedAt: number): string {
	return new Date(fetchedAt).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function formatNumber(n: number): string {
	return n.toLocaleString();
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderUsageBar(ctx: ExtensionContext, window: UsageWindow | undefined) {
	const used = clampPercent(window?.usedPercent);
	const label = `${formatUsedPercent(window)} used`;
	const filled = used === undefined || used <= 0 ? 0 : Math.max(1, Math.round((used / 100) * BAR_WIDTH));
	const empty = Math.max(0, BAR_WIDTH - filled);
	const fillColor = used !== undefined && used >= 90 ? "error" : used !== undefined && used >= 70 ? "warning" : "accent";

	return [
		ctx.ui.theme.fg(fillColor, "█".repeat(filled)),
		ctx.ui.theme.fg("muted", "█".repeat(empty)),
		"  ",
		ctx.ui.theme.fg("text", label),
	].join("");
}

// ─── Session stats computation ───────────────────────────────────────────────

function computeSessionStats(ctx: ExtensionContext): SessionStats {
	// Token/cost/context reporting lives in /context; /usage is provider quota only.
	return {
		provider: ctx.model?.provider ?? "unknown",
		model: ctx.model?.name ?? ctx.model?.id ?? "unknown",
	};
}

// ─── Codex rate-limit fetch ──────────────────────────────────────────────────

function publishGlobalSnapshot(ctx: ExtensionContext, snapshot: CodexSnapshot | undefined) {
	globalThis[GLOBAL_USAGE_KEY] = snapshot
		? {
				provider: ctx.model?.provider,
				fiveHour: snapshot.fiveHour,
				weekly: snapshot.weekly,
				fetchedAt: snapshot.fetchedAt,
			}
		: undefined;
}

async function fetchCodexUsage(ctx: ExtensionContext): Promise<CodexSnapshot | undefined> {
	const model = ctx.model;
	if (!model || !isOpenAICodexProvider(model.provider)) {
		cachedCodexSnapshot = undefined;
		publishGlobalSnapshot(ctx, undefined);
		return undefined;
	}

	if (!ctx.modelRegistry.isUsingOAuth(model)) {
		cachedCodexSnapshot = undefined;
		publishGlobalSnapshot(ctx, undefined);
		return undefined;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		cachedCodexSnapshot = undefined;
		publishGlobalSnapshot(ctx, undefined);
		return undefined;
	}

	const metadata = getTokenMetadata(auth.apiKey);
	const headers = {
		Authorization: `Bearer ${auth.apiKey}`,
		Accept: "application/json",
		"User-Agent": "pi-usage-command",
		...(metadata.accountId ? { "chatgpt-account-id": metadata.accountId } : {}),
	};

	try {
		const response = await fetch(CODEX_USAGE_ENDPOINT, { headers, signal: AbortSignal.timeout(15_000) });
		if (!response.ok) {
			cachedCodexSnapshot = undefined;
			publishGlobalSnapshot(ctx, undefined);
			return undefined;
		}

		const snapshot = parseCodexSnapshot(await response.json());
		cachedCodexSnapshot = {
			...snapshot,
			email: snapshot.email ?? metadata.email,
			planType: snapshot.planType ?? metadata.planType,
		};
		publishGlobalSnapshot(ctx, cachedCodexSnapshot);
		return cachedCodexSnapshot;
	} catch {
		cachedCodexSnapshot = undefined;
		publishGlobalSnapshot(ctx, undefined);
		return undefined;
	}
}

// ─── UI ──────────────────────────────────────────────────────────────────────

function getOpenCommand(url: string): { command: string; args: string[] } {
	if (process.platform === "darwin") return { command: "open", args: [url] };
	if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
	return { command: "xdg-open", args: [url] };
}

async function openDashboardUrl(pi: ExtensionAPI, ctx: ExtensionContext, url: string, label: string) {
	const { command, args } = getOpenCommand(url);
	const result = await pi.exec(command, args).catch(() => undefined);
	if (result?.code === 0) ctx.ui.notify(`Opened ${label} dashboard in your browser.`, "info");
	else ctx.ui.notify(`Could not open browser. Visit: ${url}`, "warning");
}

async function showUsageDetails(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	stats: SessionStats,
	codexSnapshot: CodexSnapshot | undefined,
	copilotSnapshot: CopilotSnapshot | undefined,
) {
	if (!ctx.hasUI) return;

	const dashboard = getDashboard(stats.provider);

	// Prefer Codex dashboard URL when codex snapshot is present
	const codexDashboardUrl = codexSnapshot
		? PROVIDER_DASHBOARDS["openai-codex"]!.url
		: undefined;

	const dashboardUrl = codexDashboardUrl ?? dashboard?.url;
	const dashboardLabel = codexSnapshot ? "Codex usage" : dashboard?.label ?? "usage";

	const effectiveOpenOption = dashboardUrl
		? `${OPEN_DASHBOARD_OPTION_PREFIX}${dashboardUrl}`
		: undefined;

	pi.events.emit("usage:visibility", true);
	try {
		return await ctx.ui.custom<string | undefined>((_tui, theme, _keybindings, done) => {
			const handleInput = (data: string) => {
				if (data.toLowerCase() === "o" && effectiveOpenOption) {
					done(effectiveOpenOption);
					return;
				}
				if (
					matchesKey(data, Key.enter) ||
					matchesKey(data, Key.escape) ||
					matchesKey(data, Key.ctrl("c")) ||
					data === "q"
				) {
					done(undefined);
				}
			};

			const render = (width: number): string[] => {
				const panelWidth = Math.min(PANEL_WIDTH, Math.max(36, width));
				const add = (lines: string[], content = "") => lines.push(truncateToWidth(content, panelWidth));
				const lines: string[] = [];
				const providerLabel = `${stats.provider}/${stats.model}`;

				lines.push("");
				add(lines, theme.fg("accent", theme.bold(`Usage: ${providerLabel}`)));
				lines.push("");

				if (!codexSnapshot && !copilotSnapshot) {
					add(lines, theme.fg("muted", "  No provider usage or quota data available for this provider."));
					lines.push("");
				}

				// ── Codex rate limits (only for openai-codex) ──────────────
				if (codexSnapshot) {
					const subtitle = [
						codexSnapshot.planType ? `plan: ${codexSnapshot.planType}` : undefined,
						codexSnapshot.email ? `account: ${maskEmail(codexSnapshot.email)}` : undefined,
						`fetched: ${formatFetchedAt(codexSnapshot.fetchedAt)}`,
					]
						.filter(Boolean)
						.join(" · ");

					add(lines, theme.fg("accent", theme.bold("Codex rate limits")));
					add(lines, theme.fg("dim", `  ${subtitle}`));
					lines.push("");

					add(lines, theme.fg("text", `  Current session`));
					add(lines, renderUsageBar(ctx, codexSnapshot.fiveHour));
					add(lines, theme.fg("muted", `  Resets ${formatResetTime(codexSnapshot.fiveHour?.resetAt, "clock")}`));
					lines.push("");

					add(lines, theme.fg("text", `  Current week`));
					add(lines, renderUsageBar(ctx, codexSnapshot.weekly));
					add(lines, theme.fg("muted", `  Resets ${formatResetTime(codexSnapshot.weekly?.resetAt, "date")}`));
					lines.push("");
				}

				// ── Copilot quota (only for github-copilot) ────────────
				if (copilotSnapshot) {
					const subtitle = [
						copilotSnapshot.plan ? `plan: ${copilotSnapshot.plan}` : undefined,
						copilotSnapshot.login ? `account: ${copilotSnapshot.login}` : undefined,
						`fetched: ${formatFetchedAt(copilotSnapshot.fetchedAt)}`,
					]
						.filter(Boolean)
						.join(" · ");

					add(lines, theme.fg("accent", theme.bold("Copilot quota")));
					add(lines, theme.fg("dim", `  ${subtitle}`));
					lines.push("");

					for (const quota of copilotSnapshot.quotas) {
						if (quota.unlimited) {
							add(lines, theme.fg("text", `  ${quota.label}`));
							add(lines, theme.fg("success", "  unlimited"));
							lines.push("");
							continue;
						}

						const used = Math.max(0, quota.entitlement - quota.remaining);
						add(lines, theme.fg("text", `  ${quota.label}`));
						add(lines, renderUsageBar(ctx, { usedPercent: 100 - quota.percentRemaining }));
						add(
							lines,
							theme.fg(
								"muted",
								`  ${formatNumber(used)} / ${formatNumber(quota.entitlement)} used · ${formatNumber(quota.remaining)} left${quota.overagePermitted ? " · overage allowed" : ""}`,
							),
						);
						lines.push("");
					}

					if (copilotSnapshot.resetDate) {
						add(lines, theme.fg("muted", `  Quota resets ${copilotSnapshot.resetDate}`));
						lines.push("");
					}
				}

				// ── Footer ──────────────────────────────────────────────────
				const footer = effectiveOpenOption
					? `o open ${dashboardLabel} · Enter/Esc/q close`
					: "Enter/Esc/q close";
				lines.push("");
				add(lines, theme.fg("dim", footer));
				lines.push("");
				return lines;
			};

			return {
				invalidate() {},
				handleInput,
				render,
			};
		});
	} finally {
		pi.events.emit("usage:visibility", false);
	}
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function usageExtension(pi: ExtensionAPI) {
	let inFlight: Promise<CodexSnapshot | undefined> = Promise.resolve(undefined);

	const queueCodexFetch = (ctx: ExtensionContext) => {
		inFlight = inFlight.catch(() => undefined).then(() => fetchCodexUsage(ctx));
		return inFlight;
	};

	pi.on("model_select", (_event, ctx) => {
		if (isOpenAICodexProvider(ctx.model?.provider)) void queueCodexFetch(ctx);
		else publishGlobalSnapshot(ctx, undefined);
		if (isGitHubCopilotProvider(ctx.model?.provider)) void fetchCopilotUsage(ctx);
		else cachedCopilotSnapshot = undefined;
	});

	pi.on("agent_end", (_event, ctx) => {
		if (isOpenAICodexProvider(ctx.model?.provider)) void queueCodexFetch(ctx);
		if (isGitHubCopilotProvider(ctx.model?.provider)) void fetchCopilotUsage(ctx);
	});

	pi.on("session_shutdown", () => {
		cachedCodexSnapshot = undefined;
		cachedCopilotSnapshot = undefined;
		globalThis[GLOBAL_USAGE_KEY] = undefined;
	});

	pi.registerCommand("usage", {
		description: "Show provider rate limits and quota for the current provider",
		handler: async (_args, ctx) => {
			// Compute session stats (works for any provider)
			const stats = computeSessionStats(ctx);

			// Also fetch Codex rate limits if applicable
			let codexSnapshot: CodexSnapshot | undefined;
			if (isOpenAICodexProvider(ctx.model?.provider)) {
				codexSnapshot = await queueCodexFetch(ctx);
			}

			let copilotSnapshot: CopilotSnapshot | undefined;
			if (isGitHubCopilotProvider(ctx.model?.provider)) {
				copilotSnapshot = (await fetchCopilotUsage(ctx)) ?? cachedCopilotSnapshot;
			}

			const dashboard = getDashboard(stats.provider);
			const selected = await showUsageDetails(pi, ctx, stats, codexSnapshot, copilotSnapshot);
			if (selected?.startsWith(OPEN_DASHBOARD_OPTION_PREFIX)) {
				const url = selected.slice(OPEN_DASHBOARD_OPTION_PREFIX.length);
				await openDashboardUrl(pi, ctx, url, dashboard?.label ?? "usage");
			}
		},
	});
}
