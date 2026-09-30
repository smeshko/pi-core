import { lookup } from "node:dns/promises";
import { mkdtemp, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { callHeader, displayUrl, textComponent, treeLines, type RenderContext } from "./shared/tool-render-style.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_DOWNLOAD_LIMIT_BYTES = 1_000_000;
const MAX_DOWNLOAD_LIMIT_BYTES = 5_000_000;
const MAX_REDIRECTS = 10;
const PRIVATE_NETWORK_ENV = "PI_WEBFETCH_ALLOW_PRIVATE";

const WebFetchParams = Type.Object({
	url: Type.String({ description: "HTTP or HTTPS URL to fetch" }),
	format: Type.Optional(
		StringEnum(["auto", "text", "raw"] as const, {
			description:
				"Output format. auto converts HTML to readable text and pretty-prints JSON; text forces readable text; raw returns the decoded response body.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description: `Request timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}; maximum ${MAX_TIMEOUT_MS}.`,
		}),
	),
	maxDownloadBytes: Type.Optional(
		Type.Number({
			description: `Maximum response bytes to download before stopping. Default ${formatSize(DEFAULT_DOWNLOAD_LIMIT_BYTES)}; maximum ${formatSize(MAX_DOWNLOAD_LIMIT_BYTES)}.`,
		}),
	),
});

type OutputFormat = "auto" | "text" | "raw";

interface WebFetchParamsType {
	url: string;
	format?: OutputFormat;
	timeoutMs?: number;
	maxDownloadBytes?: number;
}

interface WebFetchDetails {
	url: string;
	finalUrl: string;
	status: number;
	statusText: string;
	ok: boolean;
	contentType?: string;
	title?: string;
	outputFormat: OutputFormat | "html-text" | "json";
	downloadedBytes: number;
	downloadLimitBytes: number;
	downloadTruncated: boolean;
	outputTruncation?: TruncationResult;
	fullOutputPath?: string;
}

interface BodyReadResult {
	bytes: Buffer;
	truncated: boolean;
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

function isTruthyEnv(value: string | undefined) {
	return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function normalizeHostname(hostname: string) {
	const normalized = hostname.toLowerCase().replace(/\.$/, "");
	if (normalized.startsWith("[") && normalized.endsWith("]")) return normalized.slice(1, -1);
	return normalized;
}

function parseIPv4(address: string) {
	const parts = address.split(".").map((part) => Number(part));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
	return parts;
}

function isNonPublicIPv4(address: string) {
	const parts = parseIPv4(address);
	if (!parts) return true;
	const [a, b, c] = parts;

	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0 && (c === 0 || c === 2)) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224
	);
}

function isNonPublicIPv6(address: string) {
	const normalized = address.toLowerCase();
	if (normalized.startsWith("::ffff:")) {
		return isNonPublicIPv4(normalized.slice("::ffff:".length));
	}

	return (
		normalized === "::" ||
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		/^fe[89ab]/.test(normalized) ||
		normalized.startsWith("ff") ||
		normalized.startsWith("2001:db8")
	);
}

function isNonPublicAddress(address: string) {
	const family = isIP(address);
	if (family === 4) return isNonPublicIPv4(address);
	if (family === 6) return isNonPublicIPv6(address);
	return true;
}

async function assertFetchableUrl(urlText: string) {
	let url: URL;
	try {
		url = new URL(urlText);
	} catch {
		throw new Error(`Invalid URL: ${urlText}`);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("webfetch only supports http:// and https:// URLs.");
	}
	if (url.username || url.password) {
		throw new Error("webfetch refuses URLs with embedded credentials.");
	}

	if (isTruthyEnv(process.env[PRIVATE_NETWORK_ENV])) return url;

	const hostname = normalizeHostname(url.hostname);
	if (!hostname) throw new Error("URL is missing a hostname.");
	if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
		throw new Error(
			`webfetch blocks local/private network hosts by default (${hostname}). Set ${PRIVATE_NETWORK_ENV}=1 to allow them.`,
		);
	}

	const literalFamily = isIP(hostname);
	if (literalFamily) {
		if (isNonPublicAddress(hostname)) {
			throw new Error(
				`webfetch blocks local/private/reserved IP addresses by default (${hostname}). Set ${PRIVATE_NETWORK_ENV}=1 to allow them.`,
			);
		}
		return url;
	}

	const addresses = await lookup(hostname, { all: true, verbatim: true });
	if (addresses.length === 0) throw new Error(`Could not resolve hostname: ${hostname}`);

	for (const address of addresses) {
		if (isNonPublicAddress(address.address)) {
			throw new Error(
				`webfetch blocks local/private/reserved network addresses by default (${hostname} resolved to ${address.address}). Set ${PRIVATE_NETWORK_ENV}=1 to allow them.`,
			);
		}
	}

	return url;
}

