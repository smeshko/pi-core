/**
 * package-mcp — registers MCP servers declared in pi packages with pi's built-in MCP support.
 *
 * The built-in (`builtin:mcp`) reads `<agentDir>/mcp.json` and `<cwd>/.pi/mcp.json`, but not
 * packages. This bridge reads `mcp.json` at the root of every configured package and calls
 * `pi.registerMcpServer()` for each entry. Precedence, lowest first:
 *
 *   1. user-scope packages, in settings order (later packages replace earlier ones)
 *   2. project-scope packages (trusted projects only)
 *   3. `<agentDir>/mcp.json` and `<cwd>/.pi/mcp.json` — the built-in lets mcp.json win over
 *      any extension registration with the same name
 *
 * `pi mcp list` and the other shell commands do not load extensions, so they only show
 * mcp.json servers; `/mcp` inside a session shows these too, with this extension as source.
 *
 * Subagent children (`PI_SUBAGENT_DEPTH` >= 1) get no MCP unless their `--tools` list names
 * `codemode`, `tool_search` or an `mcp__*` tool. The built-in connects every server eagerly at
 * session start, so without this each explore/webfetch child would spawn every MCP server.
 * It works by registering a stub `/mcp`, which makes the replaceable built-in step aside.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";

import { packageRoots, type PackageScope } from "./shared/package-roots.ts";

type Entry = { name: string; config: McpServerConfig; file: string };

export function readPackageServers(cwd: string, scope: PackageScope, projectTrusted: boolean): { entries: Entry[]; errors: string[] } {
	const entries: Entry[] = [];
	const errors: string[] = [];
	for (const pkg of packageRoots(cwd, { projectTrusted }).filter((root) => root.scope === scope)) {
		const file = path.join(pkg.root, "mcp.json");
		let raw: string;
		try {
			raw = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		try {
			const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> };
			for (const [name, config] of Object.entries(parsed.mcpServers ?? {})) entries.push({ name, config, file });
		} catch (error) {
			errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { entries, errors };
}

/** True for subagent children whose tool allowlist cannot reach MCP tools anyway. */
export function childWithoutMcp(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): boolean {
	const depth = Number.parseInt(env.PI_SUBAGENT_DEPTH ?? "0", 10);
	if (!Number.isFinite(depth) || depth < 1) return false;

	if (argv.includes("--no-tools") || argv.includes("-nt")) return true;
	const flag = argv.findIndex((arg) => arg === "--tools" || arg === "-t");
	// No explicit allowlist: the child gets default tools, which include codemode once MCP connects.
	if (flag === -1) return false;
	const tools = (argv[flag + 1] ?? "").split(",").map((tool) => tool.trim());
	return !tools.some((tool) => tool === "codemode" || tool === "tool_search" || tool.startsWith("mcp__"));
}

export default function packageMcp(pi: ExtensionAPI) {
	if (childWithoutMcp()) {
		pi.registerCommand("mcp", {
			description: "MCP is off in this subagent (its tool allowlist has no MCP tools)",
			handler: async () => {},
		});
		return;
	}

	const errors: string[] = [];

	const register = (entries: Entry[]) => {
		for (const { name, config, file } of entries) {
			try {
				pi.registerMcpServer(name, config);
			} catch (error) {
				errors.push(`${name} (${file}): ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	};

	// Registered during load so they connect at session start together with mcp.json servers.
	const user = readPackageServers(process.cwd(), "user", false);
	errors.push(...user.errors);
	register(user.entries);

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.isProjectTrusted()) {
			const project = readPackageServers(ctx.cwd, "project", true);
			errors.push(...project.errors);
			register(project.entries);
		}
		if (errors.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`package-mcp: skipped invalid MCP entries\n${errors.join("\n")}`, "warning");
		}
		errors.length = 0;
	});
}
