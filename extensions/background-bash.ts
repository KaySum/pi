/**
 * Background bash - start long-running commands without blocking the turn.
 *
 * pi's built-in `bash` waits for the command to exit, which does not suit dev servers,
 * watchers, or test runs you want to keep an eye on. These tools start a command in the
 * background, read whatever it has printed since the last read, and stop it.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface Job {
	id: string;
	command: string;
	child: ChildProcess;
	buffer: string;
	exitCode?: number;
}

const MAX_BUFFER = 200_000;

export default function (pi: ExtensionAPI) {
	const jobs = new Map<string, Job>();
	let counter = 0;

	const stopAll = () => {
		for (const job of jobs.values()) job.child.kill("SIGTERM");
		jobs.clear();
	};

	pi.on("session_shutdown", stopAll);

	const describe = (job: Job) => (job.exitCode === undefined ? "running" : `exited with ${job.exitCode}`);

	pi.registerTool({
		name: "bash_background",
		label: "Background",
		description: [
			"Run a shell command in the background and return immediately with a job id.",
			"Use it for dev servers, watchers, and long builds - anything you want to start now and",
			"check on later with bash_output. For a command that finishes on its own, use bash.",
		].join("\n"),
		promptSnippet: "bash_background: start a long-running command and keep working",
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run" }),
			description: Type.Optional(Type.String({ description: "Short label, 3-5 words" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const id = `job-${++counter}`;
			const child = spawn(params.command, { shell: true, cwd: ctx.cwd, env: process.env });
			const job: Job = { id, command: params.command, child, buffer: "" };

			const append = (chunk: Buffer) => {
				job.buffer = (job.buffer + chunk.toString()).slice(-MAX_BUFFER);
			};
			child.stdout.on("data", append);
			child.stderr.on("data", append);
			child.on("close", (code) => {
				job.exitCode = code ?? 0;
			});
			child.on("error", (error) => {
				job.buffer += `\n${error}`;
				job.exitCode = 1;
			});

			jobs.set(id, job);
			return {
				content: [{ type: "text", text: `Started ${id}: ${params.command}` }],
				details: { id, command: params.command },
			};
		},
	});

	pi.registerTool({
		name: "bash_output",
		label: "Output",
		description: [
			"Read whatever a background job has printed since the last read, and whether it is still",
			"running. Poll it rather than sleeping: check, do something else, check again.",
		].join("\n"),
		promptSnippet: "bash_output: read new output from a background job",
		parameters: Type.Object({
			id: Type.String({ description: "The job id from bash_background" }),
			filter: Type.Optional(Type.String({ description: "Only return lines matching this regular expression" })),
		}),

		async execute(_toolCallId, params) {
			const job = jobs.get(params.id);
			if (!job) throw new Error(`Unknown job "${params.id}". Running: ${[...jobs.keys()].join(", ") || "none"}`);

			let output = job.buffer;
			job.buffer = "";
			if (params.filter) {
				const filter = new RegExp(params.filter);
				output = output.split("\n").filter((line) => filter.test(line)).join("\n");
			}

			// A finished job has nothing more to give; stop holding onto it.
			if (job.exitCode !== undefined) jobs.delete(params.id);

			return {
				content: [{ type: "text", text: `${job.id} (${describe(job)})\n\n${output || "(no new output)"}` }],
				details: { id: job.id, exitCode: job.exitCode, output },
			};
		},
	});

	pi.registerTool({
		name: "bash_kill",
		label: "Kill",
		description: "Stop a background job started with bash_background.",
		promptSnippet: "bash_kill: stop a background job",
		parameters: Type.Object({
			id: Type.String({ description: "The job id from bash_background" }),
		}),

		async execute(_toolCallId, params) {
			const job = jobs.get(params.id);
			if (!job) throw new Error(`Unknown job "${params.id}"`);

			job.child.kill("SIGTERM");
			jobs.delete(params.id);
			return {
				content: [{ type: "text", text: `Stopped ${job.id}: ${job.command}` }],
				details: { id: job.id, command: job.command },
			};
		},
	});

	pi.registerCommand("jobs", {
		description: "List background jobs",
		handler: async (_args, ctx) => {
			const lines = [...jobs.values()].map((job) => `  ${job.id} (${describe(job)}) ${job.command}`);
			ctx.ui.notify(lines.length ? lines.join("\n") : "No background jobs", "info");
		},
	});
}
