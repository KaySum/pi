# Read-only Neovim semantic tools

Navigation, type inspection, and symbol search through the **existing Pi-owned
Neovim service**. No extra editor process, interactive-editor connection,
background project scan, edits, rename, code actions, formatting, or commands.

## Setup

Install the shared MessagePack dependency, then run **`/reload`**:

```sh
npm --prefix ~/.pi/agent/extensions/nvim-service ci --ignore-scripts
```

Requires Node.js 22.19+, Neovim 0.11+ (tested with 0.12.5), and enabled/configured
LSP servers in your Neovim configuration. `/nvim-service` shows service status.
This extension does not install servers or parsers. It works without the
`nvim-diagnostics` extension being enabled; both consumers reuse the service's
client library and buffer cache.

## Tools

### `nvim_navigate`

```json
{"file":"src/main.ts","line":12,"column":18,"kind":"definition"}
```

`kind`: `definition`, `declaration`, `type_definition`, `implementation`, or
`references`. References include declarations by default; set
`includeDeclaration: false` to exclude them. Results may be in other files,
dependencies, or non-file URI schemes. Locations and LocationLinks are supported.

### `nvim_hover`

```json
{"file":"src/main.ts","line":12,"column":18}
```

Returns each supporting server's hover text: inferred types, signatures, or
API documentation. Markdown, plaintext, and legacy MarkedString responses are
preserved as untrusted text, not rendered/executed commands. This is LSP hover,
not a separate signature-help/active-argument or runtime-value inspection API.

### `nvim_symbols`

```json
{"file":"src/main.ts"}
{"file":"src/main.ts","scope":"document","query":"parse"}
{"file":"src/main.ts","scope":"workspace","query":"Parser"}
```

