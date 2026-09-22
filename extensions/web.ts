/**
 * Web - read pages and search the web, without credentials.
 *
 * `web_search` uses DuckDuckGo's lite endpoint, which needs no key. That endpoint rate-limits
 * by IP and answers a burst of rapid queries with an anti-bot challenge instead of results, so
 * requests here are serialized and spaced out, and a challenge is retried once before it is
 * reported. Ordinary use - a handful of searches across a session - stays well inside it.
 *
 * Setting `BRAVE_API_KEY` or `TAVILY_API_KEY` switches to that provider and sidesteps the rate
 * limit entirely. It is an upgrade, never a requirement.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_CHARS = 60_000;
/** Snippets are for deciding what to fetch, not for reading. Providers can return paragraphs. */
const SNIPPET_CAP = 300;
const TIMEOUT_MS = 30_000;
const USER_AGENT = "pi-agent";

const DUCKDUCKGO = "https://lite.duckduckgo.com/lite/";
/** DuckDuckGo serves its plain markup to a browser user agent. */
const SEARCH_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const MIN_SEARCH_INTERVAL_MS = 1_500;
const CHALLENGE_BACKOFF_MS = 3_000;

const ENTITIES: Record<string, string> = {
	"&nbsp;": " ",
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
	"&apos;": "'",
};

function decodeEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
		.replace(/&[a-z]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? " ");
}

function stripTags(html: string): string {
	return html
		.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<[^>]+>/g, " ");
}

function htmlToText(html: string): string {
	const broken = html
		.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, "\n");

	return decodeEntities(stripTags(broken))
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n\s*\n+/g, "\n\n")
		.trim();
}

/** Tags out, entities in, whitespace collapsed to one line. */
function inline(html: string): string {
	return decodeEntities(stripTags(html)).replace(/\s+/g, " ").trim();
}

function truncate(text: string, source: string): string {
	if (text.length <= MAX_CHARS) return text;
	return `${text.slice(0, MAX_CHARS)}\n\n[truncated at ${MAX_CHARS} characters; fetch ${source} directly for the rest]`;
}

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function timeoutSignal(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function request(url: string, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> {
	const response = await fetch(url, {
		...init,
		headers: { "user-agent": USER_AGENT, ...init.headers },
		signal: timeoutSignal(signal),
	});
	if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
	return response;
}

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

type Search = (query: string, signal: AbortSignal | undefined) => Promise<SearchResult[]>;

// ---------------------------------------------------------------------------
// DuckDuckGo
// ---------------------------------------------------------------------------

const RESULT_LINK = /<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
const RESULT_SNIPPET = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i;

/** Results carry a redirect wrapper: //duckduckgo.com/l/?uddg=<encoded target>&rut=... */
function resultUrl(href: string): string {
	const decoded = decodeEntities(href);
	const redirect = /[?&]uddg=([^&]+)/.exec(decoded);
	if (redirect) {
		try {
			return decodeURIComponent(redirect[1]);
		} catch {
			return "";
		}
	}
	return decoded.startsWith("//") ? `https:${decoded}` : decoded;
}

function parseResults(html: string): SearchResult[] {
	const links = [...html.matchAll(RESULT_LINK)];

	return links
		.map((link, index) => {
			// A result's snippet is the next one in the document, before the following result.
			const from = (link.index ?? 0) + link[0].length;
			const to = index + 1 < links.length ? (links[index + 1].index ?? html.length) : html.length;
			const snippet = RESULT_SNIPPET.exec(html.slice(from, to));

			return { title: inline(link[2]), url: resultUrl(link[1]), snippet: snippet ? inline(snippet[1]) : "" };
		})
		.filter((result) => result.title !== "" && result.url.startsWith("http"));
}

/** The anti-bot page is a 2xx with no results, so it has to be recognised by content. */
const looksLikeChallenge = (html: string) => /challenge|anomaly|captcha/i.test(html);

const duckDuckGo: Search = async (query, signal) => {
	const fetchOnce = async () => {
		const response = await fetch(DUCKDUCKGO, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"user-agent": SEARCH_USER_AGENT,
				referer: "https://lite.duckduckgo.com/",
			},
			body: new URLSearchParams({ q: query }).toString(),
			signal: timeoutSignal(signal),
		});
		return response.text();
	};

	let html = await fetchOnce();
	let results = parseResults(html);

	// An empty page with challenge markers means rate limiting, not "no matches".
	if (results.length === 0 && looksLikeChallenge(html)) {
		await sleep(CHALLENGE_BACKOFF_MS);
		html = await fetchOnce();
		results = parseResults(html);

		if (results.length === 0 && looksLikeChallenge(html)) {
			throw new Error(
				"DuckDuckGo is rate-limiting this address. Wait a minute before searching again, " +
					"read a known page with web_fetch instead, or set BRAVE_API_KEY or TAVILY_API_KEY to use a provider.",
			);
		}
	}

	return results;
};

// ---------------------------------------------------------------------------
// Optional providers
// ---------------------------------------------------------------------------

function braveSearch(key: string): Search {
	return async (query, signal) => {
		const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`;
		const response = await request(
			url,
			{ headers: { accept: "application/json", "x-subscription-token": key } },
			signal,
		);
		const body = (await response.json()) as {
			web?: { results?: { title: string; url: string; description: string }[] };
		};
		return (body.web?.results ?? []).map((result) => ({
			title: result.title,
			url: result.url,
			snippet: inline(result.description ?? ""),
		}));
	};
}

function tavilySearch(key: string): Search {
	return async (query, signal) => {
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
	};
}

function resolveSearch(): Search {
	const brave = process.env.BRAVE_API_KEY;
	if (brave) return braveSearch(brave);

	const tavily = process.env.TAVILY_API_KEY;
	if (tavily) return tavilySearch(tavily);

	return duckDuckGo;
}

export default function (pi: ExtensionAPI) {
	const search = resolveSearch();

	// Searches run one at a time, spaced apart. Parallel tool calls would otherwise burst
	// several requests at once, which is exactly what gets an address rate-limited.
	let queue: Promise<unknown> = Promise.resolve();
	let lastRequest = 0;

	const throttle = <T>(operation: () => Promise<T>): Promise<T> => {
		const run = queue.then(async () => {
			const wait = MIN_SEARCH_INTERVAL_MS - (Date.now() - lastRequest);
			if (wait > 0) await sleep(wait);
			try {
				return await operation();
			} finally {
				lastRequest = Date.now();
			}
		});
		queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	pi.registerTool({
		name: "web_fetch",
		label: "Fetch",
		description: [
			"Fetch a URL and return its readable text content.",
			"Use it to read documentation, issues, release notes, or any page whose contents you need.",
			"When you know where an answer lives, go straight to it rather than searching for it first.",
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
			"Searches are spaced a moment apart, so prefer one good query to several narrow ones.",
		].join("\n"),
		promptSnippet: "web_search: search the web for current information",
		parameters: Type.Object({
			query: Type.String({ description: "The search query" }),
		}),

		async execute(_toolCallId, params, signal) {
			const results = await throttle(() => search(params.query, signal));
			if (results.length === 0) {
				return { content: [{ type: "text", text: `No results for "${params.query}"` }], details: { results } };
			}

			const text = results
				.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}\n   ${clip(result.snippet, SNIPPET_CAP)}`)
				.join("\n\n");

			return { content: [{ type: "text", text }], details: { query: params.query, results } };
		},
	});
}
