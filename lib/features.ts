/**
 * Feature switches, shared by every extension in this configuration.
 *
 * `features.json` in the agent directory turns parts of it off. Everything defaults to on, so
 * an absent or partial file means "all of it", and a missing key is never a silent disable.
 *
 * This lives outside `extensions/` on purpose: pi loads `.ts` files and `index.ts`
 * subdirectories from that directory, and a shared module there would be loaded as a
 * (broken) extension of its own.
 *
 * Project-level overrides are deliberately not supported. Extensions read this when they
 * load, before pi has resolved project trust, so honouring a repository's `.pi/features.json`
 * would let a cloned repository switch off the permission gate that exists to contain it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type Feature =
	| "permissions"
	| "hooks"
	| "checkpoints"
	| "task"
	| "todo"
	| "webFetch"
	| "webSearch"
	| "ask"
	| "planMode"
	| "backgroundBash"
	| "statusline"
	| "memory"
	| "uiToolRendering"
	| "uiHeader"
	| "uiWorkingIndicator";

/** Every switch, with the one-line description `/features` prints. */
export const FEATURES: [Feature, string][] = [
	["permissions", "allow / ask / deny rules on every tool call"],
	["hooks", "shell commands bound to lifecycle events"],
	["checkpoints", "working-tree snapshots restored on session-tree moves"],
	["task", "subagents with their own context window"],
	["todo", "the todo_write task list"],
	["webFetch", "reading web pages as text"],
	["webSearch", "web search"],
	["ask", "ask_user multiple-choice questions"],
	["planMode", "/plan, exit_plan_mode, and the mutation block"],
	["backgroundBash", "background jobs and their output"],
	["statusline", "context usage and git branch in the footer"],
	["memory", "the # shortcut that appends to AGENTS.md"],
	["uiToolRendering", "Claude Code tool layout in the transcript"],
	["uiHeader", "the welcome box"],
	["uiWorkingIndicator", "the spinner, verb, and elapsed time"],
];

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

export function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
	} catch {
		return fallback;
	}
}

/** The whole switchboard, with anything unset treated as on. */
export function features(): Record<string, boolean> {
	return readJson<Record<string, boolean>>(path.join(agentDir(), "features.json"), {});
}

/**
 * Read at call time rather than cached: `/reload` re-runs extension factories, so editing
 * features.json and reloading takes effect without restarting pi.
 */
export function enabled(feature: Feature): boolean {
	return features()[feature] !== false;
}
