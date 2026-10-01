# Neovim diagnostics for Pi

An on-demand `nvim_diagnostics` tool for explicitly named **saved files**. It uses
your Neovim configuration in a **fresh headless instance per tool call**, collects
LSP, `nvim-lint`, and other `vim.diagnostic` sources, and **awaits process cleanup
before returning**. It does not connect to your editor or use unsaved buffers.

Independent of `extensions/nvim-lsp/`; that extension is unchanged and retains its
existing session-scoped process behavior. Only this new diagnostics tool has the
per-call lifetime described here. Design decisions and remaining work live in
[PLAN.md](PLAN.md).

## Requirements and loading

- Node.js 20.3+ and Neovim 0.11+ on macOS or Linux.
- A POSIX `ps` supporting `-axo pid=,pgid=,stat=` (the macOS/procps implementation).
- Already installed diagnostic providers and configuration that can run headlessly.
- No additional npm dependencies.

This directory is auto-discovered under `~/.pi/agent/extensions/`. Run `/reload`
or start a new Pi session. The extension factory starts no processes or timers.

Implementation and integration tests have been exercised on macOS with Neovim
0.12.5 and Node 26. Linux and the minimum supported versions still need independent
verification. Windows is explicitly rejected rather than providing weaker cleanup.

## Tool usage

```json
{"files":["src/main.ts","src/utils.ts"]}
```

```json
{
  "files": ["src/main.ts"],
  "severity": ["error", "warning"],
  "timeout_ms": 8000,
  "limit": 50
}
```

| Parameter | Meaning |
| --- | --- |
| `files` | Required list of 1–20 existing files, relative to Pi's working directory or absolute. Paths are canonicalized. No globs or directory scans. |
| `severity` | Optional nonempty selection of `error`, `warning`, `information`, `hint`; defaults to all four. |
| `timeout_ms` | Per-file observation budget, including attachment; default 3000 ms, range 100–30000. |
| `limit` | Request-wide diagnostic cap, default 100, maximum 500. |

Files over 1 MiB and binary/NUL-containing files are rejected individually. Duplicate
canonical paths are reported individually. If every path is invalid, no Neovim
process starts. Otherwise one process handles the whole list, serially.

The tool returns concise text and structured `details`:

- Per-file status, canonical path, SHA-256 fingerprint, and diagnostics.
- One-based lines and **byte columns**, including end positions when available.
  LSP UTF-16 positions are converted; they are not reported as byte columns directly.
- Severity, message, source/code when available, namespace, and observed freshness.
- Provider status, notices, and bounded runtime logs so failed setup is visible.
- Counts **before severity filtering**, matching diagnostics omitted by the limit,
  and explicit text/provider truncation flags.
- Cleanup outcome and elapsed time.

Individual file errors do not discard other files. Startup/transport failures,
cancellation, or unconfirmed cleanup fail the whole call. Main text is capped at
30 KB; narrow the file list/filter if truncated. Structured details retain bounded
results, not an unbounded full diagnostic dump. Diagnostic fields are capped at
1000 bytes (source/code/namespace at 200); provider metadata is capped at 50 entries
per file, notices at 30 per call, and each RPC response at 4 MiB. Terminal control
characters are escaped in model-facing text.

### What a result does—and does not—prove

`complete` is always `false`: this is a bounded snapshot, not a whole-project check
or proof that every configured provider ran. **Zero diagnostics does not mean the
file is clean.** In particular:

- `snapshot` means the observation window finished, not that analysis completed.
- `timed_out` means a known provider was still pending, or the call ran out of budget.
- `changed_during_check` means the saved file changed or disappeared; retry.
- `error` means that file could not be checked reliably.
- Provider `unavailable`, `not_configured_for_file`, `attached_no_update_observed`,
  `no_update_observed`, `initializing`, and `pending` are not clean results.
- `push_update_observed` / `update_observed` record publication, including an empty
  publication. They do not establish that every provider finished or that a server
  did not republish its own stale cache.
- `pull_responded` records a full document diagnostic response. Unknown/unchanged
  responses and pull errors are reported separately.

The tool verifies loaded buffer text against disk, catches plugin buffer changes,
and compares file fingerprints again after the batch and teardown. This reduces
version races; it does not make asynchronous diagnostics universally fresh.

Run project tests/typecheckers for stronger project-wide evidence. Provider text
is untrusted data, never instructions for Pi.

## Process ownership and cleanup

```text
Pi
└── per-call Node supervisor      IPC disconnect detects Pi death
    ├── headless Neovim           its own POSIX process group
    │   └── supported providers   kept in that same group by bootstrap
    └── short-lived RPC helpers   tracked and reaped separately
```

- Each call gets a new instance. No idle pool, restart command, or cross-call cache.
- Calls are serialized, including when the bridge is used outside Pi's sequential
  tool scheduler. Queued cancellation does not launch a process.
- Success, failure, cancellation, and partial startup all await the same cleanup.
  Session shutdown/reload also cancels queued/active work.
- Cleanup first requests LSP/Neovim shutdown without saving, then escalates through
  SIGTERM and SIGKILL and verifies the owned group has no live members. Direct
  children are reaped; OS-adopted dead descendants are left to their OS parent to reap.
