import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { readFileSync } from 'node:fs';
import { useRemote, type Remote } from '../nvim-remote/api.ts';
import type { Layout, View, Window } from './api.ts';

/** view.lua, installed in each attachment: it sends a view whenever the editor's changes. */
const MODULE = readFileSync(new URL('./view.lua', import.meta.url), 'utf8');
// A view now, and whether it is new: one sent, as if it had come by itself.
const SNAPSHOT = 'if not remote.nvim_view then return vim.NIL end return { remote.nvim_view.current() }';

type Stats = { count: number; built: number };

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0].replace(/^Lua: /, '');
// Fields in the order api.ts gives them, as Lua tables keep none; any others, as options, by name.
const ORDER: Record<string, string[]> = Object.fromEntries(Object.entries({
  view: 'editor focus you pi tabs layout windows buffers',
  editor: 'columns lines cmdheight mode blocking cwd focused',
  focus: 'tab win buf previous',
  pi: 'buf windows',
  tab: 'id number focused',
  layout: 'split children win',
  window: 'id number buf kind focused previous pi row col width height textWidth textOff topline botline leftcol skipcol rows shown cursor screenCursor cwd float options',
  line: 'line row rows fold',
  float: 'relative zindex focusable border',
  buffer: 'id name filetype buftype listed loaded modified readonly modifiable lines bytes changedtick windows lsp pi',
}).map(([shape, keys]) => [shape, keys.split(' ')]));
// What each field holds, by the shape holding it.
const FIELDS: Record<string, Record<string, string>> = {
  view: { editor: 'editor', focus: 'focus', pi: 'pi', tabs: 'tab', layout: 'layout', windows: 'window', buffers: 'buffer' },
  layout: { children: 'layout' },
  window: { shown: 'line', float: 'float' },
};

function ordered(value: unknown, shape = 'view'): unknown {
  if (Array.isArray(value)) return value.map(item => ordered(item, shape));
  if (!value || typeof value !== 'object') return value;
  const order = ORDER[shape] ?? [];
  const rank = (key: string) => order.includes(key) ? order.indexOf(key) : order.length;
  const keys = Object.keys(value).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return Object.fromEntries(keys.map(key => [key, ordered((value as Record<string, unknown>)[key], FIELDS[shape]?.[key])]));
}

// As `:set` shows them: `wrap`, `nowrap`, `signcolumn=auto`.
const set = (values: Record<string, unknown>, keys = Object.keys(values).sort()) => keys
  .map(key => values[key] === true ? key : values[key] === false || values[key] === undefined ? `no${key}` : `${key}=${values[key]}`)
  .join(' ');
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const range = (first: number, last: number) => first === last ? `line ${first}` : `lines ${first}–${last}`;
const layoutOf = (node: Layout): string =>
  'win' in node ? `${node.win}` : `${node.split}[${node.children.map(layoutOf).join(', ')}]`;

// Its lines as runs: `40, 41–44 folded, 45–46`; a wrapped one `39 (4 rows)`, virtual lines
// above one `(2 virtual) 45`.
function shownOf(win: Window) {
  const parts: string[] = [];
  let next = win.row, run: [number, number] | undefined;
  const end = () => { if (run) parts.push(run[0] === run[1] ? `${run[0]}` : `${run[0]}–${run[1]}`); run = undefined; };
  for (const { line, row, rows, fold } of win.shown) {
    const virtual = row - next;
    next = row + rows;
    if (!fold && rows === 1 && !virtual) {
      if (run && line === run[1] + 1) run[1] = line;
      else { end(); run = [line, line]; }
      continue;
    }
    end();
    parts.push(`${virtual ? `(${virtual} virtual) ` : ''}${fold ? `${line}–${fold} folded` : line}${rows > 1 ? ` (${rows} rows)` : ''}`);
  }
  end();
  return parts.join(', ');
}

