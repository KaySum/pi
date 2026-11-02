import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { relative, resolve } from 'node:path';
import { usePoint } from './api.ts';

const USAGE = 'Usage: /nvim-point <path>:<line>[-<end line>][:<column>]';
// What went wrong, without the "Lua:" and stack trace an error from the editor carries.
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0].replace(/^Lua: /, '');

// A library for other extensions (see api.ts); Pi loads this for its command.
export default function (pi: ExtensionAPI) {
  const point = usePoint(pi);

  pi.registerCommand('nvim-point', {
    description: 'Show a place in your Neovim window, as other extensions would: <path>:<line>[-<end line>][:<column>]',
    handler: async (args, ctx) => {
      // Columns from 1, as compilers and grep give them.
      const [, path, line, endLine, col] = args.trim().match(/^(.+?):(\d+)(?:-(\d+))?(?::(\d+))?$/) ?? [];
      if (!path) return ctx.ui.notify(USAGE, 'warning');
      if (col === '0') return ctx.ui.notify('Columns count from 1: 0', 'warning');
      const show = point()?.show;
      if (!show) return ctx.ui.notify('Pi is not attached to Neovim', 'warning');
      try {
        const result = await show({
          path: resolve(ctx.cwd, path),
          line: Number(line),
          endLine: endLine ? Number(endLine) : undefined,
          col: col ? Number(col) - 1 : undefined,
        });
        if (!result.shown) return ctx.ui.notify(`Not now: you are busy in Neovim (mode ${result.busy})`, 'warning');
        const done = [result.opened && 'opened a window', result.scrolled && 'scrolled'].filter(Boolean);
        const from = relative(ctx.cwd, resolve(ctx.cwd, path));
        const where = `${from.startsWith('..') ? resolve(ctx.cwd, path) : from}:${line}${endLine ? `-${endLine}` : ''}`;
        ctx.ui.notify(`Showed ${where} in window ${result.win}${done.length ? ` (${done.join(', ')})` : ''}`, 'info');
      } catch (error) { ctx.ui.notify(errorText(error), 'warning'); }
    },
  });
}
