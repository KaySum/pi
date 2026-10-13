import { readFileSync } from 'node:fs';

// For other extensions: `const nvim = useNvim(pi)` at load, then `nvim()` wherever the
// editor is needed. It only talks over Pi's event bus, so it works regardless of
// extension load order and never starts a process itself.
export function useNvim(pi) {
  let handle;
  const discover = () => pi.events.emit('nvim-service:get', { reply: value => { handle = value; } });
  pi.events.on('nvim-service:ready', value => { handle = value; });
  pi.events.on('nvim-service:stopped', () => { handle = undefined; });
  pi.on('session_start', discover);
  return () => {
    if (!handle) discover();
    if (!handle) throw new Error('Neovim service unavailable; enable nvim-service and run /reload');
    return handle;
  };
}

const LSP = readFileSync(new URL('./lsp.lua', import.meta.url), 'utf8');

/** Lua for `nvim().lua` with `servers` defined: the helpers of lsp.lua, for asking language servers to change files. */
export const withServers = lua => `local servers = (function()\n${LSP}\nend)()\n${lua}`;
