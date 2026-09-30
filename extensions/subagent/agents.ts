import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { packageRoots } from "../shared/package-roots.ts";
import type { AgentConfig, AgentDiagnostic, AgentDiscoveryResult, AgentScope, AgentSource } from "./types.ts";

export interface DiscoverAgentsOptions {
	userAgentsDir?: string;
	projectAgentsDir?: string | null;
	/**
	 * `agents/` dirs from pi packages, lowest precedence first. Defaults to the
	 * user-scope packages in the profile settings, unless `userAgentsDir` is
	 * overridden (tests), in which case no package dirs are used.
	 */
	packageAgentsDirs?: string[];
}

interface ParsedFrontmatter {
	frontmatter: Record<string, unknown>;
	body: string;
	diagnostics: string[];
}

export function getDefaultPackageAgentsDirs(cwd: string): string[] {
	return packageRoots(cwd).map((pkg) => path.join(pkg.root, "agents"));
}

function defaultAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function getDefaultUserAgentsDir(): string {
	return path.join(defaultAgentDir(), "agents");
}

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseScalarOrInlineList(rawValue: string): unknown {
	const value = rawValue.trim();
	if (value.startsWith("[") && value.endsWith("]")) {
		const inner = value.slice(1, -1).trim();
		if (!inner) return [];
		return inner
			.split(",")
			.map((item) => stripQuotes(item.trim()))
			.filter(Boolean);
	}
	if (value === "true") return true;
	if (value === "false") return false;
	return stripQuotes(value);
}

export function parseSimpleFrontmatter(content: string): ParsedFrontmatter {
	const diagnostics: string[] = [];
	const normalized = content.replace(/^\uFEFF/, "");
	if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
		return { frontmatter: {}, body: normalized, diagnostics: ["Missing YAML frontmatter block."] };
	}

	const lineEnd = normalized.startsWith("---\r\n") ? "\r\n" : "\n";
	const bodyStartOffset = 3 + lineEnd.length;
	const closingPattern = new RegExp(`(?:^|\\n)---\\s*(?:\\n|$)`);
	const closing = closingPattern.exec(normalized.slice(bodyStartOffset));
	if (!closing) {
		return { frontmatter: {}, body: normalized.slice(bodyStartOffset), diagnostics: ["Unclosed YAML frontmatter block."] };
	}

	const frontmatterText = normalized.slice(bodyStartOffset, bodyStartOffset + closing.index).replace(/^\n/, "");
	const bodyOffset = bodyStartOffset + closing.index + closing[0].length;
	const body = normalized.slice(bodyOffset);
	const frontmatter: Record<string, unknown> = {};
	const lines = frontmatterText.split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i];
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = rawLine.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
		if (!match) {
			diagnostics.push(`Ignoring invalid frontmatter line ${i + 1}: ${rawLine}`);
			continue;
		}
		frontmatter[match[1]] = parseScalarOrInlineList(match[2]);
	}

	return { frontmatter, body, diagnostics };
}

function stringField(frontmatter: Record<string, unknown>, key: string): string | undefined {
	const value = frontmatter[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

export function normalizeTools(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	const rawItems = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = rawItems
		.map((item) => (typeof item === "string" ? item.trim() : ""))
		.filter(Boolean);
	return tools.length > 0 ? Array.from(new Set(tools)) : undefined;
}

export function parseAgentMarkdown(
	content: string,
	filePath: string,
	source: Exclude<AgentSource, "unknown">,
): { agent?: AgentConfig; diagnostics: AgentDiagnostic[] } {
	const parsed = parseSimpleFrontmatter(content);
	const diagnostics: AgentDiagnostic[] = parsed.diagnostics.map((message) => ({ level: "warning", source, filePath, message }));

	const name = stringField(parsed.frontmatter, "name");
	const description = stringField(parsed.frontmatter, "description");
	if (!name) diagnostics.push({ level: "error", source, filePath, message: "Agent is missing required frontmatter field: name." });
	if (!description)
		diagnostics.push({ level: "error", source, filePath, message: "Agent is missing required frontmatter field: description." });
	if (name && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
		diagnostics.push({
			level: "error",
			source,
			filePath,
			message: `Agent name "${name}" is invalid. Use letters, numbers, dots, underscores, or hyphens.`,
		});
	}

	if (diagnostics.some((diagnostic) => diagnostic.level === "error")) return { diagnostics };

	const tools = normalizeTools(parsed.frontmatter.tools);
	const model = stringField(parsed.frontmatter, "model");
	return {
		diagnostics,
		agent: {
			name: name!,
			description: description!,
			tools,
			model,
			systemPrompt: parsed.body.trim(),
			source,
			filePath,
		},
	};
}

function loadAgentsFromDir(dir: string, source: Exclude<AgentSource, "unknown">): { agents: AgentConfig[]; diagnostics: AgentDiagnostic[] } {
	const agents: AgentConfig[] = [];
	const diagnostics: AgentDiagnostic[] = [];

	if (!fs.existsSync(dir)) return { agents, diagnostics };

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		diagnostics.push({
			level: "warning",
			source,
			filePath: dir,
			message: `Could not read agent directory: ${error instanceof Error ? error.message : String(error)}`,
		});
		return { agents, diagnostics };
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf8");
		} catch (error) {
			diagnostics.push({
				level: "warning",
				source,
				filePath,
				message: `Could not read agent file: ${error instanceof Error ? error.message : String(error)}`,
			});
			continue;
		}

		const parsed = parseAgentMarkdown(content, filePath, source);
		diagnostics.push(...parsed.diagnostics);
		if (parsed.agent) agents.push(parsed.agent);
	}

	agents.sort((a, b) => a.name.localeCompare(b.name) || a.filePath.localeCompare(b.filePath));
	return { agents, diagnostics };
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = path.resolve(cwd || process.cwd());
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope = "both", options: DiscoverAgentsOptions = {}): AgentDiscoveryResult {
	const userAgentsDir = options.userAgentsDir ?? getDefaultUserAgentsDir();
	const projectAgentsDir = options.projectAgentsDir === undefined ? findNearestProjectAgentsDir(cwd) : options.projectAgentsDir;

	const packageAgentsDirs = options.packageAgentsDirs ?? (options.userAgentsDir ? [] : getDefaultPackageAgentsDirs(cwd));

	// Package agents load first so the profile's own agents/ can override them by name.
	const user: { agents: AgentConfig[]; diagnostics: AgentDiagnostic[] } = { agents: [], diagnostics: [] };
	if (scope !== "project") {
		for (const dir of [...packageAgentsDirs, userAgentsDir]) {
			const loaded = loadAgentsFromDir(dir, "user");
			user.agents.push(...loaded.agents);
			user.diagnostics.push(...loaded.diagnostics);
		}
	}
	const project = scope === "user" || !projectAgentsDir ? { agents: [], diagnostics: [] } : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();
	if (scope === "project") {
		for (const agent of project.agents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of user.agents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of user.agents) agentMap.set(agent.name, agent);
		for (const agent of project.agents) agentMap.set(agent.name, agent);
	}

	return {
		agents: Array.from(agentMap.values()).sort((a, b) => a.name.localeCompare(b.name)),
		projectAgentsDir,
		diagnostics: [...user.diagnostics, ...project.diagnostics],
	};
}

export function formatAgentList(agents: AgentConfig[], maxItems = 20): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("; "),
		remaining,
	};
}

export function formatAvailableAgents(agents: AgentConfig[]): string {
	const list = formatAgentList(agents, 30);
	return list.remaining > 0 ? `${list.text}; ... +${list.remaining} more` : list.text;
}
