import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Remote as Attached } from './remote.ts';

export type { AutocmdEvent, CallOptions } from './remote.ts';
/** What `useRemote` and `nvim-remote:ready` give. */
export type Remote = Attached & { apiVersion: 1 };

// For other extensions: `const nvim = useRemote(pi, onAttach?)` at load, then `nvim()` wherever
// the editor is needed; it is undefined when Pi is not running inside Neovim. `onAttach` runs
// for every new handle (after /reload or a reconnect too): the place to set things up in the
// editor, since what a handle set up is undone when it goes.
export function useRemote(pi: ExtensionAPI, onAttach?: (nvim: Remote) => void): () => Remote | undefined {
  let handle: Remote | undefined;
  const adopt = (value?: Remote) => {
    if (!value || value === handle) return;
    handle = value;
    onAttach?.(value);
  };
  const discover = () => pi.events.emit('nvim-remote:get', { reply: adopt });
  pi.events.on('nvim-remote:ready', value => adopt(value as Remote));
  pi.events.on('nvim-remote:stopped', () => { handle = undefined; });
  pi.on('session_start', discover);
  return () => {
    if (!handle) discover();
    return handle;
  };
}
