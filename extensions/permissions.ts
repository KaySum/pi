/**
 * Permissions - allow / ask / deny rules for tool calls.
 *
 * pi runs every tool call unconditionally. This gates them behind Claude Code-style
 * rules loaded from `permissions.json` in the agent directory, merged with
 * `.pi/permissions.json` from a trusted project.
 *
 * Rules look like `bash(git push:*)` or `write(src/**)`. The tool name is
 * case-insensitive; the specifier is a glob, with a trailing `:*` meaning prefix match
 * on a shell command. A bare tool name matches every call to that tool.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

type Mode = "allow" | "ask" | "deny";

interface PermissionConfig {
	defaultMode?: Mode;
	allow?: string[];
	ask?: string[];
	deny?: string[];
}

interface Rule {
	tool: string;
	match: (target: string) => boolean;
}

const CONFIG_NAME = "permissions.json";

function globToRegExp(pattern: string): RegExp {
	// `foo:*` is Claude Code's prefix form: anything after the prefix is allowed.
	const isPrefix = pattern.endsWith(":*");
	const body = isPrefix ? pattern.slice(0, -2) : pattern;
	const escaped = body.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const expanded = escaped
		.split("**")
		.map((segment) => segment.replace(/\*/g, "[^/]*"))
		.join(".*");
	return new RegExp(isPrefix ? `^${expanded}\\b` : `^${expanded}$`);
}

function parseRule(rule: string): Rule | undefined {
	const parsed = /^([A-Za-z_][\w-]*)\s*(?:\((.*)\))?$/.exec(rule.trim());
	if (!parsed) return undefined;

	const [, tool, specifier] = parsed;
	if (specifier === undefined || specifier === "*") return { tool: tool.toLowerCase(), match: () => true };

	const re = globToRegExp(specifier);
	return { tool: tool.toLowerCase(), match: (target) => re.test(target) };
}

function parseRules(rules: string[] | undefined): Rule[] {
	return (rules ?? []).map(parseRule).filter((rule): rule is Rule => rule !== undefined);
}

function readConfig(file: string): PermissionConfig {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as PermissionConfig;
	} catch {
		return {};
	}
}

/** The string a rule specifier is matched against: a command, a path, or a pattern. */
function targetOf(event: ToolCallEvent, cwd: string): string {
	const input = event.input as Record<string, unknown>;
	if (typeof input.command === "string") return input.command;

	const file = input.file_path ?? input.path ?? input.pattern;
	if (typeof file !== "string") return "";
	return path.isAbsolute(file) ? path.relative(cwd, file) : file;
}

export default function (pi: ExtensionAPI) {
	let defaultMode: Mode = "allow";
	let rules: Record<Mode, Rule[]> = { allow: [], ask: [], deny: [] };
	const sessionAllowed = new Set<string>();

	const load = (ctx: ExtensionContext) => {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? "", ".pi", "agent");
		const user = readConfig(path.join(agentDir, CONFIG_NAME));
		const project = ctx.isProjectTrusted() ? readConfig(path.join(ctx.cwd, ".pi", CONFIG_NAME)) : {};

		defaultMode = project.defaultMode ?? user.defaultMode ?? "allow";
		rules = {
			allow: parseRules([...(user.allow ?? []), ...(project.allow ?? [])]),
			ask: parseRules([...(user.ask ?? []), ...(project.ask ?? [])]),
			deny: parseRules([...(user.deny ?? []), ...(project.deny ?? [])]),
		};
		sessionAllowed.clear();
	};

	pi.on("session_start", (_event, ctx) => load(ctx));

	pi.on("tool_call", async (event, ctx) => {
		const tool = event.toolName.toLowerCase();
		const target = targetOf(event, ctx.cwd);
		const matches = (mode: Mode) => rules[mode].some((rule) => rule.tool === tool && rule.match(target));

		if (matches("deny")) {
			return { block: true, reason: `Blocked by a deny rule in ${CONFIG_NAME}: ${tool}(${target})` };
		}

		const key = `${tool}:${target}`;
		if (sessionAllowed.has(key) || matches("allow")) return undefined;

		const mode: Mode = matches("ask") ? "ask" : defaultMode;
		if (mode === "allow") return undefined;
		if (mode === "deny") return { block: true, reason: `No allow rule matches ${tool}(${target})` };

		if (!ctx.hasUI) return { block: true, reason: `${tool}(${target}) needs approval, and this session has no UI` };

		const always = "Yes, and don't ask again this session";
		const choice = await ctx.ui.select(`Allow ${tool}?\n\n  ${target || "(no arguments)"}`, [
			"Yes, once",
			always,
			"No",
		]);

		if (choice === always) sessionAllowed.add(key);
		if (choice === "No" || choice === undefined) return { block: true, reason: "Denied by the user" };
		return undefined;
	});

	pi.registerCommand("permissions", {
		description: "Show the active permission rules",
		handler: async (_args, ctx) => {
			load(ctx);
			const lines = (["deny", "ask", "allow"] as Mode[]).flatMap((mode) =>
				rules[mode].map((rule) => `  ${mode}: ${rule.tool}`),
			);
			ctx.ui.notify([`default: ${defaultMode}`, ...lines].join("\n"), "info");
		},
	});
}
