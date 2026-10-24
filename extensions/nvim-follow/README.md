# nvim-follow

Watch Pi work: with following on, every file Pi edits or writes opens in the Neovim Pi runs
inside, at the lines it changed, which flash briefly. Pi keeps focus. Built on
[nvim-remote](../nvim-remote/README.md), and needs no install.

`/follow` toggles it, `/follow on` and `/follow off` set it. It starts off, and keeps its
setting across `/reload` and session switches until Pi exits. While it is on and Pi is
attached, the status bar shows `following` (status key `nvim-follow`).

## What it does

- **Where:** an edit is shown where it landed: found from where its old text was before the
  change, so a new text that also occurs elsewhere does not mislead. An edit the tool matched
  loosely (other whitespace or line endings) is placed by its new text, if that occurs once.
  A write is shown at the lines it changed; a new file at its top.
- **Window:** one already showing the file; else the one you came from; else another normal
  window in the tab. The window you are in is used only in normal mode, and only when there
  is no other, so it is never taken while you type. Terminals, help and floating windows
  never are. With none to use, nothing happens.
- **What it leaves alone:** a buffer with unsaved changes is not reloaded over your work;
  your jumplist and alternate file stay yours, so `<C-o>` and `<C-^>` still go where you
  went.
- **Highlight:** the changed lines flash for 1.5 s in `PiFollow`, linked to `IncSearch`
  unless you define it. A highlight still showing when Pi detaches goes with it.

Pi never waits on the editor: a busy or prompting one just misses a step.

## Development

```sh
node --test --test-timeout=20000 *.test.ts
../nvim-service/node_modules/.bin/tsc -p tsconfig.json
```

The tests run their own headless Neovim, never the one they might be started from.
