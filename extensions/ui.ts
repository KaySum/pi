/**
 * UI - Claude Code's transcript layout, header, and working indicator.
 *
 * pi frames each tool call in a coloured box; Claude Code uses a flat bullet with an
 * indented result line. This re-registers the built-in tools with `renderShell: "self"`
 * and custom renderers to match, delegating execution to the original implementations so
 * only the presentation changes.
 *
 * Everything here is cosmetic and can be turned off per part in `ui.json`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { EditToolDetails, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";

/** Tool arguments. `any` keeps the renderers assignable whatever schema the tool declares. */
// biome-ignore lint/suspicious/noExplicitAny: contextual typing against each tool's own schema
type Args = Record<string, any>;

interface ToolResult {
	content: { type: string; text?: string }[];
	details?: unknown;
}

interface RenderOptions {
	expanded: boolean;
	isPartial: boolean;
}

interface Config {
	toolRendering: boolean;
	header: boolean;
	workingIndicator: boolean;
}

const DEFAULTS: Config = { toolRendering: true, header: true, workingIndicator: true };

const BULLET = "⏺";
const BRANCH = "⎿";
const COLLAPSED_OUTPUT_LINES = 4;
const COLLAPSED_DIFF_LINES = 6;
const EXPANDED_LINES = 80;

/** Words the working indicator cycles through, in Claude Code's register. */
const WORKING_WORDS = [
	"Thinking",
	"Pondering",
	"Cogitating",
	"Ruminating",
	"Noodling",
	"Percolating",
	"Deliberating",
	"Mulling",
	"Puzzling",
	"Simmering",
	"Musing",
	"Tinkering",
];

const SPINNER = ["·", "✢", "✳", "∗", "✻", "✽"];

