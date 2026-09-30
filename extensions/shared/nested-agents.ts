/**
 * Nested AGENTS.md / CLAUDE.md loading.
 *
 * Pi only loads context files walking *up* from cwd, so rule files that live in
 * subdirectories (`lib/core/api/AGENTS.md`) are never seen. This module discovers
 * them once per session and hands them out lazily: when a tool call touches a
 * directory that owns rules, the rules are delivered into that tool's result.
 *
 * State is kept on `globalThis` so several extensions (the loader and the tool
 * renderers) share one instance regardless of module resolution.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type RuleFile = {
	/** Absolute path of the rule file. */
	absPath: string;
	/** Absolute directory the rules govern. */
	absDir: string;
	/** cwd-relative directory, e.g. `lib/core/api`. */
	relDir: string;
	/** cwd-relative file path, e.g. `lib/core/api/AGENTS.md`. */
	relPath: string;
	/** Nesting depth below cwd; deeper means more specific. */
	depth: number;
};

/** Mirrors the skip list used by the /context extension's memory-file walk. */
const SKIP_DIRS = new Set([
	".git",
	".hg",
	".jj",
	"node_modules",
	"build",
	"dist",
	"out",
	"coverage",
	".dart_tool",
	".venv",
	"venv",
	"__pycache__",
	".next",
	"Pods",
	".gradle",
	".idea",
	".ruff_cache",
	"target",
]);

/** Checked in order; the first hit in a directory wins, so AGENTS.md beats CLAUDE.md. */
const FILE_NAMES = ["AGENTS.md", "CLAUDE.md"];

const MAX_DEPTH = 8;
const MAX_FILES = 200;
/** Per tool call: only the most specific few directories are relevant. */
const MAX_HITS_PER_CALL = 3;
/** Whole session: a backstop against a pathological fan-out. */
const MAX_SESSION_FILES = 25;
const MAX_FILE_BYTES = 32 * 1024;
/** Include depth; guards against pathological chains. */
const MAX_INCLUDE_DEPTH = 5;

const HOME = os.homedir();

type Section = {
	/** cwd-relative path of the rule file this section came from. */
	relPath: string;
	/** One-line explanation of why the section is in scope. */
	note: string;
	body: string;
};

type State = {
	cwd: string;
	ready: boolean;
	/** Absolute directory -> rule file owned by it. */
	byDir: Map<string, RuleFile>;
	/** All discovered files, deepest first. */
	ordered: RuleFile[];
	/**
	 * relPath -> delivered section, in delivery order. One namespace for both rule
	 * files and include targets, so a file shared by several modules is sent once.
	 */
	injected: Map<string, Section>;
	/** Rule files already quoted in a block reason, so a retry is not blocked twice. */
	announced: Set<string>;
	/** Absolute path -> isDirectory, to avoid repeat stat calls. */
	dirCache: Map<string, boolean>;
	/** Why the walk was skipped for this cwd, if it was. */
	skipReason?: string;
};

const STATE_KEY = Symbol.for("pi.nested-agents.state");

function state(): State {
	const host = globalThis as Record<symbol, unknown>;
	if (!host[STATE_KEY]) {
		host[STATE_KEY] = {
			cwd: process.cwd(),
			ready: false,
			byDir: new Map(),
			ordered: [],
			injected: new Map(),
			announced: new Set(),
			dirCache: new Map(),
		} satisfies State;
	}
	return host[STATE_KEY] as State;
}

/**
 * The walk only runs when cwd is a git repository root (`.git` dir, or `.git`
 * file for worktrees/submodules) that has its own AGENTS.md. Anywhere else, such
 * as `~`, walking down would crawl the whole disk and stall startup.
 */
export function walkSkipReason(cwd: string): string | undefined {
	if (!fs.existsSync(path.join(cwd, ".git"))) return "cwd is not a git repository root";
	try {
		if (!fs.statSync(path.join(cwd, "AGENTS.md")).isFile()) return "cwd has no AGENTS.md";
	} catch {
		return "cwd has no AGENTS.md";
	}
	return undefined;
}

export function skipReason(): string | undefined {
	return state().skipReason;
}

/**
 * Walks cwd for rule files in subdirectories. Files at cwd or above are skipped:
 * pi already loads those, and re-delivering them would waste tokens.
 */
