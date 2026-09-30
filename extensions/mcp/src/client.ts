import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { ResolvedServer } from "./config.ts";

const CLIENT_INFO = { name: "pi-mcp", version: "1.0.0" };
const DEFAULT_TIMEOUT_MS = 30_000;

export type McpToolInfo = {
	/** Name as exposed by the MCP server. */
	remoteName: string;
	description: string;
	inputSchema: Record<string, unknown>;
};

export type ServerConnection = {
	server: ResolvedServer;
	status: "connected" | "failed" | "disabled";
	error?: string;
	tools: McpToolInfo[];
	client?: Client;
	close: () => Promise<void>;
};

function buildTransport(server: ResolvedServer): Transport {
	if (server.type === "stdio") {
		return new StdioClientTransport({
			command: server.command as string,
			args: server.args,
			cwd: server.cwd,
			// Inherit the parent environment so servers can find node/uvx/etc.
			env: { ...(process.env as Record<string, string>), ...(server.env ?? {}) },
			stderr: "pipe",
		});
	}

	const url = new URL(server.url as string);
	const requestInit = server.headers ? { headers: server.headers } : undefined;
	if (server.type === "sse") {
		return new SSEClientTransport(url, { requestInit });
	}
	return new StreamableHTTPClientTransport(url, { requestInit });
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isToolAllowed(server: ResolvedServer, toolName: string): boolean {
	if (server.excludeTools?.includes(toolName)) return false;
	if (server.includeTools && server.includeTools.length > 0) {
		return server.includeTools.includes(toolName);
	}
	return true;
}

function formatError(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}

/** Connects to one server and lists its tools. Never throws. */
export async function connectServer(server: ResolvedServer): Promise<ServerConnection> {
	if (server.enabled === false) {
		return { server, status: "disabled", tools: [], close: async () => {} };
	}

	const timeout = server.timeout ?? DEFAULT_TIMEOUT_MS;
	const client = new Client(CLIENT_INFO, { capabilities: {} });

	try {
		await client.connect(buildTransport(server), { timeout });
		const listed = await client.listTools(undefined, { timeout });
		const tools: McpToolInfo[] = [];

		for (const tool of listed.tools ?? []) {
			if (!isToolAllowed(server, tool.name)) continue;
			tools.push({
				remoteName: tool.name,
				description: tool.description?.trim() || `MCP tool "${tool.name}" from server "${server.name}"`,
				inputSchema: asRecord(tool.inputSchema),
			});
		}

		return {
			server,
			status: "connected",
			tools,
			client,
			close: async () => {
				try {
					await client.close();
				} catch {
					// Server already gone; nothing to clean up.
				}
			},
		};
	} catch (error) {
		try {
			await client.close();
		} catch {
			// Ignore teardown failures for a connection that never came up.
		}
		return { server, status: "failed", error: formatError(error), tools: [], close: async () => {} };
	}
}

export type CallResult = {
	text: string;
	isError: boolean;
	raw: unknown;
};

/** Calls a tool and flattens the MCP content blocks into text for the LLM. */
export async function callMcpTool(
	connection: ServerConnection,
	remoteName: string,
	args: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<CallResult> {
	if (!connection.client) {
		throw new Error(`MCP server "${connection.server.name}" is not connected`);
	}

	const result = await connection.client.callTool(
		{ name: remoteName, arguments: args },
		undefined,
		{ signal, timeout: connection.server.timeout ?? DEFAULT_TIMEOUT_MS },
	);

	const blocks = Array.isArray(result.content) ? result.content : [];
	const parts: string[] = [];

	for (const block of blocks) {
		const record = asRecord(block);
		if (record.type === "text" && typeof record.text === "string") {
			parts.push(record.text);
		} else if (record.type === "resource") {
			const resource = asRecord(record.resource);
			if (typeof resource.text === "string") {
				parts.push(resource.text);
			} else {
				parts.push(`[resource: ${String(resource.uri ?? "unknown")}]`);
			}
		} else if (record.type === "image") {
			parts.push(`[image: ${String(record.mimeType ?? "unknown type")}]`);
		} else {
			parts.push(JSON.stringify(block));
		}
	}

	if (parts.length === 0 && result.structuredContent !== undefined) {
		parts.push(JSON.stringify(result.structuredContent, null, 2));
	}

	return {
		text: parts.join("\n").trim() || "(no output)",
		isError: result.isError === true,
		raw: result,
	};
}