const ANSI = /\[[0-9;]*m/g;
const plainWidth = (text: string): number => text.replace(ANSI, "").length;

function readConfig(): Config {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	try {
		return { ...DEFAULTS, ...(JSON.parse(fs.readFileSync(path.join(agentDir, "ui.json"), "utf-8")) as Partial<Config>) };
	} catch {
		return DEFAULTS;
	}
}

function shorten(target: unknown, cwd: string): string {
	if (typeof target !== "string" || target === "") return "";
	const absolute = path.isAbsolute(target) ? target : path.resolve(cwd, target);
	if (absolute === cwd) return ".";
	if (absolute.startsWith(`${cwd}${path.sep}`)) return path.relative(cwd, absolute);
	const home = os.homedir();
	return absolute.startsWith(`${home}${path.sep}`) ? `~${absolute.slice(home.length)}` : absolute;
}

function clip(text: string, limit: number): string {
	const single = text.replace(/\s*\n\s*/g, " ⏎ ").trim();
	return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

function textOf(result: ToolResult): string {
	const first = result.content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

function isFailure(result: ToolResult): boolean {
	return /^(error|failed)\b/i.test(textOf(result).trimStart());
}

export default function (pi: ExtensionAPI) {
	const config = readConfig();
	const cwd = process.cwd();

	/** `⏺ Read(src/index.ts)` */
	const call = (theme: Theme, name: string, argument: string, suffix = ""): Component =>
		new Text(
			`${theme.fg("accent", BULLET)} ${theme.fg("toolTitle", theme.bold(name))}${theme.fg("dim", "(")}${theme.fg(
				"toolOutput",
				argument,
			)}${theme.fg("dim", ")")}${suffix}`,
			0,
			0,
		);

	/** `  ⎿  summary` followed by indented body lines. */
	const result = (theme: Theme, summary: string, body: string[] = []): Component => {
		const lines = [`  ${theme.fg("dim", BRANCH)}  ${summary}`, ...body.map((line) => `     ${line}`)];
		return new Text(lines.join("\n"), 0, 0);
	};

	/** Body lines for command-like output, collapsed unless the user expanded it. */
	const output = (theme: Theme, raw: string, expanded: boolean): string[] => {
		const all = raw.split("\n");
		while (all.length > 0 && all[all.length - 1].trim() === "") all.pop();
		if (all.length === 0) return [];

		const limit = expanded ? EXPANDED_LINES : COLLAPSED_OUTPUT_LINES;
		const shown = all.slice(0, limit).map((line) => theme.fg("toolOutput", clip(line, 200)));
		if (all.length > limit) {
			shown.push(theme.fg("dim", `… +${all.length - limit} lines${expanded ? "" : " (ctrl+r to expand)"}`));
		}
		return shown;
	};

	const pending = (theme: Theme, verb: string) => result(theme, theme.fg("dim", verb));

	if (config.toolRendering) {
		const read = createReadTool(cwd);
		pi.registerTool({
			...read,
			execute: (id, params, signal, onUpdate, ctx) => read.execute(id, params, signal, onUpdate, ctx),
			renderShell: "self",
			renderCall: (args: Args, theme: Theme) => {
				const range = args.offset || args.limit ? ` ${args.offset ?? 1}…${args.limit ? Number(args.offset ?? 1) + Number(args.limit) - 1 : ""}` : "";
				return call(theme, "Read", shorten(args.path ?? args.file_path, cwd), theme.fg("dim", range));
			},
			renderResult: (value: ToolResult, { expanded, isPartial }: RenderOptions, theme: Theme) => {
				if (isPartial) return pending(theme, "Reading…");
				if (value.content[0]?.type === "image") return result(theme, theme.fg("success", "Read image"));
				if (isFailure(value)) return result(theme, theme.fg("error", clip(textOf(value), 120)));

				const body = textOf(value);
				const count = body === "" ? 0 : body.split("\n").length;
				return result(
					theme,
					theme.fg("dim", `Read ${count} line${count === 1 ? "" : "s"}`),
					expanded ? output(theme, body, true) : [],
				);
			},
		});

		const bash = createBashTool(cwd);
		pi.registerTool({
			...bash,
			execute: (id, params, signal, onUpdate, ctx) => bash.execute(id, params, signal, onUpdate, ctx),
			renderShell: "self",
			renderCall: (args: Args, theme: Theme) => call(theme, "Bash", clip(String(args.command ?? ""), 90)),
			renderResult: (value: ToolResult, { expanded, isPartial }: RenderOptions, theme: Theme) => {
				if (isPartial) return pending(theme, "Running…");
				const body = textOf(value);
				if (isFailure(value)) {
					return result(theme, theme.fg("error", "Failed"), output(theme, body, expanded));
				}
				const lines = output(theme, body, expanded);
				return lines.length === 0
					? result(theme, theme.fg("dim", "(no output)"))
					: result(theme, lines[0], lines.slice(1));
			},
		});

		const edit = createEditTool(cwd);
		pi.registerTool({
			...edit,
			execute: (id, params, signal, onUpdate, ctx) => edit.execute(id, params, signal, onUpdate, ctx),
			renderShell: "self",
			renderCall: (args: Args, theme: Theme) => call(theme, "Update", shorten(args.path ?? args.file_path, cwd)),
			renderResult: (value: ToolResult, { expanded, isPartial }: RenderOptions, theme: Theme) => {
				if (isPartial) return pending(theme, "Editing…");
				if (isFailure(value)) return result(theme, theme.fg("error", clip(textOf(value), 120)));

				const diff = (value.details as EditToolDetails | undefined)?.diff;
				if (!diff) return result(theme, theme.fg("success", "Applied"));

				const lines = diff.split("\n");
				const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
				const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;

				const limit = expanded ? EXPANDED_LINES : COLLAPSED_DIFF_LINES;
				const body = lines.slice(0, limit).map((line) => {
					if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("toolDiffAdded", line);
					if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("toolDiffRemoved", line);
					return theme.fg("toolDiffContext", line);
				});
				if (lines.length > limit) {
					body.push(theme.fg("dim", `… +${lines.length - limit} lines${expanded ? "" : " (ctrl+r to expand)"}`));
				}

				const summary = `${theme.fg("dim", "Updated with ")}${theme.fg("toolDiffAdded", `+${added}`)}${theme.fg(
					"dim",
					" / ",
				)}${theme.fg("toolDiffRemoved", `-${removed}`)}`;
				return result(theme, summary, body);
			},
		});

		const write = createWriteTool(cwd);
		pi.registerTool({
			...write,
			execute: (id, params, signal, onUpdate, ctx) => write.execute(id, params, signal, onUpdate, ctx),
			renderShell: "self",
			renderCall: (args: Args, theme: Theme) => {
				const count = String(args.content ?? "").split("\n").length;
				return call(theme, "Write", shorten(args.path ?? args.file_path, cwd), theme.fg("dim", ` ${count} lines`));
			},
			renderResult: (value: ToolResult, { isPartial }: RenderOptions, theme: Theme) => {
				if (isPartial) return pending(theme, "Writing…");
				return isFailure(value)
					? result(theme, theme.fg("error", clip(textOf(value), 120)))
					: result(theme, theme.fg("success", "Written"));
			},
		});

		// Search tools: the summary is a match count, since their output is already a list.
		// The three factories return different tool types, so the parameter stays loose.
		const registerSearch = (
			// biome-ignore lint/suspicious/noExplicitAny: one body for three distinct tool schemas
			base: any,
			label: string,
			key: string,
		) => {
			pi.registerTool({
				...base,
				execute: (id, params, signal, onUpdate, ctx) => base.execute(id, params, signal, onUpdate, ctx),
				renderShell: "self",
				renderCall: (args: Args, theme: Theme) => {
					const argument = key === "path" ? shorten(args.path ?? ".", cwd) : String(args[key] ?? "");
					return call(theme, label, clip(argument, 70));
				},
				renderResult: (value: ToolResult, { expanded, isPartial }: RenderOptions, theme: Theme) => {
					if (isPartial) return pending(theme, "Searching…");
					if (isFailure(value)) return result(theme, theme.fg("error", clip(textOf(value), 120)));

					const body = textOf(value);
					const found = body.split("\n").filter((line) => line.trim() !== "").length;
					return result(
						theme,
						theme.fg("dim", found === 0 ? "No matches" : `${found} result${found === 1 ? "" : "s"}`),
						found === 0 ? [] : output(theme, body, expanded),
					);
				},
			});
		};

		registerSearch(createGrepTool(cwd), "Search", "pattern");
		registerSearch(createFindTool(cwd), "Glob", "pattern");
		registerSearch(createLsTool(cwd), "List", "path");
	}

	if (config.header) {
		let info = { model: "", cwd };

		class Header implements Component {
			constructor(private readonly theme: Theme) {}

			invalidate(): void {}

			render(width: number): string[] {
				const theme = this.theme;
				const box = Math.max(24, Math.min(width, 74));
				const inner = box - 2;
				const edge = (left: string, right: string) => theme.fg("borderMuted", left + "─".repeat(inner) + right);
				const row = (content: string) => {
					const pad = inner - plainWidth(content);
					if (pad < 0) return theme.fg("borderMuted", "│") + content + theme.fg("borderMuted", "│");
					return theme.fg("borderMuted", "│") + content + " ".repeat(pad) + theme.fg("borderMuted", "│");
				};

				const rows = [
					` ${theme.fg("accent", "✻")} ${theme.bold("Welcome to pi")}`,
					"",
					`   ${theme.fg("dim", "/help for commands, /plan to plan first")}`,
					"",
					`   ${theme.fg("dim", "model:")} ${theme.fg("muted", info.model || "not selected")}`,
					`   ${theme.fg("dim", "cwd:  ")} ${theme.fg("muted", shorten(info.cwd, os.homedir()) || info.cwd)}`,
				];

				return [edge("╭", "╮"), ...rows.map(row), edge("╰", "╯"), ""];
			}
		}

		pi.on("session_start", (_event, ctx) => {
			info = { model: ctx.model?.id ?? "", cwd: ctx.cwd };
			if (ctx.mode === "tui") ctx.ui.setHeader((_tui, theme) => new Header(theme));
		});
	}

	if (config.workingIndicator) {
		let timer: ReturnType<typeof setInterval> | undefined;

		const stop = (ctx: ExtensionContext) => {
			if (timer) clearInterval(timer);
			timer = undefined;
			ctx.ui.setWorkingMessage();
		};

		// Timers belong to a running turn, never to the factory: some invocations load
		// extensions without ever starting a session.
		pi.on("agent_start", (_event, ctx) => {
			if (ctx.mode !== "tui" || timer) return;

			const started = Date.now();
			let word = WORKING_WORDS[Math.floor(Math.random() * WORKING_WORDS.length)];

			const tick = () => {
				const seconds = Math.floor((Date.now() - started) / 1000);
				if (seconds > 0 && seconds % 20 === 0) {
					word = WORKING_WORDS[Math.floor(Math.random() * WORKING_WORDS.length)];
				}
				ctx.ui.setWorkingMessage(`${word}… (${seconds}s · esc to interrupt)`);
			};

			ctx.ui.setWorkingIndicator({ frames: SPINNER, intervalMs: 120 });
			tick();
			timer = setInterval(tick, 1000);
		});

		pi.on("agent_end", (_event, ctx) => stop(ctx));
		pi.on("session_shutdown", (_event, ctx) => stop(ctx));
	}
}
