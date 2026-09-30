import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { formatSize, highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { callMcpTool, connectServer, type ServerConnection } from "./src/client.ts";
import { loadMcpConfig, userConfigPath, type ResolvedServer } from "./src/config.ts";
import { LazyConnection } from "./src/lazy-connection.ts";
import { searchTools } from "./src/search.ts";
import { describeTool, piToolName, sanitizeInputSchema, type RegisteredMcpTool } from "./src/tools.ts";
import {
	asNumber,
	asString,
	callHeader,
	clippedLines,
	formatDuration,
	plural,
	textComponent,
	textOutput,
	treeLines,
	trimTrailingEmptyLines,
	type RenderContext,
	type RenderOptions,
	type ToolResult,
} from "../shared/tool-render-style.ts";

const LOADER_TOOL = "search_mcp_tools";
const DEFAULT_SEARCH_LIMIT = 5;
const ERROR_TEXT_LIMIT = 10;

/** Renders call arguments as a compact `key=value` strip; nested values are summarized, not expanded. */
function summarizeArgs(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const parts: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		if (value === undefined || value === null) continue;
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") parts.push(`${key}=${value}`);
		else if (Array.isArray(value)) parts.push(`${key}[${value.length}]`);
		else if (typeof value === "object") parts.push(`${key}{…}`);
	}
	// Right-truncate: eliding the middle would mangle the `key=` names that make the strip readable.
	return truncateToWidth(parts.join(" "), 72);
}

/** Expanded view only: syntax-highlight the payload when it is valid JSON. */
function payloadLines(text: string, theme: Theme): string[] {
	const lines = trimTrailingEmptyLines(text.split("\n"));
	if (lines.length === 0) return [];
	try {
		JSON.parse(text);
		return highlightCode(lines.join("\n"), "json");
	} catch {
		return lines.map((line) => theme.fg("toolOutput", line));
	}
}

function elapsedLabel(state: Record<string, unknown>, isPartial: boolean): string | undefined {
	const startedAt = asNumber(state.startedAt);
	if (startedAt === undefined) return undefined;
	const end = asNumber(state.endedAt) ?? Date.now();
	return `${isPartial ? "elapsed " : ""}${formatDuration(end - startedAt)}`;
}

function renderMcpResult(result: ToolResult, options: RenderOptions, theme: Theme, context: RenderContext): Text {
	// Repaint once a second so the in-flight timer advances, then stop as soon as the call settles.
	if (context.state.startedAt !== undefined && options.isPartial && !context.state.interval) {
		context.state.interval = setInterval(() => (context.state.invalidate as (() => void) | undefined)?.(), 1000);
	}
	if ((!options.isPartial || context.isError) && context.state.interval) {
		clearInterval(context.state.interval as ReturnType<typeof setInterval>);
		context.state.interval = undefined;
	}
	if (!options.isPartial && context.state.startedAt !== undefined && context.state.endedAt === undefined) {
		context.state.endedAt = Date.now();
	}

	const elapsed = elapsedLabel(context.state, options.isPartial);

	if (context.isError) {
		const message = textOutput(result).trim() || "Unknown error";
		const lines = trimTrailingEmptyLines(message.split("\n")).map((line) => theme.fg("error", line));
		return textComponent(context, treeLines(theme, "Request failed", clippedLines(lines, ERROR_TEXT_LIMIT, theme, options.expanded), { error: true }));
	}

	if (options.isPartial) {
		return textComponent(context, treeLines(theme, `Calling…${elapsed ? ` ${elapsed}` : ""}`, [], { warning: true }));
	}

	const text = textOutput(result);
	if (!text.trim()) return textComponent(context, treeLines(theme, `Empty response${elapsed ? ` · ${elapsed}` : ""}`));

	// Collapsed view is deliberately a single line: MCP payloads are JSON blobs whose leading
	// fields are rarely the interesting ones, so a partial preview would be noise rather than signal.
	const lineTotal = trimTrailingEmptyLines(text.split("\n")).length;
	const summaryParts = [plural(lineTotal, "line"), formatSize(Buffer.byteLength(text, "utf8"))];
	if (elapsed) summaryParts.push(elapsed);
	const hint = options.expanded ? "" : ` (${keyHint("app.tools.expand", "to expand")})`;
	const body = options.expanded ? payloadLines(text, theme) : [];
	return textComponent(context, treeLines(theme, `${summaryParts.join(" · ")}${hint}`, body));
}

/** Event names other extensions (e.g. /context) use to inspect MCP state. */
export const MCP_REGISTRY_REQUEST = "mcp:registry:request";
export const MCP_REGISTRY_SNAPSHOT = "mcp:registry";

