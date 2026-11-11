# nvim-remote-kit

Not an extension (Pi loads nothing from this folder): what the extensions working in the Neovim
Pi runs inside share, so that each does it the same, hardened way. Built on
[nvim-remote](../nvim-remote/README.md); used by [nvim-point](../nvim-point/README.md),
[nvim-virtual-text](../nvim-virtual-text/README.md) and [nvim-view](../nvim-view/README.md).

## In Neovim: `remote.kit`

Installed in an attachment before any module that uses it (see `install` below).

| Function | Does |
| --- | --- |
| `busy()` | What keeps the user busy, so that nothing should move their cursor now: their mode unless normal or terminal, or `"cmdwin"`. Nil while they are free. |
| `say(texts, level?)` | Say the first of `texts` that fits where messages go, else the last cut to fit: a longer one would stop the editor at "Press ENTER". |
| `shows_file(win)` | Whether a window is one of the user's own work: no float, showing a file's buffer. |
| `windows()` | This tab's windows, the one the user is in first, then the one they came from. |
| `yours()` | The user's window: the one they are in unless it is Pi's terminal (or another like it), else the one they came from, else any showing a file. |
| `file(path)` | A test of whether a buffer is the file at `path`, as Neovim tells files apart: by device and inode, so links are one file; and by name as Neovim matches one. Adds no buffer. |
| `open(path)` | The file's buffer, loaded unlisted as the user's own would be, never at a swap file's prompt, and what was done for it. Refuses what is no file to read: missing, a directory or device, unreadable, or made a buffer of another kind by the user's autocommands. An error of theirs once it is loaded is no failure. |
| `load(buf, existed)` | Load a buffer as `open` does. |
| `undo(buf, done)` | Undo what `open` or `load` did: no file left loaded (a swap file and all) that the user did not open. |
| `guarded(buf, fn)` | Run `fn` where Neovim may find the file changed on disk: rather than ask at a prompt, it is reloaded as `'autoread'` would (the buffer's own, if it has one), else left and the user told; unless they handle `FileChangedShell` for it themselves. |

## In Pi: `api.ts`

| Export | Does |
| --- | --- |
| `install(remote, source)` | Install a module of Lua in an attachment, the kit first, in one call. |
| `module(name, source)` | A `call(remote, fn, args?, options?)` running `remote[name][fn](...)`, installing the module (and the kit) the first time it is needed in an attachment. |
| `withKit(remote, code, args?)` | Run Lua as `remote.lua` does, with `kit` in scope. |
| `perAttachment(make)` | One of what `make` makes for each attachment. |
| `blocked(error)` | The mode the user is busy in, if a call failed as Neovim waits at a prompt. |
| `errorText(error)` | An error's first line, without "Lua: ": what to show the user. |
| `useCwd(pi)` | Pi's working directory, as of the session's start. |

## Development

```sh
node --test --test-timeout=30000 *.test.ts
../nvim-service/node_modules/.bin/tsc -p tsconfig.json
```
