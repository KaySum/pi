# nvim-service

Every Pi instance gets its own Neovim, with your configuration, plugins and LSP servers,
that Pi and other extensions can drive the way a person would. It stops when Pi stops,
however Pi stops.

Requires macOS or Linux, Node.js 22.19+ and Neovim 0.11+ (tested with 0.12.6).

```sh
npm ci --omit=dev --prefix ~/.pi/agent/extensions/nvim-service
```

## For you

`/nvim-service` shows the instance; `/nvim-service restart` replaces it.

```
Neovim PID 21407
Supervisor PID 21405
Socket: /tmp/pi-nvim-Uby1lu/nvim.sock
Working directory: /Users/xsv/.pi/agent
```

Watch or take over what Pi is doing from any terminal:

```sh
nvim --server /tmp/pi-nvim-Uby1lu/nvim.sock --remote-ui
```

`PI_NVIM_BIN` selects the executable and `PI_NVIM_INIT` an alternative init file (`NONE`
for a clean editor). The instance runs without swap files (`-n`), so files you have open
elsewhere never raise a swap prompt, and without shada (`-i NONE`), so Pi's history stays
out of yours.

## For Pi

| Tool | Use |
| --- | --- |
| `nvim_lua` | Run Lua and get the return value. Reaches every API, option, buffer, LSP client and plugin. |
| `nvim_keys` | Type keys. Returns one line (mode, buffer, cursor, message); the screen on request, and always at a prompt. |
| `nvim_restart` | Replace a hung instance. |

`nvim_lua` is arbitrary code execution inside the editor: the same trust as a shell tool.

## For other extensions

```js
import { useNvim } from '../nvim-service/api.mjs';

export default function (pi) {
  const nvim = useNvim(pi);
  pi.registerTool({
    // ...
    execute: async () => ({ content: [{ type: 'text', text: await nvim().lua('return vim.fn.expand("%")') }] }),
  });
}
```

`nvim()` returns the current handle, or throws if the service is not running. No
dependency install, RPC client or discovery code is needed in the consumer.

| Member | Behavior |
| --- | --- |
| `info` | `{ socket, pid, supervisorPid, cwd }` |
| `lua(code, args?, { signal }?)` | Run Lua; `...` receives `args`. |
| `request(method, args?, { signal }?)` | Any Neovim API method. |
| `keys(keys, { signal }?)` | Type keys in Neovim notation, wait until they are consumed, return `state()`. |
| `state({ signal }?)` | `{ mode, blocking, prompt, buffer, file, line, column, modified, message }` |
| `screen({ signal }?)` | The rendered screen as text, including floating windows, popups and prompts. |
| `on(name, handler)`, `channel` | Receive `rpcnotify(channel, name, ...)`, or answer `rpcrequest`. Returns an unsubscribe. |
| `resize(columns, rows)` | Change the UI size (default 120×40). |
| `connect()` | A separate RPC channel (`request`, `notify`, `on`, `close`, `channel`). |
| `restart()` | Replace the instance; resolves to the new handle. |
| `apiVersion` | `1` |

While Neovim waits at a blocking prompt, `lua` and `request` fail at once with an error
carrying `blocking: true` and the `screen`, instead of hanging; answer with `keys`.

A handle belongs to one instance. After a restart or `/reload`, call `nvim()` again
rather than keeping the old one. Extensions that prefer not to import can use the same
contract on `pi.events`: `nvim-service:ready` (handle), `nvim-service:stopped` (`info`),
and `nvim-service:get` with `{ reply }` to ask for the current handle.

## Lifetime

```
Pi ──lifetime pipe──▶ supervisor ──stdio──▶ nvim --headless --embed --listen <socket>
```

Neovim is owned by a small supervisor process whose stdin only Pi holds open. When that
pipe closes, because Pi exited, crashed or was killed, the supervisor closes Neovim's
stdin, sends `SIGTERM` after 500 ms and `SIGKILL` after 1500 ms, then removes the socket
directory. This also covers a Neovim that is frozen or stuck in Lua.

The guarantee is for the Neovim process. Language servers exit when Neovim closes their
pipes; a plugin that daemonizes its own process is outside it. A pure-Lua infinite loop
cannot be interrupted from outside, so it ends in a timeout and `nvim_restart`.

## Development

```sh
npm ci && npm test && npm run typecheck
```
