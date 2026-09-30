/**
 * Resolves the root directories of the pi packages configured for this session.
 *
 * Pi packages only carry extensions, skills, prompts and themes. Resources that
 * pi does not know about (`mcp.json`, subagent `agents/`) are looked up by the
 * extensions that own them, relative to these roots.
 *
 * Mirrors pi's own resolution (see `DefaultPackageManager.getInstalledPath`):
 *   - local  → resolved against the settings file's base dir (`<agentDir>` or `<cwd>/.pi`)
 *   - git    → `<base>/git/<host>/<path>`
 *   - npm    → `<base>/npm/node_modules/<name>`
 * Packages that are not installed yet are skipped.
 *
 * Kept free of pi runtime imports so it also works under plain `node --test`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type PackageScope = "user" | "project";

export type PackageRoot = {
	source: string;
	scope: PackageScope;
	root: string;
};

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function expandHome(input: string): string {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
	return input;
}

function readPackages(settingsFile: string): string[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as { packages?: unknown[] };
		if (!Array.isArray(parsed.packages)) return [];
		return parsed.packages
			.map((entry) => (typeof entry === "string" ? entry : (entry as { source?: unknown })?.source))
			.filter((source): source is string => typeof source === "string" && source.trim() !== "")
			.map((source) => source.trim());
	} catch {
		return [];
	}
}

/** Strips a trailing `@ref` from a git path without touching `git@host:` prefixes. */
function stripRef(repoPath: string): string {
	const at = repoPath.lastIndexOf("@");
	return at > 0 ? repoPath.slice(0, at) : repoPath;
}

function resolveSource(source: string, baseDir: string): string | undefined {
	if (source.startsWith("npm:")) {
		const spec = source.slice(4);
		// `@scope/name@1.2.3` → `@scope/name`; `name@1.2.3` → `name`.
		const at = spec.startsWith("@") ? spec.indexOf("@", 1) : spec.indexOf("@");
		const name = at > 0 ? spec.slice(0, at) : spec;
		return path.join(baseDir, "npm", "node_modules", name);
	}

	const isGit = source.startsWith("git:") || /^(https?|ssh):\/\//.test(source) || source.startsWith("git@");
	if (isGit) {
		let rest = source.replace(/^git:/, "").replace(/^(https?|ssh):\/\//, "").replace(/^git@/, "");
		rest = rest.replace(":", "/");
		rest = stripRef(rest).replace(/\.git$/, "").replace(/\/+$/, "");
		const [host, ...parts] = rest.split("/");
		if (!host || parts.length === 0) return undefined;
		return path.join(baseDir, "git", host, ...parts);
	}

	const expanded = expandHome(source);
	return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

function isDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Package roots in load order: user packages first, then project packages when
 * the project is trusted. Later entries should override earlier ones.
 */
export function packageRoots(cwd: string, options: { projectTrusted?: boolean } = {}): PackageRoot[] {
	const sources: Array<{ scope: PackageScope; baseDir: string }> = [{ scope: "user", baseDir: agentDir() }];
	if (options.projectTrusted) sources.push({ scope: "project", baseDir: path.join(cwd, ".pi") });

	const roots: PackageRoot[] = [];
	const seen = new Set<string>();
	for (const { scope, baseDir } of sources) {
		for (const source of readPackages(path.join(baseDir, "settings.json"))) {
			const resolved = resolveSource(source, baseDir);
			if (!resolved || !isDirectory(resolved)) continue;

			let real = resolved;
			try {
				real = fs.realpathSync(resolved);
			} catch {
				// Keep the nominal path.
			}
			if (seen.has(real)) continue;
			seen.add(real);
			roots.push({ source, scope, root: real });
		}
	}
	return roots;
}
