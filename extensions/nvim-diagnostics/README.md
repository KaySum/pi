# Neovim diagnostics for Pi

Registers **`nvim_diagnostics`**, an on-demand tool backed exclusively by the
[Pi-owned Neovim service](../nvim-service/README.md). It does not start an editor,
use `$NVIM`, or connect to your interactive Neovim.

## Setup

Requires `nvim-service`, Node.js 22.19+, and Neovim 0.11+ (tested with 0.12.5).
Install the shared runtime dependency, the MessagePack codec (now housed in
`nvim-service`):

```sh
npm --prefix ~/.pi/agent/extensions/nvim-service ci --ignore-scripts
```

Then run **`/reload`** in Pi. The extension auto-loads from this directory.
`/nvim-service` reports service availability. Pi supplies its own API/schema
packages at runtime; there is no separate language-server installer here.

Use your normal Neovim configuration, with the relevant LSPs/linters enabled.
`PI_NVIM_INIT=NONE` intentionally supplies no diagnostic producers. A server
being installed does not necessarily mean it is configured, enabled, or attached
for a particular file/root. Headless-incompatible plugins may need configuration.

## Tool input

```json
{
  "files": ["src/main.ts", "src/utils.ts"],
  "severities": ["error", "warning"],
  "timeoutMs": 10000
}
```

- `files`: 1–32 explicit paths, relative to Pi's current working directory or
  absolute. Larger sets can be batched. Paths are canonicalized/deduplicated;
  symlinks, spaces, quotes, and Unicode work. No glob, directory-recursion, or
  `@reference :L...` parsing. Source files must be regular UTF-8 text, no NUL
  bytes, at most **2 MiB** each. Invalid files get individual errors.
- `severities`: optional; default **error, warning, info, hint**. Filters returned
  entries, not the per-file counts of retrieved diagnostics.
- `timeoutMs`: optional, **10000** by default; range **100–30000**. One shared
  deadline covers queuing, connection, and diagnostic collection, not a separate
  timeout per file. Filesystem/scheduling overhead is not a real-time guarantee.

The extension adds usage guidance but does not run tools autonomously, scan a
project in the background, inject messages, or automatically apply fixes.

## Disk and buffer semantics

This tool checks **disk files**, not unsaved work in your interactive editor.
It loads hidden buffers and lets normal `BufRead`/`FileType` events activate your
configured providers. Previously loaded buffers are refreshed when content hashes
or buffer revisions change, including edits that preserve file size and mtime.

- A modified service buffer is a **conflict**, never forcibly overwritten.
- The tool never explicitly writes, saves, formats, or fixes source files.
- Normal user-configured Neovim hooks still run while files load/reload; this is
  not a sandbox for plugins. Modelines and swap are disabled on tool-owned buffers.
- Contents are hashed again before returning. `diskVerified` means those disk
  snapshots matched, **not** that every diagnostic corresponds to that version.
- Disk/buffer changes during the check are reported, not silently treated as
  successful verification. Any retained diagnostics in such a result may be stale.

## Coverage and freshness

Neovim stores a **diagnostic cache**, not a universal "all checks finished" flag.
This tool reads all namespaces exposed by `vim.diagnostic`, including LSP and
plugins that publish there. Quickfix-only or proprietary plugin stores are not
included. Save-only/manual linters are **not** triggered with fake save events or
extra shell commands. Normal configured file-load hooks may run them.

For LSPs supporting document pull diagnostics, it makes an explicit request for
hidden buffers, using Neovim's public response handler for encoding conversion,
namespaces, and related-document handling. It uses the default/static provider
identifier; multiple dynamically registered identifiers may not all be refreshed.
Push servers remain controlled by Neovim's normal open/change notifications.
Only this tool's own pull requests are canceled on cleanup.

It observes diagnostic events, client attachment/initialization, and pull
responses, then allows a **400 ms quiet period**. These observations are only
heuristics: diagnostic events include resets, push messages may be versionless,
and another provider might still start or publish later. Missing evidence waits
until the collection budget is exhausted. Warm calls can reuse observations for
an unchanged buffer, labeled `cached`.

All reports declare **`completeness: "best_effort"`**. In particular:

