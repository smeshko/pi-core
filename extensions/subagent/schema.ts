import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const ToolsArray = Type.Array(Type.String(), {
	description:
		'Optional child tool allowlist. Omit (or pass []) to keep the agent/config tool policy. Pass ["none"] to run the child with no tools at all.',
});

export const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for this child agent process" })),
	tools: Type.Optional(ToolsArray),
});

export const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for this child agent process" })),
	tools: Type.Optional(ToolsArray),
});

export const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Which agent directories to use. Default: "both" loads ~/.pi/agent/agents (plus agents/ in pi packages) and nearest .pi/agents; project agents override user agents.',
	default: "both",
});

const ResourceModeSchema = StringEnum(["inherit", "none", "allowlist"] as const, {
	description:
		"Child resource policy: inherit normal Pi discovery, none disables discovery, allowlist disables discovery then adds explicit paths.",
});

const ResourcePolicySchema = Type.Object({
	mode: Type.Optional(ResourceModeSchema),
	allow: Type.Optional(Type.Array(Type.String({ description: "Absolute or cwd-relative path to allow in allowlist mode" }))),
});

const RuntimePolicySchema = Type.Object({
	extensions: Type.Optional(ResourcePolicySchema),
	skills: Type.Optional(ResourcePolicySchema),
	promptTemplates: Type.Optional(ResourcePolicySchema),
	contextFiles: Type.Optional(
		StringEnum(["inherit", "none"] as const, {
			description: 'Use "none" to pass --no-context-files to child Pi processes.',
		}),
	),
});

export const SubagentParamsSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description:
				"Prompt before running project-local agents when UI is available. Default is false because project agents load by default under this extension's accepted safety model.",
			default: false,
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	tools: Type.Optional(ToolsArray),
	runtime: Type.Optional(RuntimePolicySchema),
});
