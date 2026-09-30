import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { callHeader, displayUrl, textComponent, treeLines, type RenderContext } from "./shared/tool-render-style.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;
const PROVIDER = "duckduckgo-html";

const WebSearchParams = Type.Object({
	query: Type.String({ description: "Web search query" }),
	maxResults: Type.Optional(
		Type.Number({ description: `Maximum search results to return. Default ${DEFAULT_MAX_RESULTS}; maximum ${MAX_RESULTS}.` }),
	),
	site: Type.Optional(Type.String({ description: "Optional domain to restrict results to, e.g. docs.python.org" })),
	timeoutMs: Type.Optional(
		Type.Number({ description: `Request timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}; maximum ${MAX_TIMEOUT_MS}.` }),
	),
});

interface WebSearchParamsType {
	query: string;
	maxResults?: number;
	site?: string;
	timeoutMs?: number;
}

interface WebSearchResult {
	title: string;
	url: string;
	snippet?: string;
}

interface WebSearchDetails {
	query: string;
	effectiveQuery: string;
	provider: typeof PROVIDER;
	searchUrl: string;
	resultCount: number;
	results: WebSearchResult[];
	outputTruncation?: TruncationResult;
	fullOutputPath?: string;
}

const namedEntities: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	copy: "©",
	reg: "®",
	trade: "™",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
};

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function cleanSite(site: string | undefined) {
	if (!site) return undefined;
	let cleaned = site.trim();
	if (!cleaned) return undefined;
	cleaned = cleaned.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0] ?? "";
	return cleaned || undefined;
}

function effectiveQuery(query: string, site: string | undefined) {
	const trimmed = query.trim();
	const domain = cleanSite(site);
	return domain ? `${trimmed} site:${domain}` : trimmed;
}

function decodeCodePoint(codePoint: number, fallback: string) {
	return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : fallback;
}

function decodeHtmlEntities(input: string) {
	return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (entity, body: string) => {
		if (body.startsWith("#x") || body.startsWith("#X")) return decodeCodePoint(Number.parseInt(body.slice(2), 16), entity);
		if (body.startsWith("#")) return decodeCodePoint(Number.parseInt(body.slice(1), 10), entity);
		return namedEntities[body.toLowerCase()] ?? entity;
	});
}

function stripHtml(input: string) {
	return decodeHtmlEntities(
		input
			.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
			.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim(),
	);
}

