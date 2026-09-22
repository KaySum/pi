/**
 * Checkpoints - restore the working tree when you move around the session tree.
 *
 * Every snapshot is a commit in a shadow git repository that lives outside the project,
 * has its own index, and never touches the project's own `.git`. A checkpoint is recorded
 * as a session entry, so it sits at a fixed point in pi's session tree.
 *
 * Restoring resolves to one rule:
 *
 *   the state for entry T is the last checkpoint on the path from the root to T
 *
 * `getBranch(T)` returns exactly that path, so the rule works in every direction. Moving
 * back finds an earlier checkpoint, moving forward finds a later one, and moving to a
 * sibling branch finds that branch's own checkpoint - checkpoints taken on a path you are
 * not on are not on the path, and cannot be selected.
 *
 * A checkpoint entry records the tree at the instant it was inserted, so its position in
 * the tree and the state it holds are taken together. Everything above it in the path had
 * already happened; everything below it had not.
 */

import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "checkpoint";

/** Tools that cannot change a file. Everything else is assumed to mutate one. */
const READ_ONLY_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"web_fetch",
	"web_search",
	"todo_write",
	"ask_user",
	"exit_plan_mode",
	"bash_output",
]);

interface Config {
	enabled: boolean;
	/** "tool" snapshots after every mutating tool; "turn" only at turn boundaries. */
	granularity: "tool" | "turn";
	restoreOnTreeNavigation: boolean;
	restoreOnFork: boolean;
	trackAgentEditedIgnoredFiles: boolean;
	exclude: string[];
}

const DEFAULTS: Config = {
	enabled: true,
	granularity: "tool",
	restoreOnTreeNavigation: true,
	restoreOnFork: true,
	trackAgentEditedIgnoredFiles: true,
	exclude: [],
};

interface Checkpoint {
	/** Commit in the shadow repository holding the working tree at this point. */
	commit: string;
	/** Shadow repository path, so a session resumed elsewhere cannot restore the wrong tree. */
	repo: string;
	label: string;
	files: number;
	timestamp: string;
}

interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

function readConfig(cwd: string, trusted: boolean): Config {
	const load = (file: string): Partial<Config> => {
		try {
			return JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<Config>;
		} catch {
			return {};
		}
	};
	const user = load(path.join(agentDir(), "checkpoints.json"));
	const project = trusted ? load(path.join(cwd, ".pi", "checkpoints.json")) : {};
	return { ...DEFAULTS, ...user, ...project };
}

/**
 * Run git against the shadow repository.
 *
 * The environment is pinned rather than inherited. The shadow repo must not pick up the
 * user's global config, because a global `commit.gpgsign`, `core.hooksPath`, `core.autocrlf`
 * or an LFS filter would sign, hook, rewrite line endings, or replace file contents with
 * pointers. With no global or system config an unconfigured `.gitattributes` filter is a
 * no-op, so contents are stored byte for byte.
 *
 * No timeout: killing git while it writes its index or objects is how repositories get
 * corrupted, and a slow snapshot is better than a broken one.
 */
function git(repo: string, worktree: string, args: string[]): Promise<GitResult> {
	return new Promise((resolve) => {
		execFile(
			"git",
			args,
			{
				cwd: worktree,
				maxBuffer: 256 * 1024 * 1024,
				env: {
					...process.env,
					GIT_DIR: repo,
					GIT_WORK_TREE: worktree,
					GIT_CONFIG_GLOBAL: os.devNull,
					GIT_CONFIG_SYSTEM: os.devNull,
					GIT_AUTHOR_NAME: "pi checkpoints",
					GIT_AUTHOR_EMAIL: "checkpoints@pi.invalid",
					GIT_COMMITTER_NAME: "pi checkpoints",
					GIT_COMMITTER_EMAIL: "checkpoints@pi.invalid",
					GIT_TERMINAL_PROMPT: "0",
				},
			},
			(error, stdout, stderr) => {
				const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
				resolve({ code, stdout, stderr });
			},
		);
	});
}

function repoPathFor(cwd: string): string {
	let real = cwd;
	try {
		real = fs.realpathSync(cwd);
	} catch {
		// A cwd that cannot be resolved still gets a stable key from its literal path.
	}
	const digest = crypto.createHash("sha256").update(real).digest("hex").slice(0, 16);
	return path.join(agentDir(), "checkpoints", `${path.basename(real) || "root"}-${digest}`);
}

