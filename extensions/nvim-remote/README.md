# nvim-remote

When Pi runs in a Neovim terminal (sidekick, `:terminal`, toggleterm, …) it attaches to that
editor and can control all of it: buffers, windows, options, commands, plugins, language
servers, autocommands. Other extensions build features on it without changing it. Outside
Neovim it does nothing.

Not to be confused with [nvim-service](../nvim-service/README.md), a private, headless Neovim
that Pi owns. This is the editor you are typing in. A later `pi-remote` would be the other
direction: Neovim controlling Pi.

Needs nvim-service installed (it reuses its RPC client) and Neovim 0.10+. After updating
nvim-service, quit and restart Pi: `/reload` does not reload its `.mjs` files, and
nvim-remote says so if it finds the old ones.

Detection is `$NVIM`, which Neovim sets to its socket in every terminal it starts. A Pi
started by sidekick inside tmux or zellij is not under Neovim and does not attach. Neither
does a Pi started by an attached one (from its bash tool, say), which inherits `$NVIM`: the
attached Pi marks itself in `PI_NVIM_REMOTE`.

## For you

While attached the status bar shows `nvim` (status key `nvim-remote`). `/nvim-remote` shows
the connection; `/nvim-remote reconnect` attaches again.

Your config can react to Pis taking and giving up control:

```lua
vim.api.nvim_create_autocmd('User', { pattern = 'NvimRemoteAttach', callback = function(ev)
  -- ev.data: { channel, pid, cwd, terminal }; NvimRemoteDetach likewise.
end })
```

## For other extensions

```ts
import { useRemote } from '../nvim-remote/api.ts';

export default function (pi) {
  const nvim = useRemote(pi, async remote => {
    // Every new attachment, after /reload or a reconnect too: set up here, since what an
    // attachment set up is undone when it goes.
    await remote.autocmd('BufWritePost', event => { /* ... */ });
  });
  pi.on('tool_result', async () => {
    await nvim()?.lua('vim.cmd.checktime()');
  });
}
```

`nvim()` is the current handle, or `undefined` when Pi is not attached. The same contract is
on `pi.events`: `nvim-remote:ready` (handle), `nvim-remote:stopped` (`info`), and
`nvim-remote:get` with `{ reply }`.

A handler given to `on` or `autocmd` that throws, or rejects, is reported as a warning in Pi
and as `nvim-remote:error` (`{ error, source }`) on `pi.events`; the other handlers and the
connection carry on.

| Member | Behavior |
| --- | --- |
| `lua(code, args?, options?)` | Run Lua: `code` is a function body, `...` its `args`, with `remote` in scope (below). Resolves to the first value returned. Errors carry Lua's message and the line in `code`. |
| `request(method, args?, options?)` | Any Neovim API method. |
| `notify(method, args?)` | Any API method, without waiting for it. |
| `on(name, handler)` | Receive `remote.notify(name, ...)` from Lua. Returns an unsubscribe. |
| `autocmd(events, handler, autocmdOptions?, options?)` | Run `handler` in Pi on an autocommand. `autocmdOptions` are nvim_create_autocmd's (`pattern`, `buffer`, `once`, …). The handler gets `{ event, buf, file, match, id, data }`; `data` is left out if it cannot be sent (holds a function, say). Resolves to an async unsubscribe. |
| `connect()` | A separate raw RPC channel, for what this one does not cover (attaching a UI, say): no prompt check, timeout or cleanup. The caller closes it. |
| `onClose(handler)` | Called once the connection ends, by `close` or because the editor went away. |
| `info`, `channel`, `closed`, `apiVersion` | `{ socket, pid, channel, terminal }` (`pid` is Neovim's; `terminal` is Pi's terminal buffer, if Pi runs in one of the editor's); the RPC channel; whether it has ended; `1`. |

`options` is `{ signal?, timeout? }`. `timeout` defaults to 10000 ms; `Infinity` waits as long
as it takes. A call that times out or is aborted stops waiting, but what it asked for may
still finish in the editor.

While the editor waits at a hit-enter or confirm prompt, `lua`, `request` and `autocmd`
fail at once with an error carrying `blocking: true` and `mode`, rather than waiting until
the user answers. `nvim_get_mode`, `nvim_input` and `nvim_input_mouse` still go through, so
a prompt can be seen and answered.

### In Lua: `remote`

| `remote.` | |
| --- | --- |
| `group` | An augroup of this Pi's. Deleted on detach. |
| `ns` | A namespace of this Pi's, for extmarks and highlights. Cleared in every buffer on detach. |
| `on_detach(fn)` | Run `fn` on detach; the last registered runs first, and one that fails does not stop the rest. |
| `notify(name, ...)` | Notify Pi; heard by `on(name, handler)`. |
| `terminal`, `channel`, `pid`, `cwd` | Pi's terminal buffer (or `nil`), RPC channel, process and working directory. |

Whatever a feature sets up in the editor should hang off `remote`, so that nothing of it is
left when Pi goes, however it goes: anything else (a keymap, a user command, a window)
needs an `on_detach` that removes it.

```lua
vim.keymap.set('n', '<leader>p', function() remote.notify('pressed') end)
remote.on_detach(function() pcall(vim.keymap.del, 'n', '<leader>p') end)
```

## Detaching

A Pi detaches when it quits, reloads, reconnects or is replaced by `/nvim-remote reconnect`:
its cleanups run, its group and namespace go, and `User NvimRemoteDetach` fires. Cleanups
that fail are reported in Pi. Neovim does not say when a channel closes, so it checks the
channels of attached Pis every 0.5 s: a Pi that crashed or was killed is detached the same
way, within half a second.

Several Pis can control one editor; each has its own `remote`, and detaching one leaves the
others' setup alone. Their state is in `package.loaded['nvim_remote.v1']` (`.contexts`, by
channel); the version changes only when that state does, so Pis with nvim-remotes that do not
fit together each keep their own.

## Development

```sh
node --test --test-timeout=20000 *.test.ts
../nvim-service/node_modules/.bin/tsc -p tsconfig.json
```

The tests run their own headless Neovim, never the one they might be started from.
