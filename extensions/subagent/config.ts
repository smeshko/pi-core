import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeTools } from "./agents.ts";
import type {
	ChildRuntimePolicy,
	ConfigDiagnostic,
	ContextFilesPolicy,
	LoadedSubagentConfig,
	PartialResourcePolicyInput,
	PartialRuntimePolicyInput,
	RecursionPolicy,
	ResourceListPolicy,
	ResourcePolicyMode,
	SubagentConfig,
	SubagentParams,
} from "./types.ts";

export const PI_SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";

export const DEFAULT_RUNTIME_POLICY: ChildRuntimePolicy = Object.freeze({
	extensions: Object.freeze({ mode: "inherit", allow: [] }),
	skills: Object.freeze({ mode: "inherit", allow: [] }),
	promptTemplates: Object.freeze({ mode: "inherit", allow: [] }),
	contextFiles: "inherit",
});

export const DEFAULT_RECURSION_POLICY: RecursionPolicy = Object.freeze({ allow: false, maxDepth: 4 });

export const DEFAULT_CONFIG: SubagentConfig = Object.freeze({
	agentScope: "both",
	confirmProjectAgents: false,
	maxParallelTasks: 8,
	maxConcurrency: 4,
	defaultTools: undefined,
	runtime: DEFAULT_RUNTIME_POLICY,
	recursion: DEFAULT_RECURSION_POLICY,
	stderrMaxBytes: 16 * 1024,
	killTimeoutMs: 5_000,
	emptyOutputRetries: 3,
});

