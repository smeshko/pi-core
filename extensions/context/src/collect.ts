import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { walkSkipReason } from "../../shared/nested-agents.ts";
import { packageRoots } from "../../shared/package-roots.ts";

export const CATEGORY_KEYS = ["system", "tools", "mcp", "files", "skills", "messages"] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];

export type Category = { key: CategoryKey; label: string; tokens: number };

export type ContextReport = {
	model: { name: string; id: string; provider: string; contextWindow: number; thinking: string };
	measured: boolean;
	totalTokens: number;
	estimatedTotal: number;
	categories: Category[];
	free: number;
	mcp: {
		loaded: Array<{ name: string; tokens: number }>;
		servers: Array<{
			name: string;
			type: string;
			scope: string;
			status: string;
			error?: string;
			availableCount: number;
			availableTokens: number;
		}>;
		savedTokens: number;
	};
	contextFiles: Array<{ path: string; tokens: number }>;
	memoryFiles: Array<{ path: string; tokens: number; loaded: boolean }>;
	skills: Array<{ name: string; tokens: number; scope: string }>;
	extensions: Array<{ name: string; scope: string; tools: number; mcpTools: number; commands: string[] }>;
	commands: { extension: string[]; skill: string[]; prompt: string[] };
	agents: Array<{ name: string; scope: string; description: string }>;
	keybindings: {
		total?: number;
		overrides: string[];
		configPath: string;
		exists: boolean;
		extensionShortcuts: Array<{ key: string; description: string; extension: string }>;
	};
	themes: string[];
};

type McpSnapshot = {
	servers: Array<{
		name: string;
		type: string;
		scope: string;
		status: string;
		error?: string;
		toolNames: string[];
	}>;
	toolOwners: Record<string, string>;
	configErrors: string[];
};

const MCP_REGISTRY_REQUEST = "mcp:registry:request";

export function toTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function homeRelative(filePath: string, cwd: string): string {
	const relative = path.relative(cwd, filePath);
	if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
	const home = os.homedir();
	return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

function readDirSafe(dir: string): string[] {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

/** Asks the MCP extension for its live registry. Returns undefined when it is not loaded. */
function requestMcpSnapshot(pi: ExtensionAPI): McpSnapshot | undefined {
	let snapshot: McpSnapshot | undefined;
	try {
		pi.events.emit(MCP_REGISTRY_REQUEST, {
			respond: (value: McpSnapshot) => {
				snapshot = value;
			},
		});
	} catch {
		return undefined;
	}
	return snapshot;
}

function toolTokens(tool: { description?: string; parameters?: unknown }): number {
	const description = tool.description ?? "";
	let parameters = "";
	try {
		parameters = JSON.stringify(tool.parameters ?? {});
	} catch {
		parameters = "";
	}
	return toTokens(description.length + parameters.length);
}

function parseFrontmatter(content: string): Record<string, string> {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return {};
	const result: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator === -1) continue;
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
		if (key) result[key] = value;
	}
	return result;
}

/** Package resource dirs, labelled with the package folder name (e.g. `pi-core`). */
function packageDirs(cwd: string, projectTrusted: boolean, subdir: string): Array<{ dir: string; scope: string }> {
	return packageRoots(cwd, { projectTrusted }).map((pkg) => ({
		dir: path.join(pkg.root, subdir),
		scope: path.basename(pkg.root),
	}));
}