export function discoverRuleFiles(cwd: string, alreadyLoaded: Iterable<string> = []): RuleFile[] {
	const current = state();
	current.cwd = cwd;
	current.byDir.clear();
	current.ordered = [];
	// A fresh discovery means a fresh session; nothing has been delivered yet.
	current.injected.clear();
	current.announced.clear();
	current.dirCache.clear();

	current.skipReason = walkSkipReason(cwd);
	if (current.skipReason) {
		current.ready = true;
		return [];
	}

	const loaded = new Set<string>();
	for (const entry of alreadyLoaded) {
		try {
			loaded.add(fs.realpathSync(entry));
		} catch {
			loaded.add(path.resolve(entry));
		}
	}

	const found: RuleFile[] = [];

	const visit = (dir: string, depth: number) => {
		if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		// cwd itself is already covered by pi's upward walk.
		if (depth > 0) {
			for (const name of FILE_NAMES) {
				const candidate = path.join(dir, name);
				if (!entries.some((entry) => entry.isFile() && entry.name === name)) continue;

				let real = candidate;
				try {
					real = fs.realpathSync(candidate);
				} catch {
					// Unreadable; still record the nominal path.
				}
				if (loaded.has(real)) break;

				const relDir = path.relative(cwd, dir);
				found.push({
					absPath: candidate,
					absDir: dir,
					relDir,
					relPath: path.join(relDir, name),
					depth,
				});
				break;
			}
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;

			// A nested VCS root means vendored or submoduled code, not our guidance.
			const child = path.join(dir, entry.name);
			if (fs.existsSync(path.join(child, ".git"))) continue;

			visit(child, depth + 1);
		}
	};

	visit(cwd, 0);

	found.sort((a, b) => b.depth - a.depth || a.relPath.localeCompare(b.relPath));
	current.ordered = found;
	for (const file of found) current.byDir.set(file.absDir, file);
	current.ready = true;
	return found;
}

export function isReady(): boolean {
	return state().ready;
}

export function discoveredCount(): number {
	return state().ordered.length;
}

export function discoveredPaths(): string[] {
	return state().ordered.map((file) => file.relPath);
}

function isDirectory(absPath: string): boolean {
	const current = state();
	const cached = current.dirCache.get(absPath);
	if (cached !== undefined) return cached;

	let result = false;
	try {
		result = fs.statSync(absPath).isDirectory();
	} catch {
		result = false;
	}
	current.dirCache.set(absPath, result);
	return result;
}

