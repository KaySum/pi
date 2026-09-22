/**
 * Hooks - run shell commands on lifecycle events.
 *
 * Mirrors Claude Code's hook system. Definitions live in `hooks.json` in the agent
 * directory, merged with `.pi/hooks.json` from a trusted project:
 *
 *   { "PreToolUse": [{ "matcher": "write|edit", "hooks": [{ "command": "./fmt.sh" }] }] }
 *
 * Each hook receives a JSON payload on stdin. Exit 0 accepts; exit 2 blocks the action
 * and reports stderr as the reason; any other non-zero code is reported and ignored.
 * On UserPromptSubmit and SessionStart, stdout is added to the model's context.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { enabled } from "../lib/features.ts";

type HookEvent =
	| "PreToolUse"
	| "PostToolUse"
	| "UserPromptSubmit"
	| "Stop"
	| "PreCompact"
	| "SessionStart"
	| "SessionEnd";

interface Hook {
	command: string;
	timeout?: number;
}

interface HookMatcher {
	matcher?: string;
	hooks: Hook[];
}

type HookConfig = Partial<Record<HookEvent, HookMatcher[]>>;

interface HookOutcome {
	blocked?: string;
	output: string;
}

const CONFIG_NAME = "hooks.json";
const DEFAULT_TIMEOUT_MS = 60_000;
const BLOCK_EXIT_CODE = 2;

function readConfig(file: string): HookConfig {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as HookConfig;
	} catch {
		return {};
	}
}

function run(hook: Hook, payload: unknown, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(hook.command, {
			shell: true,
			cwd,
			env: { ...process.env, PI_PROJECT_DIR: cwd },
			timeout: hook.timeout ? hook.timeout * 1000 : DEFAULT_TIMEOUT_MS,
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => resolve({ code: 1, stdout, stderr: String(error) }));
		child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));

		// A hook that ignores stdin closes the pipe early; that is not an error.
		child.stdin.on("error", () => {});
		child.stdin.end(JSON.stringify(payload));
	});
}

export default function (pi: ExtensionAPI) {
	if (!enabled("hooks")) return;

	let config: HookConfig = {};

	const load = (ctx: ExtensionContext) => {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? "", ".pi", "agent");
		const user = readConfig(path.join(agentDir, CONFIG_NAME));
		const project = ctx.isProjectTrusted() ? readConfig(path.join(ctx.cwd, ".pi", CONFIG_NAME)) : {};

		config = {};
		for (const event of new Set([...Object.keys(user), ...Object.keys(project)]) as Set<HookEvent>) {
			config[event] = [...(user[event] ?? []), ...(project[event] ?? [])];
		}
	};

	const fire = async (
		event: HookEvent,
		ctx: ExtensionContext,
		payload: Record<string, unknown>,
		subject = "",
	): Promise<HookOutcome> => {
		const outcome: HookOutcome = { output: "" };

		for (const entry of config[event] ?? []) {
			if (entry.matcher && entry.matcher !== "*" && !new RegExp(entry.matcher, "i").test(subject)) continue;

			for (const hook of entry.hooks) {
				const result = await run(hook, { event, cwd: ctx.cwd, ...payload }, ctx.cwd);
				if (result.code === BLOCK_EXIT_CODE) {
					outcome.blocked = result.stderr.trim() || `Blocked by hook: ${hook.command}`;
					return outcome;
				}
				if (result.code !== 0) {
					ctx.ui.notify(`Hook failed (${hook.command}): ${result.stderr.trim() || result.code}`, "warning");
					continue;
				}
				outcome.output += result.stdout;
			}
		}

		return outcome;
	};

	pi.on("session_start", async (_event, ctx) => {
		load(ctx);
		const { output } = await fire("SessionStart", ctx, {});
		if (output.trim()) {
			pi.sendMessage({ customType: "hook-context", content: output.trim(), display: "SessionStart hook" });
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await fire("SessionEnd", ctx, {});
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		await fire("PreCompact", ctx, {});
	});

	pi.on("input", async (event, ctx) => {
		const { blocked, output } = await fire("UserPromptSubmit", ctx, { prompt: event.text });
		if (blocked) {
			ctx.ui.notify(blocked, "error");
			return { action: "handled" as const };
		}
		if (!output.trim()) return undefined;
		return { action: "transform" as const, text: `${event.text}\n\n${output.trim()}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		const { blocked } = await fire(
			"PreToolUse",
			ctx,
			{ tool_name: event.toolName, tool_input: event.input },
			event.toolName,
		);
		return blocked ? { block: true, reason: blocked } : undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		await fire(
			"PostToolUse",
			ctx,
			{ tool_name: event.toolName, tool_input: event.input, tool_response: event.content, is_error: event.isError },
			event.toolName,
		);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await fire("Stop", ctx, {});
	});
}