- `document` (default): a flattened symbol outline with container names, kinds,
  selection ranges, and full declaration ranges where supplied. An optional
  query filters names by case-insensitive substring (Lua's case folding).
- `workspace`: query **only the clients attached to the explicit anchor file**,
  whose project roots are included in the response. A nonempty query is required;
  matching behavior is server-defined. Does not search every running server or
  recurse through the filesystem. URI-only workspace results remain unresolved;
  no guessed ranges or automatic `workspaceSymbol/resolve` requests.

All tools take `timeoutMs` (default **10000**, range **100–30000**) covering the
whole call, including queuing. Navigation and symbols accept `limit` (default
**100**, range **1–500**) across all providers. There is no pagination; narrow
queries or request a larger limit if results are truncated. Duplicate results
from different providers remain separate to preserve provenance.

Paths are explicit, relative to Pi's current cwd or absolute; no globs or
`@reference :L...` syntax. Inputs must be regular UTF-8 text, at most **2 MiB**.

## Positions and target files

Inputs and normalized `range`/`fullRange` fields use **1-based lines and UTF-8
byte columns**, with **exclusive ends**. Columns refer to Neovim's decoded lines,
not screen cells; UTF-8 BOMs are excluded. Input positions must be on character
boundaries. UTF-8, UTF-16, and UTF-32 LSP encodings are converted per client.

`range` is the precise symbol/selection location; `fullRange`, when supplied,
covers its declaration. You can use these to choose spans for `read_reference`,
but that tool's explicit range ends are **inclusive**, not exclusive. It also
counts raw BOM bytes: add three bytes to first-line columns when referencing a
UTF-8-BOM disk file.

Target files are read directly from disk for conversion, **not loaded into
Neovim or refreshed automatically**. Conversion is bounded to 32 files including
the anchor, with an 8 MiB retained-text budget and a 2 MiB per-file limit. Missing,
oversized, non-UTF-8, budget-exceeded, modified/unverified target buffers, invalid
ranges, non-file URIs, and unsupported line endings/encodings remain explicit.
They keep `uri`, `lspRange`, and `lspFullRange` where available; **raw LSP ranges
are 0-based in the provider's `encoding`**, never silently presented as byte
positions. Non-file URIs are not fetched. Converted LF/CRLF ranges are rechecked
against disk hashes; bare-CR conversion is not guessed.

## What statuses mean

Semantic requests receive explicit LSP responses; unlike diagnostic cache reads,
a valid empty response can be distinguished from no response.

| Status | Meaning |
| --- | --- |
| `ok` | Observed supporting providers answered. Zero matches is a valid response, not proof of absence across the project. |
| `partial` | Some providers answered, but another failed, remained pending/initializing, was omitted, or a deadline interrupted processing. |
| `unsupported` | Observed clients do not advertise the requested method. |
| `no_provider_observed` | No attached LSP was observed within the collection budget. |
| `provider_error` | Requests failed or responses could not be parsed. Individual provider errors are retained. |
| `timed_out` | No completed response before the deadline, including queue/connection time. |
| `invalid_position`, `file_error`, `unsupported_encoding` | The source cannot safely be queried. |
| `buffer_modified`, `buffer_changed`, `buffer_unavailable`, `disk_changed` | A source conflict or race; never forcibly overwrite it. |

Per-provider statuses distinguish `completed`, `empty`, `unsupported`,
`initializing`, `pending`, and `error`. A short 200 ms discovery quiet period
allows late attachment; it does **not** establish universal readiness. Failed
service discovery, identity checks, disconnection, or cancellation fail the tool
call rather than pretending to return zero matches.

All reports declare **best-effort coverage**. `ok` means the observed providers
responded, **not** that every server finished indexing or every dependency is
current. In real vtsls testing, a cold definition request initially returned a
local import alias; a later request resolved the implementation. Follow the
returned location or retry after startup when results seem incomplete.

Only the anchor buffer is refreshed from its disk hash. If other files changed,
check/refresh those explicit files with `nvim_diagnostics` before depending on
cross-file results. Disk hashes verify matching snapshots, not server index
versions. A target's `targetDiskVerified` says its disk snapshots matched;
check `locationStatus` before using its range. Source conflicts can invalidate
otherwise retained provider results.

## Safety and lifecycle

The common client library verifies PID/ownership/socket identity, serializes
requests across semantic and diagnostic consumers, and uses shared leases so
cache eviction cannot unload active buffers. The 128-entry cache unloads only
old tool-owned, hidden, unlisted, unmodified buffers. The historical
`vim.b[buf].pi_nvim_diagnostics_owned` marker remains the shared ownership flag;
mark an adopted buffer listed or clear that flag to protect it.

Existing modified buffers are never replaced. Normal user-configured read/type
hooks still run; this is **not a plugin sandbox**. No tool sends save events,
applies edits, changes the project cwd, replaces global LSP handlers, invokes
UI navigation, or executes server commands. Neovim flushes pending `didChange`
notifications before LSP requests. Only this call's requests are canceled.

Caller cancellation, deadlines, service replacement, and shutdown clean up
request-local work. Lua leases expire one second after the caller's deadline if
RPC disconnects. Idle sockets are unreferenced; no idle polling. Process lifetime
remains the service supervisor's responsibility. OS/filesystem/plugin scheduling
can exceed nominal deadlines; this is not a real-time or sandbox guarantee.

## Output bounds

At most 16 observed providers, the requested item limit, and approximately 1 MiB
of retained response records per call. Symbol traversal is bounded to 10000 nodes
and depth 32. Hover text is capped at 64 KiB/64 parts per provider; long metadata
is clipped. Truncation is explicit; bounds apply to retained output, not the
language server's internal allocations or indexing workload.

Readable output is capped at **16 KiB / 1000 lines**. Larger retrieved reports
are saved as mode-0600 JSON in a private temporary directory, with a path in the
text and `details.fullOutputPath`. Structured inline details omit large item
arrays when spilled. Full retrieved reports cannot restore collection-time
omissions. Temporary reports persist after service shutdown for normal OS temp
retention. All server text, names, and paths are untrusted data.

## Development

Reuse the optional Pi/Node/TypeScript development environment in
`nvim-diagnostics`; the sibling tsconfigs explicitly resolve those typings.
These are development-only, not semantic runtime dependencies.

```sh
npm --prefix extensions/nvim-service ci --ignore-scripts
npm --prefix extensions/nvim-diagnostics ci --ignore-scripts
npm --prefix extensions/nvim-diagnostics run typecheck
node --test --test-timeout=15000 extensions/nvim-semantic/*.test.mjs
node --test --test-timeout=15000 extensions/*/*.test.mjs
```

Tests use disposable services and deterministic LSP fixtures, including actual
Pi loading/restart, shared consumer serialization, Unicode encodings, locations,
hover, symbol hierarchy/search, missing/unsupported/failed providers, edits and
races, cancellation, frozen service deadlines, and bounded/private output.
