/**
 * Relevance search over the registered MCP tools.
 *
 * The naive version scored every query term equally against one concatenated haystack, so
 * filler carried a match: "Azure DevOps list pull requests for branch" ranked a Figma tool
 * above `repo_branch` on the strength of "list" and "for" alone. The replacement rests on
 * four ideas:
 *
 * 1. Filler is dropped and operation verbs are discounted, so domain nouns decide the match.
 * 2. Terms are weighted by rarity in the corpus (idf), so words nearly every tool shares
 *    ("project", "data") cannot outweigh the discriminating ones.
 * 3. Scores are normalized by query weight, so a verbose description cannot win on surface area.
 * 4. Server affinity: terms that identify one server ("azure", "figma") lift that server's
 *    tools, so cross-server bleed needs a genuine per-tool match to survive.
 */

export type SearchableTool = {
	piName: string;
	serverName: string;
	remoteName: string;
	description: string;
};

export type SearchMatch<T extends SearchableTool = SearchableTool> = {
	tool: T;
	score: number;
};

/**
 * Filler words plus MCP boilerplate that appears in server names and descriptions.
 * Only words with no selection signal belong here; operation verbs go in ACTION_WORDS.
 */
const STOPWORDS = new Set([
	"a", "about", "all", "also", "an", "and", "any", "are", "as", "at", "be", "by", "can", "do",
	"does", "for", "from", "give", "help", "how", "i", "if", "in", "into", "is", "it", "its", "me",
	"my", "need", "of", "on", "or", "our", "please", "should", "so", "some", "such", "than", "that",
	"the", "their", "them", "then", "there", "these", "they", "this", "to", "use", "used", "using",
	"want", "was", "we", "what", "when", "where", "which", "will", "with", "would", "you", "your",
	// MCP plumbing: present in most server names, tool names, and descriptions.
	"api", "mcp", "server", "servers", "tool", "tools",
]);

/**
 * Verbs that describe an operation rather than a domain. They still discriminate
 * (`repo_create_branch` vs `repo_branch`), so they are not stopwords, but they must never
 * outweigh the nouns: "list all pipelines" is about pipelines, not about listing.
 */
const ACTION_WORDS = new Set([
	"add", "assign", "close", "create", "delete", "download", "edit", "fetch", "find", "get",
	"list", "load", "make", "open", "read", "remove", "retrieve", "run", "search", "set",
	"show", "update", "upload", "write",
]);

/** Multiplier applied to an action word's weight. */
const ACTION_WEIGHT = 0.5;

/** Per-field weight of a term hit. Name hits are the strongest signal, prose the weakest. */
const NAME_EXACT = 1;
const NAME_PARTIAL = 0.75;
const SERVER_EXACT = 0.9;
const DESCRIPTION_EXACT = 0.5;
const DESCRIPTION_PARTIAL = 0.3;

/** How much a server-identity match can lift its own tools. */
const SERVER_AFFINITY_BONUS = 0.75;
/** Tools below this normalized score are noise regardless of what else matched. */
const MIN_SCORE = 0.14;
/** Tools scoring below this fraction of the best hit are dropped as long-tail matches. */
const RELATIVE_CUTOFF = 0.4;
/** Shortest term allowed to match a longer token by prefix. */
const MIN_PARTIAL_LENGTH = 4;
/** Shared prefix that makes two different words count as the same concept (selected/selection). */
const MIN_SHARED_PREFIX = 5;
/** A term in this many tools of a single server is that server's boilerplate, not a capability. */
const IDENTITY_MIN_TOOLS = 3;