function createRequestSignal(parent: AbortSignal | undefined, timeoutMs: number) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error(`webfetch timed out after ${timeoutMs}ms`)), timeoutMs);

	const abortFromParent = () => controller.abort(parent?.reason);
	if (parent?.aborted) abortFromParent();
	else parent?.addEventListener("abort", abortFromParent, { once: true });

	return {
		signal: controller.signal,
		cleanup() {
			clearTimeout(timeout);
			parent?.removeEventListener("abort", abortFromParent);
		},
	};
}

async function fetchWithRedirects(urlText: string, signal: AbortSignal, redirectsLeft = MAX_REDIRECTS): Promise<Response> {
	let currentUrl = (await assertFetchableUrl(urlText)).toString();

	for (let redirectCount = 0; redirectCount <= redirectsLeft; redirectCount++) {
		await assertFetchableUrl(currentUrl);
		const response = await fetch(currentUrl, {
			method: "GET",
			redirect: "manual",
			signal,
			headers: {
				accept: "text/html,application/xhtml+xml,application/json,text/plain,application/xml;q=0.9,*/*;q=0.8",
				"user-agent": "pi-webfetch/1.0 (+https://pi.dev)",
			},
		});

		const location = response.headers.get("location");
		if (response.status < 300 || response.status >= 400 || !location) return response;

		if (redirectCount === redirectsLeft) {
			throw new Error(`Too many redirects while fetching ${urlText}`);
		}
		currentUrl = new URL(location, currentUrl).toString();
	}

	throw new Error(`Too many redirects while fetching ${urlText}`);
}

function isLikelyTextContentType(contentType: string | null) {
	if (!contentType) return true;
	const normalized = contentType.toLowerCase();
	return (
		normalized.startsWith("text/") ||
		normalized.includes("json") ||
		normalized.includes("xml") ||
		normalized.includes("javascript") ||
		normalized.includes("ecmascript") ||
		normalized.includes("yaml") ||
		normalized.includes("x-www-form-urlencoded")
	);
}

async function readResponseBody(response: Response, maxBytes: number): Promise<BodyReadResult> {
	if (!response.body) return { bytes: Buffer.alloc(0), truncated: false };

	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	let truncated = false;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;

			const chunk = Buffer.from(value);
			const remaining = maxBytes - total;
			if (chunk.length > remaining) {
				if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
				total = maxBytes;
				truncated = true;
				await reader.cancel();
				break;
			}

			chunks.push(chunk);
			total += chunk.length;
		}
	} finally {
		reader.releaseLock();
	}

	return { bytes: Buffer.concat(chunks, total), truncated };
}

function detectCharset(contentType: string | null) {
	const match = contentType?.match(/charset\s*=\s*([^;]+)/i);
	return match?.[1]?.trim().replace(/^['"]|['"]$/g, "") || "utf-8";
}

function decodeBody(bytes: Buffer, contentType: string | null) {
	const charset = detectCharset(contentType);
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

function looksBinary(bytes: Buffer) {
	if (bytes.length === 0) return false;
	const sample = bytes.subarray(0, Math.min(bytes.length, 2048));
	let control = 0;
	for (const byte of sample) {
		if (byte === 0) return true;
		if (byte < 8 || (byte > 13 && byte < 32)) control++;
	}
	return control / sample.length > 0.1;
}

function codePointToString(codePoint: number, fallback: string) {
	if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback;
	try {
		return String.fromCodePoint(codePoint);
	} catch {
		return fallback;
	}
}

function decodeEntities(text: string) {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
		const normalized = entity.toLowerCase();
		if (normalized.startsWith("#x")) {
			return codePointToString(Number.parseInt(normalized.slice(2), 16), match);
		}
		if (normalized.startsWith("#")) {
			return codePointToString(Number.parseInt(normalized.slice(1), 10), match);
		}
		return namedEntities[normalized] ?? match;
	});
}

function stripTags(text: string) {
	return text.replace(/<[^>]*>/g, " ");
}

function normalizePlainText(text: string) {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/[\t\f\v ]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function extractHtmlTitle(html: string) {
	const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
	if (!match) return undefined;
	const title = normalizePlainText(decodeEntities(stripTags(match[1])));
	return title || undefined;
}

function extractAttribute(attrs: string, name: string) {
	const quoted = attrs.match(new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
	if (quoted) return quoted[2];
	const unquoted = attrs.match(new RegExp(`${name}\\s*=\\s*([^\\s>]+)`, "i"));
	return unquoted?.[1];
}

function absolutizeLink(href: string | undefined, baseUrl: string) {
	if (!href || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) return undefined;
	try {
		const url = new URL(decodeEntities(href), baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

function htmlToText(html: string, baseUrl: string) {
	let working = html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<!doctype[\s\S]*?>/gi, " ")
		.replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
		.replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, " ")
		.replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, " ")
		.replace(/<canvas\b[\s\S]*?<\/canvas\s*>/gi, " ");

	working = working.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_match, attrs: string, body: string) => {
		const label = normalizePlainText(decodeEntities(stripTags(body)));
		const link = absolutizeLink(extractAttribute(attrs, "href"), baseUrl);
		if (!label) return link ?? "";
		if (!link || link === label) return label;
		return `${label} (${link})`;
	});

	working = working
		.replace(/<br\s*\/?\s*>/gi, "\n")
		.replace(/<hr\s*\/?\s*>/gi, "\n---\n")
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<h[1-6]\b[^>]*>/gi, "\n")
		.replace(/<\/(p|div|section|article|header|footer|main|nav|aside|h[1-6]|li|ul|ol|tr|table|blockquote|pre|figure|figcaption)\s*>/gi, "\n")
		.replace(/<(p|div|section|article|header|footer|main|nav|aside|tr|table|blockquote|pre|figure|figcaption)\b[^>]*>/gi, "\n");

	return normalizePlainText(decodeEntities(stripTags(working)));
}

