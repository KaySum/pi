## Neovim diagnostics

When programming, use the `nvim_diagnostics` tool to check the current Neovim diagnostics for the files you changed. Run it after edits and address relevant errors and warnings before considering the work complete. The tool checks disk files through Pi-owned Neovim and reports modified service buffers as conflicts. Inspect coverage/freshness status: cached or empty results may be incomplete or stale and are not a substitute for running project tests, builds, or linters when those are warranted.