/** The view, readably, all of it: what `/nvim-view` shows. */
export function describe(view: View, stats?: Stats) {
  const { editor, focus } = view;
  const lines = [
    `Editor ${editor.columns}×${editor.lines}, cmdheight ${editor.cmdheight}, mode ${editor.mode}${editor.blocking ? ' (blocking)' : ''}, cwd ${editor.cwd}`
      + (editor.focused === undefined ? '' : `, terminal ${editor.focused ? 'focused' : 'not focused'}`),
    `Focus: tab ${focus.tab}, window ${focus.win}, buffer ${focus.buf}${focus.previous ? `, previous ${focus.previous}` : ''}; yours ${view.you ?? 'none'}`
      + (view.pi ? `; Pi's buffer ${view.pi.buf} in ${view.pi.windows.join(', ')}` : ''),
    `Tab ${view.tabs.find(tab => tab.focused)?.number} of ${view.tabs.length}; ids ${view.tabs.map(tab => tab.id).join(', ')}`,
    `Layout: ${layoutOf(view.layout)}`,
  ];
  for (const win of view.windows) {
    const marks = [win.id === view.you && 'yours', win.focused && 'focused', win.previous && 'previous', win.pi && 'pi'].filter(Boolean);
    const float = win.float && `, float relative=${win.float.relative} zindex=${win.float.zindex} ${win.float.focusable ? 'focusable' : 'nofocusable'} border=${JSON.stringify(win.float.border)}`;
    lines.push('',
      `Window ${win.id} (#${win.number}), ${win.kind}, buffer ${win.buf}${marks.length ? `  [${marks.join(', ')}]` : ''}`,
      `  ${win.width}×${win.height} at ${win.row},${win.col}, text ${win.textWidth} wide after a gutter of ${win.textOff}${float || ''}`,
      `  ${range(win.topline, win.botline)} in ${plural(win.rows, 'row')}: ${shownOf(win)}`
        + (win.leftcol || win.skipcol ? `; scrolled leftcol ${win.leftcol}, skipcol ${win.skipcol}` : ''),
      `  cursor ${win.cursor[0]}:${win.cursor[1]}, ${win.screenCursor ? `at ${win.screenCursor.join(',')} on screen` : 'not on screen'}`
        + (win.cwd === editor.cwd ? '' : `, cwd ${win.cwd}`),
      `  ${set(win.options)}`);
  }
  for (const buf of view.buffers) {
    const size = buf.lines === undefined ? 'not loaded' : `${plural(buf.lines, 'line')}, ${plural(buf.bytes ?? 0, 'byte')}`;
    lines.push('',
      `Buffer ${buf.id} ${buf.name || '[No Name]'}${buf.filetype ? `, ${buf.filetype}` : ''}${buf.buftype ? `, ${buf.buftype}` : ''}${buf.pi ? '  [pi]' : ''}`,
      `  ${size}, changedtick ${buf.changedtick}, in ${buf.windows.join(', ')}${buf.lsp.length ? `, lsp ${buf.lsp.join(', ')}` : ''}`,
      `  ${set(buf, ['listed', 'loaded', 'modified', 'readonly', 'modifiable'])}`);
  }
  if (stats) lines.push('', `Views sent: ${stats.count}; the last took ${stats.built.toFixed(2)} ms to make`);
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

  const show = (format: (view: View) => string) => async (_args: string, ctx: ExtensionCommandContext) => {
    if (!nvim()) return ctx.ui.notify('Pi is not attached to Neovim', 'warning');
    try {
      const view = await refresh();
      ctx.ui.notify(view ? format(view) : 'No view of the editor yet', 'info');
    } catch (error) { ctx.ui.notify(errorText(error), 'warning'); }
  };

  pi.registerCommand('nvim-view', {
    description: 'Show what nvim-view gives extensions: what is on screen in Neovim, its splits, windows and buffers',
    handler: show(view => describe(view, stats)),
  });
  pi.registerCommand('nvim-view-json', {
    description: 'Show the view nvim-view gives extensions exactly, as JSON',
    handler: show(view => JSON.stringify(ordered(view), null, 2)),
  });
}
