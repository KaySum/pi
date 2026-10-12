# nvim-navigation

Lets Pi follow code by meaning, through the language servers of its own Neovim. Requires
[`nvim-service`](../nvim-service/README.md); it has no dependencies or install step of
its own.

## The tool

`nvim_navigate({ action, file, line?, symbol?, column?, query?, timeoutMs? })`

| Action | Answers | Needs |
| --- | --- | --- |
| `definition` | Where the symbol is defined | `line` and `symbol` or `column` |
| `type` | Where its type is defined | same |
| `implementation` | What implements it | same |
| `declaration` | Where it is declared | same |
| `references` | Everywhere it is used, declaration included | same |
| `hover` | Its type and documentation | same |
| `symbols` | The file's outline, optionally filtered by `query` | — |
| `workspace_symbols` | Symbols across the project whose name matches `query` | `query` |

A symbol is pointed at by its line and its text on that line: `{ line: 3, symbol: "greet" }`
means the first `greet` on line 3. `column` (1-based, in bytes) picks a later occurrence
or replaces `symbol`.

```
4 references for greet — vtsls
src/defs.ts
  8:17  export function greet(name: string): string {
src/main.ts
  1:10  import { greet, FriendlyGreeter } from "./defs";
  3:17  const message = greet("Pi");
  5:41  console.log(message, g.greet("é😀"), greet("x"));
```

```
5 symbols in src/defs.ts — vtsls
  1: interface Greeter
    1: method greet
  3: class FriendlyGreeter
    4: method greet
  8: function greet
```

Every location comes with its source line, so Pi rarely has to open the file to see what
it found. Lines and byte columns are 1-based. At most 100 results are listed.

## What it takes care of

- **The file on disk is what is asked about.** If the buffer no longer matches the file it
  is reloaded, under a new document version, because some servers cache by version (vtsls
  would otherwise return the old outline). A buffer with unsaved changes is used as it
  is, and the answer is marked `(unsaved buffer)`.
- **A server that is still loading is not believed.** One that has just started, or is
  showing progress, is waited for. rust-analyzer answers "nothing" before it has loaded
  the project and only then starts showing progress, so an empty answer from a server
  that started in the last 15 s is asked for again once it has been calm for 0.7 s.
- **A server whose state changed under the request** (it says so with an error) is asked
  again, up to three times.
- **Every server that can answer is asked**, and their answers are merged without
  duplicates. One that failed is named in the header; one that does not support the
  action is left out.

If the header says servers were still loading, the answer may be incomplete: ask again.
An empty result from a server that answered is real.

Measured with Neovim 0.12.6: a question to a running server takes 3–60 ms. The first one
to a server takes as long as it needs to load the project: about 1 s for pyright, 2 s
for vtsls and lua_ls, 4.5 s for rust-analyzer.

## Development

```sh
node --test --test-timeout=40000 *.test.mjs
../nvim-service/node_modules/.bin/tsc -p .
```

The tests run a real Neovim against [`test/lsp.mjs`](test/lsp.mjs), a scriptable language
server. They need `nvim-service`'s dev dependencies (`npm ci --prefix ../nvim-service`).
