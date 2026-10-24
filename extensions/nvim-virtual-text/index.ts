import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { relative } from 'node:path';
import { useRemote, type Remote } from '../nvim-remote/api.ts';
import { call, type Chunk, type Placed } from './api.ts';

const SHOWN = 50;
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
function describe(mark: Inspected, cwd: string) {
  const path = relative(cwd, mark.path).startsWith('..') ? mark.path : relative(cwd, mark.path);
  const lines = mark.endLine && mark.endLine !== mark.line ? `${mark.line}-${mark.endLine}` : `${mark.line}`;
  const flags = [
    mark.match !== undefined && 'match',
    mark.ttl !== undefined && `ttl ${mark.ttl}`,
    mark.invalidate && 'invalidate',
    mark.invalid && 'hidden',
    mark.stale && 'changed while hidden',
  ].filter(Boolean);
  const text = mark.text === undefined ? '' : ` ${mark.position ?? 'eol'} "${preview(mark.text)}"`;
  return `  #${mark.id} ${path || mark.path}:${lines}${text}${flags.length ? `  [${flags.join(', ')}]` : ''}`;
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
