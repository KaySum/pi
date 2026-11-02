import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { usePoint } from './api.ts';

const USAGE = 'Usage: /nvim-point <path>:<line>[-<end line>][:<column>]';
// What went wrong, without the "Lua:" and stack trace an error from the editor carries.
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0].replace(/^Lua: /, '');

const SHOWN = 50;

/**
 * Files and directories under what is typed, from `cwd`: a directory goes on with "/", a file
 * with ":" for its line. Hidden ones once a "." is typed; none once the line is.
 */
export async function completePath(prefix: string, cwd: string) {
  const typed = prefix.trimStart();
  if (/:\d*(-\d*)?(:\d*)?$/.test(typed)) return null;
  const folder = typed.slice(0, typed.lastIndexOf('/') + 1), start = typed.slice(folder.length);
  const entries = await readdir(resolve(cwd, folder || '.'), { withFileTypes: true }).catch(() => []);
  const items = entries
    .filter(entry => entry.name.startsWith(start) && (start.startsWith('.') || !entry.name.startsWith('.')))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, SHOWN)
    .map(entry => {
      const name = entry.isDirectory() ? `${entry.name}/` : entry.name;
      return { value: `${folder}${name}${entry.isDirectory() ? '' : ':'}`, label: name };
    });
  return items.length ? items : null;
}

// A library for other extensions (see api.ts); Pi loads this for its command.
export default function (pi: ExtensionAPI) {
  const point = usePoint(pi);
  // Pi's working directory, which paths typed are from.
  let cwd = process.cwd();
  pi.on('session_start', (_event, ctx) => { cwd = ctx.cwd; });

  pi.registerCommand('nvim-point', {
    description: 'Show a place in your Neovim window, as other extensions would: <path>:<line>[-<end line>][:<column>]',
    getArgumentCompletions: prefix => completePath(prefix, cwd),
    handler: async (args, ctx) => {
      // Columns from 1, as compilers and grep give them.
      const [, path, line, endLine, col] = args.trim().match(/^(.+?):(\d+)(?:-(\d+))?(?::(\d+))?$/) ?? [];
      if (!path) return ctx.ui.notify(USAGE, 'warning');
      if (col === '0') return ctx.ui.notify('Columns count from 1: 0', 'warning');
      const show = point()?.show;
      if (!show) return ctx.ui.notify('Pi is not attached to Neovim', 'warning');
      try {
        const result = await show({
          path,
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
