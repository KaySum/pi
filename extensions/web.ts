/**
 * Web - fetch a page and search the web.
 *
 * `web_fetch` retrieves a URL and returns readable text. `web_search` needs a provider
 * key: set BRAVE_API_KEY or TAVILY_API_KEY, whichever you have.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_CHARS = 60_000;
const TIMEOUT_MS = 30_000;
const USER_AGENT = "pi-agent";

const ENTITIES: Record<string, string> = {
	"&nbsp;": " ",
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
};

function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
		.replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n\s*\n+/g, "\n\n")
		.trim();
}

function truncate(text: string, source: string): string {
	if (text.length <= MAX_CHARS) return text;
	return `${text.slice(0, MAX_CHARS)}\n\n[truncated at ${MAX_CHARS} characters; fetch ${source} directly for the rest]`;
}

async function request(url: string, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const response = await fetch(url, {
		...init,
		headers: { "user-agent": USER_AGENT, ...init.headers },
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
	return response;
}

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

async function braveSearch(query: string, key: string, signal: AbortSignal | undefined): Promise<SearchResult[]> {
	const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`;
	const response = await request(url, { headers: { accept: "application/json", "x-subscription-token": key } }, signal);
	const body = (await response.json()) as { web?: { results?: { title: string; url: string; description: string }[] } };
	return (body.web?.results ?? []).map((result) => ({
		title: result.title,
		url: result.url,
		snippet: htmlToText(result.description ?? ""),
	}));
}

async function tavilySearch(query: string, key: string, signal: AbortSignal | undefined): Promise<SearchResult[]> {
	const response = await request(
		"https://api.tavily.com/search",
		{
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
			body: JSON.stringify({ query, max_results: 10 }),
		},
		signal,
	);
	const body = (await response.json()) as { results?: { title: string; url: string; content: string }[] };
	return (body.results ?? []).map((result) => ({ title: result.title, url: result.url, snippet: result.content }));
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "Fetch",
		description: [
			"Fetch a URL and return its readable text content.",
			"Use it to read documentation, issues, or any page whose contents you need verbatim.",
			"Prefer an authenticated CLI such as `gh` for private resources; this tool sends no credentials.",
		].join("\n"),
		promptSnippet: "web_fetch: read a web page as text",
		parameters: Type.Object({
			url: Type.String({ description: "Absolute http(s) URL" }),
		}),

		async execute(_toolCallId, params, signal) {
			const url = new URL(params.url);
			if (url.protocol === "http:") url.protocol = "https:";

			const response = await request(url.toString(), {}, signal);
			const contentType = response.headers.get("content-type") ?? "";
			const body = await response.text();
			const text = contentType.includes("html") ? htmlToText(body) : body;

			return {
				content: [{ type: "text", text: truncate(text, url.toString()) }],
				details: { url: url.toString(), contentType, length: text.length },
			};
		},
	});

	pi.registerTool({
		name: "web_search",
		label: "Search",
		description: [
			"Search the web and return titles, URLs, and snippets.",
			"Use it for anything that may have changed since your training data, then read the",
			"promising results with web_fetch rather than trusting the snippets alone.",
		].join("\n"),
		promptSnippet: "web_search: search the web for current information",
		parameters: Type.Object({
			query: Type.String({ description: "The search query" }),
		}),

		async execute(_toolCallId, params, signal) {
			const brave = process.env.BRAVE_API_KEY;
			const tavily = process.env.TAVILY_API_KEY;
			if (!brave && !tavily) {
				throw new Error("Web search needs a provider key. Set BRAVE_API_KEY or TAVILY_API_KEY.");
			}

			const results = brave
				? await braveSearch(params.query, brave, signal)
				: await tavilySearch(params.query, tavily as string, signal);

			if (results.length === 0) {
				return { content: [{ type: "text", text: `No results for "${params.query}"` }], details: { results } };
			}

			const text = results
				.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`)
				.join("\n\n");

			return { content: [{ type: "text", text }], details: { query: params.query, results } };
		},
	});
}