/** Splits on non-alphanumerics: "get_pull_request v2" → get, pull, request, v2. */
function splitWords(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/**
 * Extra tokens from camelCase identifiers: "getPullRequest" → get, pull, request.
 * Only applied to tool and server names. Prose keeps its words whole, because splitting
 * there shreds product names: "DevOps" would become "dev" + "ops", two weak terms that
 * together outvote a real name match.
 */
function splitIdentifier(value: string): string[] {
	return splitWords(value.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
}

/**
 * Crude singularization so "requests" matches "request". Deliberately conservative:
 * anything it misses is still caught by the prefix match in `termWeight`.
 */
function stem(word: string): string {
	if (word.length >= 4 && word.endsWith("s") && !/(ss|us|is|as)$/.test(word)) {
		return word.slice(0, -1);
	}
	return word;
}

function tokenSet(value: string, kind: "identifier" | "prose"): Set<string> {
	const words = kind === "identifier" ? [...splitWords(value), ...splitIdentifier(value)] : splitWords(value);
	const tokens = new Set<string>();
	for (const word of words) {
		if (STOPWORDS.has(word)) continue;
		tokens.add(stem(word));
	}
	return tokens;
}

/** Query terms, deduped and stripped of filler. Order is irrelevant to scoring. */
export function queryTerms(query: string): string[] {
	return [...tokenSet(query, "prose")];
}

/** True when `term` and some token are the same concept up to a prefix (branch/branches, selected/selection). */
function hasPartial(tokens: Set<string>, term: string): boolean {
	if (term.length < MIN_PARTIAL_LENGTH) return false;
	for (const token of tokens) {
		if (token.length < MIN_PARTIAL_LENGTH) continue;
		if (token.startsWith(term) || term.startsWith(token)) return true;
		let shared = 0;
		while (shared < token.length && shared < term.length && token[shared] === term[shared]) shared++;
		if (shared >= MIN_SHARED_PREFIX) return true;
	}
	return false;
}

type ToolTokens = {
	name: Set<string>;
	server: Set<string>;
	description: Set<string>;
	/** Union of the three, used for document frequency. */
	all: Set<string>;
};

function toolTokens(tool: SearchableTool): ToolTokens {
	const name = tokenSet(tool.remoteName, "identifier");
	const server = tokenSet(tool.serverName, "identifier");
	const description = tokenSet(tool.description, "prose");
	return { name, server, description, all: new Set([...name, ...server, ...description]) };
}

/** log-scaled inverse document frequency; rare terms approach `log(1 + total)`. */
function idf(total: number, documentFrequency: number): number {
	return Math.log(1 + total / (1 + documentFrequency));
}

/** Best per-field weight for one term against one tool. */
function termWeight(tokens: ToolTokens, term: string, isIdentityTerm: boolean): number {
	if (tokens.name.has(term)) return NAME_EXACT;
	if (tokens.server.has(term)) return SERVER_EXACT;
	if (hasPartial(tokens.name, term)) return NAME_PARTIAL;
	// Identity terms ("azure", "figma") appear in the boilerplate of every description their
	// server ships, so crediting them here would rank tools by boilerplate and double-count
	// what server affinity already rewards.
	if (isIdentityTerm) return 0;
	if (tokens.description.has(term)) return DESCRIPTION_EXACT;
	if (hasPartial(tokens.description, term)) return DESCRIPTION_PARTIAL;
	return 0;
}

function matches(tokens: Set<string>, term: string): boolean {
	return tokens.has(term) || hasPartial(tokens, term);
}

type TermStats = {
	/** Weight of the term when ranking tools against each other. */
	toolIdf: number;
	/** Weight of the term when deciding which server the query is about. */
	serverIdf: number;
	/** Some tool in the corpus can match this term. */
	reachable: boolean;
	/** The term names one server rather than one capability. */
	identity: boolean;
};

/**
 * Ranks tools against a free-text query and drops the long tail.
 *
 * An empty query returns the first `limit` tools unranked, matching the previous behavior
 * of scoring everything equally.
 */
export function searchTools<T extends SearchableTool>(tools: T[], query: string, limit: number): SearchMatch<T>[] {
	if (tools.length === 0) return [];

	const terms = queryTerms(query);
	if (terms.length === 0) {
		return tools.slice(0, limit).map((tool) => ({ tool, score: 1 }));
	}

	const tokens = new Map<string, ToolTokens>();
	const byServer = new Map<string, T[]>();
	const vocabularies = new Map<string, Set<string>>();
	for (const tool of tools) {
		const parsed = toolTokens(tool);
		tokens.set(tool.piName, parsed);

		const siblings = byServer.get(tool.serverName);
		if (siblings) siblings.push(tool);
		else byServer.set(tool.serverName, [tool]);

		let vocabulary = vocabularies.get(tool.serverName);
		if (!vocabulary) {
			vocabulary = new Set<string>();
			vocabularies.set(tool.serverName, vocabulary);
		}
		for (const token of parsed.all) vocabulary.add(token);
	}

	const stats = new Map<string, TermStats>();
	for (const term of terms) {
		let toolHits = 0;
		let servers = 0;
		let maxHitsInOneServer = 0;
		for (const [serverName, siblings] of byServer) {
			const hits = siblings.filter((tool) => matches(tokens.get(tool.piName)!.all, term)).length;
			toolHits += hits;
			if (matches(vocabularies.get(serverName)!, term)) servers++;
			maxHitsInOneServer = Math.max(maxHitsInOneServer, hits);
		}
		stats.set(term, {
			toolIdf: idf(tools.length, toolHits) * (ACTION_WORDS.has(term) ? ACTION_WEIGHT : 1),
			serverIdf: idf(byServer.size, servers),
			reachable: toolHits > 0,
			identity: servers === 1 && byServer.size > 1 && maxHitsInOneServer >= IDENTITY_MIN_TOOLS,
		});
	}

	// A term nothing matches (a typo, or "azure" with no Azure server) must not drag every
	// score toward zero, so the normalizer only counts weight some tool can actually earn.
	const reachableIdf = terms.reduce((sum, term) => sum + (stats.get(term)!.reachable ? stats.get(term)!.toolIdf : 0), 0);
	if (reachableIdf === 0) return [];
	const serverIdfTotal = terms.reduce((sum, term) => sum + stats.get(term)!.serverIdf, 0);

	const affinities = new Map<string, number>();
	for (const [serverName, vocabulary] of vocabularies) {
		const matched = terms.reduce((sum, term) => sum + (matches(vocabulary, term) ? stats.get(term)!.serverIdf : 0), 0);
		affinities.set(serverName, serverIdfTotal === 0 ? 0 : matched / serverIdfTotal);
	}

	const scored: SearchMatch<T>[] = [];
	for (const tool of tools) {
		const parsed = tokens.get(tool.piName)!;
		let weighted = 0;
		for (const term of terms) {
			const stat = stats.get(term)!;
			weighted += stat.toolIdf * termWeight(parsed, term, stat.identity);
		}
		if (weighted <= 0) continue;
		scored.push({ tool, score: (weighted / reachableIdf) * (1 + SERVER_AFFINITY_BONUS * (affinities.get(tool.serverName) ?? 0)) });
	}

	if (scored.length === 0) return [];
	// Ties are common when the query only names a server: prefer the shorter name, which for
	// most servers is the umbrella tool (`work`) rather than a narrow variant (`work_capacity_write`).
	scored.sort(
		(a, b) =>
			b.score - a.score ||
			a.tool.remoteName.length - b.tool.remoteName.length ||
			a.tool.piName.localeCompare(b.tool.piName),
	);

	const best = scored[0].score;
	// Keep the top hit even if it is weak: one mediocre answer beats "no tools matched".
	return scored.filter((entry, index) => index === 0 || (entry.score >= MIN_SCORE && entry.score >= best * RELATIVE_CUTOFF)).slice(0, limit);
}
