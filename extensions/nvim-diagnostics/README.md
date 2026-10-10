# Neovim diagnostics for Pi

Registers **`nvim_diagnostics`**, an on-demand tool backed exclusively by the
[Pi-owned Neovim service](../nvim-service/README.md). It does not start an editor,
use `$NVIM`, or connect to your interactive Neovim.

## Setup

Requires `nvim-service`, Node.js 22.19+, and Neovim 0.11+ (tested with 0.12.5).
Install the shared runtime dependency, the MessagePack codec (now housed in
`nvim-service`, also used by `nvim-semantic`):

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
- `mode`: optional, **`snapshot`** by default. Reads best-effort cached observations,
  not a completed check. Use **`check`** for explicit required-provider completion.
- `requiredClients`: required in check mode and forbidden in snapshot mode;
  **1–16 unique exact, case-sensitive LSP client names**, at most 512 characters
  each. The same requirements apply to **every file** in the batch. These are
  client names (`pyright`), not diagnostic sources (`Pyright`).
- `severities`: optional; default **error, warning, info, hint**. Filters returned
  entries, not the per-file counts of retrieved diagnostics.
- `timeoutMs`: optional, **10000** by default; range **100–30000**. One shared
  deadline covers queuing, connection, discovery, collection/conversion, and source
  verification, not a separate timeout per file. It is a maximum, not a startup
  sleep. Filesystem/scheduling overhead is not a real-time guarantee.

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

## Check mode: explicit required providers

```json
{
  "files": ["probe.py"],
  "mode": "check",
  "requiredClients": ["pyright"],
  "timeoutMs": 20000
}
```

A fast empty linter cannot satisfy a requirement for an absent type checker.
Check mode waits for the named clients on each file and requests every currently
exposed applicable pull provider from each matching attached instance. Unrelated
clients remain visible but receive no tool-owned requests and cannot block it.
No server is installed, enabled, or guessed to fulfill a requirement.

Only this call's **uncancelled full document-diagnostic replies** count. These replies are
retained directly and converted against the input disk snapshot; neither cached
results, automatic pulls, push publications, nor `unchanged` replies without a
baseline establish completion. Related-document results are outside the anchor's
scope. Check mode does not publish its replies through Neovim's cache handler.
This also avoids depending on that handler's hidden-buffer pull-state setup.

`check.status` is separate from observation status and diagnostic counts:

| Check status | Meaning |
| --- | --- |
| `not_requested` | Snapshot mode; no provider-backed check was attempted. |
| `complete` | Required owned replies were collected and sources reverified. Errors can still be present: **complete is not a pass verdict**. |
| `incomplete` | Missing/initializing clients, pending responses, unverifiable push-only coverage, or a final verification race prevented completion. |
| `failed` | A required request/lookup, response validation/collection, or source verification failed. Partial results may remain. |

Missing and push-only providers wait within the same deadline: an attachment or
new pull capability might still arrive. Neovim's public discovery currently hides
clients awaiting initialization, so `missing` means **not observed**, not proven
absent or disabled. Terminal failures can finish early. Provider disappearance,
identifier changes, and changed registration option values retire obsolete owned
work. Equivalent registration aliases do not consume attempts merely because
UUIDs, Lua objects, or duplicate match counts changed. Retries and limits apply
across the call. Multiple instances with one required name must all answer
when observed attached; the first successful instance cannot hide another failure.

Check mode compares loaded logical UTF-8 lines with the disk snapshot (BOM/CRLF
normalized), then fences buffer revisions and reverifies disk hashes. It rejects
bare-CR files and unsafe range conversions. A source conflict invalidates completion,
without overwriting the buffer or discarding already-retained useful replies.

This is deliberately scoped to names/instances/registrations observed at final
verification. It cannot certify future attachments, complete workspace indexing,
server correctness, or builds/tests. Push-only observations remain available in
snapshot mode. Neovim 0.11's single-match dynamic accessor cannot establish full
registration coverage, so such checks stay unconfirmed; static providers can still
be checked. Compatibility shapes are simulated on 0.12, not tested on a 0.11 binary.
See [the full completion contract and regression boundaries](CHECK_CONTRACT.md).