/** Same precedence as the subagent extension: packages < profile < project; later names win. */
function collectAgents(cwd: string): ContextReport["agents"] {
	const sources: Array<{ dir: string; scope: string }> = [
		...packageDirs(cwd, false, "agents"),
		{ dir: path.join(agentDir(), "agents"), scope: "user" },
		{ dir: path.join(cwd, ".pi", "agents"), scope: "project" },
	];

	const byName = new Map<string, ContextReport["agents"][number]>();
	for (const { dir, scope } of sources) {
		for (const file of readDirSafe(dir)) {
			if (!file.endsWith(".md")) continue;
			let content = "";
			try {
				content = fs.readFileSync(path.join(dir, file), "utf8");
			} catch {
				continue;
			}
			const meta = parseFrontmatter(content);
			const name = meta.name ?? path.basename(file, ".md");
			byName.set(name, {
				name,
				scope,
				description: (meta.description ?? "").split(/(?<=\.)\s/)[0] ?? "",
			});
		}
	}
	return [...byName.values()];
}

export function collectExtensionDirs(cwd: string, projectTrusted: boolean): Array<{ name: string; scope: string; entryPaths: string[] }> {
	const sources: Array<{ dir: string; scope: string }> = [
		...packageDirs(cwd, projectTrusted, "extensions"),
		{ dir: path.join(agentDir(), "extensions"), scope: "user" },
		{ dir: path.join(cwd, ".pi", "extensions"), scope: "project" },
	];

	const results: Array<{ name: string; scope: string; entryPaths: string[] }> = [];
	for (const { dir, scope } of sources) {
		for (const entry of readDirSafe(dir)) {
			const full = path.join(dir, entry);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(full);
			} catch {
				continue;
			}

			if (stat.isDirectory()) {
				const index = path.join(full, "index.ts");
				if (fs.existsSync(index)) {
					results.push({ name: `${entry}/`, scope, entryPaths: [full] });
				}
			} else if (entry.endsWith(".ts")) {
				results.push({ name: entry, scope, entryPaths: [full] });
			}
		}
	}
	return results;
}

const MEMORY_FILE_NAMES = new Set(["agents.md", "claude.md"]);
const MEMORY_SKIP_DIRS = new Set([
	".git",
	".hg",
	"node_modules",
	"build",
	"dist",
	"out",
	"coverage",
	".dart_tool",
	".venv",
	"venv",
	"__pycache__",
	".next",
	"Pods",
	".gradle",
	".idea",
	".ruff_cache",
	"target",
]);
const MEMORY_MAX_DEPTH = 8;
const MEMORY_MAX_FILES = 200;

/**
 * Finds every AGENTS.md / CLAUDE.md under cwd plus the ancestors pi and Claude Code consult.
 *
 * The downward walk uses the same gate as nested-agents: only a git repository
 * root with its own AGENTS.md is walked. Anywhere else (e.g. `~`) only cwd itself
 * is checked, otherwise this would crawl the whole disk.
 */
export function collectMemoryFiles(cwd: string, loadedPaths: Set<string>): ContextReport["memoryFiles"] {
	const found = new Map<string, number>();

	const addFile = (filePath: string) => {
		if (found.has(filePath) || found.size >= MEMORY_MAX_FILES) return;
		try {
			found.set(filePath, fs.statSync(filePath).size);
		} catch {
			// Unreadable file; skip it.
		}
	};

	const visit = (dir: string, depth: number) => {
		if (depth > MEMORY_MAX_DEPTH || found.size >= MEMORY_MAX_FILES) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (MEMORY_SKIP_DIRS.has(entry.name)) continue;
				visit(path.join(dir, entry.name), depth + 1);
			} else if (entry.isFile() && MEMORY_FILE_NAMES.has(entry.name.toLowerCase())) {
				addFile(path.join(dir, entry.name));
			}
		}
	};

	if (walkSkipReason(cwd)) {
		for (const name of ["AGENTS.md", "CLAUDE.md"]) {
			const candidate = path.join(cwd, name);
			if (fs.existsSync(candidate)) addFile(candidate);
		}
	} else {
		visit(cwd, 0);
	}

	// Ancestors above cwd, plus the global agent directory.
	let ancestor = path.dirname(cwd);
	const home = os.homedir();
	for (let depth = 0; depth < 6; depth++) {
		for (const name of ["AGENTS.md", "CLAUDE.md"]) {
			const candidate = path.join(ancestor, name);
			if (fs.existsSync(candidate)) addFile(candidate);
		}
		if (ancestor === home || ancestor === path.dirname(ancestor)) break;
		ancestor = path.dirname(ancestor);
	}
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		const candidate = path.join(agentDir(), name);
		if (fs.existsSync(candidate)) addFile(candidate);
	}
	for (const loaded of loadedPaths) addFile(loaded);

	return [...found.entries()]
		.map(([filePath, size]) => ({
			path: homeRelative(filePath, cwd),
			tokens: toTokens(size),
			loaded: loadedPaths.has(filePath),
		}))
		.sort((a, b) => Number(b.loaded) - Number(a.loaded) || b.tokens - a.tokens);
}

