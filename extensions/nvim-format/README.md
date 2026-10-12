# nvim-format

Lets Pi format files the way your editor would: with the formatters its own Neovim is
configured with for each file type. Requires
[`nvim-service`](../nvim-service/README.md); it has no dependencies or install step of
its own.

## The tool

`nvim_format({ files, timeoutMs? })`

- `files`: 1–32 paths, relative to cwd or absolute.
- `timeoutMs`: how long all the files together may take; default 10000, at most 60000.
  A file whose formatting finishes later than that is not written.

```
src/a.lua: formatted, lines 1-2, 14 changed — stylua
src/b.ts: already formatted — prettier
src/c.py: formatted, lines 2-5 changed — ruff
notes.txt: no formatter for this file
src/d.lua: failed: Formatter 'stylua' error: … unexpected token `=` (1:9 to 1:10) — stylua
vendor/e.lua: not formatted: the file is read-only
```

The lines are those of the file as it is now, so Pi knows where what it last read no
longer holds. The file's bytes are compared, so a change of line endings or of the final
newline counts. At most 12 ranges are listed per file.

Pi calls it when it has finished editing, not after every edit: its edits match text
exactly, and a file reformatted in between would no longer contain what it expects.

`/nvim-format` shows what the last call returned; `/nvim-format src/a.lua src/b.ts`
formats those files. Paths are split on whitespace, so the command cannot take a path
containing spaces.

## What does the formatting

- With [conform.nvim](https://github.com/stevearc/conform.nvim) installed, whatever
  `conform.format()` would run for the buffer, with your options: the formatters of
  `formatters_by_ft`, and the language servers where `lsp_format` says so (LazyVim sets
  `fallback`, so a server formats what has no formatter of its own).
- Without it, each of the file's language servers that can format, in turn.

Format-on-save settings (`vim.g.autoformat` and the like) are not consulted: this is an
explicit request, not a save.

## What it takes care of

- **The file on disk is what is formatted.** A buffer that no longer matches its file is
  reloaded first. One with unsaved changes is refused, since writing it would put those
  changes into the file along with the formatting.
- **Nothing is half done.** If a formatter fails, or a language server answers with an
  error or not at all, the buffer is put back and the file is not written, whatever an
  earlier formatter in the chain had already done. Syntax errors are the usual cause, and
  the formatter's message says where. conform reports a server's error without its
  message, so that server is asked once more for what it said.
- **Language servers are waited for.** When only a server can format the file, one that
  is still starting is waited for, and a file just loaded is given 0.3 s for its server
  to attach (2 s the first time a file type is seen). So the first `no formatter for
  this file` of a file type takes 2 s.
- **Language-server formatting gets the right file.** Both conform and Neovim build the
  request from the current buffer, whichever buffer they were given, so each file is
  made current for the call. Pi's windows and cursor are not touched.
- **Read-only files are refused up front.** With `confirm` set, as LazyVim has it,
  writing one would stop the editor at a dialog.
- **The write runs no autocommands**, so format-on-save does not format a second time.
  [`nvim-diagnostics`](../nvim-diagnostics/README.md) notices the new text by itself at
  its next check.

Formatted files stay loaded, so their servers keep their state.

Cancelling a call stops Pi waiting, not Neovim working: the call runs to its end inside
the editor, so files may still be formatted and written after it.

`already formatted` means the formatter had nothing to change, not that the file parses:
ruff's language server answers a Python file with a syntax error with no edits and no
error. [`nvim-diagnostics`](../nvim-diagnostics/README.md) is what finds those.

Measured on this machine with Neovim 0.12.6 and files already loaded: 20–60 ms a file
for stylua, prettier, shfmt and ruff. The first file of a type in a session takes as long
as its formatter or server needs to start, up to a few seconds.

## Development

```sh
node --test --test-timeout=40000 *.test.mjs
../nvim-service/node_modules/.bin/tsc -p .
```

The tests run a real Neovim with a stand-in for conform and a language server written in
Lua inside it. They need `nvim-service`'s dev dependencies
(`npm ci --prefix ../nvim-service`).
