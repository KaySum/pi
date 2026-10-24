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

Plugins that do not belong in it, such as a session manager that would overwrite your
session for the same directory on exit, can be kept out with lazy.nvim's names in
`~/.pi/agent/nvim-service.json`, read at each start:

```json
{ "disabledPlugins": ["persistence.nvim"] }
```

They are disabled as by a false `cond`, unless their spec sets its own `cond`.

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
| `connect()` | A separate RPC channel (`request`, `notify`, `on`, `onClose`, `close`, `channel`). |
| `restart()` | Replace the instance; resolves to the new handle. |
| `apiVersion` | `1` |

While Neovim waits at a blocking prompt, `lua` and `request` fail at once with an error
carrying `blocking: true` and the `screen`, instead of hanging; answer with `keys`.

A handle belongs to one instance. After a restart or `/reload`, call `nvim()` again
rather than keeping the old one. Extensions that prefer not to import can use the same
contract on `pi.events`: `nvim-service:ready` (handle), `nvim-service:stopped` (`info`),
and `nvim-service:get` with `{ reply }` to ask for the current handle.

### Having language servers change files

A language server answers about its own copy of a file, and edits made for an older text
ruin the present one: rust-analyzer takes in no changes while it scans a project, and
says nothing of it. Lua that asks servers for edits gets the precautions with
`withServers`:

```js
import { withServers } from '../nvim-service/api.mjs';
const LUA = withServers("local edits, problem, again = servers.ask(client, 'textDocument/formatting', params, buf, 5000) ...");
```

| `servers.` | Behavior |
| --- | --- |
| `ask(client, method, params, buf, ms)` | The answer; or `nil`, what went wrong (an error raised by a server that runs inside Neovim included), and whether asking again may help. The server is only asked once it has shown no progress for 0.5 s (so the first request to each server in a session waits that long), and its answer is dropped if it showed any before the answer came. It is first sent the pending changes of every buffer, not only of `buf`: Neovim holds them back for 150 ms. |
| `attached(buf, loaded?)` | True once no more servers are to be expected for the buffer and those it has are running. `loaded` is when it was (re)loaded, if only just: it is then given 0.3 s, or 2 s for the first file of a type. |
| `saved(buf)` | Tell the buffer's servers it was written, after a write without autocommands. clangd only then rereads a header for the sources that include it. |
| `seen(buf)` | Call once a buffer's servers have been waited for, so the next file of its type is not given the 2 s. |

This rests on the server saying that it is loading: the protocol has no way to ask a
server what text it holds.

Sending the pending changes uses `vim.lsp._changetracking.flush`, which is private to
Neovim: there is no public way to do it (tested with 0.12.6). If a later Neovim renames
or removes it, the call is skipped without an error, and a server may again be asked
about a project while it lacks the last 150 ms of changes to other files; pyright then
left files out of a rename made straight after another. The test "a server is sent every
change before it is asked about the project" in `nvim-refactor` fails when that happens,
so run the tests after updating Neovim.

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
