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
| `answered` | The server replied to a diagnostic request for this text while idle. What it also published for this text is included. |
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

It must also have no progress showing and be quiet for 0.3 s, and a server that started
less than 5 s ago is not called `silent` yet. A check that takes a server unusually long
can still be reported too early, so no diagnostics never replaces a build or a test run.

A server showing progress (loading a project, running `cargo check`) is never treated as
finished, whichever kind it is. rust-analyzer shows why this matters for request-capable
servers too: it answers with an empty result while its project is still loading.

## How a check works

Everything happens in one Lua call inside Neovim ([`diagnostics.lua`](diagnostics.lua)):

1. A file whose text the servers already have (same file on disk, same buffer contents as
   the last check) is left alone. Its servers' last word still stands, so a repeat check
   costs a few milliseconds.
2. Otherwise the buffer is loaded, or reloaded from disk, and touched with a no-op change
   so the text goes out under a new document version and no server can answer from a
   cache keyed on the old one. A buffer with unsaved changes is checked as it is and
   marked `(unsaved buffer)`; nothing is ever written.
3. Each server is told the file was saved, since the buffer now matches the file. Some
   only do their real checking then: rust-analyzer runs `cargo check` on save.
4. Servers that support `textDocument/diagnostic` are asked directly once they are idle,
   and only a reply to a request that was not cancelled counts. Neovim cancels pending
   requests whenever it refreshes its own, and pyright answers a cancelled request with
   an empty report, so cancelled requests are sent again.
5. `publishDiagnostics` is recorded as it arrives, from every server. rust-analyzer
   answers requests for its own analysis but publishes the compiler's errors.
6. If [nvim-lint](https://github.com/mfussenegger/nvim-lint) is installed, its linters
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
| Unchanged file | a few ms |
| Changed JSON, CMake | 20–60 ms |
| Changed Python (pyright, ruff) | 0.1–0.9 s |
| Changed Rust (rust-analyzer with `cargo check`) | about 0.7 s |
| Changed C, Lua, YAML, shell, Markdown | about 1 s |
| Changed TypeScript (vtsls) | 1.2 s, up to 4 s after it has been slow on a large file |
| First check of a file type in a session | 0.5–6 s |

## Development

```sh
node --test --test-timeout=30000 *.test.mjs
../nvim-service/node_modules/.bin/tsc -p .
```

The tests run a real Neovim against [`test/lsp.mjs`](test/lsp.mjs), a scriptable language
server that reproduces the behaviors above. They need `nvim-service`'s dev dependencies
(`npm ci --prefix ../nvim-service`).