export type McpServerSnapshot = {
	name: string;
	type: "stdio" | "http" | "sse";
	scope: "user" | "project";
	status: "idle" | "connecting" | "connected" | "failed" | "disabled";
	error?: string;
	/** pi-side tool names contributed by this server. */
	toolNames: string[];
};

export type McpRegistrySnapshot = {
	servers: McpServerSnapshot[];
	/** Maps pi tool name to its owning server name. */
	toolOwners: Record<string, string>;
	configErrors: string[];
};

export default function mcpExtension(pi: ExtensionAPI): void {
	const connections = new Map<string, ServerConnection>();
	const configuredServers = new Map<string, ResolvedServer>();
	const registry = new Map<string, RegisteredMcpTool>();
	let registeredNames = new Set<string>();
	let configErrors: string[] = [];
	let currentContext: ExtensionContext | undefined;

	function activateTools(names: string[]): string[] {
		const active = pi.getActiveTools();
		const added = names.filter((name) => !active.includes(name));
		if (added.length > 0) {
			pi.setActiveTools([...new Set([...active, ...added])]);
		}
		return added;
	}

	function registerRemoteTool(connection: ServerConnection, remoteName: string, description: string, schema: Record<string, unknown>): void {
		const serverName = connection.server.name;
		let piName = piToolName(serverName, remoteName);
		if (registeredNames.has(piName)) {
			let suffix = 2;
			while (registeredNames.has(`${piName}_${suffix}`)) suffix++;
			piName = `${piName}_${suffix}`;
		}

		registeredNames.add(piName);
		registry.set(piName, { piName, serverName, remoteName, description });

		pi.registerTool({
			name: piName,
			label: `${serverName}: ${remoteName}`,
			description,
			// Cast: MCP tools ship JSON Schema, which pi validates directly.
			parameters: Type.Unsafe(sanitizeInputSchema(schema)) as unknown as ReturnType<typeof Type.Object>,
			renderShell: "self",
			renderCall(args, theme, context) {
				const renderContext = context as unknown as RenderContext;
				renderContext.state.invalidate = context.invalidate;
				if (context.executionStarted && renderContext.state.startedAt === undefined) {
					renderContext.state.startedAt = Date.now();
					renderContext.state.endedAt = undefined;
				}
				const summary = summarizeArgs(args as Record<string, unknown>);
				return textComponent(renderContext, callHeader(theme, renderContext, "MCP", `${serverName}: ${remoteName}${summary ? ` ${summary}` : ""}`));
			},
			renderResult(result, options, theme, context) {
				return renderMcpResult(result as ToolResult, options, theme, context as unknown as RenderContext);
			},
			async execute(_toolCallId, params, signal) {
				const live = connections.get(serverName);
				if (!live || live.status !== "connected") {
					throw new Error(`MCP server "${serverName}" is not connected`);
				}

				const result = await callMcpTool(live, remoteName, (params ?? {}) as Record<string, unknown>, signal);
				if (result.isError) {
					throw new Error(result.text);
				}
				return {
					content: [{ type: "text", text: result.text }],
					details: { server: serverName, tool: remoteName },
				};
			},
		});
	}

	function buildSnapshot(): McpRegistrySnapshot {
		const toolOwners: Record<string, string> = {};
		for (const tool of registry.values()) {
			toolOwners[tool.piName] = tool.serverName;
		}

		return {
			servers: [...configuredServers.values()].map((server) => {
				const connection = connections.get(server.name);
				return {
					name: server.name,
					type: (server.type ?? "stdio") as "stdio" | "http" | "sse",
					scope: server.scope,
					status:
						server.enabled === false
							? "disabled"
							: connection?.status ?? (lazyConnection.state === "connecting" ? "connecting" : "idle"),
					error: connection?.error,
					toolNames: [...registry.values()]
						.filter((tool) => tool.serverName === server.name)
						.map((tool) => tool.piName),
				};
			}),
			toolOwners,
			configErrors: [...configErrors],
		};
	}

	function publishSnapshot(): void {
		pi.events.emit(MCP_REGISTRY_SNAPSHOT, buildSnapshot());
	}

	const lazyConnection = new LazyConnection(() => publishSnapshot());

	// Synchronous request/respond so callers get state without waiting for a reconnect.
	pi.events.on(MCP_REGISTRY_REQUEST, (payload: unknown) => {
		const respond = (payload as { respond?: (snapshot: McpRegistrySnapshot) => void } | undefined)?.respond;
		if (typeof respond === "function") {
			respond(buildSnapshot());
		}
	});

	function loadConfiguration(ctx: ExtensionContext): void {
		const { servers, errors } = loadMcpConfig(ctx.cwd, ctx.isProjectTrusted());
		configuredServers.clear();
		for (const server of servers) configuredServers.set(server.name, server);
		configErrors = errors;
		publishSnapshot();
	}

	async function connectAll(ctx: ExtensionContext): Promise<void> {
		const results = await Promise.all([...configuredServers.values()].map((server) => connectServer(server)));
		for (const connection of results) {
			connections.set(connection.server.name, connection);
			if (connection.status !== "connected") continue;

			for (const tool of connection.tools) {
				registerRemoteTool(connection, tool.remoteName, describeTool(tool, connection.server.name), tool.inputSchema);
			}
		}

		// MCP tools are lazy: registering activates them, so strip them back out and leave only
		// the loader. The model re-activates what it needs via LOADER_TOOL.
		// Note: this also runs on reload/resume/fork, so a resumed transcript that already called
		// an MCP tool must load it again before calling it. Accepted tradeoff — keeping the whole
		// server toolset in the prompt from turn one costs more than the occasional reload.
		const mcpNames = new Set(registry.keys());
		const active = pi.getActiveTools().filter((name) => !mcpNames.has(name));
		pi.setActiveTools([...new Set([...active, LOADER_TOOL])]);

		const failed = results.filter((result) => result.status === "failed");
		publishSnapshot();
		if (ctx.hasUI && (failed.length > 0 || configErrors.length > 0)) {
			const detail = [...failed.map((f) => `${f.server.name}: ${f.error}`), ...configErrors].join("; ");
			ctx.ui.notify(`MCP: ${failed.length} server(s) unavailable — ${detail}`, "warning");
		}
	}

	async function ensureConnected(ctx: ExtensionContext | undefined = currentContext): Promise<void> {
		if (!ctx) throw new Error("MCP is unavailable because no session is active");
		await lazyConnection.ensure(() => connectAll(ctx));
	}

	async function disconnectAll(): Promise<void> {
		const registered = new Set(registry.keys());
		await Promise.all([...connections.values()].map((connection) => connection.close()));
		connections.clear();
		registry.clear();
		registeredNames = new Set();
		if (registered.size > 0) {
			pi.setActiveTools(pi.getActiveTools().filter((name) => !registered.has(name)));
		}
		publishSnapshot();
	}

	pi.registerTool({
		name: LOADER_TOOL,
		label: "Search MCP Tools",
		description:
			"Search tools provided by connected MCP servers and load the matching ones so they become callable. " +
			"Call this before attempting any task that needs an external integration (issue trackers, browsers, databases, cloud APIs).",
		promptSnippet: "Search and load tools exposed by configured MCP servers",
		promptGuidelines: [
			`Use ${LOADER_TOOL} when a task needs an external system and no active tool covers it.`,
		],
		parameters: Type.Object({
			query: Type.String({ description: "Capability, integration, or task to search for" }),
			server: Type.Optional(Type.String({ description: "Restrict the search to a single MCP server name" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, description: "Maximum tools to load" })),
		}),
		renderShell: "self",
		renderCall(args, theme, context) {
			const renderContext = context as unknown as RenderContext;
			const query = asString(args.query) ?? "";
			const server = asString(args.server);
			const label = `${query ? `"${query}"` : "…"}${server ? ` in ${server}` : ""}`;
			return textComponent(renderContext, callHeader(theme, renderContext, "MCP search", truncateToWidth(label, 72)));
		},
		renderResult(result, options, theme, context) {
			const renderContext = context as unknown as RenderContext;
			if (options.isPartial) return textComponent(renderContext, treeLines(theme, "Searching…", [], { warning: true }));
			if (renderContext.isError) {
				return textComponent(renderContext, treeLines(theme, textOutput(result as ToolResult).trim() || "Search failed", [], { error: true }));
			}

			const details = (result as ToolResult).details ?? {};
			const matches = Array.isArray(details.matches) ? (details.matches as string[]) : [];
			if (matches.length === 0) {
				return textComponent(renderContext, treeLines(theme, textOutput(result as ToolResult).split("\n")[0] ?? "No matches", [], { warning: true }));
			}

			const added = Array.isArray(details.added) ? (details.added as string[]) : [];
			const summary = `${plural(matches.length, "tool")} ${added.length > 0 ? "loaded" : "already active"}`;
			const body = clippedLines(matches.map((name) => theme.fg("toolOutput", name)), 8, theme, options.expanded);
			return textComponent(renderContext, treeLines(theme, summary, body));
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await ensureConnected(ctx);
			// Fuzzy server filter: exact match first, then substring/prefix so "ado"
			// resolves to "ado_remote_mcp" without the model knowing the full name.
			const resolvedServer = params.server
				? ([...configuredServers.keys()].find((name) => name === params.server) ??
				  [...configuredServers.keys()].find(
					(name) => name.includes(params.server!) || params.server!.includes(name),
				  ))
				: undefined;

			const candidates = [...registry.values()].filter(
				(tool) => !params.server || tool.serverName === resolvedServer,
			);

			if (candidates.length === 0) {
				if (configuredServers.size === 0) {
					return {
						content: [{ type: "text", text: `No MCP tools available. No MCP servers configured (${userConfigPath()} or a package mcp.json).` }],
						details: { matches: [] },
					};
				}
				const knownServers = [...configuredServers.keys()].join(", ");
				const hint = params.server
					? ` Server "${params.server}" did not match any connected server. Known servers: ${knownServers}. Retry without a server filter or use the exact name.`
					: ` No tools are registered. Known servers: ${knownServers}.`;
				return {
					content: [{ type: "text", text: `No MCP tools available.${hint}` }],
					details: { matches: [] },
				};
			}

			const matches = searchTools(candidates, params.query, params.limit ?? DEFAULT_SEARCH_LIMIT).map((entry) => entry.tool);

			if (matches.length === 0) {
				const inventory = [...new Set(candidates.map((tool) => tool.serverName))]
					.map((server) => `${server} (${candidates.filter((tool) => tool.serverName === server).length} tools)`)
					.join(", ");
				return {
					content: [
						{
							type: "text",
							text: `No MCP tools matched "${params.query}". Connected servers: ${inventory}. Retry with the domain nouns of the task, or use "/mcp load <server>".`,
						},
					],
					details: { matches: [] },
				};
			}

			const added = activateTools(matches.map((tool) => tool.piName));
			const lines = matches.map((tool) => `- ${tool.piName}: ${tool.description}`);

			return {
				content: [
					{
						type: "text",
						text: `${added.length > 0 ? "Loaded" : "Already active"} ${matches.length} MCP tool(s):\n${lines.join("\n")}`,
					},
				],
				details: { matches: matches.map((tool) => tool.piName), added },
			};
		},
	});

	pi.registerCommand("mcp", {
		description: "Show MCP server status and loaded tools",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;

			const trimmed = args.trim();
			if (trimmed === "reload") {
				await lazyConnection.reset(disconnectAll);
				loadConfiguration(ctx);
				await ensureConnected(ctx);
				ctx.ui.notify(`MCP reloaded: ${connections.size} server(s), ${registry.size} tool(s)`, "info");
				return;
			}

			await ensureConnected(ctx);

			if (trimmed.startsWith("load ")) {
				const target = trimmed.slice(5).trim();
				const names = [...registry.values()]
					.filter((tool) => tool.serverName === target || tool.piName === target)
					.map((tool) => tool.piName);
				if (names.length === 0) {
					ctx.ui.notify(`No MCP tools found for "${target}"`, "warning");
					return;
				}
				const added = activateTools(names);
				ctx.ui.notify(`Activated ${added.length} of ${names.length} tool(s) for "${target}"`, "info");
				return;
			}

			if (configuredServers.size === 0 && configErrors.length === 0) {
				ctx.ui.notify(`No MCP servers configured. Create ${userConfigPath()} or add mcp.json to a pi package`, "info");
				return;
			}

			const active = new Set(pi.getActiveTools());
			const lines: string[] = [];
			for (const connection of connections.values()) {
				const { name, type, scope } = connection.server;
				if (connection.status === "connected") {
					const tools = [...registry.values()].filter((tool) => tool.serverName === name);
					const loaded = tools.filter((tool) => active.has(tool.piName)).length;
					lines.push(`✓ ${name} (${type}, ${scope}) — ${tools.length} tool(s), ${loaded} active`);
				} else if (connection.status === "disabled") {
					lines.push(`· ${name} (${type}, ${scope}) — disabled`);
				} else {
					lines.push(`✗ ${name} (${type}, ${scope}) — ${connection.error}`);
				}
			}
			for (const error of configErrors) {
				lines.push(`! ${error}`);
			}
			lines.push("", "/mcp reload · /mcp load <server|tool>");

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await lazyConnection.reset(disconnectAll);
		currentContext = ctx;
		loadConfiguration(ctx);
	});

	pi.on("session_shutdown", async () => {
		await lazyConnection.reset(disconnectAll);
		currentContext = undefined;
		configuredServers.clear();
		configErrors = [];
		publishSnapshot();
	});
}
