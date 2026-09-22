/**
 * Task - delegate work to a subagent with its own context window.
 *
 * Each subagent is a Markdown file with `name`, `description`, and optional `tools`
 * and `model` frontmatter; its body becomes the subagent's instructions. Definitions
 * are discovered in the agent directory's `agents/`, and in a trusted project's
 * `.pi/agents/` or `.claude/agents/`.
 *
 * A task runs a separate `pi` process in print mode, so the subagent's exploration
 * never enters the parent's context - only its final report does.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface Agent {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	instructions: string;
}

interface TaskDetails {
	agent: string;
	prompt: string;
	output: string;
	exitCode: number;
}

const TaskParams = Type.Object({
	agent: Type.String({ description: "Name of the subagent to run" }),
	prompt: Type.String({ description: "The task. Be specific: the subagent cannot see this conversation." }),
	description: Type.Optional(Type.String({ description: "Short label for the task, 3-5 words" })),
});

/** Set for child processes so a subagent cannot spawn subagents of its own. */
const SUBAGENT_ENV = "PI_SUBAGENT";

function toolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw.filter((tool): tool is string => typeof tool === "string").map((tool) => tool.trim()).filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function loadAgents(dir: string): Agent[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir).filter((entry) => entry.endsWith(".md"));
	} catch {
		return [];
	}

	const agents: Agent[] = [];
	for (const entry of entries) {
		try {
			const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(
				fs.readFileSync(path.join(dir, entry), "utf-8"),
			);
			if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;

			agents.push({
				name: frontmatter.name,
				description: frontmatter.description,
				tools: toolList(frontmatter.tools),
				model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
				instructions: body,
			});
		} catch {
			// A malformed file must not hide every other agent in the directory.
		}
	}
	return agents;
}

function discover(cwd: string): Map<string, Agent> {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? "", ".pi", "agent");
	const dirs = [
		path.join(agentDir, "agents"),
		path.join(cwd, ".pi", "agents"),
		path.join(cwd, ".claude", "agents"),
	];

	// Later directories win, so a project can override a personal agent by name.
	return new Map(dirs.flatMap(loadAgents).map((agent) => [agent.name, agent]));
}

function runSubagent(agent: Agent, prompt: string, cwd: string, signal: AbortSignal | undefined) {
	const args = ["--print", "--no-session", "--append-system-prompt", agent.instructions];
	if (agent.tools) args.push("--tools", agent.tools.join(","));
	if (agent.model) args.push("--model", agent.model);
	args.push("--", prompt);

	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn("pi", args, { cwd, env: { ...process.env, [SUBAGENT_ENV]: "1" } });

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));

		signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
	});
}

export default function (pi: ExtensionAPI) {
	if (process.env[SUBAGENT_ENV]) return;

	const agents = discover(process.cwd());

	pi.registerCommand("agents", {
		description: "List the available subagents",
		handler: async (_args, ctx) => {
			const lines = [...agents.values()].map((agent) => `  ${agent.name} - ${agent.description}`);
			ctx.ui.notify(lines.length ? lines.join("\n") : "No subagents found", "info");
		},
	});

	if (agents.size === 0) return;

	const roster = [...agents.values()].map((agent) => `- ${agent.name}: ${agent.description}`).join("\n");

	pi.registerTool({
		name: "task",
		label: "Task",
		description: [
			"Delegate a task to a subagent that works in its own context window and reports back.",
			"Use it for open-ended search or research where you only need the conclusion, not the",
			"intermediate file contents. Do not use it for work you can finish in a few tool calls.",
			"",
			"The subagent is stateless: it cannot see this conversation and cannot ask follow-up",
			"questions, so state the full task and the exact shape of the answer you want.",
			"",
			"Available agents:",
			roster,
		].join("\n"),
		promptSnippet: "task: delegate research or broad search to a subagent",
		parameters: TaskParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const agent = agents.get(params.agent);
			if (!agent) {
				throw new Error(`Unknown agent "${params.agent}". Available: ${[...agents.keys()].join(", ")}`);
			}

			ctx.ui.setWorkingMessage(`${agent.name}: ${params.description ?? "working"}`);
			try {
				const { code, stdout, stderr } = await runSubagent(agent, params.prompt, ctx.cwd, signal);
				if (code !== 0) throw new Error(`Subagent "${agent.name}" failed: ${stderr.trim() || `exit ${code}`}`);

				const output = stdout.trim() || "(the subagent produced no output)";
				return {
					content: [{ type: "text", text: output }],
					details: { agent: agent.name, prompt: params.prompt, output, exitCode: code } as TaskDetails,
				};
			} finally {
				ctx.ui.setWorkingMessage();
			}
		},
	});
}
