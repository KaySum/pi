# nvim-point

Lets other extensions show you a place in the code, in the Neovim Pi runs inside: the file
opened in your window, your cursor on the place, folds over it open, and scrolled to it if it
is not on screen. Your focus stays where it is, in Pi's terminal (unless an extension asks for
it, `focus: true`), and `<C-o>` in your window takes you back. It never moves anything while
you are typing there. It registers no tools. Built on [nvim-remote](../nvim-remote/README.md),
and needs no install.

## For you

`/nvim-point <path>:<line>[-<end line>][:<column>] [option=value …]` shows a place as other
extensions would, the path from Pi's working directory and the column from 1, as compilers and
grep give them. The options are those below, as `show` takes them: `match`, `buf`, `context`,
`scroll`, `jump`, `open`, `focus`, `wait`; a value with spaces is quoted, as JSON. With
`match=`, a path alone will do (a line given picks the nearest); with `buf=`, the lines alone.
Paths, options and their values complete as you type:

```
/nvim-point src/app.ts:120-140
/nvim-point src/app.ts:42:7 scroll=minimal focus=true
/nvim-point src/app.ts match="async function retry("
/nvim-point 120-130 buf=7 jump=false
```

## For other extensions

```ts
import { usePoint } from '../nvim-point/api.ts';

export default function (pi) {
  const point = usePoint(pi);
  pi.on('tool_result', async () => {
    const shown = await point()?.show({ path: 'src/app.ts', match: 'async function retry(' }, { wait: 5000 });
    if (shown && !shown.shown) { /* Still typing after 5 s (shown.busy), or a later show came. */ }
  });
}
```

`point()` is undefined while Pi is not attached to Neovim. `show(place)` takes:

| Place | |
| --- | --- |
| `path` | The file: absolute, or relative to Pi's working directory, as Pi's tools give paths. |
| `buf` | Or a buffer, by number, instead: one without a file too, any but a terminal. Left listed or not, as it was. |
| `line`, `endLine` | 1-based; the lines to bring on screen together (`endLine` defaults to `line`). |
| `match` | Or the code, rather than its lines, which move as the file changes: each of its lines within one of the file's, in order, the space around them aside. Its lines are brought on screen, the cursor where it starts. Of several, the one nearest `line` wins, the earlier on a tie; else the first. Not with `endLine` or `col`, which it gives. |
| `col` | Where the cursor goes on `line`, in 0-based bytes, kept within the line and on a character's first byte; else its first non-blank, as `^` goes. |
| `context` | Lines kept around them when it has to scroll. Default 3. |

### Where

In a window of the current tab showing the file already, else yours: the one you are in unless
it is Pi's terminal (or another like it), else the one you came from, else any showing a file.
With none, one opens beside Pi's terminal (beneath it, if it floats), its jumplist empty. If
yours has unsaved changes Neovim cannot hide (`'hidden'` off), the file opens in a split above
it rather than lose them.

### How

The cursor goes on the place, and folds over its lines open. If the lines were on screen
already, the window does not scroll: you know where to look. Else they are brought on screen
whole: centered if they fit with their context, or with `{ scroll: 'top' }` at the top, or
with `{ scroll: 'minimal' }` just past the edge they were off, moving the screen least; too
tall for the window, from their start. A move within the file goes in your jumplist, as does
leaving another file for it; with `{ jump: false }`, as for following Pi around, neither your
jumplist nor your alternate file (`<C-^>`) changes.

It resolves to `{ shown: true, win, buf, opened, scrolled }`: `opened` if a window was opened
for it, `scrolled` if the window scrolled. While you are busy (inserting, selecting, typing a
command, in the command-line window, at a prompt), it changes nothing and resolves to
`{ shown: false, busy }`, the mode you are in (`i`, `v`, `c`…): with `{ wait: ms }`, it tries
again until you are free, for up to that long (`Infinity`: as long as it takes), and a later
`show` ends the wait (`superseded`): only the newest place is shown. With `{ open: false }`,
as for following Pi only through files you have open, it shows the place only where a window
of the tab shows the file already; else it loads and changes nothing, and resolves to
`{ shown: false, closed: true }`. A path that is not a file (missing, unreadable, a directory
or device, a buffer of another kind), lines past its end, or a `match` not there, reject.

A file changed on disk since Neovim loaded it would have Neovim ask what to do at a prompt,
holding the call until you answer. Unless you handle that yourself (`FileChangedShell`), it is
reloaded as `'autoread'` would, if you have not changed it; else left as it is, and you are told
after, in one line.

## Development

```sh
node --test --test-timeout=20000 *.test.ts
../nvim-service/node_modules/.bin/tsc -p tsconfig.json
```

The tests run their own headless Neovim, never the one they might be started from.
