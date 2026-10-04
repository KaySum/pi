# Pi-owned Neovim

Starts one private, headless Neovim when a Pi extension runtime starts a session.
Run **`/reload`** or restart Pi to activate. **`/nvim-service`** shows its PID,
supervisor PID, working directory, and RPC socket.

Requires **macOS or Linux**, Node.js 22.19+ (as required by Pi), and `nvim` on PATH.
There are no additional npm, Python, or compiler dependencies.

## Configuration

By default this uses your normal Neovim configuration, including its LSP setup:

```sh
nvim --headless --embed --listen <private-socket> -n -i NONE
```

Swap files and shared ShaDa persistence are disabled by these startup options.
No buffers are opened automatically; clients decide which files to load and
which RPC calls to make. Headless-unfriendly plugins can be skipped in your
Neovim config by checking `vim.env.PI_NVIM_SERVICE == "1"`.

Optional environment variables, set **before starting Pi**:

| Variable | Meaning |
| --- | --- |
| `PI_NVIM_BIN` | Neovim executable name or path, not a shell command. Default: `nvim`. |
| `PI_NVIM_INIT` | An alternative `-u` init file. Use `NONE` for an isolated, plugin-free instance. Unset to use your usual config. |

`PI_NVIM_SOCKET` is an **output**, managed by this extension. It is published only
after startup reaches `VimEnter`; shell commands launched by Pi then inherit it.
Every instance has a unique Unix socket in a private mode-0700 directory under
`/tmp`. No TCP listener or shared PID file is used.

Your existing **`$NVIM` is never changed** in Pi. `NVIM` and the legacy
`NVIM_LISTEN_ADDRESS` are removed only from the owned Neovim's environment, so
it cannot accidentally attach to or reuse your interactive editor. Nested Pi
instances start their own services rather than adopting an inherited socket.

## Using it from extensions

For a shell/RPC client launched after startup:

```sh
nvim --server "$PI_NVIM_SOCKET" --remote-expr 'getpid()'
```

Alternatively, use Pi's extension event bus. These are custom events, not Pi
built-ins. The metadata is `{ socket, pid, supervisorPid, cwd }`:

```typescript
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

type NvimInfo = { socket: string; pid: number; supervisorPid: number; cwd: string };

export default function (pi: ExtensionAPI) {
  let nvim: NvimInfo | undefined;
  const accept = (info: NvimInfo | undefined) => { nvim = info; };

  pi.events.on('nvim-service:ready', value => accept(value as NvimInfo));
  pi.events.on('nvim-service:stopped', () => accept(undefined));
  pi.on('session_start', () => {
    pi.events.emit('nvim-service:get', { reply: accept });
  });

  // In a tool/command: check nvim, then connect your Msgpack-RPC client to
  // nvim.socket. Do not use the private --embed stdio channel.
}
```

Subscribe to `:ready` **and** query `:get`: session-start handlers run in load
order, so querying before this service starts returns `undefined`. Do not block
an earlier `session_start` handler waiting for a later handler to run. In tools
and commands, report that the service is unavailable if it has not become ready.

`nvim-service:stopped` carries the departing instance's metadata. Drop cached
connections then. `/reload` shuts down the old service before starting a fresh
one; ordinary repeated `session_start` events reuse a live instance. Runtime
resources never start in the extension factory (e.g. during `pi --help`).

This extension only manages the instance; it does **not** register model-facing
Neovim tools or connect existing tools to it automatically.

## Shutdown and failure handling

```text
Pi --private lifetime pipe--> supervisor --embedded RPC stdio--> Neovim
                                  |
                                  +-- independent termination deadline
```

- The supervisor runs in its own process group, outside Pi's terminal group.
- Only Pi holds the writing end of the lifetime pipe. Neither Neovim nor other
  subprocesses inherit it. Pi closing it, exiting naturally, crashing, or being
  killed (including `SIGKILL`) causes EOF in the supervisor.
- On EOF, the supervisor closes Neovim's embedded stdin. Neovim normally exits
  immediately. At **500 ms** it sends `SIGTERM`; at **1500 ms** it sends `SIGKILL`
  if Neovim has not exited. This also handles a stuck Lua callback or `SIGSTOP`.
- It waits for/reaps Neovim, removes its private runtime directory, and exits.
  Cleanup does not wait for plugin processes to close inherited output pipes.
- Orderly `session_shutdown`, including reload, requests the same cleanup and
  waits for completion. Idle handles are unreferenced so they do not themselves
  prevent Pi from exiting. Startup and shutdown are idempotent.
- Startup has a **15-second** deadline. Readiness comes from a private pipe after
  `VimEnter`, not merely from the existence of a socket. Failed startup cleans
  up before reporting failure; Pi remains usable, with a warning. Unexpected
  Neovim exit unpublishes the socket. Use `/reload` to retry; there is no restart
  loop or steady-state polling.

**Guarantee boundary:** this protects against Pi terminating while the supervisor
and OS are functioning. It cannot guarantee a real-time deadline during machine
suspension, kernel failures/uninterruptible I/O, or if the supervisor is also
forcibly killed/stopped. The embedded EOF behavior is an extra fallback if the
supervisor dies, but a hung Neovim still needs a functioning supervisor to kill
it. Arbitrary plugin-spawned/daemonized processes are not supervised; the explicit
termination guarantee covers the owned Neovim process, not every descendant.
Never use broad `pkill nvim` or stale PID files: cleanup targets only the
supervisor's own, unreaped child.

## Tests

```sh
node --test --test-timeout=15000 extensions/nvim-service/*.test.mjs
```

Pi supplies extension imports through its loader; this config repository does
not install project-local Pi/Node development typings. A standalone editor may
therefore report missing `@earendil-works/pi-coding-agent` or `@types/node` types.
For type-checking, resolve those from your installed Pi, or install them as local
development dependencies. They are not additional runtime dependencies.

Tests use `-u NONE` or temporary init files, not your interactive Neovim or its
configuration. They cover normal/natural exit, crashes, signals including
`SIGKILL`, stuck/stopped Neovim, startup death/timeouts, missing executables,
isolation between simultaneous instances, discovery events, and reload cleanup.
