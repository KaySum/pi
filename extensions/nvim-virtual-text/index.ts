import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { useRemote } from '../nvim-remote/api.ts';
import { call } from './api.ts';

// A library for other extensions (see api.ts); Pi loads this for the command alone.
export default function (pi: ExtensionAPI) {
  const nvim = useRemote(pi);
  pi.registerCommand('virtual-text', {
    description: 'Remove the virtual text Pi placed in Neovim: clear',
    getArgumentCompletions: prefix => 'clear'.startsWith(prefix.trim()) ? [{ value: 'clear', label: 'clear', description: 'Remove all of it' }] : null,
    handler: async (args, ctx) => {
      if (args.trim() !== 'clear') return ctx.ui.notify('Usage: /virtual-text clear', 'warning');
      const remote = nvim();
      if (!remote) return ctx.ui.notify('Pi is not attached to Neovim', 'warning');
      const removed = await call(remote, 'clear', [null, {}]);
      ctx.ui.notify(`Removed ${removed} mark${removed === 1 ? '' : 's'}`, 'info');
    },
  });
}
