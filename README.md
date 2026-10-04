# Pi configuration

## Initial setup

Install Pi, then clone this repository as its personal configuration directory:

```sh
mkdir -p ~/.pi
git clone https://github.com/KaySum/pi.git ~/.pi/agent
```

Install the extensions declared in `settings.json` using the sync command:

```sh
node ~/.pi/agent/scripts/sync-packages.mjs
npm --prefix ~/.pi/agent/extensions/nvim-service ci --ignore-scripts
```

Then start Pi and sign in to your model provider. Credentials are stored locally
and are not included in this repository.

## Pi-owned Neovim

`extensions/nvim-service/` starts a private headless Neovim for each Pi runtime.
An independent supervisor cleans it up even if Pi crashes or is killed, including
when Neovim is unresponsive. Run `/reload` to activate and `/nvim-service` to
inspect it. Other extensions can use `PI_NVIM_SOCKET` or its discovery events;
your editor's `$NVIM` is unchanged.

See [configuration, extension API, and shutdown guarantees](extensions/nvim-service/README.md).

`extensions/nvim-diagnostics/` adds the `nvim_diagnostics` tool. Pi can request a
batch of disk files, optionally filter severities, and receive Neovim diagnostics
with explicit coverage/freshness status. Modified service buffers are never
overwritten; missing providers and timeouts are not presented as clean results.
See [setup, tool parameters, limits, and tests](extensions/nvim-diagnostics/README.md).

`extensions/nvim-semantic/` adds read-only `nvim_navigate`, `nvim_hover`, and
`nvim_symbols` tools for LSP navigation, type inspection, and file/workspace
symbol search. It shares RPC, disk refresh, request serialization, and buffer
leases with diagnostics—no extra Neovim. See [parameters and coverage limits](extensions/nvim-semantic/README.md).

## Session cleanup

The local `extensions/session-cleanup/` extension expires inactive sessions after
30 days and cleans configured plugin metadata for manually deleted transcripts.
It runs only at session start or by explicit command—never by polling. Edit `session-cleanup.json` to change retention or add declarative
file, SQLite, or command cleanup rules—no extension code changes needed.

Run `/session-cleanup preview` to inspect candidates. See
[configuration, safety limits, and plugin coverage](extensions/session-cleanup/README.md).
Reload all running Pi instances before relying on active-session protection.

## Update and sync extensions

Update the versions of configured extensions with:

```sh
pi update --extensions
```

To reconcile installed packages with the list in `settings.json`, run the sync
command. It uses `pi install` for missing packages and `pi uninstall` for
packages absent from the configured list:

```sh
node ~/.pi/agent/scripts/sync-packages.mjs
```

Preview actions without changing packages or files:

```sh
node ~/.pi/agent/scripts/sync-packages.mjs --dry-run
```

The script checks Pi's actual user install inventory: direct npm packages in
`~/.pi/agent/npm/package.json` that have installed package files, plus
Pi-managed git package checkouts. It uses Pi's `install`/`uninstall` commands to
reconcile that inventory with `settings.json`; it does not run `npm install` or
rewrite the npm lockfile.
