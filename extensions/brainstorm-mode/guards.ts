/**
 * Read-only enforcement for brainstorm mode.
 *
 * Three rings, in order of reliability:
 *
 *   1. Tool absence      - `pi.setActiveTools()` with an allowlist, so write
 *                          tools are not in the schema at all.
 *   2. Call-time block   - this module, re-checked in the `tool_call` hook,
 *                          because MCP servers and `registerTool` can add tools
 *                          *after* the mode was entered (the MCP loader calls
 *                          `pi.setActiveTools()` additively mid-turn).
 *   3. Argument coercion - for tools that are safe only under certain args,
 *                          notably `subagent`, whose `tools` parameter would
 *                          otherwise hand a child process write access.
 */

/** Tools that are always safe in brainstorm mode. */
export const ALLOWED_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"askUserQuestion",
	"websearch",
	"webfetch",
	"subagent",
	"search_mcp_tools",
	"brainstorm_save",
] as const;

/**
 * Read-only child agents, with the tool set that is FORCED onto them.
 *
 * `subagent`'s runner resolves child tools as
 *   `taskTools ?? agent.tools ?? config.defaultTools`
 * so a model-supplied `tools` array overrides the agent's frontmatter. We
 * therefore overwrite `tools` rather than validate it: whatever the model asks
 * for is discarded, and the child is spawned as
 *   `pi -p --no-session --tools read,grep,find,ls`
 * which is enforced by argv, not by prompting.
 */
export const READONLY_AGENTS: Record<string, string[]> = {
	explore: ["read", "grep", "find", "ls"],
	webfetch: ["websearch", "webfetch"],
};

/** MCP tool names are `mcp__<server>__<remoteName>` (see mcp/src/tools.ts). */
const MCP_PREFIX = "mcp__";

/** Verbs that read. Matched as a whole segment of the remote tool name. */
const READ_VERBS = new Set([
	"get",
	"list",
	"search",
	"read",
	"show",
	"query",
	"find",
	"describe",
	"fetch",
	"view",
	"count",
	"diff",
	"export",
	"preview",
]);

/** Verbs that mutate. Checked first so `get_or_create` style names fail closed. */
const WRITE_VERBS = new Set([
	"create",
	"update",
	"delete",
	"add",
	"remove",
	"set",
	"close",
	"link",
	"unlink",
	"publish",
	"push",
	"merge",
	"complete",
	"abandon",
	"resolve",
	"assign",
	"comment",
	"vote",
	"approve",
	"reject",
	"reply",
	"post",
	"put",
	"patch",
	"write",
	"edit",
	"move",
	"copy",
	"rename",
	"run",
	"execute",
	"trigger",
	"queue",
	"cancel",
	"restart",
	"upload",
	"import",
]);

export interface McpToolId {
	server: string;
	remote: string;
}

/** Split an MCP pi-side tool name into its server and remote parts. */
export function parseMcpToolName(name: string): McpToolId | undefined {
	if (!name.startsWith(MCP_PREFIX)) return undefined;
	const rest = name.slice(MCP_PREFIX.length);
	const separator = rest.indexOf("__");
	if (separator === -1) return undefined;
	return { server: rest.slice(0, separator), remote: rest.slice(separator + 2) };
}

/**
 * Classify an MCP tool as read-only, fail-closed.
 *
 * The MCP extension does not retain the server's `annotations.readOnlyHint`, so
 * classification is name-based. A write verb anywhere in the name loses; a read
 * verb must be present to win; anything else is denied and reported so it can be
 * added to `extraAllow`.
 */
export function isReadOnlyMcpTool(remote: string, extraAllow: ReadonlySet<string>): boolean {
	if (extraAllow.has(remote)) return true;
	const segments = remote.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
	if (segments.some((segment) => WRITE_VERBS.has(segment))) return false;
	return segments.some((segment) => READ_VERBS.has(segment));
}

