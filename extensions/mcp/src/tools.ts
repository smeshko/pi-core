import type { McpToolInfo } from "./client.ts";

const MAX_TOOL_NAME_LENGTH = 64;

function sanitizeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "x";
}

/**
 * Builds the pi-side tool name: `mcp__<server>__<tool>`.
 * Truncates the tool segment so the total stays within provider name limits.
 */
export function piToolName(serverName: string, remoteName: string): string {
	const prefix = `mcp__${sanitizeSegment(serverName)}__`;
	const tool = sanitizeSegment(remoteName);
	const budget = Math.max(1, MAX_TOOL_NAME_LENGTH - prefix.length);
	return `${prefix}${tool.slice(0, budget)}`;
}

/**
 * MCP input schemas are JSON Schema. Pi validates against the schema object directly,
 * so we only normalize the parts that break validation or provider schema checks.
 */
export function sanitizeInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const cleaned: Record<string, unknown> = { ...schema };
	delete cleaned.$schema;
	delete cleaned.$id;

	if (cleaned.type !== "object") {
		cleaned.type = "object";
	}
	if (!cleaned.properties || typeof cleaned.properties !== "object") {
		cleaned.properties = {};
	}
	if (cleaned.required !== undefined && !Array.isArray(cleaned.required)) {
		delete cleaned.required;
	}
	return cleaned;
}

export type RegisteredMcpTool = {
	piName: string;
	serverName: string;
	remoteName: string;
	description: string;
};

export function describeTool(tool: McpToolInfo, serverName: string): string {
	const summary = tool.description.replace(/\s+/g, " ").trim();
	return `[${serverName}] ${summary}`;
}
