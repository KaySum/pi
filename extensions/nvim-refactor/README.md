# nvim-refactor

Lets Pi change code the way your editor would: rename a symbol everywhere it is used, and
apply the quick fixes and refactorings its language servers offer. Requires
[`nvim-service`](../nvim-service/README.md); it has no dependencies or install step of
its own.

## The tool

`nvim_refactor({ action, file, line?, symbol?, column?, endLine?, newName?, title?, kind?, timeoutMs? })`

| Action | Does | Needs |
| --- | --- | --- |
| `rename` | Renames the symbol in every file that uses it | `line`, `symbol` or `column`, `newName` |
| `actions` | Lists the code actions offered for a place | — |
| `apply` | Carries one of them out | `title` or `kind` |

A symbol is pointed at as in [`nvim-navigation`](../nvim-navigation/README.md): by its
line and its text on that line, with `column` (1-based, in bytes) to pick a later
occurrence. For `actions` and `apply` the place may also be

- nothing: the whole file, which is where file-wide actions are asked for;
- a `line`: all of it, which is what a quick fix for a diagnostic there needs;
- a `line` and `symbol`: that text, which may be an expression to extract;
- a `line` and `endLine`: those lines, whole.

```
Renamed FriendlyGreeter to Greeter in 2 files — vtsls
src/defs.ts: lines 4 changed
src/main.ts: lines 1, 5 changed
```

```
7 code actions for src/main.ts:5 — vtsls
  Update import from "./defs"  [quickfix]
  Remove unused declaration for: 'g'  [quickfix]
  Extract to constant in enclosing scope  [refactor.extract.constant]
  …
  +14 that cannot be applied here
```

```
Applied "Update import from "./defs"" in 1 file — vtsls
src/main.ts: lines 1 changed
```

`apply` takes the title as `actions` listed it, or any part of it that only one action
has; case does not matter. `kind` narrows both to a kind and those under it
(`quickfix`, `refactor.extract`, `source`), and is enough by itself when one action is
left: `{ action: "apply", file, kind: "source.organizeImports" }`. Some servers only
offer their `source` actions when asked for that kind. When no single action is meant,
nothing is applied and the candidates come back as the error.

The lines are those of the files as they are now, so Pi knows where what it last read no
longer holds. At most 12 ranges are listed per file, and 50 actions.

`/nvim-refactor` shows what the last call returned; `/nvim-refactor rename src/a.ts 3
greet welcome`, `actions src/a.ts [3]` and `apply src/a.ts [3] <title>` make one.

## What it takes care of

- **The files on disk are what is changed.** Every loaded buffer that no longer matches
  its file is reloaded first, since a server answers from the buffers it has open. One
  with unsaved changes is left as it is, and a change that would touch it is refused.
- **All of it or none.** Nothing is written until every edit has been applied and every
  file is known to be writable; otherwise the buffers are put back. An edit the server
  made for another version of a file than the one it now has is not applied, and the
  server is asked again. The exception is an edit that creates, renames or deletes
  files: Neovim does that on disk as it goes.
- **Nothing outside the project.** An edit that reaches a file outside Pi's working
  directory and the server's own workspace is refused.
- **A server that is loading is not asked**, and its answer is dropped if it began
  loading meanwhile, as in [`nvim-format`](../nvim-format/README.md): rust-analyzer
  answers about the files as they were before a scan. Requests are made again up to four
  more times, 0.3 s apart, within the time allowed.
- **Quick fixes are told of the diagnostics**, the ones Neovim holds for those lines,
  from every source. So [`nvim-diagnostics`](../nvim-diagnostics/README.md) comes first:
  it is what makes the servers report on the file as it is now.
- **Actions are resolved and their commands run.** A command a plugin defines in the
  editor runs there; any other is sent to the server, whose edits are then written too.
- **The write runs no autocommands**, so format-on-save does not reformat files that
  were only renamed in. Changed files stay loaded.

## What it cannot know

A rename is as complete as the server's picture of the project, and a server does not
say when that picture is partial.

- clangd without a `compile_commands.json` has no index: it renames within the file
  asked about, leaves the header and the other sources alone, and reports success.
- TypeScript, asked to rename an imported name where it is used, keeps the export and
  writes `import { greet as welcome }`. Pointed at the definition, it renames everywhere.

So the files listed are worth a glance, and `nvim_diagnostics` on them afterwards shows
what a partial rename broke.

Cancelling a call stops Pi waiting, not Neovim working: the call runs to its end inside
the editor, so files may still be changed after it.

Tried on this machine with Neovim 0.12.6 against vtsls, rust-analyzer, pyright, ruff,
lua_ls and clangd: mostly under 0.2 s a request once a server is up, and as long as the
server takes to load for the first one.

## Development

```sh
node --test --test-timeout=40000 *.test.mjs
../nvim-service/node_modules/.bin/tsc -p .
```

The tests run a real Neovim with a language server written in Lua inside it. They need
`nvim-service`'s dev dependencies (`npm ci --prefix ../nvim-service`).
