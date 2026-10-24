# nvim-virtual-text

Lets other extensions put virtual text and highlights in the Neovim Pi runs inside: notes at
the end of a line, at the window's edge, over or between characters, or as lines of their own
above or below, in any highlight group or a style of their own. It only draws: opening files,
moving the cursor and scrolling are for others. Built on [nvim-remote](../nvim-remote/README.md),
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
      { path: '/abs/file.ts', line: 20, endLine: 24, highlight: 'Visual',
        text: [['why: ', 'Title'], ['retries here\nbefore giving up']], position: 'below' },
      { path: '/abs/file.ts', line: 3, text: 'flash', hl: { fg: '#ff9e64', bold: true }, ttl: 1500 },
    ]);
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
| `remove(ids, options?)` | Remove marks by id. Ids already gone are ignored. |
| `clear(where?, options?)` | Remove this group's marks, or only those in `{ path }` or `{ buf }`. Resolves to how many went. |

`options` are nvim-remote's `{ signal?, timeout? }`.

| Mark | |
| --- | --- |
| `path` or `buf` | An absolute file path, or a buffer number. A file the user hasn't opened is loaded unlisted, so its marks are there when they open it. |
| `line`, `endLine` | 1-based lines, clamped to the buffer. `endLine` (default `line`) ends the span `highlight` covers, and is where `below` goes. |
| `col`, `endCol` | 0-based byte columns: where `overlay` and `inline` go, and a character span for `highlight`. Without them `highlight` covers whole lines, to the window's edge. |
| `text` | A string, or `[text, hl?]` chunks. A newline starts another line for `above` and `below`, and becomes a space elsewhere. |
| `position` | `eol` (default), `right`, `overlay`, `inline`, `above`, `below`. |
| `hl` | The highlight for text without its own, default `PiVirtualText`. Either a group name or a style (`{ fg, bg, sp, bold, italic, underline, undercurl, strikethrough, reverse }`), which gets a group of its own and is reapplied after `:colorscheme`. |
| `highlight` | Highlight the lines or span marked. |
| `fill` | For `above` and `below`: pad each line to the widest window showing the buffer, so its background fills the line. The width is taken when the mark is placed. A buffer shown in no window gets no padding. |
| `ttl` | Remove the mark after this many milliseconds. |
| `priority` | As for extmarks. |

Marks are extmarks, so they move with the text as it is edited.

## Development

```sh
node --test --test-timeout=20000 *.test.ts
../nvim-service/node_modules/.bin/tsc -p tsconfig.json
```

The tests run their own headless Neovim, never the one they might be started from.