const SHORTCUT_PATTERN = /registerShortcut\(\s*([^,]+?),\s*\{([\s\S]{0,200}?)\}/g;

function humanizeShortcutKey(expression: string): string | undefined {
	const trimmed = expression.trim();
	const literal = trimmed.match(/^["'`]([^"'`]+)["'`]$/);
	if (literal) return literal[1];

	const helper = trimmed.match(/^Key\.(\w+)(?:\(\s*["'`]([^"'`]+)["'`]\s*\))?$/);
	if (!helper) return undefined;

	const modifiers: Record<string, string> = {
		ctrl: "ctrl",
		alt: "alt",
		shift: "shift",
		ctrlAlt: "ctrl+alt",
		ctrlShift: "ctrl+shift",
		altShift: "alt+shift",
	};
	const prefix = modifiers[helper[1]];
	if (prefix && helper[2]) return `${prefix}+${helper[2]}`;
	return helper[2] ? `${helper[1]}+${helper[2]}` : helper[1];
}

/** Extension shortcuts are not exposed by the API, so read them out of the sources. */
function collectExtensionShortcuts(
	extensions: Array<{ name: string; entryPaths: string[] }>,
): ContextReport["keybindings"]["extensionShortcuts"] {
	const shortcuts: ContextReport["keybindings"]["extensionShortcuts"] = [];

	for (const extension of extensions) {
		const files: string[] = [];
		for (const entry of extension.entryPaths) {
			try {
				if (fs.statSync(entry).isDirectory()) {
					for (const name of readDirSafe(entry)) {
						if (name.endsWith(".ts")) files.push(path.join(entry, name));
					}
				} else {
					files.push(entry);
				}
			} catch {
				continue;
			}
		}

		for (const file of files) {
			let source = "";
			try {
				source = fs.readFileSync(file, "utf8");
			} catch {
				continue;
			}

			for (const match of source.matchAll(SHORTCUT_PATTERN)) {
				const key = humanizeShortcutKey(match[1] ?? "");
				if (!key) continue;
				const description = match[2]?.match(/description:\s*["'`]([^"'`]+)/)?.[1] ?? "";
				shortcuts.push({ key, description, extension: extension.name });
			}
		}
	}

	return shortcuts;
}

function collectKeybindings(
	extensions: Array<{ name: string; entryPaths: string[] }>,
): ContextReport["keybindings"] {
	const configPath = path.join(agentDir(), "keybindings.json");
	const exists = fs.existsSync(configPath);
	const overrides: string[] = [];

	if (exists) {
		try {
			const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
			for (const [key, value] of Object.entries(parsed)) {
				if (key.startsWith("$")) continue;
				overrides.push(`${key} = ${Array.isArray(value) ? value.join(", ") : String(value)}`);
			}
		} catch {
			overrides.push("(failed to parse keybindings.json)");
		}
	}

	return {
		total: defaultKeybindingCount,
		overrides,
		configPath,
		exists,
		extensionShortcuts: collectExtensionShortcuts(extensions),
	};
}

let defaultKeybindingCount: number | undefined;

/** Walks up from the running pi binary to locate its package root. */
function findPiPackageRoot(): string | undefined {
	try {
		let dir = path.dirname(fs.realpathSync(process.argv[1] ?? ""));
		for (let depth = 0; depth < 6; depth++) {
			const manifest = path.join(dir, "package.json");
			if (fs.existsSync(manifest)) {
				const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: string };
				if (parsed.name === "@earendil-works/pi-coding-agent") return dir;
			}
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/**
 * Loads the built-in keybinding table. It sits behind the package exports map,
 * so locate the package root and import the internal module by absolute path.
 */
export async function preloadKeybindingDefaults(): Promise<void> {
	if (defaultKeybindingCount !== undefined) return;
	const root = findPiPackageRoot();
	if (!root) return;
	try {
		const moduleUrl = pathToFileURL(path.join(root, "dist", "core", "keybindings.js")).href;
		const defaults = (await import(moduleUrl)) as { KEYBINDINGS?: Record<string, unknown> };
		if (defaults.KEYBINDINGS) defaultKeybindingCount = Object.keys(defaults.KEYBINDINGS).length;
	} catch {
		defaultKeybindingCount = undefined;
	}
}

function estimateMessageTokens(ctx: ExtensionCommandContext): number {
	let total = 0;
	try {
		for (const entry of ctx.sessionManager.buildContextEntries()) {
			if (entry.type !== "message") continue;
			try {
				total += estimateTokens(entry.message as Parameters<typeof estimateTokens>[0]);
			} catch {
				// Skip message shapes the estimator does not understand.
			}
		}
	} catch {
		return 0;
	}
	return total;
}

export function collectReport(pi: ExtensionAPI, ctx: ExtensionCommandContext): ContextReport {
	const options = ctx.getSystemPromptOptions();
	const systemPromptTokens = toTokens(ctx.getSystemPrompt().length);

	const contextFiles = (options.contextFiles ?? []).map((file) => ({
		path: homeRelative(file.path, ctx.cwd),
		tokens: toTokens(file.content.length),
	}));
	const contextFileTokens = contextFiles.reduce((sum, file) => sum + file.tokens, 0);

	const skills = (options.skills ?? []).map((skill) => ({
		name: skill.name,
		scope: skill.sourceInfo?.scope ?? "user",
		// The prompt embeds name, description, and path for each skill.
		tokens: toTokens(skill.name.length + skill.description.length + skill.filePath.length + 8),
	}));
	const skillTokens = skills.reduce((sum, skill) => sum + skill.tokens, 0);

	const baseSystemTokens = Math.max(0, systemPromptTokens - contextFileTokens - skillTokens);

	const snapshot = requestMcpSnapshot(pi);
	const owners = snapshot?.toolOwners ?? {};
	const isMcpTool = (name: string) => (snapshot ? name in owners : name.startsWith("mcp__"));

	const allTools = pi.getAllTools();
	const activeNames = new Set(pi.getActiveTools());

	let nativeToolTokens = 0;
	const loadedMcp: Array<{ name: string; tokens: number }> = [];
	const availableByServer = new Map<string, { count: number; tokens: number }>();

	for (const tool of allTools) {
		const tokens = toolTokens(tool);
		const mcpTool = isMcpTool(tool.name);

		if (activeNames.has(tool.name)) {
			if (mcpTool) loadedMcp.push({ name: tool.name, tokens });
			else nativeToolTokens += tokens;
			continue;
		}

		if (!mcpTool) continue;
		const server = owners[tool.name] ?? tool.name.split("__")[1] ?? "unknown";
		const bucket = availableByServer.get(server) ?? { count: 0, tokens: 0 };
		bucket.count++;
		bucket.tokens += tokens;
		availableByServer.set(server, bucket);
	}

	loadedMcp.sort((a, b) => b.tokens - a.tokens);
	const loadedMcpTokens = loadedMcp.reduce((sum, tool) => sum + tool.tokens, 0);

	const servers = (snapshot?.servers ?? [...availableByServer.keys()].map((name) => ({
		name,
		type: "stdio",
		scope: "user",
		status: "connected",
		error: undefined,
		toolNames: [],
	}))).map((server) => {
		const bucket = availableByServer.get(server.name) ?? { count: 0, tokens: 0 };
		return {
			name: server.name,
			type: server.type,
			scope: server.scope,
			status: server.status,
			error: server.error,
			availableCount: bucket.count,
			availableTokens: bucket.tokens,
		};
	});
	const savedTokens = servers.reduce((sum, server) => sum + server.availableTokens, 0);

	const fixedTokens =
		baseSystemTokens + nativeToolTokens + loadedMcpTokens + contextFileTokens + skillTokens;

	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const measuredTotal = usage?.tokens && usage.tokens > 0 ? usage.tokens : undefined;

	const messageTokens =
		measuredTotal !== undefined
			? Math.max(0, measuredTotal - fixedTokens)
			: estimateMessageTokens(ctx);

	const estimatedTotal = fixedTokens + messageTokens;
	const totalTokens = measuredTotal ?? estimatedTotal;

	const categories: Category[] = [
		{ key: "system", label: "System prompt", tokens: baseSystemTokens },
		{ key: "tools", label: "System tools", tokens: nativeToolTokens },
		{ key: "mcp", label: "MCP tools", tokens: loadedMcpTokens },
		{ key: "files", label: "Context files", tokens: contextFileTokens },
		{ key: "skills", label: "Skills", tokens: skillTokens },
		{ key: "messages", label: "Messages", tokens: messageTokens },
	];

	const commandInfos = pi.getCommands();
	const commands = {
		extension: commandInfos.filter((c) => c.source === "extension").map((c) => c.name),
		skill: commandInfos.filter((c) => c.source === "skill").map((c) => c.name),
		prompt: commandInfos.filter((c) => c.source === "prompt").map((c) => c.name),
	};

	const projectTrusted = ctx.isProjectTrusted?.() ?? false;
	const extensionDirs = collectExtensionDirs(ctx.cwd, projectTrusted);
	const extensions = extensionDirs.map((extension) => {
		const owns = (candidate: string | undefined) =>
			!!candidate && extension.entryPaths.some((base) => candidate === base || candidate.startsWith(`${base}/`));

		const ownTools = allTools.filter((tool) => owns(tool.sourceInfo?.path));
		return {
			name: extension.name,
			scope: extension.scope,
			tools: ownTools.filter((tool) => !isMcpTool(tool.name)).length,
			mcpTools: ownTools.filter((tool) => isMcpTool(tool.name)).length,
			commands: commandInfos
				.filter((command) => command.source === "extension" && owns(command.sourceInfo?.path))
				.map((command) => command.name),
		};
	});

	let themes: string[] = [];
	try {
		themes = (ctx.ui.getAllThemes?.() ?? []).map((theme) => theme.name);
	} catch {
		themes = [];
	}

	const loadedMemoryPaths = new Set((options.contextFiles ?? []).map((file) => file.path));

	return {
		model: {
			name: ctx.model?.name ?? "unknown",
			id: ctx.model?.id ?? "unknown",
			provider: ctx.model?.provider ?? "unknown",
			contextWindow,
			thinking: ctx.thinkingLevel ?? "off",
		},
		measured: measuredTotal !== undefined,
		totalTokens,
		estimatedTotal,
		categories,
		free: Math.max(0, contextWindow - totalTokens),
		mcp: { loaded: loadedMcp, servers, savedTokens },
		contextFiles,
		memoryFiles: collectMemoryFiles(ctx.cwd, loadedMemoryPaths),
		skills: skills.sort((a, b) => b.tokens - a.tokens),
		extensions,
		commands,
		agents: collectAgents(ctx.cwd),
		keybindings: collectKeybindings(extensionDirs),
		themes,
	};
}