export interface GuardVerdict {
	/** Undefined means the call may proceed. */
	reason?: string;
}

export interface GuardOptions {
	/** Remote MCP tool names to force-allow despite the verb heuristic. */
	extraAllow: ReadonlySet<string>;
}

const allowedSet = new Set<string>(ALLOWED_TOOLS);

/**
 * Name-level check, used to build the active-tool set.
 *
 * Distinct from `guardToolCall`, which additionally inspects arguments: `subagent`
 * is allowed as a *name* but rejected for specific arguments, so the two questions
 * must not share an answer.
 */
export function isToolNameAllowed(toolName: string, extraAllow: ReadonlySet<string>): boolean {
	const mcp = parseMcpToolName(toolName);
	if (mcp) return isReadOnlyMcpTool(mcp.remote, extraAllow);
	return allowedSet.has(toolName);
}

/**
 * Decide whether a tool call is permitted, and coerce its arguments in place
 * where that is what makes it safe.
 *
 * `input` is mutated for `subagent`. Pi's `tool_call` hook propagates argument
 * mutations to the executing tool and to later handlers.
 */
export function guardToolCall(
	toolName: string,
	input: Record<string, unknown>,
	options: GuardOptions,
): GuardVerdict {
	if (toolName === "subagent") return guardSubagent(input);

	const mcp = parseMcpToolName(toolName);
	if (mcp) {
		if (isReadOnlyMcpTool(mcp.remote, options.extraAllow)) return {};
		return {
			reason:
				`Brainstorm mode is read-only, and the MCP tool "${mcp.remote}" (server "${mcp.server}") ` +
				`is not classified as read-only. If it is in fact read-only, add "${mcp.remote}" to ` +
				`extraAllowedMcpTools in the brainstorm-mode extension. Otherwise: describe what you ` +
				`would call it for, and leave brainstorm mode to actually do it.`,
		};
	}

	if (allowedSet.has(toolName)) return {};

	return {
		reason:
			`Brainstorm mode is read-only. The "${toolName}" tool is not available here. ` +
			`Explore with read/grep/find/ls, ask the user with askUserQuestion, and capture ` +
			`conclusions with brainstorm_save. Do not ask the user to leave brainstorm mode ` +
			`so you can make changes.`,
	};
}

/** Item shape shared by the `tasks` and `chain` arrays of the subagent tool. */
interface SubagentItem {
	agent?: unknown;
	tools?: unknown;
	runtime?: unknown;
}

function guardSubagent(input: Record<string, unknown>): GuardVerdict {
	const items: SubagentItem[] = [input as SubagentItem];
	for (const key of ["tasks", "chain"] as const) {
		const value = input[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (item && typeof item === "object") items.push(item as SubagentItem);
			}
		}
	}

	const named = items.filter((item) => typeof item.agent === "string");
	if (named.length === 0) {
		return { reason: "Brainstorm mode: subagent calls must name an agent explicitly." };
	}

	const rejected = named
		.map((item) => item.agent as string)
		.filter((agent) => !(agent in READONLY_AGENTS));

	if (rejected.length > 0) {
		return {
			reason:
				`Brainstorm mode allows only read-only subagents: ${Object.keys(READONLY_AGENTS).join(", ")}. ` +
				`Rejected: ${[...new Set(rejected)].join(", ")}.`,
		};
	}

	// Force the child tool set. Any model-supplied `tools` override is discarded,
	// and `runtime` overrides are dropped so the child cannot widen its own
	// resource discovery.
	for (const item of named) {
		item.tools = [...READONLY_AGENTS[item.agent as string]!];
		if (item.runtime !== undefined) delete item.runtime;
	}
	// A top-level `tools` on a tasks/chain call would otherwise apply as the default.
	if (!("agent" in input) || typeof input.agent !== "string") {
		if (Array.isArray(input.tools)) delete input.tools;
	}

	return {};
}
