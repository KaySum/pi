# nvim-follow

Watch Pi work: with following on, every file Pi edits or writes (and, if you like, reads)
opens in the Neovim Pi runs inside, at the lines it changed, which flash briefly. Pi keeps focus. Built on
[nvim-remote](../nvim-remote/README.md), and needs no install.

| `/follow` | |
| --- | --- |
| `on` | Follow what Pi edits and writes. |
| `all` | Follow what it reads as well. |
| `off` | Stop following. |
| *(nothing)* | Switch off, or back to whichever of `on` and `all` was last used. |

The options are offered as completions after `/follow `. It starts off, and keeps its
setting across `/reload` and session switches until Pi exits. While following and attached,
the status bar shows `following edits` or `following all` (status key `nvim-follow`).

## What it does

- **Where:** the cursor goes to the character where a change starts, and only the lines that
  changed flash: the context Pi's edits carry to be unique is left out. An edit is found from
  where its old text was before the change, so a new text that also occurs elsewhere does not
  mislead; one the tool matched loosely (other whitespace or line endings) is placed by its new
  text, if that occurs once. A write is shown at what it changed, a new file at its top. An
  added or removed line that could be placed several ways is placed at a line start, as diff
  tools do.
- **Window:** one already showing the file; else the one you came from; else another normal
  window in the tab. The window you are in is used only in normal mode, and only when there
  is no other, so it is never taken while you type. Terminals, help and floating windows
  never are. With none to use, nothing happens.
- **What it leaves alone:** a buffer with unsaved changes is not reloaded over your work;
  your jumplist and alternate file stay yours, so `<C-o>` and `<C-^>` still go where you
  went.
- **Reads:** a read is shown at the lines it asked for (`offset` and `limit`); one of a whole
  file just opens it. Image reads and failed ones are not shown.
- **Highlight:** the changed lines flash for 1.5 s in `PiFollow`, linked to `IncSearch`, and
  the lines read in `PiFollowRead`, linked to `Visual`, unless you define them. A highlight
  still showing when Pi detaches goes with it.

Pi never waits on the editor: a busy or prompting one just misses a step.

## Development

```sh
node --test --test-timeout=20000 *.test.ts
../nvim-service/node_modules/.bin/tsc -p tsconfig.json
```

The tests run their own headless Neovim, never the one they might be started from.
