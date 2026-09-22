# Checkpoints

`extensions/checkpoints.ts` keeps the working tree in step with where you are in pi's session
tree. Moving back restores the code as it was; moving forward again restores the later state;
moving to a sibling branch restores that branch's code. It is not a one-way undo.

## The rule

Every snapshot is a commit in a shadow git repository, recorded as a session entry at the point
in the tree where it was taken. Restoring resolves to a single rule:

> the state for entry `T` is the last checkpoint on the path from the root to `T`

`sessionManager.getBranch(T)` returns exactly that path, so one rule covers every direction:

| Move | Why it lands on the right state |
|---|---|
| Back | The shorter path ends before the later checkpoints, so the last one on it is earlier |
| Forward | The longer path contains the later checkpoints again, so the last one on it is later |
| Sibling branch | The other branch's checkpoints are not on this path and cannot be selected |

A checkpoint entry records the tree at the instant it is inserted, so its position and its
contents are taken together: everything above it in the path had already happened, everything
below it had not.

## Storage

The shadow repository lives at `~/.pi/agent/checkpoints/<dirname>-<hash>/`, keyed by the real
path of the working directory, with mode `0700`. It has its own index and its own HEAD.

It never touches the project's `.git`: every git call passes an explicit `GIT_DIR` and
`GIT_WORK_TREE`, so your branch, index, stash, and history are untouched. Restoring changes
files in the working tree — which is the point — and your own `git status` will show that.

Git runs with `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` pointed at `/dev/null`. This is not
tidiness: a global `commit.gpgsign` would sign every snapshot, `core.hooksPath` would run your
hooks, `core.autocrlf` would rewrite line endings, and a configured LFS filter would store
pointers instead of contents. With no global config an unconfigured `.gitattributes` filter is
a no-op, so files are stored byte for byte.

Git operations are serialized through a promise chain, because pi runs tool calls in parallel
and a repository has one index.

## When a snapshot is taken

- at session start
- before each turn — catches edits you made yourself, including `!` commands
- after each mutating tool call, when `granularity` is `"tool"`
- at the end of each turn
- at session shutdown

A snapshot that finds no changes is skipped, so idle turns cost one `git add -A`.

## When a restore happens

- **Tree navigation** — after `/tree` moves the leaf.
- **Fork** — a fork is a deliberate move to an earlier point, so the code moves with it.
- **`/rewind`** — pick a checkpoint and restore the files without moving the conversation.

**Resume does not restore.** A resumed session's working tree may have moved on for reasons
that have nothing to do with that session, and overwriting it unasked would destroy work. Use
`/rewind` when you do want it.

Restoring while the agent is still streaming is refused, with a message telling you to run
`/rewind` once it stops. `reset --hard` and a tool writing the same file are two writers on one
path.

## Restoring is reversible

A restore first commits the current tree, then resets to the target. Committing first does two
things: it makes files created since the checkpoint *tracked*, so `reset --hard` removes them
exactly, and it leaves the state you are replacing reachable in the shadow repository instead
of destroyed. `/rewind` can take you back to it.

## Ignored files

Files excluded by the project's `.gitignore` are not checkpointed — `node_modules`, build
output, and local caches stay where they are through a restore, which is almost always what
you want.

The exception is a file the agent itself wrote with `write` or `edit`. Those are force-added so
they restore correctly, which means an agent-edited `.env` is stored in the shadow repository.
Set `trackAgentEditedIgnoredFiles` to `false` if you would rather it were not.

## Settings

`checkpoints.json` in the agent directory, overridden by `.pi/checkpoints.json` in a trusted
project. To switch checkpointing off entirely, set `"checkpoints": false` in `features.json`.

| Key | Default | Meaning |
|---|---|---|
| `granularity` | `"tool"` | `"tool"` snapshots after every mutating tool; `"turn"` only at turn boundaries |
| `restoreOnTreeNavigation` | `true` | Restore after `/tree` moves the leaf |
| `restoreOnFork` | `true` | Restore when a fork opens at an earlier point |
| `trackAgentEditedIgnoredFiles` | `true` | Force-add gitignored files the agent edits |
| `exclude` | `[]` | Extra gitignore patterns for the shadow repo, written to its `info/exclude` |

The session directory is excluded automatically when it sits inside the working directory,
otherwise every snapshot would contain the record of itself.

## Verified behavior

The git mechanics were checked directly against git: restoring reverts modified files, brings
back deleted ones, removes files and directories created since the checkpoint, reverts a
force-added ignored file, preserves the executable bit and symlinks, leaves untracked ignored
files alone, and leaves the project's own repository HEAD untouched. Forward restore to a later
checkpoint is exact.

## Limits

These are real and worth knowing before you rely on it:

- **Only the working directory.** Nothing outside it is restored: no databases, no migrations
  that already ran, no network calls, no files written elsewhere on disk.
- **Nested repositories** (submodules, vendored checkouts with their own `.git`) are recorded
  as gitlinks. Their contents are not checkpointed.
- **Empty directories** are not tracked by git, so one may linger after a restore.
- **Two pi sessions in one directory** share a shadow repository. Git's index lock keeps them
  from corrupting it, but a snapshot may fail and report a warning.
- **Untracked ignored files created by bash** are not checkpointed, since only `write` and
  `edit` paths are force-added.
- Checkpoint entries are appended to the session tree during a turn. That is pi's documented
  mechanism for durable state, but it has not been exercised against a running pi here — set
  `granularity` to `"turn"` for fewer of them.
