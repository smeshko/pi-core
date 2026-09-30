import * as fs from "node:fs";
import * as path from "node:path";

import { agentDir, packageRoots } from "../../shared/package-roots.ts";

export type McpServerConfig = {
	/** Transport. Inferred from `url`/`command` when omitted. */
	type?: "stdio" | "http" | "sse";
	/** stdio: executable to spawn. */
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	/** http/sse: endpoint URL. */
	url?: string;
	headers?: Record<string, string>;
	/** Set false to keep the entry but skip connecting. */
	enabled?: boolean;
	/** Only expose these tool names (server-side names). */
	includeTools?: string[];
	/** Never expose these tool names (server-side names). */
	excludeTools?: string[];
	/** Connect/list timeout in milliseconds. */
	timeout?: number;
};

export type ResolvedServer = McpServerConfig & {
	name: string;
	scope: "user" | "project";
	sourcePath: string;
};

type McpConfigFile = {
	mcpServers?: Record<string, McpServerConfig>;
};

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Expands `$VAR` / `${VAR}` from the current environment. Unknown vars resolve to "". */
export function interpolateEnv(value: string): string {
	return value.replace(ENV_PATTERN, (_match, braced: string | undefined, bare: string | undefined) => {
		const key = braced ?? bare ?? "";
		return process.env[key] ?? "";
	});
}

function interpolateRecord(record: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!record) return undefined;
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(record)) {
		result[key] = interpolateEnv(value);
	}
	return result;
}

function readConfigFile(filePath: string): McpConfigFile | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}

	try {
		const parsed = JSON.parse(raw) as McpConfigFile;
		if (!parsed || typeof parsed !== "object") {
			throw new Error("expected a JSON object");
		}
		return parsed;
	} catch (error) {
		throw new Error(`Invalid MCP config at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function userConfigPath(): string {
	return path.join(agentDir(), "mcp.json");
}

export function projectConfigPath(cwd: string): string {
	return path.join(cwd, ".pi", "mcp.json");
}

function normalize(name: string, config: McpServerConfig, scope: "user" | "project", sourcePath: string): ResolvedServer {
	const type = config.type ?? (config.url ? "http" : "stdio");
	return {
		...config,
		type,
		name,
		scope,
		sourcePath,
		command: config.command ? interpolateEnv(config.command) : undefined,
		args: config.args?.map(interpolateEnv),
		env: interpolateRecord(config.env),
		url: config.url ? interpolateEnv(config.url) : undefined,
		headers: interpolateRecord(config.headers),
	};
}

export function validateServer(server: ResolvedServer): string | undefined {
	if (server.type === "stdio") {
		if (!server.command) return "stdio servers require a \"command\"";
		return undefined;
	}
	if (!server.url) return `${server.type} servers require a "url"`;
	try {
		new URL(server.url);
	} catch {
		return `invalid url: ${server.url}`;
	}
	return undefined;
}

export type LoadedConfig = {
	servers: ResolvedServer[];
	errors: string[];
};

type ConfigSource = { file: string; scope: "user" | "project" };

/**
 * Config files in precedence order, lowest first. Later entries override servers
 * with the same name:
 *
 *   1. `mcp.json` at the root of each user-scope pi package (e.g. pi-core, pi-work)
 *   2. `<agentDir>/mcp.json` (the profile)
 *   3. `mcp.json` at the root of each project-scope pi package   (trusted only)
 *   4. `<cwd>/.pi/mcp.json`                                       (trusted only)
 */
export function configSources(cwd: string, projectTrusted: boolean): ConfigSource[] {
	const packageFiles = (scope: "user" | "project"): ConfigSource[] =>
		packageRoots(cwd, { projectTrusted })
			.filter((pkg) => pkg.scope === scope)
			.map((pkg) => ({ file: path.join(pkg.root, "mcp.json"), scope }));

	const sources: ConfigSource[] = [...packageFiles("user"), { file: userConfigPath(), scope: "user" }];
	if (projectTrusted) {
		sources.push(...packageFiles("project"), { file: projectConfigPath(cwd), scope: "project" });
	}
	return sources;
}

/**
 * Loads package, profile and project configs (see `configSources`).
 * Later sources override earlier servers with the same name.
 */
export function loadMcpConfig(cwd: string, projectTrusted: boolean): LoadedConfig {
	const errors: string[] = [];
	const byName = new Map<string, ResolvedServer>();

	const sources = configSources(cwd, projectTrusted);

	for (const { file, scope } of sources) {
		let parsed: McpConfigFile | undefined;
		try {
			parsed = readConfigFile(file);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
			continue;
		}
		if (!parsed?.mcpServers) continue;

		for (const [name, raw] of Object.entries(parsed.mcpServers)) {
			if (!raw || typeof raw !== "object") {
				errors.push(`Invalid MCP server "${name}" in ${file}: expected an object`);
				continue;
			}
			const server = normalize(name, raw, scope, file);
			const problem = validateServer(server);
			if (problem) {
				errors.push(`Invalid MCP server "${name}" in ${file}: ${problem}`);
				continue;
			}
			byName.set(name, server);
		}
	}

	return { servers: [...byName.values()], errors };
}
