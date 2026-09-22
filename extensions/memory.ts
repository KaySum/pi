/**
 * Memory - `# something to remember` appends a line to a context file.
 *
 * Claude Code's `#` shortcut. The note goes to the project's AGENTS.md when there is one,
 * otherwise to the user-level file, and never reaches the model as a prompt.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { enabled } from "../lib/features.ts";

const HEADING = "## Notes";

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

/** The context files a note could go to, nearest first. */
function targets(cwd: string): string[] {
	const project = ["AGENTS.md", "CLAUDE.md"]
		.map((name) => path.join(cwd, name))
		.filter((file) => fs.existsSync(file));
	return [...project, path.join(agentDir(), "AGENTS.md")];
}

function append(file: string, note: string): void {
	const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
	const body = existing.includes(HEADING) ? existing : `${existing.trimEnd()}\n\n${HEADING}\n`;
	fs.writeFileSync(file, `${body.trimEnd()}\n- ${note}\n`);
}

export default function (pi: ExtensionAPI) {
	if (!enabled("memory")) return;

	const choose = async (ctx: ExtensionContext): Promise<string | undefined> => {
		const files = targets(ctx.cwd);
		if (files.length === 1 || !ctx.hasUI) return files[0];

		const labels = files.map((file) => (file.startsWith(ctx.cwd) ? path.relative(ctx.cwd, file) : file));
		const choice = await ctx.ui.select("Remember this in:", labels);
		return choice === undefined ? undefined : files[labels.indexOf(choice)];
	};

	pi.on("input", async (event, ctx) => {
		const note = event.text.startsWith("#") ? event.text.slice(1).trim() : "";
		if (note === "") return undefined;

		const file = await choose(ctx);
		if (!file) return { action: "handled" as const };

		try {
			append(file, note);
			ctx.ui.notify(`Remembered in ${path.basename(file)}. Run /reload to apply it now.`, "info");
		} catch (error) {
			ctx.ui.notify(`Could not write the note: ${error}`, "error");
		}
		return { action: "handled" as const };
	});
}
