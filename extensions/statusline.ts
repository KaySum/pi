/**
 * Status line - context usage and git branch in the footer.
 *
 * An executable `statusline` in the agent directory overrides the built-in text: it receives
 * a JSON payload on stdin and its first line of stdout becomes the status.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const KEY = "statusline";
const TIMEOUT_MS = 5_000;

function run(command: string, args: string[], cwd: string, stdin?: string): Promise<string> {
	return new Promise((resolve) => {
		const child = execFile(command, args, { cwd, timeout: TIMEOUT_MS }, (error, stdout) =>
			resolve(error ? "" : stdout.trim()),
		);
		child.stdin?.on("error", () => {});
		child.stdin?.end(stdin ?? "");
	});
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? "", ".pi", "agent");
}

function isExecutable(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	const custom = path.join(agentDir(), KEY);

	const refresh = async (ctx: ExtensionContext) => {
		const usage = ctx.getContextUsage();
		const branch = await run("git", ["branch", "--show-current"], ctx.cwd);

		if (isExecutable(custom)) {
			const payload = JSON.stringify({
				cwd: ctx.cwd,
				branch,
				model: ctx.model?.id,
				thinkingLevel: ctx.thinkingLevel,
				contextTokens: usage?.tokens,
				contextPercent: usage?.percent,
			});
			const text = (await run(custom, [], ctx.cwd, payload)).split("\n")[0];
			ctx.ui.setStatus(KEY, text || undefined);
			return;
		}

		const parts = [branch && `⎇ ${branch}`, usage?.percent != null && `ctx ${Math.round(usage.percent)}%`];
		ctx.ui.setStatus(KEY, parts.filter(Boolean).join("  ") || undefined);
	};

	pi.on("session_start", (_event, ctx) => refresh(ctx));
	pi.on("turn_end", (_event, ctx) => refresh(ctx));
	pi.on("session_tree", (_event, ctx) => refresh(ctx));
}