## Snapshot coverage and freshness

Neovim stores a **diagnostic cache**, not a universal "all checks finished" flag.
Snapshot mode reads all namespaces exposed by `vim.diagnostic`, including LSP and
plugins that publish there. Quickfix-only or proprietary plugin stores are not
included. Save-only/manual linters are **not** triggered with fake save events or
extra shell commands. Normal configured file-load hooks may run them.

For LSPs supporting document pull diagnostics, it makes explicit requests for
hidden buffers, using Neovim's public response handler for encoding conversion,
namespaces, and related-document handling. Provider identifiers come from
Neovim's dynamic registrations matching the **explicit anchor buffer**, with
static/default capabilities used when no matching dynamic registration exists.
This keeps tool-owned and automatic pulls in the same provider namespace instead
of creating an extra default-identifier copy (for example, with Pyright).

Requests are tracked separately for each client/provider identifier. Repeated
registrations for the same identifier share a pull; diagnostics from **distinct
providers are not deduplicated by message text**. Neovim 0.12 exposes multiple
matching registrations; the 0.11 accessor exposes only its first matching
registration, so other providers may not all be explicitly refreshed there.
The tool limits observations to **16 client instances per file/call**, prioritizing
required names in check mode, and pulls to **16 distinct identifiers per
client/file/call**. Identifiers are bounded to 512 bytes, and each lookup permits
at most 128 matching registrations (including duplicates). Comparing registration
options uses canonical values, bounded per lookup to 64 KiB, 2048 visited
keys/values, and nesting depth 16. Client/provider limits include registration/client
changes during that call. Lookup failures, invalid identifiers/options, and
exhausted provider limits are explicit `pull_error` results,
not guessed default identifiers or proof of complete coverage.

Registration lookup does not repair Neovim's own buffer initialization. For
example, Neovim 0.12 can fail to initialize pull state for a hidden buffer with
only selector-scoped dynamic registrations. A response-handler failure remains
`pull_error` in snapshot mode; the tool does not patch private runtime state to
hide it. Check mode consumes direct replies instead of using that cache handler.
Push servers remain controlled by Neovim's normal open/change notifications.
Only this tool's own pull requests are canceled on cleanup.

Neovim can cancel a tool-owned pull during an automatic diagnostic refresh. A
server may answer with an ordinary **empty full report**, not a cancellation error;
that reply must not clear a snapshot cache or establish check completion. The tool
observes public `LspRequest` cancellation events and discards such replies. A cancel
event alone is not completion: no retry starts until the reply/completion arrives.
Neovim can also consume a cancellation acknowledgement without invoking its
response callback; deferred completion bookkeeping handles that path while letting
normal response handlers run first.

Interrupted pulls retry at most twice per client/provider/file. Meaningful provider
changes consume the same three-attempt budget; equivalent registration aliases do
not. Exhausted retries or other explicit failures become `pull_error`, not phantom
pending work or a clean result. A cancelled request that never completes remains
pending until the deadline. Retries use the original whole-call deadline. This
does not disable automatic refreshes or cancel other consumers' requests.

Snapshot mode observes diagnostic events, client attachment/initialization, and
pull responses, then allows a **400 ms quiet period**. Check mode does not use a
quiet period as a completion condition. These observations are only
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
| `pull_error` | An explicit pull failed, including cancellation after bounded retries. Retained diagnostics may be useful but coverage is incomplete. |
| `file_error` | Missing, unreadable, non-regular, oversized, invalid-UTF-8 file, or Neovim loading error. |
| `buffer_modified` | An unsaved service buffer was left untouched. |
| `disk_changed`, `buffer_changed`, `buffer_unavailable` | The input changed or disappeared during the check. |