function isHtmlContent(contentType: string | null, text: string) {
	return Boolean(
		contentType?.toLowerCase().includes("html") || /^\s*(<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(text),
	);
}

function isJsonContent(contentType: string | null, text: string) {
	return Boolean(contentType?.toLowerCase().includes("json") || /^\s*[\[{]/.test(text));
}

function convertBody(text: string, contentType: string | null, format: OutputFormat, finalUrl: string) {
	if (format === "raw") return { text, outputFormat: "raw" as const, title: undefined };

	if (isHtmlContent(contentType, text)) {
		return {
			text: htmlToText(text, finalUrl),
			outputFormat: "html-text" as const,
			title: extractHtmlTitle(text),
		};
	}

	if (format === "auto" && isJsonContent(contentType, text)) {
		try {
			return { text: JSON.stringify(JSON.parse(text), null, 2), outputFormat: "json" as const, title: undefined };
		} catch {
			// Fall back to raw text below.
		}
	}

	return {
		text: format === "text" ? normalizePlainText(text) : text.trim(),
		outputFormat: format,
		title: undefined,
	};
}

async function saveFullOutput(output: string) {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-webfetch-"));
	const tempFile = join(tempDir, "output.txt");
	await writeFile(tempFile, output, "utf8");
	return tempFile;
}

function makeMetadataLines(details: WebFetchDetails) {
	const lines = [
		`URL: ${details.finalUrl}`,
		`Status: ${details.status} ${details.statusText || ""}`.trim(),
		details.contentType ? `Content-Type: ${details.contentType}` : undefined,
		details.title ? `Title: ${details.title}` : undefined,
		`Format: ${details.outputFormat}`,
		`Downloaded: ${formatSize(details.downloadedBytes)}${details.downloadTruncated ? ` (capped at ${formatSize(details.downloadLimitBytes)})` : ""}`,
	];
	return lines.filter((line): line is string => Boolean(line));
}


export default function webFetchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "webfetch",
		label: "Web Fetch",
		description: `Fetch an HTTP(S) URL and return readable text. HTML is converted to readable text by default, JSON is pretty-printed, output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}, and downloads are capped at ${formatSize(DEFAULT_DOWNLOAD_LIMIT_BYTES)} by default. Local/private network URLs are blocked unless ${PRIVATE_NETWORK_ENV}=1 is set.`,
		promptSnippet: "Fetch public HTTP(S) URLs and return readable text from web pages, docs, JSON, or plain text resources.",
		promptGuidelines: [
			"Use webfetch when the user asks to inspect a public URL, current web page, online documentation, JSON endpoint, or other web text resource.",
			"Do not use webfetch for local files; use read for local paths instead.",
			"When webfetch output says it was truncated, use the provided temp file path with read only if the omitted content is needed.",
		],
		parameters: WebFetchParams,
		renderShell: "self",

		async execute(_toolCallId, params: WebFetchParamsType, signal) {
			const timeoutMs = clampNumber(params.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS);
			const downloadLimitBytes = clampNumber(
				params.maxDownloadBytes,
				DEFAULT_DOWNLOAD_LIMIT_BYTES,
				1_024,
				MAX_DOWNLOAD_LIMIT_BYTES,
			);
			const format = params.format ?? "auto";

			const request = createRequestSignal(signal, timeoutMs);
			try {
				const response = await fetchWithRedirects(params.url, request.signal);
				const contentType = response.headers.get("content-type") ?? undefined;
				const detailsBase = {
					url: params.url,
					finalUrl: response.url || params.url,
					status: response.status,
					statusText: response.statusText,
					ok: response.ok,
					contentType,
					downloadLimitBytes,
				};

				if (!isLikelyTextContentType(contentType ?? null)) {
					const details: WebFetchDetails = {
						...detailsBase,
						outputFormat: format,
						downloadedBytes: 0,
						downloadTruncated: false,
					};
					return {
						content: [
							{
								type: "text" as const,
								text: `${makeMetadataLines(details).join("\n")}\n\nResponse body was not read because the content type does not look text-based.`,
							},
						],
						details,
					};
				}

				const body = await readResponseBody(response, downloadLimitBytes);
				if (!contentType && looksBinary(body.bytes)) {
					const details: WebFetchDetails = {
						...detailsBase,
						outputFormat: format,
						downloadedBytes: body.bytes.length,
						downloadTruncated: body.truncated,
					};
					return {
						content: [
							{
								type: "text" as const,
								text: `${makeMetadataLines(details).join("\n")}\n\nResponse body appears to be binary data and was not decoded.`,
							},
						],
						details,
					};
				}

				const decoded = decodeBody(body.bytes, contentType ?? null);
				const converted = convertBody(decoded, contentType ?? null, format, response.url || params.url);
				const outputTruncation = truncateHead(converted.text, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});

				const details: WebFetchDetails = {
					...detailsBase,
					title: converted.title,
					outputFormat: converted.outputFormat,
					downloadedBytes: body.bytes.length,
					downloadTruncated: body.truncated,
				};

				let output = outputTruncation.content;
				const notices: string[] = [];

				if (body.truncated) {
					notices.push(
						`[Download capped: only the first ${formatSize(body.bytes.length)} were read from the response. Increase maxDownloadBytes up to ${formatSize(MAX_DOWNLOAD_LIMIT_BYTES)} if needed.]`,
					);
				}

				if (outputTruncation.truncated) {
					const tempFile = await saveFullOutput(converted.text);
					details.outputTruncation = outputTruncation;
					details.fullOutputPath = tempFile;
					notices.push(
						`[Output truncated: showing ${outputTruncation.outputLines} of ${outputTruncation.totalLines} lines (${formatSize(outputTruncation.outputBytes)} of ${formatSize(outputTruncation.totalBytes)}). Full converted output saved to: ${tempFile}]`,
					);
				}

				if (notices.length > 0) output += `\n\n${notices.join("\n")}`;

				const metadata = makeMetadataLines(details).join("\n");
				return {
					content: [{ type: "text" as const, text: `${metadata}\n\n${output}`.trim() }],
					details,
				};
			} finally {
				request.cleanup();
			}
		},

		renderCall(args, theme, context) {
			const renderContext = context as unknown as RenderContext;
			const url = typeof args.url === "string" ? args.url : "";
			return textComponent(renderContext, callHeader(theme, renderContext, "Webfetch", displayUrl(url)));
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const renderContext = context as unknown as RenderContext;
			if (isPartial) return textComponent(renderContext, treeLines(theme, "Fetching URL", [], { warning: true }));

			const details = result.details as WebFetchDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return textComponent(renderContext, first?.type === "text" ? (first.text ?? "") : "");
			}

			const status = `${details.status} ${details.statusText || ""}`.trim();
			const body: string[] = [];
			if (details.title) body.push(theme.fg("muted", truncateToWidth(details.title, 96)));
			if (details.downloadTruncated || details.outputTruncation?.truncated) body.push(theme.fg("warning", "truncated"));
			if (expanded) {
				body.push(theme.fg("dim", `URL: ${details.finalUrl}`));
				if (details.contentType) body.push(theme.fg("dim", `Content-Type: ${details.contentType}`));
				body.push(theme.fg("dim", `Downloaded: ${formatSize(details.downloadedBytes)}`));
				body.push(theme.fg("dim", `Format: ${details.outputFormat}`));
				if (details.fullOutputPath) body.push(theme.fg("dim", `Full output: ${details.fullOutputPath}`));
			}

			return textComponent(renderContext, treeLines(theme, `Fetched ${status}`, body, { warning: !details.ok }));
		},
	});
}