export interface LoadSubagentConfigOptions {
	userConfigPath?: string;
	projectConfigPath?: string | null;
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function defaultUserConfigPath(): string {
	return path.join(agentDir(), "subagent.config.json");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isResourceMode(value: unknown): value is ResourcePolicyMode {
	return value === "inherit" || value === "none" || value === "allowlist";
}

function isContextPolicy(value: unknown): value is ContextFilesPolicy {
	return value === "inherit" || value === "none";
}

function isAgentScope(value: unknown): value is SubagentConfig["agentScope"] {
	return value === "user" || value === "project" || value === "both";
}

function readJsonFile(filePath: string): { data?: Record<string, unknown>; diagnostic?: ConfigDiagnostic } {
	if (!fs.existsSync(filePath)) return {};
	try {
		const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (!isPlainRecord(data)) {
			return { diagnostic: { level: "error", filePath, message: "Config file must contain a JSON object." } };
		}
		return { data };
	} catch (error) {
		return {
			diagnostic: {
				level: "error",
				filePath,
				message: `Could not parse config: ${error instanceof Error ? error.message : String(error)}`,
			},
		};
	}
}

function expandPath(input: string, baseDir: string): string {
	const expanded = input === "~" ? os.homedir() : input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
	return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDir, expanded);
}

function normalizeStringArray(value: unknown, baseDir: string): string[] {
	if (!Array.isArray(value)) return [];
	return Array.from(
		new Set(
			value
				.map((item) => (typeof item === "string" ? item.trim() : ""))
				.filter(Boolean)
				.map((item) => expandPath(item, baseDir)),
		),
	);
}

function normalizeResourcePolicy(
	current: ResourceListPolicy,
	value: unknown,
	baseDir: string,
	diagnostics: ConfigDiagnostic[],
	filePath: string,
	key: string,
): ResourceListPolicy {
	if (value === undefined) return current;
	if (typeof value === "string") {
		if (isResourceMode(value)) return { ...current, mode: value };
		diagnostics.push({ level: "warning", filePath, message: `Ignoring runtime.${key}: invalid mode "${value}".` });
		return current;
	}
	if (!isPlainRecord(value)) {
		diagnostics.push({ level: "warning", filePath, message: `Ignoring runtime.${key}: expected object or mode string.` });
		return current;
	}

	let mode = current.mode;
	if (value.mode !== undefined) {
		if (isResourceMode(value.mode)) mode = value.mode;
		else diagnostics.push({ level: "warning", filePath, message: `Ignoring runtime.${key}.mode: invalid mode.` });
	}
	const allow = value.allow === undefined ? current.allow : normalizeStringArray(value.allow, baseDir);
	return { mode, allow };
}

function mergeRuntimePolicy(
	current: ChildRuntimePolicy,
	value: unknown,
	baseDir: string,
	diagnostics: ConfigDiagnostic[],
	filePath: string,
): ChildRuntimePolicy {
	if (value === undefined) return current;
	if (!isPlainRecord(value)) {
		diagnostics.push({ level: "warning", filePath, message: "Ignoring runtime: expected object." });
		return current;
	}

	let contextFiles = current.contextFiles;
	if (value.contextFiles !== undefined) {
		if (isContextPolicy(value.contextFiles)) contextFiles = value.contextFiles;
		else diagnostics.push({ level: "warning", filePath, message: "Ignoring runtime.contextFiles: expected inherit or none." });
	}

	return {
		extensions: normalizeResourcePolicy(current.extensions, value.extensions, baseDir, diagnostics, filePath, "extensions"),
		skills: normalizeResourcePolicy(current.skills, value.skills, baseDir, diagnostics, filePath, "skills"),
		promptTemplates: normalizeResourcePolicy(
			current.promptTemplates,
			value.promptTemplates,
			baseDir,
			diagnostics,
			filePath,
			"promptTemplates",
		),
		contextFiles,
	};
}

function positiveInteger(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function mergeRecursionPolicy(
	current: RecursionPolicy,
	value: unknown,
	diagnostics: ConfigDiagnostic[],
	filePath: string,
): RecursionPolicy {
	if (value === undefined) return current;
	if (typeof value === "boolean") return { ...current, allow: value };
	if (!isPlainRecord(value)) {
		diagnostics.push({ level: "warning", filePath, message: "Ignoring recursion: expected object or boolean." });
		return current;
	}
	return {
		allow: typeof value.allow === "boolean" ? value.allow : current.allow,
		maxDepth: positiveInteger(value.maxDepth, current.maxDepth, 1, 16),
	};
}

function mergeConfigObject(current: SubagentConfig, data: Record<string, unknown>, filePath: string): { config: SubagentConfig; diagnostics: ConfigDiagnostic[] } {
	const diagnostics: ConfigDiagnostic[] = [];
	const baseDir = path.dirname(filePath);
	const next: SubagentConfig = {
		...current,
		runtime: {
			extensions: { ...current.runtime.extensions, allow: [...current.runtime.extensions.allow] },
			skills: { ...current.runtime.skills, allow: [...current.runtime.skills.allow] },
			promptTemplates: { ...current.runtime.promptTemplates, allow: [...current.runtime.promptTemplates.allow] },
			contextFiles: current.runtime.contextFiles,
		},
		recursion: { ...current.recursion },
		defaultTools: current.defaultTools ? [...current.defaultTools] : undefined,
	};

	if (data.agentScope !== undefined) {
		if (isAgentScope(data.agentScope)) next.agentScope = data.agentScope;
		else diagnostics.push({ level: "warning", filePath, message: "Ignoring agentScope: expected user, project, or both." });
	}
	if (typeof data.confirmProjectAgents === "boolean") next.confirmProjectAgents = data.confirmProjectAgents;
	if (data.maxParallelTasks !== undefined) next.maxParallelTasks = positiveInteger(data.maxParallelTasks, next.maxParallelTasks, 1, 32);
	if (data.maxConcurrency !== undefined) next.maxConcurrency = positiveInteger(data.maxConcurrency, next.maxConcurrency, 1, 16);
	if (data.stderrMaxBytes !== undefined) next.stderrMaxBytes = positiveInteger(data.stderrMaxBytes, next.stderrMaxBytes, 1024, 1024 * 1024);
	if (data.killTimeoutMs !== undefined) next.killTimeoutMs = positiveInteger(data.killTimeoutMs, next.killTimeoutMs, 250, 60_000);
	if (data.emptyOutputRetries !== undefined) next.emptyOutputRetries = positiveInteger(data.emptyOutputRetries, next.emptyOutputRetries, 0, 10);
	if (data.defaultTools !== undefined) next.defaultTools = normalizeTools(data.defaultTools) ?? [];
	next.runtime = mergeRuntimePolicy(next.runtime, data.runtime, baseDir, diagnostics, filePath);
	next.recursion = mergeRecursionPolicy(next.recursion, data.recursion, diagnostics, filePath);

	return { config: next, diagnostics };
}

function isFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

export function findNearestProjectConfigPath(cwd: string): string | null {
	let currentDir = path.resolve(cwd || process.cwd());
	while (true) {
		const candidate = path.join(currentDir, ".pi", "subagent.config.json");
		if (isFile(candidate)) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function loadSubagentConfig(cwd: string, options: LoadSubagentConfigOptions = {}): LoadedSubagentConfig {
	const userConfigPath = options.userConfigPath ?? defaultUserConfigPath();
	const projectConfigPath = options.projectConfigPath === undefined ? findNearestProjectConfigPath(cwd) : options.projectConfigPath;
	let config: SubagentConfig = {
		...DEFAULT_CONFIG,
		runtime: {
			extensions: { ...DEFAULT_CONFIG.runtime.extensions },
			skills: { ...DEFAULT_CONFIG.runtime.skills },
			promptTemplates: { ...DEFAULT_CONFIG.runtime.promptTemplates },
			contextFiles: DEFAULT_CONFIG.runtime.contextFiles,
		},
		recursion: { ...DEFAULT_CONFIG.recursion },
	};
	const diagnostics: ConfigDiagnostic[] = [];
	const loadedPaths: string[] = [];

	for (const filePath of [userConfigPath, projectConfigPath].filter((p): p is string => Boolean(p))) {
		const loaded = readJsonFile(filePath);
		if (loaded.diagnostic) diagnostics.push(loaded.diagnostic);
		if (!loaded.data) continue;
		loadedPaths.push(filePath);
		const merged = mergeConfigObject(config, loaded.data, filePath);
		config = merged.config;
		diagnostics.push(...merged.diagnostics);
	}

	config.maxConcurrency = Math.min(config.maxConcurrency, config.maxParallelTasks);
	return { config, diagnostics, userConfigPath, projectConfigPath, loadedPaths };
}

export function mergeRuntimeOverride(current: ChildRuntimePolicy, override: PartialRuntimePolicyInput | undefined, baseDir: string): ChildRuntimePolicy {
	if (!override) return current;
	const diagnostics: ConfigDiagnostic[] = [];
	return mergeRuntimePolicy(current, override, baseDir, diagnostics, "<tool-params>");
}

export function applyToolParamOverrides(config: SubagentConfig, params: SubagentParams, cwd: string): SubagentConfig {
	const next: SubagentConfig = {
		...config,
		runtime: {
			extensions: { ...config.runtime.extensions, allow: [...config.runtime.extensions.allow] },
			skills: { ...config.runtime.skills, allow: [...config.runtime.skills.allow] },
			promptTemplates: { ...config.runtime.promptTemplates, allow: [...config.runtime.promptTemplates.allow] },
			contextFiles: config.runtime.contextFiles,
		},
		recursion: { ...config.recursion },
		defaultTools: config.defaultTools ? [...config.defaultTools] : undefined,
	};
	if (params.agentScope) next.agentScope = params.agentScope;
	if (params.confirmProjectAgents !== undefined) next.confirmProjectAgents = params.confirmProjectAgents;
	if (params.tools !== undefined) next.defaultTools = normalizeTools(params.tools) ?? [];
	if (params.runtime) next.runtime = mergeRuntimeOverride(next.runtime, params.runtime, cwd);
	return next;
}

export function buildResourcePolicyArgs(policy: ResourceListPolicy, noFlag: string, addFlag: string): string[] {
	if (policy.mode === "inherit") return [];
	const args = [noFlag];
	if (policy.mode === "allowlist") {
		for (const allowedPath of policy.allow) args.push(addFlag, allowedPath);
	}
	return args;
}

export function buildRuntimeArgs(runtime: ChildRuntimePolicy): string[] {
	return [
		...buildResourcePolicyArgs(runtime.extensions, "--no-extensions", "--extension"),
		...buildResourcePolicyArgs(runtime.skills, "--no-skills", "--skill"),
		...buildResourcePolicyArgs(runtime.promptTemplates, "--no-prompt-templates", "--prompt-template"),
		...(runtime.contextFiles === "none" ? ["--no-context-files"] : []),
	];
}

export function getSubagentDepth(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[PI_SUBAGENT_DEPTH_ENV];
	if (!raw) return 0;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function buildChildEnv(parentEnv: NodeJS.ProcessEnv, config: SubagentConfig): NodeJS.ProcessEnv {
	return {
		...parentEnv,
		[PI_SUBAGENT_DEPTH_ENV]: String(getSubagentDepth(parentEnv) + 1),
		PI_SUBAGENT_RECURSION_ALLOWED: config.recursion.allow ? "1" : "0",
	};
}

export function shouldRegisterSubagentTool(config: SubagentConfig, depth = getSubagentDepth()): boolean {
	if (depth <= 0) return true;
	return config.recursion.allow && depth < config.recursion.maxDepth;
}

export function recursionBlockMessage(config: SubagentConfig, depth = getSubagentDepth()): string {
	if (!config.recursion.allow) {
		return `Recursive subagent calls are disabled by default (current ${PI_SUBAGENT_DEPTH_ENV}=${depth}). Set recursion.allow=true in subagent.config.json to enable intentional recursion.`;
	}
	return `Recursive subagent depth limit reached (${PI_SUBAGENT_DEPTH_ENV}=${depth}, maxDepth=${config.recursion.maxDepth}). Increase recursion.maxDepth only if this recursion is intentional.`;
}
