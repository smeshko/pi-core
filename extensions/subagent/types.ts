export const DEFAULT_MAX_PARALLEL_TASKS = 8;
export const DEFAULT_MAX_CONCURRENCY = 4;
export const DEFAULT_PER_TASK_OUTPUT_CAP_BYTES = 50 * 1024;
export const DEFAULT_STDERR_MAX_BYTES = 16 * 1024;
export const DEFAULT_KILL_TIMEOUT_MS = 5_000;
export const DEFAULT_EMPTY_OUTPUT_RETRIES = 3;

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "user" | "project" | "unknown";
export type DiagnosticLevel = "warning" | "error";

export interface AgentDiagnostic {
	level: DiagnosticLevel;
	source: AgentSource;
	filePath?: string;
	message: string;
}

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: Exclude<AgentSource, "unknown">;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	diagnostics: AgentDiagnostic[];
}

export type ResourcePolicyMode = "inherit" | "none" | "allowlist";
export type ContextFilesPolicy = "inherit" | "none";

export interface ResourceListPolicy {
	mode: ResourcePolicyMode;
	allow: string[];
}

export interface ChildRuntimePolicy {
	extensions: ResourceListPolicy;
	skills: ResourceListPolicy;
	promptTemplates: ResourceListPolicy;
	contextFiles: ContextFilesPolicy;
}

export interface RecursionPolicy {
	allow: boolean;
	maxDepth: number;
}

export interface SubagentConfig {
	agentScope: AgentScope;
	confirmProjectAgents: boolean;
	maxParallelTasks: number;
	maxConcurrency: number;
	defaultTools?: string[];
	runtime: ChildRuntimePolicy;
	recursion: RecursionPolicy;
	stderrMaxBytes: number;
	killTimeoutMs: number;
	/** Extra attempts when a run completes cleanly but produces no output (0 disables). */
	emptyOutputRetries: number;
}

export interface ConfigDiagnostic {
	level: DiagnosticLevel;
	filePath?: string;
	message: string;
}

export interface LoadedSubagentConfig {
	config: SubagentConfig;
	diagnostics: ConfigDiagnostic[];
	userConfigPath: string;
	projectConfigPath: string | null;
	loadedPaths: string[];
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface PiContentPart {
	type: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface PiMessage {
	role: string;
	content: PiContentPart[];
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number } | number;
		totalTokens?: number;
		contextTokens?: number;
		[key: string]: unknown;
	};
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	[key: string]: unknown;
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> }
	| { type: "toolResult"; name?: string; isError?: boolean; text?: string }
	| { type: "stderr"; text: string };

export type FailureKind = "unknown_agent" | "child_error" | "spawn_error" | "aborted" | "invalid_params";

export interface SingleResult {
	agent: string;
	agentSource: AgentSource;
	task: string;
	cwd?: string;
	exitCode: number;
	messages: PiMessage[];
	activity: DisplayItem[];
	partialText: string;
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	failureKind?: FailureKind;
	step?: number;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	configFiles: string[];
	runtimePolicy: ChildRuntimePolicy;
	recursion: RecursionPolicy;
	diagnostics: Array<AgentDiagnostic | ConfigDiagnostic>;
	results: SingleResult[];
	hadRuntimeFailure: boolean;
}

export interface TaskParams {
	agent: string;
	task: string;
	cwd?: string;
	tools?: string[];
}

export interface SubagentParams {
	agent?: string;
	task?: string;
	tasks?: TaskParams[];
	chain?: TaskParams[];
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	cwd?: string;
	tools?: string[];
	runtime?: PartialRuntimePolicyInput;
}

export interface PartialResourcePolicyInput {
	mode?: ResourcePolicyMode;
	allow?: string[];
}

export interface PartialRuntimePolicyInput {
	extensions?: PartialResourcePolicyInput;
	skills?: PartialResourcePolicyInput;
	promptTemplates?: PartialResourcePolicyInput;
	contextFiles?: ContextFilesPolicy;
}
