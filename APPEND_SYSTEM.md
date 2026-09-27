## Neovim diagnostics

When programming, use the `nvim_diagnostics` tool to check the current Neovim diagnostics for the files you changed. Run it after edits and address relevant errors and warnings before considering the work complete. Diagnostics may include unsaved-buffer state and can be stale after external edits; do not treat an empty result as a substitute for running project tests, builds, or linters when those are warranted.
