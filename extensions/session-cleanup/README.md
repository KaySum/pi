# Session cleanup

Local Pi extension for session and associated metadata cleanup.

- Runs once at **session start**, or explicitly through `/session-cleanup`. No polling, filesystem watchers, or scheduled retries.
- Expires transcripts after **30 days without modification**, configurable.
- Reconciles transcripts deleted using Pi's built-in selector, a shell, or another process on the next run.
- Both paths use the **same configurable metadata rules**.
- Remembers session identity before deletion; retries failed rules without rerunning successful ones.
- Protects sessions leased by running instances of this extension. Dead process leases are discarded.

## Configure

Edit `<agent-dir>/session-cleanup.json`. Changes are read on each session-start or explicit run; no reload is needed for configuration. Run `/reload` once to load the extension itself. **Reload every running Pi instance before relying on active-session protection.** Instances without this extension cannot advertise their active sessions.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Pause both expiration and metadata cleanup when false |
| `retentionDays` | `30` | Inactivity based on transcript mtime; `null` disables expiration but retains manual-deletion cleanup |
| `sessionRoots` | `["{agentDir}/sessions"]` | Absolute directories to inventory recursively; add custom session locations explicitly |
| `rules` | `[]` | Metadata cleanup rules (the repository config supplies defaults below) |

Only the personal config is loaded. Project repositories cannot inject cleanup commands.

Commands:

- `/session-cleanup` or `/session-cleanup preview`: show eligible sessions and target paths without deleting them or running commands.
- `/session-cleanup run`: scan now using the configured retention.
- `/session-cleanup config`: show the configuration path and effective values.

Manual deletion is **eventually consistent**, not atomic: it is observed on the next session start or `/session-cleanup run`. Associated metadata is cleaned during that same run, without an extra delay. Failed cleanup retries wait for another session-start or explicit run; no timer is scheduled. The built-in selector itself is unchanged. Before a session has ever been inventoried, its deletion cannot be associated with external metadata. Existing orphans are deliberately not guessed at.

A matching session ID still present elsewhere in the configured inventory blocks metadata cleanup. Include **all** custom session roots to make that protection meaningful. A missing/unreadable root pauses the entire scan. Invalid transcripts are preserved, not assumed deleted. Custom IDs must contain only ASCII letters, digits, `_`, `-`, start with a letter/digit, and be at most 200 characters.

## Add an extension without changing code

Add a rule to the JSON `rules` array. Each rule has a unique `name`; `"enabled": false` disables it. Rules must be idempotent: a crash or partial operation can cause a retry.

Template variables:

- `{agentDir}`, `{home}`, `{node}` (current Node executable)
- `{sessionId}` (Pi transcript header ID), `{sessionFile}` (original absolute transcript path)
- `{sessionPathHash16}` (first 16 hex characters of SHA-256 of that path)
- `{cwd}` (project directory recorded in the transcript header)

Session roots accept only the first three variables. Metadata rules accept all of them. `~/` is also expanded. No environment-variable or shell expansion occurs.

### Session-owned files/directories

```json
{
  "name": "example-plugin",
  "type": "paths",
  "root": "{cwd}/.pi/example-plugin",
  "patterns": ["sessions/{sessionId}"],
  "guards": [{ "file": "active.json", "pidField": "pid" }]
}
```

Patterns are root-relative and support `*` within a single path segment, not `**`. A path rule must contain an exact `{sessionId}` segment, a session filename such as `{sessionId}.json`, or a `{sessionId}-*` segment. `..`, absolute patterns, and symbolic links are refused. Only matched subtrees are removed; roots/shared parents remain.

Optional guards read a JSON file directly inside each matched target. A live/unknown PID or malformed lease blocks cleanup (and automatic expiration of that transcript). A missing guard file means no lease; a dead PID permits cleanup. PID reuse conservatively delays removal. Use a command adapter instead if a plugin has more complicated liveness or ownership semantics.

