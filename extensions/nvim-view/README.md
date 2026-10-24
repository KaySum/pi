# nvim-view

What you see in the Neovim Pi runs inside: its tabs and splits, the windows in them (what
part of which buffer each shows, in how much room), the buffers (their sizes, whether they're
modified, which language servers they have), what has focus and which window is yours. Other
extensions build on it: anything that depends on the layout, on what's on screen, or on how
big a buffer is. It registers no tools. Built on [nvim-remote](../nvim-remote/README.md), and
needs no install.

## For you

`/nvim-view` shows what it gives extensions, readably:

```
Editor 212×58, mode n, cwd ~/Code/app
Tab 1 (focused): [[#1000 / #1002] | #1001]
  #1000 normal src/app.ts  120×40 at 1,1, text 115  lines 40–79 of 812  cursor 63:4  [yours, previous]
  #1002 quickfix [No Name]  120×10 at 42,1, text 120  lines 1–10 of 23  cursor 1:0
  #1001 terminal Pi  91×52 at 1,122, text 91  lines 1–52 of 52  cursor 52:2  [focused]
Buffers: 3 shown, 41 unlisted and unseen left out
  #1 src/app.ts  typescript  812 lines, 24.1 KB  in #1000  lsp tsserver
  ...
Views sent: 132; the last took 0.21 ms to make
```

`/nvim-view-json` shows exactly what they get, as JSON.

## For other extensions

```ts
import { bufferOf, useView, windowOf } from '../nvim-view/api.ts';

export default function (pi) {
  const view = useView(pi, v => { /* every change: a new view */ });
  pi.on('tool_result', async () => {
    const v = view();              // The latest, at once; undefined while not attached.
    const yours = windowOf(v, v?.you); // Undefined too, then.
    const fresh = await view.refresh(); // One made now, cursor and all.
  });
}
```

A view is plain data. `windowOf(view, id)`, `bufferOf(view, id)` and `bufferFor(view, path)`
find a window or buffer in it, or give undefined for no view. `refresh()` makes a view now:
one that's new goes to every extension, as if sent by itself. The same view is on `pi.events`: `nvim-view:changed` (the
view), `nvim-view:stopped`, and `nvim-view:get` with `{ reply }`.

| View | |
| --- | --- |
| `editor` | `columns` × `lines`, `cmdheight`, `mode` (as `mode()` gives it) and `blocking` (waiting at a prompt), the global `cwd`, and `focused`: whether the terminal it runs in has focus, once it has said (for terminals that report it). |
| `focus` | The current `tab`, `win` and `buf`, and the `previous` window (`#`): the one the user came from. |
| `you` | The user's window: the focused one unless it's Pi's terminal or another like it, else the one they came from, else any showing a file. The place to show something to the user. |
| `pi` | Pi's terminal `buf` and the `windows` showing it, if Pi runs in one of the editor's. |
| `tabs` | Each tab's `id`, `number`, its `windows`, and its `layout`: the splits, as a tree of `{ split: 'row' \| 'col', children }` (side by side, stacked) with `{ win }` leaves. |
| `windows` | Each window's `id`, `number`, `tab`, `buf`, and `kind`: `normal` (a file), `float`, `terminal`, `help`, `quickfix`, `loclist`, `nofile`, `prompt`… Its screen position (`row`, `col`, 1-based) and size (`width`, `height`); `textWidth`, the room for text, and `textOff`, what the number, sign and fold columns take; what it shows (`topline`–`botline`, `leftcol`, `skipcol`) and its `cursor` (1-based line, 0-based byte). Its `cwd`; `float` (`relative`, `zindex`, `focusable`, `border`) for a float; `options` that change what it shows (`wrap`, `number`, `relativenumber`, `signcolumn`, `foldcolumn`, `cursorline`, `scrolloff`, `sidescrolloff`, `list`, `diff`, `spell`, `conceallevel`, `colorcolumn`). `focused`, `previous` and `pi` mark those. |
| `buffers` | Each buffer's `id`, `name` (its file's absolute path), `filetype`, `buftype`, whether `listed`, `loaded`, `modified`, `readonly`, `modifiable`; for a loaded one its size, in `lines` and `bytes`; its `changedtick` (up with every change), the `windows` showing it in any tab, and the names of the language servers attached (`lsp`). Listed buffers, buffers shown, and Pi's terminal: unlisted ones no one sees (plugins' scratch buffers) are left out, and counted in `omitted`. |

### When views come

Whenever what you see changes: windows opened, closed, entered, resized or scrolled; buffers
entered, added, deleted, written, modified or retyped; tabs; the editor resized; the mode;
the directory; terminals; text changed; the cursor moved; options set; language servers
attaching; the terminal's focus. Some changes fire no event at all: a float changed, a
cursor moved in a window that isn't current, a buffer edited or unloaded while unseen, all
by plugins through the API. Those are seen once the editor is idle, by a quick look (a few
microseconds) at what they change. Changes are gathered for 30 ms, so a burst (a split opening
fires half a dozen) makes one view, and a view the same as the last isn't sent at all.

A view takes about 0.1 ms to make with a few windows, and under 0.5 ms with 17 windows in 6
tabs, 66 buffers and 400 more left out. With few windows it's a few kilobytes.

## Development

```sh
node --test --test-timeout=20000 *.test.ts
../nvim-service/node_modules/.bin/tsc -p tsconfig.json
```

The tests run their own headless Neovim, never the one they might be started from.
