# nvim-diagnostics

Lets Pi check files with the language servers of its own Neovim. Requires
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
src/b.ts: no diagnostics — vtsls reported
notes.txt: no language server attached
src/c.rs: incomplete after 10000 ms: no diagnostics — rust_analyzer starting
```

Lines and byte columns are 1-based. At most 50 diagnostics are listed per file.

## What the server statuses mean

| Status | Meaning |
| --- | --- |
| `answered` | The server replied to a diagnostic request for exactly this text. Definite. |
| `reported` | A push-only server published for this text and then went quiet. Best effort. |
| `starting` | The server had not finished initializing by the deadline. |
| `silent` | A push-only server published nothing for this text. |
| `no answer` | A diagnostic request was still pending at the deadline. |
| `still working` | A push-only server was still publishing or showing progress. |
| `failed: …` | The server answered the request with an error. |

A file is `incomplete` unless every attached server is `answered` or `reported`.

A push-only server has no way to say it is finished. vtsls, for example, clears a file's
diagnostics at once and sends the real ones about half a second later. The tool waits for
at least one second of quiet, twice the longest pause it has seen from that server (up to
five seconds), and for any progress the server shows to end. A check that takes a server
unusually long can still be reported too early, so no diagnostics never replaces a build
or a test run.

## How a check works

Everything happens in one Lua call inside Neovim ([`diagnostics.lua`](diagnostics.lua)):

1. Each file's buffer is loaded, or reloaded from disk if it has no unsaved changes, and
   then touched with a no-op change. The server therefore sees the current text under a
   new document version, cannot answer from a cache keyed on an old one, and has to
   report again. A buffer with unsaved changes is checked as it is and marked
   `(unsaved buffer)`; nothing is ever written.
2. Servers that support `textDocument/diagnostic` are asked directly, and only a reply to
   a request that was not cancelled counts. Neovim cancels pending requests whenever it
   refreshes its own, and pyright answers a cancelled request with an empty report, so
   cancelled requests are sent again.
3. For other servers, `publishDiagnostics` is observed. Reports labelled with an older
   document version are ignored.

Neovim's own diagnostic store (`vim.diagnostic.get`) is deliberately not the source: it
applies those empty replies to cancelled requests, and can then accept "unchanged" for
the text it just cleared.

Pi's windows, current buffer and cursor are not touched.

Measured on this machine with Neovim 0.12.6: a Python file with pyright and ruff takes
about 0.1 s, a TypeScript file with vtsls 1.1–1.7 s, and the first check after startup
about 2.4 s.

## Development

```sh
node --test --test-timeout=30000 *.test.mjs
../nvim-service/node_modules/.bin/tsc -p .
```

The tests run a real Neovim against [`test/lsp.mjs`](test/lsp.mjs), a scriptable language
server that reproduces the behaviors above. They need `nvim-service`'s dev dependencies
(`npm ci --prefix ../nvim-service`).