### Rows in a shared SQLite database

```json
{
  "name": "example-database",
  "type": "sqlite",
  "root": "{agentDir}/state/example",
  "patterns": ["*.db"],
  "key": "sessionId",
  "tables": [{ "table": "events", "column": "session_id" }]
}
```

`key` is `sessionId` or `sessionPathHash16`. Deletes are parameterized and transactional **per database**, never whole-database deletion. Missing tables are skipped, but missing identity columns, corruption, and locks are reported and retried. NULL/unattributed rows and sibling sessions remain. SQLite rules require a Node runtime with `node:sqlite` (Node 22.13+); unavailable support is reported, not silently ignored. Schema changes may require updating configuration.

### Custom cleanup command

```json
{
  "name": "example-api",
  "type": "command",
  "command": "{home}/bin/example-cleanup",
  "args": ["--session", "{sessionId}"],
  "timeoutSeconds": 30
}
```

Commands run **without a shell**, with literal argument substitution. They also receive JSON on stdin containing `id`, `path`, `cwd`, `agentDir`, and bookkeeping fields. Exit zero only when cleanup is complete or nothing exists; nonzero exits/timeouts remain pending. Preview never launches commands. Commands are trusted user code and can access anything your account can; unlike path rules, the extension cannot bound their effects. Prefer plugin-supported deletion APIs and check active work/reference sharing inside the adapter. On POSIX, timeout kills the command's newly created process group and releases its pipes; Windows kills the direct child. Commands must not detach work into a different group.

## Included coverage and intentional exclusions

The repository's `session-cleanup.json` includes:

- **Workspace history:** session subtrees only, guarded by `active-session.json`; shared workspace repositories/logs remain. Change the root if the plugin uses custom `storageDir`.
- **Context-mode:** session events/resume/meta/tool counters and session-attributed FTS chunks, using its transcript-path hash rather than Pi UUID. Shared databases, untagged knowledge, vocabulary/source metadata, project event Markdown, and stats remain. Change the roots if using `CONTEXT_MODE_DIR`. These are targeted row deletions, not a whole-project purge.
- **Todo/questionnaire transcript data:** disappears with the transcript; there is no separate owned database to delete. Unattributable crash-leftover editor temp files are not guessed at.

No blanket deletion of `.pi`, shared caches, plugin configuration, credentials, or project output files is performed. Web-access caches are shared/referenced by forks and already have a one-hour TTL; cleanup leaves them to that plugin. Background-task and billion-context data must not be removed with naive session-ID globs: running task ownership and proxy conversation/reference lifecycles need a safe adapter.

## Recovery and safety limits

State lives in `<agent-dir>/state/session-cleanup/`: an identity inventory, per-process active leases, and a cross-process lock. The inventory contains paths/IDs/cwd, **not conversation contents**. Completed records are removed. Newly added rules apply to future/pending cleanups, not already forgotten sessions.

Expiration tries Pi's `trash` command and falls back to unlink. **Metadata deletion is permanent**, even if the transcript went to Trash. Restoring that transcript later will not restore deleted plugin history. Preview first; set `retentionDays` to `null` to disable expiration.

If cleanup crashes while holding its lock, it fails closed. Stop Pi instances, inspect `<agent-dir>/state/session-cleanup/lock/owner.json`, and remove **only that lock directory** once its owner is no longer running. Do not remove the inventory: it is needed to reconcile manual deletions. Corrupt config/inventory is reported rather than silently replaced.

Filesystem checks and PID leases reduce risk but are not an atomic transaction with Pi's selector or third-party plugin writers. This is a local, trusted-filesystem extension, not a defense against hostile concurrent path replacement. Closed/moved projects, custom storage overrides, other machines, or unconfigured session roots require configuration/operator care.

Tests (temporary fixtures only):

```sh
node --test extensions/session-cleanup/*.test.mjs
```
