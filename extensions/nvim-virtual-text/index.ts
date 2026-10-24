import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { relative, resolve } from 'node:path';
import { useRemote, type Remote } from '../nvim-remote/api.ts';
import { completeAdd, markOf } from './add.ts';
import { call, virtualText, type Chunk, type Placed } from './api.ts';

const SHOWN = 50;
/** The group of the marks you place yourself. */
const GROUP = 'user';
// Your window: the one you are in unless it is Pi's terminal (or another like it), else the
// one you came from, else any showing a file.
const YOURS = `local function yours(win)
  return win ~= 0 and vim.api.nvim_win_is_valid(win) and vim.api.nvim_win_get_config(win).relative == ''
    and vim.bo[vim.api.nvim_win_get_buf(win)].buftype == ''
end
local wins = { vim.api.nvim_get_current_win(), vim.fn.win_getid(vim.fn.winnr('#')) }
for _, win in ipairs(vim.list_extend(wins, vim.api.nvim_tabpage_list_wins(0))) do
  if yours(win) then return { buf = vim.api.nvim_win_get_buf(win), line = vim.api.nvim_win_get_cursor(win)[1] } end
end`;
// What went wrong, without the "Lua:" and stack trace an error from the editor carries.
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0].replace(/^Lua: /, '');
type Inspected = Placed & { stale?: true };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const graphemes = new Intl.Segmenter();
/** At most 40 characters as seen, never splitting one (an emoji, an accented letter). */
const preview = (text: Placed['text']) => {
  const flat = typeof text === 'string' ? text : (text ?? []).map((chunk: Chunk) => chunk[0]).join('');
  const shown = Array.from(graphemes.segment(flat.replaceAll('\n', '⏎')), part => part.segment);
  return shown.length > 40 ? `${shown.slice(0, 39).join('')}…` : shown.join('');
};

/** One line for a mark: where, how, what and what is special about it. */
const shortPath = (path: string, cwd: string) => relative(cwd, path).startsWith('..') ? path : relative(cwd, path) || path;

function describe(mark: Inspected, cwd: string) {
  const path = shortPath(mark.path, cwd);
  const lines = mark.endLine && mark.endLine !== mark.line ? `${mark.line}-${mark.endLine}` : `${mark.line}`;
  const flags = [
    mark.match !== undefined && 'match',
    mark.ttl !== undefined && `ttl ${mark.ttl}`,
    mark.invalidate && 'invalidate',
    mark.invalid && 'hidden',
    mark.stale && 'changed while hidden',
  ].filter(Boolean);
  const text = mark.text === undefined ? '' : ` ${mark.position ?? 'eol'} "${preview(mark.text)}"`;
  return `  #${mark.id} ${path}:${lines}${text}${flags.length ? `  [${flags.join(', ')}]` : ''}`;
}

async function report(remote: Remote, cwd: string) {
  // Nothing placed, nothing installed: the module goes in with the first mark.
  if (!(await remote.lua('return remote.nvim_virtual_text ~= nil'))) return 'No virtual text placed';
  const { marks, watched, styles } = await call(remote, 'inspect', []) as { marks: Inspected[]; watched: number; styles: number };
  const groups = Map.groupBy(marks, mark => mark.group);
  const hidden = marks.filter(mark => mark.invalid).length, stale = marks.filter(mark => mark.stale).length;
  const lines = [
    `${plural(marks.length, 'mark')} in ${plural(groups.size, 'group')}, ${plural(new Set(marks.map(mark => mark.buf)).size, 'file')}`
      + (hidden ? `; ${hidden} hidden by a deletion` : '') + (stale ? `; ${stale} changed while hidden` : ''),
  ];
  let shown = 0;
  for (const [group, list] of groups) {
    lines.push(`${group} (${list.length})`);
    for (const mark of list) if (shown++ < SHOWN) lines.push(describe(mark, cwd));
  }
  if (shown > SHOWN) lines.push(`  … ${shown - SHOWN} more`);
  lines.push(`Watching ${plural(watched, 'buffer')}; ${plural(styles, 'style')} made`);
  return lines.join('\n');
}

// A library for other extensions (see api.ts); Pi loads this for its commands.
export default function (pi: ExtensionAPI) {
  const nvim = useRemote(pi);
  const attached = (ctx: ExtensionCommandContext) => {
    const remote = nvim();
    if (!remote) ctx.ui.notify('Pi is not attached to Neovim', 'warning');
    return remote;
  };

  pi.registerCommand('nvim-virtual-text', {
    description: 'Show the virtual text Pi has placed in Neovim: every mark, by group',
    handler: async (_args, ctx) => {
      const remote = attached(ctx);
      if (remote) ctx.ui.notify(await report(remote, ctx.cwd), 'info');
    },
  });

  pi.registerCommand('nvim-virtual-text-add', {
    description: 'Place virtual text at your cursor: [option=value …] <text>, options as for a mark (position=below, hl=…, fg=#…)',
    getArgumentCompletions: completeAdd,
    handler: async (args, ctx) => {
      const remote = attached(ctx);
      if (!remote) return;
      try {
        const mark = markOf(args, await remote.lua(YOURS) ?? undefined, path => resolve(ctx.cwd, path));
        const [id] = await virtualText(remote, GROUP).place(mark);
        const placed = (await virtualText(remote, GROUP).list()).find(m => m.id === id)!;
        ctx.ui.notify(`Placed #${id} at ${shortPath(placed.path, ctx.cwd)}:${placed.line}`, 'info');
      } catch (error) { ctx.ui.notify(errorText(error), 'warning'); }
    },
  });

  pi.registerCommand('nvim-virtual-text-remove', {
    description: 'Remove virtual text by the ids /nvim-virtual-text shows: <id …>',
    handler: async (args, ctx) => {
      const ids = [...args.matchAll(/\d+/g)].map(Number);
      if (!ids.length) return ctx.ui.notify('Usage: /nvim-virtual-text-remove <id …>', 'warning');
      const remote = attached(ctx);
      if (!remote) return;
      const result = await remote.lua('return remote.nvim_virtual_text ~= nil') && await call(remote, 'remove', [null, ids]);
      const removed: number[] = Array.isArray(result) ? result : [];
      const missing = ids.filter(id => !removed.includes(id));
      const said = [
        removed.length && `removed ${removed.map(id => `#${id}`).join(', ')}`,
        missing.length && `no mark ${missing.map(id => `#${id}`).join(', ')}`,
      ].filter(Boolean).join('; ');
      ctx.ui.notify(said[0].toUpperCase() + said.slice(1), missing.length ? 'warning' : 'info');
    },
  });

  pi.registerCommand('nvim-virtual-text-clear', {
    description: 'Remove all the virtual text Pi has placed in Neovim',
    handler: async (_args, ctx) => {
      const remote = attached(ctx);
      if (!remote) return;
      const removed = await call(remote, 'clear', [null, {}]);
      ctx.ui.notify(`Removed ${plural(removed, 'mark')}`, 'info');
    },
  });
}