- The supervisor also tears down on parent IPC disconnect, including Pi `SIGKILL`,
  and has a work deadline independent of Neovim's event loop.
- Startup has a 15-second cap; work is capped at 115 seconds after the supervisor
  starts, reserving approximately 5 seconds for normal teardown. Queue wait and
  preflight validation are outside that clock. These are not hard real-time
  guarantees: OS stalls and emergency cleanup can take longer.
- If a supervisor fails, Pi attempts scoped fallback cleanup. Cleanup that cannot
  be confirmed is an error and **poisons the bridge**: reload the extension before
  using it again rather than silently accumulating instances.
- Private sockets, caches/state, logs, and temporary directories are removed.
  Neither Neovim nor the supervisor is intentionally kept alive after a call.

Only recorded owned groups are signaled; no executable-name matching or broad
`pkill` is used. Supported Lua spawn paths cannot detach from Neovim's group.
However, arbitrary native plugins, `jobstart(..., {detach=true})`, external tools
that daemonize themselves, and simultaneous supervisor/parent failures can escape
this ownership model. An abrupt supervisor failure before ownership handoff is
also an exceptional gap. This is not a sandbox or a universal orphan-prevention
system. The standard `vim.lsp.rpc.connect` shared/TCP connection helper is rejected:
the extension must not shut down an unrelated server it does not own.

## Configuration and headless guards

Set overrides **before starting Pi**:

```sh
PI_NVIM_DIAGNOSTICS_BIN=/absolute/path/to/nvim pi
PI_NVIM_DIAGNOSTICS_INIT=/absolute/path/to/headless-init.lua pi
```

The default loads your normal init. `PI_NVIM_DIAGNOSTICS_INIT=NONE` is useful for
isolation/troubleshooting but has no configured LSP or lint providers by itself.

The child receives `PI_NVIM_DIAGNOSTICS=1`; your config can use it to skip UI-only
plugins or other unwanted activity. It does not inherit `NVIM` or
`NVIM_LISTEN_ADDRESS`. Swap, persistent undo, ShaDa, and project exrc are disabled
before init (user code can override options). Cache/state/log paths are private.

The bootstrap applies headless-only, best-effort guards for the inspected plugin
APIs:

- Disables Lazy's automatic update checking, missing-plugin installation, and
  config-change detection.
- Empties Mason-LSPConfig's ensure-installed list and blocks Mason registry
  refresh/update and package installation/uninstallation. Suppressed install
  attempts become notices, not a reason to abort other installed providers.
- Sets LazyVim's autoformat flag to false; no save or fake save event is issued.
- Captures default WARN/ERROR notifications as deduplicated notices rather than
  rendering them inside a long-running RPC. This prevents handled provider errors
  from turning into whole-call RPC errors. Plugins can override/bypass this hook.
- Forces `vim.uv.spawn` children (including the inspected LSP and `nvim-lint`
  launch paths) to stay in Neovim's process group.

No files in your editor configuration are modified. These guards depend on plugin
APIs and **do not guarantee no network access or no filesystem side effects**.
Your init's own bootstrap code can run before plugin guards take effect. Use a
minimal custom init if stronger predictability is needed; use OS isolation if a
real security boundary is needed.

### Provider activation

Opening each requested file activates normal filetype/LSP configuration. Pull
requests are issued when supported; results are normalized into the client's
Neovim diagnostic namespace. Identical push/pull findings from the same client are
not counted twice; independent clients/namespaces remain independent sources.

The `nvim-lint` adapter explicitly runs filetype linters, compound-filetype matches,
fallback (`_`), and global (`*`) linters, honoring conditions. In the headless child,
its standard automatic group and `try_lint` callbacks are suppressed after adapter
activation to avoid debounced callbacks cancelling explicit checks on the wrong
current buffer. Arbitrary custom lint wrappers/events may need a dedicated adapter.

Every namespace published through `vim.diagnostic` is collected, even if no LSP
attaches. Unknown providers do not get a fabricated refresh/completion guarantee.

## Tests

```sh
node --test extensions/nvim-diagnostics/bridge.test.mjs
```

Tests launch real Neovim with isolated config and deterministic LSP/lint fixtures.
They cover cold process ownership, push/pull and non-LSP diagnostics, UTF-16/byte
conversion, conditions, file races, partial batches, errors, limits, cancellation,
hung processes, supervisor failure, and forced parent death. Parent-death tests
kill only disposable test parents—not your Pi process or editor.

To additionally exercise an installed `nvim-lint` checkout, still with isolated
config and a deterministic linter executable:

```sh
PI_NVIM_DIAGNOSTICS_TEST_LINT_RUNTIME="$HOME/.local/share/nvim/lazy/nvim-lint" \
  node --test extensions/nvim-diagnostics/bridge.test.mjs
```

Real-config smoke validation has found Lua syntax errors through the user's
LazyVim/lua_ls setup, followed by a fresh-call check after fixing the file. Both
calls verified teardown. Cold calls with 8s/5s observation budgets took roughly
9s/6s on this machine; the fixed-file snapshot had no observed push update, so it
was correctly not labeled a verified clean result. A final default-budget (3s)
check also found both syntax errors in about 3.6s total, with verified cleanup.
Representative large-project benchmarks and additional OS/version testing remain
open in [PLAN.md](PLAN.md).
