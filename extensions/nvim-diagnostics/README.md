# Neovim diagnostics for Pi

Reads `vim.diagnostic.get()` from your existing Neovim instance. No plugin,
additional npm dependencies, or separate language server required. Requires
Neovim 0.10+ and `nvim` on Pi's PATH.

## Use

Run `/reload` in Pi after installation. Ask Pi to inspect Neovim diagnostics;
the `nvim_diagnostics` tool is available automatically.

- `/nvim-connect` checks the current connection.
- `/nvim-connect <address>` selects an instance for this extension runtime.
- `/nvim-connect auto` resets that selection.
- `/nvim-diagnostics` displays and adds project diagnostics to the conversation,
  without starting a model turn.
- `/nvim-diagnostics all` shares all cached editor diagnostics.
- `/nvim-diagnostics path/to/file.ts` shares one file's diagnostics.

Connection precedence: command override, `pi --nvim-socket <address>`,
`PI_NVIM_SOCKET`, then `NVIM`. Pi launched inside Neovim's `:terminal` normally
inherits `NVIM`. In another terminal, use `:echo v:servername` in Neovim and
paste its value into `/nvim-connect`, without quotes. Or launch Neovim with
`nvim --listen /tmp/my-nvim.sock` and Pi with
`PI_NVIM_SOCKET=/tmp/my-nvim.sock pi`. Only connect to trusted local servers;
Neovim RPC grants powerful access. There is no socket scanning or automatic
selection of a different editor.

## Behavior and limitations

The tool defaults to files underneath Pi's working directory. Set `scope: "all"`
for all cached diagnostics, or `file` for an exact path (relative to Pi's cwd).
`severity` accepts `error`, `warning`, `information`, `hint`, or `all`.
`limit` defaults to 200, maximum 500. Output is bounded and reports omissions.

Diagnostics come from all Neovim diagnostic namespaces, including non-LSP
plugins. This matches the diagnostic cache, not necessarily display filters
configured for signs/virtual text. Loaded-buffer metadata includes attached
LSP names and whether each buffer is modified. Locations are 1-based, columns
are byte offsets. Empty results do not prove a workspace is error-free.

This is an on-demand snapshot, not a push subscription. It does not save,
reload, or edit buffers. Diagnostics for unopened files may be absent. After
Pi changes files on disk, Neovim must notice/reload them and the LSP must finish
analysis before a subsequent snapshot reflects the changes. Unsaved editor
contents may differ from the files Pi reads. Paths are compared lexically;
symlink aliases may need an explicit Neovim path or `scope: "all"`.

Each query starts a short-lived `nvim --server ... --remote-expr` client with a
5-second timeout and cancellation support. No persistent process is started.
A command-selected connection resets on `/reload`; use the environment or CLI
flag for a lasting selection.

## Tests

```sh
node --test ~/.pi/agent/extensions/nvim-diagnostics/bridge.test.mjs
```

Includes a read-only live integration check when `NVIM` is set.