Schema-version-2 reports expose request ID, mode, check status, elapsed time,
budget/stop reason, and serving PID/socket/identity verification **in model-visible
text**, not only Pi's UI-only `details`. A queued request can identify an advertised
service without falsely claiming it contacted it. The diagnostic helper protocol
version is an API contract marker, not proof of a particular Git checkout.
Helper protocol **3** rejects older helpers without the cancellation/registration
fixes; the report schema remains version 2. Run `/reload` after upgrading.

Per-file output includes source hashes/ticks, verification state, required-client
outcomes, observed client IDs/names/roots, and per-provider identifiers, owned
request IDs, attempts, response kinds, timing offsets and failures. Per-pull
`cancelled`/`cancelledAtMs` describe the current attempt's observed cancellation
request, not its completion. `cancelledAttempts` and `discardedReplies` retain
counts across retries; these are also shown in model-visible text. Neovim request
versions are not server acknowledgements of index freshness. Snapshots expose
cache namespaces; checks expose direct client/provider provenance. Provider
metadata retained across a source conflict is labeled as not reverified.
`pendingPullClients` identifies outstanding owned work; `pullRetries` counts extra
attempts after cancellation/supersession, including registration changes. A service
disconnect is an explicit failed tool call; deadlines can retain partial results.
**No matching diagnostics does not mean the file passed every check.** Still run
appropriate tests, builds, and linters.

## Output and limits

Results are grouped by canonical file, sorted by severity and position, and
contain message, source/namespace, code, start/end range, and severity counts.
Positions use **1-based lines and UTF-8 byte columns; ends are exclusive**. Neovim
converts encodings for cached snapshots; check mode converts owned response ranges
against the original UTF-8 input, independently of diagnostic caches. Unconvertible
ranges stay explicitly labeled with raw 0-based, provider-encoded `lspRange` values
and invalidate completion; they are never presented as invented source positions.

Readable output is capped at **16 KiB / 1000 lines**. Larger results include a
mode-0600 `report.json` in a private temporary directory. The path is in both the
text and structured `details.fullOutputPath`; read it with Pi's file tools.
Reports persist independently of the Neovim service so they remain readable
after a service restart (normal OS temp-file retention applies).

A further RPC safety cap limits each snapshot, or retained owned check replies
across the call, to 10000 diagnostics / an estimated 8 MiB and each message to
8192 bytes. Response collection omissions invalidate check completion. Omissions and message truncation are
explicit; even the full retrieved report cannot restore those omitted details.
Arbitrary diagnostic `user_data` is not serialized. Diagnostic text and file
names are untrusted data, never instructions to execute.

## Lifecycle

Discovery uses the service's `:get`, `:ready`, and `:stopped` events. Connections
are lazy and verify the service PID/ownership marker/socket before loading Lua.
No resources start during registration, and discovery never blocks an earlier
`session_start` handler waiting for a later one.

Calls are serialized across diagnostics and semantic consumers using the shared
service client library. Both use the same buffer cache and active-request leases.
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
partial coverage, native refresh/cancellation acknowledgements, bounded retries,
dynamic identifiers/selectors, static fallback, multiple-provider provenance,
legacy registration-accessor compatibility, provider limits, queued deadlines,
frozen/dead services, cache retention, output limits, discovery/reload behavior,
and RPC framing/lifecycle. `check.test.mjs` additionally covers cold fast-empty /
late-checker discovery with an already-incorrect file; missing, initializing,
push-only and hanging clients; per-file requirements; unrelated hangs; cache
contamination; full-response/range validation; multiple matching instances;
meaningful registration changes and equivalent aliases; cancelled full replies,
synchronous cancellation and retry bounds; observation/collection/option limits;
final source races; BOM/CRLF/Unicode conversion; and stale-helper rejection.
`CHECK_CONTRACT.md` defines the completion contract. The local `TEST_PLAN.md`, when
present, describes live cold-check and snapshot retesting; it is not required at
runtime.
