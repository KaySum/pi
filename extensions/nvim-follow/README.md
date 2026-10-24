# nvim-follow

Watch Pi work: with following on, every file Pi edits or writes (and, if you like, reads)
opens in the Neovim Pi runs inside, at the lines it changed, which flash briefly. Pi keeps focus. Built on
[nvim-remote](../nvim-remote/README.md), and needs no install.

| `/follow`   |                                                                   |
| ----------- | ----------------------------------------------------------------- |
| `on`        | Follow what Pi edits and writes.                                  |
| `all`       | Follow what it reads as well.                                     |
| `off`       | Stop following.                                                   |
| _(nothing)_ | Switch off, or back to whichever of `on` and `all` was last used. |

The options are offered as completions after `/follow`. It starts off, and keeps its
setting across `/reload` and session switches until Pi exits. While following and attached,
the status bar shows `following edits` or `following all` (status key `nvim-follow`).

## What it does

- **Where:** the cursor goes to the character where a change starts, and only the lines that
  changed flash. An edit is shown from the patch Pi's edit tool returns with it: Pi's own diff
  of the file it wrote, so a new text that also occurs elsewhere, a loose match, other line
  endings or a byte order mark are all placed as Pi placed them, and no file is read. (From an
  edit tool that returns no patch, its first changed line, else just the file.) A write is
  compared with the file as it was before it, read then; a new file is shown at its top.
- **View:** center the complete diff when it fits, counting removed virtual lines and wrapped
  text as screen rows. Otherwise, prefer the view showing the most changed rows, centering
  that region rather than the unchanged gap between distant edits. The cursor stays on the
  first change when possible, or moves to a change in the chosen view. `scrolloff` is kept;
  large virtual blocks and partial wrapped rows are handled best-effort.
- **Window:** one already showing the file; else the one you came from; else another normal
  window in the tab. The window you are in is used only in normal mode, and only when there
  is no other, so it is never taken while you type. Terminals, help and floating windows
  never are. With none to use, nothing happens.
- **What it leaves alone:** a buffer with unsaved changes is not reloaded over your work;
  your jumplist and alternate file stay yours, so `<C-o>` and `<C-^>` still go where you
  went.
- **Reads:** a read is shown at the lines it asked for (`offset` and `limit`); one of a whole
  file just opens it. Image reads and failed ones are not shown.
- **Highlight:** the changed lines flash for 1.5 s in `PiFollow`, linked to `DiffAdd`, and
  the lines read in `PiFollowRead`, linked to `Visual`, unless you define them. Pure deletions
  show the removed text as temporary virtual lines with its original indentation, in `PiFollowDelete`.
  Their background fills the code area, including for blank lines, using the widest window
  currently showing the buffer; padding is recalculated on the next follow.
  They use `DiffDelete` by default and sit above their former boundary or below the last line at EOF.
  Every replacement shows its old lines above the highlighted new lines, whether the block
  shrinks, grows, or stays the same size, including single-line edits. Writes show the old
  block between the common start and end, just like their added-code highlight. For pure deletions, the
  surviving line is not highlighted; the cursor stays at the deletion boundary. Highlights
  and virtual lines still showing when Pi detaches go with it.

Pi never waits on the editor: a busy or prompting one just misses a step.

## Development

```sh
node --test --test-timeout=20000 *.test.ts
../nvim-service/node_modules/.bin/tsc -p tsconfig.json
```

The tests run their own headless Neovim, never the one they might be started from.