export default function (pi: ExtensionAPI) {
	let config = DEFAULTS;
	let repo = "";
	let ready = false;
	/** Files the agent edited that the project's .gitignore excludes; force-added so they restore. */
	const forced = new Set<string>();

	// Git keeps one index per repository and pi runs tool calls in parallel, so every
	// operation goes through this chain. Two snapshots can never interleave.
	let lock: Promise<unknown> = Promise.resolve();
	const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = lock.then(operation, operation);
		lock = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	const run = async (cwd: string, args: string[]): Promise<string> => {
		const result = await git(repo, cwd, args);
		if (result.code !== 0) {
			throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
		}
		return result.stdout;
	};

	const head = async (cwd: string): Promise<string | null> => {
		const result = await git(repo, cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
		return result.code === 0 ? result.stdout.trim() : null;
	};

	const init = async (ctx: ExtensionContext): Promise<boolean> => {
		config = readConfig(ctx.cwd, ctx.isProjectTrusted());
		if (!config.enabled) return false;

		repo = repoPathFor(ctx.cwd);
		if (!fs.existsSync(path.join(repo, "HEAD"))) {
			fs.mkdirSync(repo, { recursive: true, mode: 0o700 });
			await run(ctx.cwd, ["init", "-q"]);
			// Local config beats the (disabled) global config and pins the rest.
			for (const [key, value] of Object.entries({
				"core.bare": "false",
				"core.logAllRefUpdates": "true",
				"core.autocrlf": "false",
				"core.safecrlf": "false",
				"core.quotePath": "false",
				"commit.gpgsign": "false",
				"gc.auto": "0",
			})) {
				await run(ctx.cwd, ["config", key, value]);
			}
		}

		// Snapshotting the session file would make every snapshot contain the record of
		// itself, so the session directory is excluded when it sits inside the project.
		const sessionDir = path.resolve(ctx.cwd, ctx.sessionManager.getSessionDir());
		const inside = sessionDir.startsWith(`${ctx.cwd}${path.sep}`);
		const patterns = [...config.exclude, ...(inside ? [`/${path.relative(ctx.cwd, sessionDir)}/`] : [])];

		fs.mkdirSync(path.join(repo, "info"), { recursive: true });
		fs.writeFileSync(path.join(repo, "info", "exclude"), patterns.length ? `${patterns.join("\n")}\n` : "");
		return true;
	};

	/** Stage the whole working tree. Returns the paths that differ from the last snapshot. */
	const stage = async (cwd: string): Promise<string[]> => {
		await run(cwd, ["add", "-A"]);

		if (config.trackAgentEditedIgnoredFiles) {
			for (const file of forced) {
				if (fs.existsSync(file)) await git(repo, cwd, ["add", "-f", "--", file]);
			}
		}

		// With no commit yet there is no HEAD to diff against, so compare with the empty
		// tree. Asking git for its hash works whatever object format the repo uses.
		const base = (await head(cwd)) ?? (await run(cwd, ["hash-object", "-t", "tree", os.devNull])).trim();
		const changed = await run(cwd, ["diff", "--cached", "--name-only", "--no-renames", base]);
		return changed.split("\n").filter(Boolean);
	};

	/** Commit the staged tree. Returns the new commit, or null when nothing changed. */
	const commit = async (cwd: string, label: string): Promise<{ commit: string; files: number } | null> => {
		const changed = await stage(cwd);
		if (changed.length === 0) return null;

		await run(cwd, ["commit", "-q", "--no-verify", "--no-gpg-sign", "-m", label]);
		const sha = await head(cwd);
		if (!sha) throw new Error("the checkpoint commit produced no HEAD");
		return { commit: sha, files: changed.length };
	};

	/** Commit the current tree and record it in the session tree at the current position. */
	const checkpoint = (ctx: ExtensionContext, label: string) =>
		serialize(async () => {
			const created = await commit(ctx.cwd, label);
			if (!created) return;

			pi.appendEntry<Checkpoint>(ENTRY_TYPE, {
				commit: created.commit,
				repo,
				label,
				files: created.files,
				timestamp: new Date().toISOString(),
			});
		});

	/** The last checkpoint on the path from the root to `entryId` - see the file header. */
	const resolve = (ctx: ExtensionContext, entryId: string | null): Checkpoint | undefined => {
		const branch = ctx.sessionManager.getBranch(entryId ?? undefined);
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data = entry.data as Checkpoint | undefined;
			if (data?.commit) return data;
		}
		return undefined;
	};

	/** Returns the number of files whose contents changed. Throws without touching the tree. */
	const restore = (ctx: ExtensionContext, target: Checkpoint) =>
		serialize(async () => {
			if (target.repo !== repo) {
				throw new Error(`that checkpoint belongs to ${target.repo}; refusing to restore it into this directory`);
			}
			if ((await git(repo, ctx.cwd, ["cat-file", "-e", `${target.commit}^{commit}`])).code !== 0) {
				throw new Error(`checkpoint ${target.commit.slice(0, 8)} is no longer in ${repo}`);
			}

			// Commit the current tree first. This is what makes the restore both exact and
			// reversible: staging every file makes those created since the checkpoint tracked,
			// so `reset --hard` removes them, and committing leaves the state being replaced
			// reachable in the shadow repo instead of lost.
			await commit(ctx.cwd, "before restore");
			const before = await head(ctx.cwd);

			await run(ctx.cwd, ["reset", "-q", "--hard", target.commit]);

			if (!before || before === target.commit) return 0;
			const changed = await run(ctx.cwd, ["diff", "--name-only", "--no-renames", before, target.commit]);
			return changed.split("\n").filter(Boolean).length;
		});

	const restoreTo = async (ctx: ExtensionContext, target: Checkpoint | undefined, reason: string) => {
		if (!target) {
			ctx.ui.notify(`${reason}: no checkpoint covers this point, so the working tree was left alone.`, "warning");
			return;
		}

		try {
			const files = await restore(ctx, target);
			ctx.ui.notify(
				files === 0
					? `${reason}: the working tree already matched this point.`
					: `${reason}: restored ${files} file${files === 1 ? "" : "s"} (${target.label}).`,
				"info",
			);
		} catch (error) {
			ctx.ui.notify(`Restore failed, working tree unchanged: ${error}`, "error");
		}
	};

	const guard = async (ctx: ExtensionContext, work: () => Promise<void>) => {
		if (!ready) return;
		try {
			await work();
		} catch (error) {
			ctx.ui.notify(`Checkpoint failed: ${error}`, "warning");
		}
	};

	pi.on("session_start", async (event, ctx) => {
		ready = false;
		forced.clear();

		if ((await git(repoPathFor(ctx.cwd), ctx.cwd, ["--version"])).code !== 0) {
			ctx.ui.notify("Checkpoints are off: git is not on PATH.", "warning");
			return;
		}

		try {
			ready = await init(ctx);
		} catch (error) {
			ctx.ui.notify(`Checkpoints are off: ${error}`, "warning");
			return;
		}
		if (!ready) return;

		// A fork is a deliberate move to an earlier point, so the code moves with it. A
		// resume is not: the working tree may have moved on for reasons that have nothing to
		// do with this session, and overwriting it unasked would destroy that work.
		if (event.reason === "fork" && config.restoreOnFork) {
			await restoreTo(ctx, resolve(ctx, ctx.sessionManager.getLeafId()), "Forked");
			return;
		}

		await guard(ctx, () => checkpoint(ctx, "session start"));
	});

	pi.on("before_agent_start", (_event, ctx) => guard(ctx, () => checkpoint(ctx, "before turn")));

	pi.on("tool_result", async (event, ctx) => {
		if (!ready) return;

		// Tracked whatever the granularity, so a later snapshot still picks the file up.
		if (config.trackAgentEditedIgnoredFiles && (event.toolName === "write" || event.toolName === "edit")) {
			const raw = event.input.file_path ?? event.input.path;
			if (typeof raw === "string") {
				const absolute = path.resolve(ctx.cwd, raw);
				// A path outside the work tree cannot be added to this repository.
				if (absolute.startsWith(`${ctx.cwd}${path.sep}`)) forced.add(absolute);
			}
		}

		if (config.granularity !== "tool" || READ_ONLY_TOOLS.has(event.toolName)) return;
		await guard(ctx, () => checkpoint(ctx, `after ${event.toolName}`));
	});

	pi.on("turn_end", (_event, ctx) => guard(ctx, () => checkpoint(ctx, "end of turn")));

	pi.on("session_tree", async (event, ctx) => {
		if (!ready || !config.restoreOnTreeNavigation) return;

		// reset --hard rewrites files. Racing it against a tool that is still writing would
		// put two writers on the same paths, so leave the tree alone and say so.
		if (!ctx.isIdle()) {
			ctx.ui.notify("Moved without restoring code: the agent is still running. Run /rewind once it stops.", "warning");
			return;
		}

		await restoreTo(ctx, resolve(ctx, event.newLeafId), "Moved");
	});

	// Capture the tree on the way out so work done after the last checkpoint stays
	// recoverable. No session entry: this session is already ending.
	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ready) return;
		try {
			await serialize(() => commit(ctx.cwd, "session end"));
		} catch {
			// Shutting down must not fail because a snapshot could not be written.
		}
	});

	pi.registerCommand("rewind", {
		description: "Restore the working tree to an earlier checkpoint, without moving the conversation",
		handler: async (_args, ctx) => {
			if (!ready) {
				ctx.ui.notify("Checkpoints are not active in this session.", "warning");
				return;
			}

			const points: Checkpoint[] = [];
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
				const data = entry.data as Checkpoint | undefined;
				if (data?.commit) points.push(data);
			}

			if (points.length === 0) {
				ctx.ui.notify("No checkpoints in this session yet.", "info");
				return;
			}

			// Newest first, and numbered so two identical labels stay distinguishable.
			const recent = points.reverse().slice(0, 20);
			const options = recent.map(
				(point, index) =>
					`${index + 1}. ${point.timestamp.slice(11, 19)}  ${point.label}  (${point.files} file${point.files === 1 ? "" : "s"}, ${point.commit.slice(0, 8)})`,
			);

			const choice = await ctx.ui.select("Restore the working tree to:", options);
			const target = choice === undefined ? undefined : recent[options.indexOf(choice)];
			if (!target) return;

			await restoreTo(ctx, target, "Rewound");
		},
	});
}