function toAbsolute(rawPath: string, cwd: string): string {
	let expanded = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	if (expanded === "~") expanded = HOME;
	else if (expanded.startsWith("~/")) expanded = `${HOME}${expanded.slice(1)}`;
	return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

/**
 * Rule files owning `rawPath`, deepest first.
 *
 * Directory arguments (grep/find/ls roots) include the directory itself; file
 * arguments start at the parent directory.
 */
export function rulesForPath(rawPath: string): RuleFile[] {
	const current = state();
	if (!current.ready || !rawPath) return [];

	const absolute = toAbsolute(rawPath, current.cwd);
	let dir = isDirectory(absolute) ? absolute : path.dirname(absolute);

	const hits: RuleFile[] = [];
	// Stop at cwd: anything at or above it is already in the system prompt.
	while (dir.startsWith(current.cwd) && dir !== current.cwd && dir !== path.dirname(dir)) {
		const hit = current.byDir.get(dir);
		if (hit) hits.push(hit);
		dir = path.dirname(dir);
	}
	return hits.slice(0, MAX_HITS_PER_CALL);
}

/**
 * Rule files whose directory is mentioned anywhere in `text`.
 *
 * Used for tools with no path argument (bash, subagent, MCP). The set of rule
 * directories is small and known, so this is a substring test rather than an
 * attempt to parse arbitrary commands. False positives cost a few tokens;
 * false negatives cost a rule violation.
 */
export function rulesForText(text: string): RuleFile[] {
	const current = state();
	if (!current.ready || !text) return [];

	const hits: RuleFile[] = [];
	for (const file of current.ordered) {
		if (!file.relDir) continue;
		if (text.includes(file.relDir) || text.includes(file.absDir)) hits.push(file);
		if (hits.length >= MAX_HITS_PER_CALL) break;
	}
	return hits;
}

/** Rule files from `files` that have not been delivered to the model yet. */
export function pending(files: RuleFile[]): RuleFile[] {
	const current = state();
	if (current.injected.size >= MAX_SESSION_FILES) return [];
	return files.filter((file) => !current.injected.has(file.relPath));
}

/**
 * Builds the sections for `file` plus every file it includes, skipping anything
 * already present in `seen`. `seen` holds cwd-relative paths and is shared with
 * the session-wide delivered set, so rules referenced by several modules (the
 * `@lib/core/common/bloc/AGENTS.md` pointers) are emitted exactly once.
 */
function collectSections(absPath: string, note: string, seen: Set<string>, depth: number): Section[] {
	const current = state();
	const relPath = path.relative(current.cwd, absPath);
	if (seen.has(relPath)) return [];

	const body = readFileCapped(absPath);
	if (!body) return [];
	seen.add(relPath);

	const sections: Section[] = [{ relPath, note, body }];
	if (depth >= MAX_INCLUDE_DEPTH) return sections;

	for (const token of includeTokens(body)) {
		const resolved = resolveInclude(token, path.dirname(absPath));
		if (!resolved) continue;

		const targetDir = path.dirname(resolved);
		const owned = current.byDir.get(targetDir);
		const targetNote = owned
			? `Applies to every file under \`${owned.relDir}/\`; referenced by ${relPath}.`
			: `Referenced by ${relPath}.`;

		sections.push(...collectSections(resolved, targetNote, seen, depth + 1));
	}
	return sections;
}

function sectionsFor(files: RuleFile[], seen: Set<string>): Section[] {
	const sections: Section[] = [];
	for (const file of files) {
		sections.push(...collectSections(file.absPath, `Applies to every file under \`${file.relDir}/\`.`, seen, 0));
	}
	return sections;
}

function readFileCapped(absPath: string): string | undefined {
	try {
		const stats = fs.statSync(absPath);
		if (stats.size > MAX_FILE_BYTES) return undefined;
		const content = fs.readFileSync(absPath, "utf8").trim();
		return content || undefined;
	} catch {
		return undefined;
	}
}

/** Blanks out fenced blocks and inline code so `@override` in a Dart sample is not an include. */
function stripCode(text: string): string {
	return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

/**
 * Resolves an `@path` token.
 *
 * Tokens are tried relative to the including file first, then relative to the
 * project root, because this repo writes project-root-relative pointers
 * (`@lib/core/api/AGENTS.md`) from inside nested directories.
 */
function resolveInclude(token: string, fromDir: string): string | undefined {
	const current = state();
	let raw = token;
	if (raw.startsWith("~/")) raw = `${HOME}${raw.slice(1)}`;

	const candidates = path.isAbsolute(raw)
		? [raw]
		: [path.resolve(fromDir, raw.replace(/^\.\//, "")), path.resolve(current.cwd, raw)];

	for (const candidate of candidates) {
		// Includes outside the project are not loaded without review.
		if (!candidate.startsWith(current.cwd)) continue;
		try {
			if (fs.statSync(candidate).isFile()) return candidate;
		} catch {
			// Try the next candidate.
		}
	}
	return undefined;
}

/** `@path` tokens outside code, restricted to markdown files. */
function includeTokens(content: string): string[] {
	const matches = [...stripCode(content).matchAll(/(?:^|\s)@([^\s`]+\.md)\b/g)].map((match) => match[1] ?? "");
	return [...new Set(matches)].filter(Boolean);
}

/**
 * Marks the rules owning `files` — and everything they include — as delivered.
 * Returns only the sections added by this call.
 */
export function markInjected(files: RuleFile[]): Section[] {
	const current = state();
	if (current.injected.size >= MAX_SESSION_FILES) return [];

	const seen = new Set(current.injected.keys());
	const fresh = sectionsFor(files, seen);

	const accepted: Section[] = [];
	for (const section of fresh) {
		if (current.injected.size >= MAX_SESSION_FILES) break;
		current.injected.set(section.relPath, section);
		accepted.push(section);
	}
	return accepted;
}

function render(section: Section): string {
	return [`## ${section.relPath}`, section.note, "", section.body].join("\n");
}

/** Text appended to a tool result so the rules land in the same turn that triggered them. */
export function rulesMessage(sections: Section[]): string {
	if (sections.length === 0) return "";
	return [
		"",
		"---",
		"# Module-scoped rules now in effect",
		"These files govern the path this tool touched. They add to the project rules already in your system prompt and take precedence where they are more specific.",
		"",
		sections.map(render).join("\n\n"),
	].join("\n");
}

export function injectedPaths(): string[] {
	return [...state().injected.keys()];
}

/** True the first time a rule file is quoted in a blocked tool call. */
export function announceOnce(files: RuleFile[]): RuleFile[] {
	const current = state();
	const fresh = files.filter((file) => !current.announced.has(file.relPath));
	for (const file of fresh) current.announced.add(file.relPath);
	return fresh;
}

/** Rule text used as the reason of a blocked mutation. Does not mark anything delivered. */
export function blockReason(files: RuleFile[]): string {
	const sections = sectionsFor(files, new Set(state().injected.keys()));
	return [
		"This path is governed by module-scoped rules you have not read yet. Re-issue the same tool call after applying them.",
		"",
		sections.map(render).join("\n\n"),
	].join("\n");
}
