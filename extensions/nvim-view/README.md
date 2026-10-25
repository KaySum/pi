# nvim-view

What you see in the Neovim Pi runs inside, and only that: the current tab's splits and the
windows in them (what part of which buffer each shows, in how much room), the buffers they
show (their sizes, whether they're modified, which language servers they have), what has
focus and which window is yours. Other tabs' windows and hidden buffers aren't on screen, so
they aren't in it. Other extensions build on it: anything that depends on the layout, on
what's on screen, or on how big a shown buffer is. It registers no tools. Built on [nvim-remote](../nvim-remote/README.md), and
needs no install.

## For you

`/nvim-view` shows what it gives extensions, readably:

```
Editor 212×58, mode n, cwd ~/Code/app
Tab 1 of 2: [[#1000 / #1002] | #1001]
  #1000 normal src/app.ts  120×40 at 1,1, text 115  lines 40–84 of 812 in 40 rows, folded 51–56  cursor 63:4  [yours, previous]
  #1002 quickfix [No Name]  120×10 at 42,1, text 120  lines 1–10 of 23 in 10 rows  cursor 1:0
  #1001 terminal Pi  91×52 at 1,122, text 91  lines 1–52 of 52 in 52 rows  cursor 52:2  [focused]
Buffers shown: 3
  #1 src/app.ts  typescript  812 lines, 24.1 KB  in #1000  lsp tsserver
  ...
Views sent: 132; the last took 0.21 ms to make
```

`/nvim-view-json` shows exactly what they get, as JSON.

## For other extensions

```ts
import { bufferOf, isShown, useView, windowOf } from '../nvim-view/api.ts';

export default function (pi) {
  const view = useView(pi, v => { /* every change: a new view */ });
  pi.on('tool_result', async () => {
    const v = view();              // The latest, at once; undefined while not attached.
    const yours = windowOf(v, v?.you); // Undefined too, then.
    const fresh = await view.refresh(); // One made now, cursor and all.
    if (isShown(yours, 42)) { /* Line 42 is on screen, not folded away. */ }
  });
}
```

A view is plain data. `windowOf(view, id)`, `bufferOf(view, id)` and `bufferFor(view, path)`
find a window or buffer in it, or give undefined for no view. `isShown(win, line)` says whether a line's text is on screen, `shownLine(win, line)` gives where (the fold hiding it, if one is), and `lineAtRow(win, row)` which line is at a screen row. `refresh()` makes a view now:
one that's new goes to every extension, as if sent by itself. The same view is on `pi.events`: `nvim-view:changed` (the
view), `nvim-view:stopped`, and `nvim-view:get` with `{ reply }`.

| View | |
| --- | --- |
| `editor` | `columns` × `lines`, `cmdheight`, `mode` (as `mode()` gives it) and `blocking` (waiting at a prompt), the global `cwd`, and `focused`: whether the terminal it runs in has focus, once it has said (for terminals that report it). |
| `focus` | The current `tab`, `win` and `buf`, and the `previous` window (`#`): the one the user came from. |
| `you` | The user's window: the focused one unless it's Pi's terminal or another like it, else the one they came from, else any showing a file. The place to show something to the user. |
| `pi` | Pi's terminal `buf` and the `windows` showing it, if it's on screen. |
| `tabs` | Each tab's `id` and `number`, and which is `focused`: what the tabline names. Only the current tab's windows are on screen. |
| `layout` | The current tab's splits, as a tree of `{ split: 'row' \| 'col', children }` (side by side, stacked) with `{ win }` leaves. |
| `windows` | The windows on screen: the current tab's, floats included but those configured hidden. Each one's `id`, `number`, `buf`, and `kind`: `normal` (a file), `float`, `terminal`, `help`, `quickfix`, `loclist`, `nofile`, `prompt`… Its screen position (`row`, `col`, 1-based) and size (`width`, `height`); `textWidth`, the room for text, and `textOff`, what the number, sign and fold columns take; what it shows (`topline`–`botline`, even a line shown only in part, as a long line wrapped at the bottom; `leftcol`, `skipcol`), the `rows` those lines take once wrapped (the rest are empty), and `shown`, each of them top to bottom: its `line`, the screen `row` its text starts on, the `rows` it takes, and for a closed fold, the last line it hides (`fold`); and its `cursor` (1-based line, 0-based byte) and `screenCursor` (where it is on the screen). Its `cwd`; `float` (`relative`, `zindex`, `focusable`, `border`) for a float; `options` that change what it shows (`wrap`, `number`, `relativenumber`, `signcolumn`, `foldcolumn`, `cursorline`, `scrolloff`, `sidescrolloff`, `list`, `diff`, `spell`, `conceallevel`, `colorcolumn`). `focused`, `previous` and `pi` mark those. |
| `buffers` | Each buffer's `id`, `name` (its file's absolute path), `filetype`, `buftype`, whether `listed`, `loaded`, `modified`, `readonly`, `modifiable`; for a loaded one its size, in `lines` and `bytes`; its `changedtick` (up with every change), the `windows` on screen showing it, and the names of the language servers attached (`lsp`). Only the buffers shown: a hidden one, however modified, isn't on screen. |

### When views come

Whenever what you see changes: windows opened, closed, entered, resized or scrolled; buffers
shown, edited, written, modified or retyped; tabs; the editor resized; the mode; the
directory; terminals; text changed; the cursor moved; options set; language servers attaching;
the terminal's focus. Some changes fire no event at all: a float changed, a cursor moved in a
window that isn't current, a shown buffer edited while another is current, a fold opened or
closed, virtual lines added, all by plugins through the API. Those are seen once the editor is
idle, by a quick look (a few microseconds) at what's on screen. Changes to what isn't on
screen send nothing.

A view goes as soon as the editor is free after a change, so a burst (a split opening fires
half a dozen events) makes one, and while changes keep coming (typing, scrolling) one goes
every 30 ms at most, none held back longer.

A view takes about 0.2 ms to make with four full windows on screen, some 2 µs a line shown,
and what isn't on screen costs nothing: other tabs and hidden buffers, however many, aren't
looked at.

## Development

```sh
node --test --test-timeout=20000 *.test.ts
../nvim-service/node_modules/.bin/tsc -p tsconfig.json
```

The tests run their own headless Neovim, never the one they might be started from.
