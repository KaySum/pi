# Headless Neovim LSP for Pi

A read-only `nvim_lsp` tool backed by a **dedicated headless Neovim**, separate from your editor. Uses your normal Neovim config and installed language servers. No npm dependencies.

## Enable

This directory is auto-discovered under `~/.pi/agent/extensions/`. Run `/reload` in Pi, or start a new session.

Requires Neovim **0.11+** on PATH and LSP configuration that works headlessly. The process starts on the first tool call, uses Pi's working directory, persists for subsequent requests, and stops on session shutdown/reload. `/nvim-lsp-restart` stops it so the next call starts fresh.

The existing `nvim_diagnostics` extension is unchanged: that tool reads your **running editor**, including unsaved buffers. `nvim_lsp` reads **disk files** in an independent process.

## Tool examples

```json
{"action":"diagnostics","file":"src/main.ts"}
{"action":"hover","file":"src/main.ts","target":"myFunction","anchor":"const result = myFunction(input);"}
{"action":"definition","file":"lsp_actions_test.py","target":"format_greeting","anchor":"greeting = format_greeting(\"Neovim\")"}
{"action":"references","file":"src/main.ts","target":"uniqueSymbolName"}
{"action":"symbols","file":"src/main.ts"}
{"action":"workspace_symbols","file":"src/main.ts","query":"User"}
```

- **Prefer text targeting** for hover, definition and references. Copy `target` and optional `anchor` from the file. Both are exact, case-sensitive, single-line literal text, not regex. The tool finds target occurrences entirely contained within the anchor (or anywhere in the file if omitted) and calculates byte coordinates itself. Exactly one occurrence must qualify. Repeated anchors or repeated targets within an anchor are rejected if multiple positions qualify; up to 10 candidates with source snippets are returned. Zero matches also fail, without querying the LSP. Matching is textual, not language-aware: choose enough context to avoid comments or similarly named symbols.
- Advanced alternative: provide **all three** of `line`, `column`, and `expected_text`. Positions are **1-based lines and byte columns**, as in Neovim. The byte position must fall within a literal occurrence of `expected_text`. Mismatches fail with the source line and candidate locations. **Bare coordinates are no longer accepted.** Do not mix this mode with `target`/`anchor`.
- Positional responses include `position.line`, `position.column`, `position.sourceLine`, and `position.expected_text`, plus the target/anchor when used—even when the LSP returns `null`. The tool never guesses among multiple locations; callers must disambiguate.
- Navigation, symbol and hover results preserve LSP structure: ranges are **0-based** in the reported client's `positionEncoding` (typically UTF-16). Definition responses may contain `LocationLink` objects.
- Diagnostic cache entries use **1-based lines and byte columns**. Pull diagnostic responses, when supported, appear separately under `results` with raw LSP ranges.
- `file` is always required; it chooses the project/server for workspace symbol searches.
- `limit` defaults to 100, maximum 500; applies to top-level lists, not nested symbol trees. Model output is capped at 30,000 characters; oversized full responses are saved in a private temporary directory and the path is returned.
- `timeout_ms` defaults to 8000 (maximum 15000), separately for LSP attachment and requests. Startup has a separate 15-second deadline. Servers may need another request after initial indexing.
- Diagnostics additionally wait `wait_ms` (default 1000, maximum 5000) for push updates. There is no universal push-diagnostics completion signal: **empty results are not proof of a clean file**. Unopened files are not checked. Keep running project tests/typecheckers.

## Configuration

Set environment variables **before starting Pi**:

```sh
PI_NVIM_LSP_BIN=/path/to/nvim pi
PI_NVIM_LSP_INIT=/absolute/path/to/minimal-init.lua pi
```

By default your normal init.lua is used, so its plugins, configuration code, and language servers run with your user permissions. This is not a sandbox. No formatting, rename, code-action or save operations are exposed, but user plugins can still have their own side effects.

The child has `PI_NVIM_LSP=1`, so your config can skip UI-only plugins and update checks. It does not inherit `NVIM` or `NVIM_LISTEN_ADDRESS`. Swap, undo persistence and ShaDa are disabled on startup; project exrc is disabled before init (your config can override options). Socket files are private and cleaned up on shutdown. Requests are serialized, and cancellation or RPC errors discard the headless instance before reuse.

For a minimal config on Neovim 0.11+:

```lua
vim.lsp.config('my_server', {
  cmd = { '/absolute/path/to/language-server', '--stdio' },
  filetypes = { 'your_filetype' },
  root_markers = { '.git' },
})
vim.lsp.enable('my_server')
```

If no server attaches, verify filetype detection, server installation, root markers and headless compatibility. The extension does not install servers or scan/open the whole workspace.

## Tests

```sh
node --test extensions/nvim-lsp/bridge.test.mjs
```

Integration tests launch real Neovim with an isolated init and a deterministic mock LSP, without loading your personal plugins. Covers startup/shutdown, process reuse, concurrent-call serialization, diagnostics and disk reload, UTF-16 conversion, navigation, symbols, quoting, cancellation, failures and output limits.
