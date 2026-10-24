# nvim-control

Lets the model control the Neovim Pi runs inside, as [nvim-service](../nvim-service/README.md)
lets it control its own private one. Built on [nvim-remote](../nvim-remote/README.md), and
needs no install. Outside Neovim it registers nothing, so it costs no tokens; inside, the
two tools' descriptions are in the system prompt.

| Tool | Use |
| --- | --- |
| `nvim_control_lua` | Run Lua in your editor and get the return value (text, or JSON). `...` receives `args`. `remote` is in scope, so what the model sets up can go when Pi does: in `remote.group` or `remote.ns`, or removed in `remote.on_detach(fn)`. |
| `nvim_control_keys` | Type keys into the focused window, in Neovim notation, and get one line back: mode, buffer, cursor and the last message. Empty keys just looks. |

Both take `timeoutMs` (default 10000), for the whole call: once it runs out nothing more is
sent, and `nvim_control_keys` says how much it had typed. What the editor was already asked
may still finish there. Output is cut at 16 KB, never inside a character.

Control starts off: the model gets the tools only once you let it, with `/nvim-control on`.
`/nvim-control off` takes them away again, so it cannot use them and their descriptions leave
the system prompt; `/nvim-control` alone toggles. The setting is kept across `/reload` and
session switches until Pi exits. Toggling changes the system prompt, so Pi's prompt cache is
rebuilt once on the next turn. While Pi is attached, the status bar shows `control on` or
`control off` (status key `nvim-control`).

`nvim_control_lua` is arbitrary code running in your editor, with your unsaved buffers: the same
trust as the bash tool, but where you are working. The model is told these are your editor,
not its private instance, and never to quit Neovim, close Pi's terminal, discard unsaved
changes, or write buffers you are editing without being asked.

## Typing keys

Keys go to the window that has focus, which while you talk to Pi is usually Pi's own
terminal. Keys reach Pi itself only while that terminal is in terminal mode, so that is the one
place `nvim_control_keys` will not type: it refuses then, and the model can focus another window
with `nvim_control_lua` first (taking your focus there too), or do the work with
`nvim_control_lua`, which needs no focus. In the terminal's other modes, at a dialog or the
command line say, keys go to Neovim, and are typed one at a time with the check before each; a
key that enters terminal mode may go in, the one after it may not. The check and the typing are
one step in the editor, so focus and mode cannot change between them. (Keys are queued, then
taken a moment later: a change in that moment cannot be seen.)

A busy editor (in Lua, a plugin's say) still answers calls but takes in typed keys only when
it is done, so `nvim_control_keys` waits until they are taken before saying what they did. Neovim
takes only as much typed input as fits in its 16 KB input buffer, so long keys are sent in
parts of at most 4 KB, each once the last is taken, cut between whole keys (names with
punctuation, such as `<C-]>`, included) and characters; none are dropped. (For pasting text, `nvim_control_lua` and the buffer API are still
the better tool.) At a
hit-enter prompt it says so, and further keys answer it; `nvim_control_lua` fails at once there.

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
