# nvim-control

Lets the model control the Neovim Pi runs inside, as [nvim-service](../nvim-service/README.md)
lets it control its own private one. Built on [nvim-remote](../nvim-remote/README.md), and
needs no install. Outside Neovim it registers nothing, so it costs no tokens; inside, the
two tools' descriptions are in the system prompt.

| Tool | Use |
| --- | --- |
| `editor_lua` | Run Lua in your editor and get the return value (text, or JSON). `...` receives `args`. `remote` is in scope, so what the model sets up can go when Pi does: in `remote.group` or `remote.ns`, or removed in `remote.on_detach(fn)`. |
| `editor_keys` | Type keys into the focused window, in Neovim notation, and get one line back: mode, buffer, cursor and the last message. Empty keys just looks. |

Both take `timeoutMs` (default 10000). Output is cut at 16 KB.

`/nvim-control off` takes the tools away from the model, so it cannot use them and their
descriptions leave the system prompt; `/nvim-control on` gives them back, and `/nvim-control`
alone toggles. Control starts on, and keeps its setting across `/reload` and session
switches until Pi exits. Toggling changes the system prompt, so Pi's prompt cache is rebuilt
once on the next turn.

`editor_lua` is arbitrary code running in your editor, with your unsaved buffers: the same
trust as the bash tool, but where you are working. The model is told these are your editor,
not its private instance, and never to quit Neovim, close Pi's terminal, discard unsaved
changes, or write buffers you are editing without being asked.

## Typing keys

Keys go to the window that has focus, which while you talk to Pi is Pi's own terminal: they
would be typed into Pi. `editor_keys` refuses then; the model can focus another window with
`editor_lua` first (taking your focus there too), or do the work with `editor_lua`, which
needs no focus.

A busy editor (in Lua, a plugin's say) still answers calls but takes in typed keys only when
it is done, so `editor_keys` waits until they are taken before saying what they did. At a
hit-enter prompt it says so, and further keys answer it; `editor_lua` fails at once there.

## Not here

- **The screen.** nvim-service's `nvim_keys` can return the rendered screen, which needs a
  UI attached. A second UI changes your editor: Neovim enables UI extensions (noice's message
  and command-line handling, say) only while every attached UI supports them. The last line
  of `:messages` stands in for the message line.
- **Restarting.** Your editor is yours: there is no `nvim_restart` here.

## Development

```sh
node --test --test-timeout=20000 *.test.ts
../nvim-service/node_modules/.bin/tsc -p tsconfig.json
```

The tests run their own headless Neovim, never the one they might be started from.
