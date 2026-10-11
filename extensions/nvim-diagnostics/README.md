# nvim-diagnostics

Lets Pi check files with the language servers and linters of its own Neovim. Requires
[`nvim-service`](../nvim-service/README.md); it has no dependencies or install step of
its own.

## The tool

`nvim_diagnostics({ files, severity?, timeoutMs? })`

- `files`: 1–32 paths, relative to cwd or absolute.
- `severity`: least severe level to list (`error`, `warning`, `info`, `hint`); default
  `warning`. The counts always cover every level.
- `timeoutMs`: how long to wait for the servers; default 10000, at most 60000.

```
src/a.py: 1 error, 1 warning — pyright answered, ruff answered
  4:16 error [reportAssignmentType] Type "str" is not assignable to declared type "int" (Pyright)
  5:8 warning [F401] `os` imported but unused (Ruff)
src/b.ts: no diagnostics — tailwindcss silent, vtsls reported
README.md: 2 warnings — marksman no new report, markdownlint-cli2 linted
  3:1 warning error MD001/heading-increment Heading levels should only increment by one level at a time (markdownlint)
  7:1 warning [2] Link to non-existent document './nope.md' (Marksman)
notes.txt: no language server or linter for this file
src/c.rs: incomplete after 10000 ms: no diagnostics — rust_analyzer starting
```

Lines and byte columns are 1-based. At most 50 diagnostics are listed per file.

## Debugging: `/nvim-diagnostics`

Without arguments it lists the language servers in Pi's Neovim and how each is treated,
followed by the output of the most recent check (what Pi last saw):

```
Language servers in Pi's Neovim:
  pyright (1): pull, answers are definite; 1 buffer; root none
  vtsls (3): push only, given 1000 ms after a change; 1 buffer; root /Users/xsv/project

Last check 12 s ago, took 1552 ms:
src/a.py: 1 error — pyright answered
  ...
```

With paths (`/nvim-diagnostics src/a.py src/b.ts`) it checks them at every severity and
adds a timeline of each sync, request, cancellation, reply and report:

```
Timeline (1552 ms):
   30 ms  a.py: reloaded from disk, document version 6
   63 ms  pyright pull #13 for a.py sent
   72 ms  pyright pull #13 for a.py cancelled by Neovim
  138 ms  vtsls published 0 for b.ts
  168 ms  pyright pull #13 for a.py: reply discarded (cancelled)
  168 ms  pyright pull #16 for a.py sent (attempt 2)
  170 ms  pyright pull #16 for a.py: full, 1 diagnostics
  170 ms  a.py: pyright is answered
  552 ms  vtsls published 1 for b.ts
 1552 ms  b.ts: vtsls is reported
```

Paths are split on whitespace, so the command cannot take a path containing spaces.

## What the statuses mean

| Status | Meaning |
| --- | --- |
| `answered` | The server replied to a diagnostic request for exactly this text. Definite. |
| `reported` | A push-only server published for this text. Best effort. |
| `no new report` | A push-only server published nothing after the last change; its previous report is shown. |
| `silent` | A push-only server has never published anything for this file. |
| `linted` | A linter run through nvim-lint finished for this text. |
| `starting` | The server had not finished initializing by the deadline. |
| `no answer` | A diagnostic request was still pending at the deadline. |
| `still working` | A push-only server was still inside its reporting window or showing progress. |
| `linting` | A linter was still running at the deadline. |
| `failed: …` | The server answered the request with an error. |

A file is `incomplete` only for the last five. `no language server or linter for this
file` means nothing attached to it at all.

A push-only server has no way to say it is finished, and they behave differently: vtsls
and clangd clear a reopened file at once and send the real result later, marksman only
publishes when its answer changes, and tailwindcss outside a Tailwind project never
publishes. So after a change each push server gets a window to report:

- 1.5 times the longest it has taken before in this session (at least 1 s, at most 10 s),
- 2.5 s if it has not reported yet,
- 0.5 s once it has stayed silent through two changes.

It must also have no progress showing and be quiet for 0.3 s. A check that takes a server
unusually long can still be reported too early, so no diagnostics never replaces a build
or a test run.

## How a check works

Everything happens in one Lua call inside Neovim ([`diagnostics.lua`](diagnostics.lua)):

1. A file whose text the servers already have (same file on disk, same buffer contents as
   the last check) is left alone. Its servers' last word still stands, so a repeat check
   costs a few milliseconds.
2. Otherwise the buffer is loaded, or reloaded from disk, and touched with a no-op change
   so the text goes out under a new document version and no server can answer from a
   cache keyed on the old one. A buffer with unsaved changes is checked as it is and
   marked `(unsaved buffer)`; nothing is ever written.
3. Servers that support `textDocument/diagnostic` are asked directly, and only a reply to
   a request that was not cancelled counts. Neovim cancels pending requests whenever it
   refreshes its own, and pyright answers a cancelled request with an empty report, so
   cancelled requests are sent again.
4. For other servers, `publishDiagnostics` is recorded as it arrives.
5. If [nvim-lint](https://github.com/mfussenegger/nvim-lint) is installed, its linters
   are run for the file. By itself it only lints the buffer a person is looking at, so
   markdownlint, hadolint and the like would otherwise never run here.

Neovim's own diagnostic store (`vim.diagnostic.get`) is deliberately not the source for
language servers: it applies those empty replies to cancelled requests, and can then
accept "unchanged" for the text it just cleared. It is the source for linters, which
write nowhere else.

Pi's windows, current buffer and cursor are not touched.

Measured on this machine with Neovim 0.12.6:

| Check | Time |
| --- | --- |
| Unchanged file | a few ms (pull servers are still asked: Python about 35 ms) |
| Changed Python, JSON, CMake (pull servers) | 20–50 ms |
| Changed TypeScript, C, Lua, YAML, shell, Markdown (push servers) | about 1 s |
| First check of a file type in a session | 0.3–3.5 s |

## Development

```sh
node --test --test-timeout=30000 *.test.mjs
../nvim-service/node_modules/.bin/tsc -p .
```

The tests run a real Neovim against [`test/lsp.mjs`](test/lsp.mjs), a scriptable language
server that reproduces the behaviors above. They need `nvim-service`'s dev dependencies
(`npm ci --prefix ../nvim-service`).