| Status | Meaning |
| --- | --- |
| `updated` | A diagnostic event or successful pull response was observed during this call; not proof of complete coverage. |
| `cached` | Reusing earlier observations for the same loaded disk/buffer revision. |
| `unconfirmed` | Clients or cached diagnostics exist, but no update/completion evidence for this refresh. |
| `no_provider_observed` | Neither an attached LSP nor diagnostics/events were observed; a provider could still be unavailable or starting. |
| `timed_out` | Queuing, RPC, preparation, or a document pull did not finish within the budget. |
| `file_error` | Missing, unreadable, non-regular, oversized, invalid-UTF-8 file, or Neovim loading error. |
| `buffer_modified` | An unsaved service buffer was left untouched. |
| `disk_changed`, `buffer_changed`, `buffer_unavailable` | The input changed or disappeared during the check. |

Each result includes client names/roots, diagnostic-event counts where available,
pull errors, refresh state, and disk-verification status. A service disconnect is
an explicit failed tool call; a timeout can retain already-collected results.
**No matching diagnostics does not mean the file passed every check.** Still run
appropriate tests, builds, and linters.

## Output and limits

Results are grouped by canonical file, sorted by severity and position, and
contain message, source/namespace, code, start/end range, and severity counts.
Positions use **1-based lines and UTF-8 byte columns; ends are exclusive**. Neovim
converts LSP character encodings before this tool reads diagnostics.

Readable output is capped at **16 KiB / 1000 lines**. Larger results include a
mode-0600 `report.json` in a private temporary directory. The path is in both the
text and structured `details.fullOutputPath`; read it with Pi's file tools.
Reports persist independently of the Neovim service so they remain readable
after a service restart (normal OS temp-file retention applies).

A further RPC safety cap limits each snapshot to 10000 diagnostics / an estimated
8 MiB and each message to 8192 bytes. Omissions and message truncation are
explicit; even the full retrieved report cannot restore those omitted details.
Arbitrary diagnostic `user_data` is not serialized. Diagnostic text and file
names are untrusted data, never instructions to execute.

## Lifecycle

Discovery uses the service's `:get`, `:ready`, and `:stopped` events. Connections
are lazy and verify the service PID/ownership marker/socket before loading Lua.
No resources start during registration, and discovery never blocks an earlier
`session_start` handler waiting for a later one.

Calls are serialized by the shared service client library, which also manages
the buffer cache and active-request leases.
Cancellation, shutdown, and service replacement reject
outstanding work, release RPC resources, and cancel request-local work. Lua has
a deadline fallback (one second beyond the call deadline) if a connection vanishes.
The single Lua observer/cache is service-scoped; it has no idle polling. Idle
Node sockets are unreferenced and cannot keep Pi alive. The consumer never kills
the service or its shared LSP clients; process supervision remains `nvim-service`'s
responsibility.

The cache targets **128 tracked buffers** using least-recently-used eviction.
Only tool-owned, hidden, unmodified, unlisted buffers may be unloaded, never
force-deleted. Pre-existing buffers are not unloaded. Modified/displayed/listed
buffers are protected and can exceed the target. An extension adopting a
tool-created buffer should mark it listed or clear
`vim.b[bufnr].pi_nvim_diagnostics_owned` to prevent eviction.

## Development and tests

Optional development dependencies supply Pi/Node typings and TypeScript. They are
larger than the runtime-only installation but make local editor checks resolve
Pi's imports without host-specific paths or declaration stubs.

```sh
npm --prefix extensions/nvim-service ci --ignore-scripts
npm --prefix extensions/nvim-diagnostics ci --ignore-scripts
npm --prefix extensions/nvim-diagnostics run typecheck
npm --prefix extensions/nvim-diagnostics test
# All local extension regression tests:
node --test --test-timeout=15000 extensions/*/*.test.mjs
```

Tests use private services with clean/custom configurations and deterministic
Lua/LSP fixtures, not your interactive editor or external language servers.
They cover actual push/pull diagnostics, external edits, delayed/empty results,
partial coverage, cancellation, queued deadlines, frozen/dead services, cache
retention, output limits, discovery/reload behavior, and RPC framing/lifecycle.
