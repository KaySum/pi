import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { readFileSync, realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { useRemote, type Remote } from '../nvim-remote/api.ts';
import { bufferOf, type Layout, type View } from './api.ts';

/** view.lua, installed in each attachment: it sends a view whenever the editor's changes. */
const MODULE = readFileSync(new URL('./view.lua', import.meta.url), 'utf8');
// A view now, and whether it is new: one sent, as if it had come by itself.
const SNAPSHOT = 'if not remote.nvim_view then return vim.NIL end return { remote.nvim_view.current() }';

type Stats = { count: number; built: number };

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0].replace(/^Lua: /, '');
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };
// From the working directory, as the editor names it: its real path, links followed.
const shortPath = (path: string, cwd: string) => {
  if (!path) return '[No Name]';
  const from = relative(real(cwd), path);
  return from && !from.startsWith('..') ? from : path;
};
const flags = (list: (string | false | undefined)[]) => {
  const shown = list.filter(Boolean);
  return shown.length ? `  [${shown.join(', ')}]` : '';
};
const layoutOf = (node: Layout): string =>
  'win' in node ? `#${node.win}` : `[${node.children.map(layoutOf).join(node.split === 'row' ? ' | ' : ' / ')}]`;

/** The view, readably: what `/nvim-view` shows. */
export function describe(view: View, cwd: string, stats?: Stats) {
  const { editor } = view;
  const lines = [
    `Editor ${editor.columns}×${editor.lines}, mode ${editor.mode}${editor.blocking ? ' (waiting at a prompt)' : ''}, cwd ${editor.cwd}`
      + (editor.focused === undefined ? '' : editor.focused ? ', terminal focused' : ', terminal not focused'),
  ];
  const tab = view.tabs.find(tab => tab.focused);
  lines.push(`Tab ${tab?.number ?? 1} of ${view.tabs.length}: ${layoutOf(view.layout)}`);
  for (const win of view.windows) {
    const buf = bufferOf(view, win.buf);
    const name = win.pi ? 'Pi' : buf ? shortPath(buf.name, cwd) : `buffer ${win.buf}`;
    const folds = win.shown.filter(shown => shown.fold).map(shown => `${shown.line}–${shown.fold}`);
    const shows = buf?.lines ? `  lines ${win.topline}–${win.botline} of ${buf.lines} in ${win.rows} rows` : '';
    lines.push(`  #${win.id} ${win.kind} ${name}  ${win.width}×${win.height} at ${win.row},${win.col}, text ${win.textWidth}`
      + `${shows}${folds.length ? `, folded ${folds.join(', ')}` : ''}  cursor ${win.cursor[0]}:${win.cursor[1]}`
      + flags([win.id === view.you && 'yours', win.focused && 'focused', win.previous && 'previous', win.float && `float z${win.float.zindex ?? 50}`]));
  }
  lines.push(`Buffers shown: ${view.buffers.length}`);
  for (const buf of view.buffers) {
    const name = buf.pi ? 'Pi terminal' : shortPath(buf.name, cwd);
    const contents = buf.lines === undefined ? 'not loaded' : `${buf.lines} line${buf.lines === 1 ? '' : 's'}, ${size(buf.bytes ?? 0)}`;
    lines.push(`  #${buf.id} ${name}${buf.filetype ? `  ${buf.filetype}` : ''}  ${contents}`
      + `  in ${buf.windows.map(id => `#${id}`).join(', ')}`
      + (buf.lsp.length ? `  lsp ${buf.lsp.join(', ')}` : '')
      + flags([buf.modified && 'modified', !buf.listed && 'unlisted', buf.readonly && 'readonly', buf.buftype]));
  }
  if (stats) lines.push(`Views sent: ${stats.count}; the last took ${stats.built.toFixed(2)} ms to make`);
  return lines.join('\n');
}

export default function (pi: ExtensionAPI) {
  let latest: View | undefined;
  let stats: Stats | undefined;
  let attached: Remote | undefined;

  const install = (remote: Remote) => remote.lua(MODULE);
  const publish = (view: View) => {
    latest = view;
    pi.events.emit('nvim-view:changed', view);
  };

  const nvim = useRemote(pi, remote => {
    attached = remote;
    remote.on('nvim-view:changed', (view: View, sent: Stats) => {
      if (attached !== remote) return;
      stats = sent;
      publish(view);
    });
    // Not awaited: Pi does not wait on the editor; a refresh installs it if this could not.
    void install(remote).catch(() => {});
  });
  pi.events.on('nvim-remote:stopped', () => {
    if (!attached) return;
    attached = latest = stats = undefined;
    pi.events.emit('nvim-view:stopped', {});
  });

  async function refresh() {
    const remote = nvim();
    if (!remote) return undefined;
    let answer = await remote.lua(SNAPSHOT) as [View, boolean] | null;
    if (!answer) {
      await install(remote);
      answer = await remote.lua(SNAPSHOT) as [View, boolean] | null;
    }
    // Asked of an editor since gone, or replaced: its answer is no longer the view.
    if (!answer || attached !== remote) return undefined;
    const [view, changed] = answer;
    // New, it goes to everyone, as a view sent by itself would.
    if (changed) publish(view);
    else latest = view;
    return view;
  }

  pi.events.on('nvim-view:get', request => (request as { reply?: (view?: View) => void })?.reply?.(latest));
  pi.events.on('nvim-view:refresh', request => (request as { reply?: (view: Promise<View | undefined>) => void })?.reply?.(refresh()));

  const show = (render: (view: View, ctx: ExtensionCommandContext) => string) => async (_args: string, ctx: ExtensionCommandContext) => {
    if (!nvim()) return ctx.ui.notify('Pi is not attached to Neovim', 'warning');
    try {
      const view = await refresh();
      ctx.ui.notify(view ? render(view, ctx) : 'No view of the editor yet', 'info');
    } catch (error) { ctx.ui.notify(errorText(error), 'warning'); }
  };

  pi.registerCommand('nvim-view', {
    description: 'Show what nvim-view gives extensions: what is on screen in Neovim, its splits, windows and buffers',
    handler: show((view, ctx) => describe(view, ctx.cwd, stats)),
  });
  pi.registerCommand('nvim-view-json', {
    description: 'Show the view nvim-view gives extensions exactly, as JSON',
    handler: show(view => JSON.stringify(view, null, 2)),
  });
}
