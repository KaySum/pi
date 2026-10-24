# nvim-virtual-text

Lets other extensions put virtual text and highlights in the Neovim Pi runs inside. Notes can
go at the end of a line, at the window's edge, at a fixed screen column, over or between
characters, or as lines of their own above or below, wrapped and indented to fit the code.
They can also highlight lines or characters and put signs in the gutter, in any highlight
group or a style of their own. It only draws: opening files, moving the cursor and scrolling
are for others. Built on [nvim-remote](../nvim-remote/README.md),
and needs no install.

## For you

`/virtual-text clear` removes every mark Pi placed. They all go anyway when Pi detaches.

The default highlights are linked, unless you define them: `PiVirtualText` to `Comment`, and
`PiVirtualTextInfo`, `…Hint`, `…Warn`, `…Error` and `…Ok` to the `DiagnosticVirtualText` group
of that name.

## For other extensions

```ts
import { useVirtualText } from '../nvim-virtual-text/api.ts';

export default function (pi) {
  const text = useVirtualText(pi, 'my-extension');
  pi.on('tool_result', async () => {
    const ids = await text()?.place([
      { path: '/abs/file.ts', line: 12, text: 'parses the header', hl: 'PiVirtualTextInfo' },
      { path: '/abs/file.ts', match: 'async function fetchAll(', highlight: 'Visual', sign: '▶',
        text: [['why: ', 'Title'], ['retries here before giving up']],
        position: 'above', indent: true, wrap: true },
      { path: '/abs/file.ts', line: 3, text: 'flash', hl: { fg: '#ff9e64', bold: true }, ttl: 1500 },
    ]);
    await text()?.update(ids[0], { text: 'parses the header and the trailer' });
  });
}
```

`text()` is undefined while Pi is not attached. Each group has its own namespace, so
`clear()` only removes that group's marks. `virtualText(remote, group)` does the same for a
`remote` you already have, and `useVirtualText(pi, group, (text, nvim) => …)` runs its callback
on every new attachment.

| Member | Behavior |
| --- | --- |
| `place(marks, options?)` | Place one mark or several. Resolves to their ids, in order. A mark that can't be placed rejects the call, and the marks before it stay. |
| `update(id, patch, options?)` | Change a mark and keep its id. What `patch` leaves out stays; `null` takes an option away. Lines and columns it doesn't give stay where edits have moved them, and a `ttl` starts again. Resolves to whether this group had such a mark. One that can't be changed so (its new `match` isn't found, say) rejects, and the mark stays as it was. |
| `remove(ids, options?)` | Remove marks by id. Ids already gone, or another group's, are ignored. |
| `list(where?, options?)` | This group's marks, or only those in `{ path }` or `{ buf }`, in the order placed. Each is the mark as placed and updated, with its `id`, `group`, `buf` and `path`, and its lines and columns where edits have moved them. |
| `clear(where?, options?)` | Remove this group's marks, or only those in `{ path }` or `{ buf }`. Resolves to how many went. |

`options` are nvim-remote's `{ signal?, timeout? }`.

| Mark | |
| --- | --- |
| `path` or `buf` | An absolute file path, or a buffer number. A file the user hasn't opened is loaded unlisted, so its marks are there when they open it. |
| `line`, `endLine` | 1-based lines, clamped to the buffer. `endLine` (default `line`) ends the span `highlight` covers, and is where `below` goes. |
| `match` | Code to find instead of giving lines: the mark covers the lines it's on. Each line of `match` must be found within one of the buffer's, in order, ignoring the whitespace around it, so quoted code needn't be indented as in the file. The occurrence nearest `line` wins (the first, without it). Not found, the call is rejected. It's looked for when the mark is placed, and when an update gives it a new `match`, `line`, `path` or `buf`. Otherwise the mark keeps to its lines as they're edited. |
| `col`, `endCol` | 0-based byte columns: where `overlay` and `inline` go, and a character span for `highlight`. Without them `highlight` covers whole lines, to the window's edge. |
| `text` | A string, or `[text, hl?]` chunks. A newline starts another line for `above` and `below`, and becomes a space elsewhere. |
| `position` | `eol` (default), `right` (the window's edge), `overlay`, `inline`, `above`, `below`, or a number: that screen column, to line notes up. |
| `hl` | The highlight for text without its own, default `PiVirtualText`. Either a group name or a style (`{ fg, bg, sp, bold, italic, underline, undercurl, strikethrough, reverse }`), which gets a group of its own and is reapplied after `:colorscheme`. |
| `highlight` | Highlight the lines or span marked. |
| `sign` | Up to two cells in the sign column at `line`: a string, or `[text, hl]`. In `hl` unless given its own. |
| `indent` | For `above` and `below`: start at the indentation of the line they go by (`true`), or this many columns. |
| `wrap` | For `above` and `below`: break lines at spaces (never inside a word, even one split across highlights) to fit the widest window showing the buffer, or the editor if none (`true`), or this many columns. Indentation counts. Measured when placed. |
| `fill` | For `above` and `below`: give each line `hl`'s background across the window's whole width, whatever its size, indentation and blank lines included. |
| `invalidate` | Hide the mark while all its lines are deleted, and show it again if they come back on undo. `list` gives it with `invalid: true` meanwhile. Updated while hidden without being moved, it stays hidden and shows the change once undone. Reloaded from disk, it shows again if its text is back, and is removed if its text is nowhere. |
| `ttl` | Remove the mark after this many milliseconds. |
| `priority` | As for extmarks. |

Marks are extmarks, so they move with the text as it's edited in the buffer. Every mark also
keeps the text its lines had when it was placed or moved by an update (or its `match`). When the file is reloaded from disk (`:edit`,
or autoread after Pi edits it), a mark whose lines no longer hold that text moves to the
nearest place that does. For a mark placed by line, that's the nearest exact copy of its lines
if there is one, however far. A mark whose text is gone stays where it was, unless it
`invalidate`s.

## Development

```sh
node --test --test-timeout=20000 *.test.ts
../nvim-service/node_modules/.bin/tsc -p tsconfig.json
```

The tests run their own headless Neovim, never the one they might be started from.