function getAttribute(tag: string, name: string) {
	const match = tag.match(new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
	return match ? decodeHtmlEntities(match[2] ?? "") : undefined;
}

function resolveResultUrl(rawHref: string | undefined) {
	if (!rawHref) return undefined;
	const href = decodeHtmlEntities(rawHref).trim();
	const absolute = href.startsWith("//") ? `https:${href}` : href;
	try {
		const url = new URL(absolute);
		if (url.hostname.endsWith("duckduckgo.com") && url.pathname === "/l/") {
			const target = url.searchParams.get("uddg");
			if (target) return target;
		}
		return url.toString();
	} catch {
		return /^https?:\/\//i.test(href) ? href : undefined;
	}
}

function truncateSnippet(snippet: string | undefined) {
	if (!snippet) return undefined;
	return truncateToWidth(snippet.replace(/\s+/g, " ").trim(), 320);
}

function parseDuckDuckGoHtml(html: string, maxResults: number): WebSearchResult[] {
	const anchorPattern = /<a\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bresult__a\b[^"']*["'])[^>]*>[\s\S]*?<\/a>/gi;
	const anchors = [...html.matchAll(anchorPattern)];
	const results: WebSearchResult[] = [];
	const seenUrls = new Set<string>();

	for (let index = 0; index < anchors.length && results.length < maxResults; index++) {
		const anchor = anchors[index];
		const anchorHtml = anchor[0] ?? "";
		const tag = anchorHtml.match(/^<a\b[^>]*>/i)?.[0] ?? "";
		const url = resolveResultUrl(getAttribute(tag, "href"));
		if (!url || !/^https?:\/\//i.test(url) || seenUrls.has(url)) continue;

		const title = stripHtml(anchorHtml);
		if (!title) continue;

		const currentEnd = (anchor.index ?? 0) + anchorHtml.length;
		const nextStart = anchors[index + 1]?.index ?? html.length;
		const block = html.slice(currentEnd, nextStart);
		const snippetMatch = block.match(
			/<(?:a|div)\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'])[^>]*>([\s\S]*?)<\/(?:a|div)>/i,
		);
		const snippet = truncateSnippet(snippetMatch ? stripHtml(snippetMatch[1] ?? "") : undefined);

		seenUrls.add(url);
		results.push({ title, url, snippet });
	}

	return results;
}

function makeSearchUrl(query: string) {
	const url = new URL("https://html.duckduckgo.com/html/");
	url.searchParams.set("q", query);
	return url.toString();
}

function createRequestSignal(parentSignal: AbortSignal | undefined, timeoutMs: number) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	if (parentSignal) {
		if (parentSignal.aborted) controller.abort();
		else parentSignal.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		dispose() {
			clearTimeout(timeout);
			parentSignal?.removeEventListener("abort", onAbort);
		},
	};
}

async function fetchSearchHtml(searchUrl: string, signal: AbortSignal) {
	const response = await fetch(searchUrl, {
		signal,
		headers: {
			"User-Agent": "pi-websearch/1.0 (+https://pi.dev)",
			Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9,*;q=0.5",
		},
	});

	if (!response.ok) throw new Error(`Search provider returned ${response.status} ${response.statusText}`.trim());
	return response.text();
}

function formatResults(details: WebSearchDetails) {
	const lines = [
		`Query: ${details.query}`,
		details.effectiveQuery !== details.query ? `Effective query: ${details.effectiveQuery}` : undefined,
		`Provider: ${details.provider}`,
		`Results: ${details.resultCount}`,
		"",
	].filter((line): line is string => Boolean(line));

	if (details.results.length === 0) {
		lines.push("No search results found.");
		return lines.join("\n");
	}

	details.results.forEach((result, index) => {
		lines.push(`${index + 1}. ${result.title}`);
		lines.push(`   URL: ${result.url}`);
		if (result.snippet) lines.push(`   Snippet: ${result.snippet}`);
	});
	return lines.join("\n");
}

async function saveFullOutput(output: string) {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-websearch-"));
	const tempFile = join(tempDir, "output.txt");
	await writeFile(tempFile, output, "utf8");
	return tempFile;
}

function isAbortError(error: unknown) {
	return error instanceof Error && error.name === "AbortError";
}

export default function webSearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "websearch",
		label: "Web Search",
		description: `Search the public web and return a concise list of result titles, URLs, and snippets. Uses DuckDuckGo's HTML endpoint. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} if needed.`,
		promptSnippet: "Search the public web for result URLs, titles, and snippets.",
		promptGuidelines: [
			"Use websearch when the user asks for current information or when you need to discover relevant public URLs before using webfetch.",
			"Use webfetch after websearch when you need to read and synthesize the contents of specific result pages.",
		],
		parameters: WebSearchParams,
		renderShell: "self",

		async execute(_toolCallId, params: WebSearchParamsType, signal) {
			const query = params.query.trim();
			if (!query) throw new Error("Search query cannot be empty.");

			const maxResults = clampNumber(params.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS);
			const timeoutMs = clampNumber(params.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS);
			const searchQuery = effectiveQuery(query, params.site);
			const searchUrl = makeSearchUrl(searchQuery);
			const request = createRequestSignal(signal, timeoutMs);

			try {
				const html = await fetchSearchHtml(searchUrl, request.signal);
				const results = parseDuckDuckGoHtml(html, maxResults);
				const details: WebSearchDetails = {
					query,
					effectiveQuery: searchQuery,
					provider: PROVIDER,
					searchUrl,
					resultCount: results.length,
					results,
				};

				let output = formatResults(details);
				const truncation = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
				output = truncation.content;

				if (truncation.truncated) {
					details.outputTruncation = truncation;
					details.fullOutputPath = await saveFullOutput(formatResults(details));
					output += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
					output += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
					output += ` Full output saved to: ${details.fullOutputPath}]`;
				}

				return { content: [{ type: "text" as const, text: output }], details };
			} catch (error) {
				if (isAbortError(error)) throw new Error(`websearch request timed out after ${timeoutMs}ms or was aborted.`);
				throw error;
			} finally {
				request.dispose();
			}
		},

		renderCall(args, theme, context) {
			const renderContext = context as unknown as RenderContext;
			const params = args as Partial<WebSearchParamsType>;
			return textComponent(renderContext, callHeader(theme, renderContext, "Websearch", params.query ? truncateToWidth(params.query, 72) : "..."));
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const renderContext = context as unknown as RenderContext;
			const details = result.details as WebSearchDetails | undefined;
			if (isPartial) return textComponent(renderContext, treeLines(theme, "Searching web...", [], { warning: true }));
			if (!details) return textComponent(renderContext, treeLines(theme, "No search details returned", [], { warning: true }));

			const summary = details.resultCount === 1 ? "1 result" : `${details.resultCount} results`;
			const body = expanded
				? details.results.map((item, index) => `${index + 1}. ${theme.fg("accent", truncateToWidth(item.title, 88))} ${theme.fg("dim", displayUrl(item.url, 72))}`)
				: details.results.slice(0, 3).map((item) => `${theme.fg("accent", truncateToWidth(item.title, 72))} ${theme.fg("dim", displayUrl(item.url, 56))}`);

			if (details.outputTruncation?.truncated) body.push(theme.fg("warning", "Output truncated"));
			return textComponent(renderContext, treeLines(theme, summary, body));
		},
	});
}
