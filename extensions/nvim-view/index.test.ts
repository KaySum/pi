import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { launch } from '../nvim-service/service.mjs';
import { attach, connect } from '../nvim-remote/remote.ts';
import registerRemote from '../nvim-remote/index.ts';
import registerView from './index.ts';
import { bufferFor, bufferOf, isShown, lineAtRow, shownLine, useView, windowOf, type View } from './api.ts';

const service = launch({ cwd: '/tmp', init: 'NONE', graceMs: 100, killMs: 300 });
const { socket } = await service.ready;
after(() => service.stop());
const editor = await connect(socket); // The user.
after(() => editor.close());
const lua = (code: string, ...args: unknown[]): Promise<any> => editor.request('nvim_exec_lua', [code, args]);
const dir = await realpath(await mkdtemp(join(tmpdir(), 'nvim-view-')));
after(() => rm(dir, { recursive: true, force: true }));
afterEach(() => lua('vim.cmd("silent! tabonly | silent! only | enew! | silent! %bwipeout!")'));

async function eventually<T>(check: () => Promise<T> | T, ms = 3000): Promise<NonNullable<Exclude<T, false | '' | 0>>> {
  for (const end = Date.now() + ms; ; await delay(20)) {
    const value = await check();
    if (value) return value as NonNullable<Exclude<T, false | '' | 0>>;
    if (Date.now() > end) assert.fail(`not within ${ms} ms`);
  }
}

type Command = { handler(args: string, ctx: object): Promise<void> };

/** Pi with nvim-remote and nvim-view loaded (only nvim-view's API if `!view`), its session started. */
async function pi({ view = true } = {}) {
  process.env.NVIM = socket;
  delete process.env.PI_NVIM_REMOTE;
  const bus = new EventEmitter(), hooks = new EventEmitter();
  const commands: Record<string, Command> = {};
  const notes: [string, string | undefined][] = [];
  const api = {
    events: { on: (channel: string, handler: (data: unknown) => void) => bus.on(channel, handler), emit: (channel: string, data: unknown) => bus.emit(channel, data) },
    on: (event: string, handler: () => void) => hooks.on(event, handler),
    registerCommand: (name: string, command: Command) => { commands[name] = command; },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, hasUI: true, ui: { setStatus() {}, notify: (text: string, type?: string) => notes.push([text, type]) } };
  const fire = (event: string) => Promise.all(hooks.listeners(event).map(handler => handler({}, ctx)));
  registerRemote(api);
  if (view) registerView(api);
  const changes: View[] = [];
  const handle = useView(api, change => changes.push(change));
  await fire('session_start');
  const run = async (name: string) => { await commands[name].handler('', ctx); return notes.at(-1)!; };
  return { api, view: handle, changes, run, commands, bus, shutdown: () => fire('session_shutdown') };
}

/** A file of `n` numbered lines. */
async function file(name: string, n: number) {
  const path = join(dir, name);
  await writeFile(path, Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  return path;
}

test('the view shows the splits, the windows and the buffers in them', async () => {
  const { view, shutdown } = await pi();
  try {
    const path = await file('app.ts', 300);
    // Your file on the left, scrolled down; a terminal beside it; a scratch split under it;
    // a float over it all; the terminal focused, as Pi's would be.
    await lua(`vim.cmd('edit ' .. vim.fn.fnameescape(...))
      vim.cmd('normal! 150Gzz')
      vim.cmd('rightbelow vsplit | terminal')
      vim.cmd('wincmd h | rightbelow split | enew | setlocal buftype=nofile')
      vim.api.nvim_open_win(vim.api.nvim_create_buf(false, true), false, { relative = 'editor', row = 2, col = 4, width = 20, height = 3, zindex = 60 })
      vim.cmd('wincmd t | wincmd l')`, path);
    const v = await eventually(async () => { const v = await view.refresh(); return v?.windows.length === 4 && v; });

    assert.deepEqual(v.tabs, [{ id: v.focus.tab, number: 1, focused: true }]);
    const code = v.windows.find(w => bufferOf(v, w.buf)?.name === path)!;
    const term = v.windows.find(w => w.kind === 'terminal')!;
    const scratch = v.windows.find(w => w.kind === 'nofile')!;
    const float = v.windows.find(w => w.kind === 'float')!;
    assert.deepEqual(v.layout, { split: 'row', children: [{ split: 'col', children: [{ win: code.id }, { win: scratch.id }] }, { win: term.id }] });
    assert.deepEqual([term.focused, code.previous, v.focus.win, v.focus.previous], [true, true, term.id, code.id]);
    assert.equal(v.you, code.id); // Not the terminal you are in: the window you came from.
    assert.deepEqual([float.float?.zindex, float.float?.relative], [60, 'editor']);

    // Where the file is shown: what part of it, from where, in how much room.
    assert.ok(code.topline < 150 && code.botline > 150, `${code.topline}–${code.botline}`);
    assert.deepEqual(code.cursor, [150, 0]);
    assert.equal(code.textWidth, code.width - code.textOff);
    assert.deepEqual([code.row, code.col], [1, 1]);
    assert.equal(code.options.wrap, true);

    const buf = bufferFor(v, path)!;
    assert.deepEqual([buf.lines, buf.bytes, buf.listed, buf.loaded, buf.modified, buf.windows], [300, (await readFile(path)).length, true, true, false, [code.id]]);
    assert.equal(windowOf(v, v.you)!.buf, buf.id);
    assert.deepEqual([v.editor.cwd, v.editor.mode], [await realpath('/tmp'), 'nt']); // Normal mode, in a terminal.
  } finally { await shutdown(); }
});

const readFile = async (path: string) => readFileSync(path);

test('changes are sent as they happen, one view for a burst, none when nothing changed', async () => {
  const { view, changes, shutdown } = await pi();
  try {
    await eventually(() => view());
    await delay(100);
    const before = changes.length;
    await lua('vim.cmd("vsplit | split | vsplit")'); // A burst: one view.
    await eventually(() => changes.length > before);
    await delay(100);
    assert.equal(changes.length, before + 1);
    assert.equal(changes.at(-1)!.windows.length, 4);
    assert.equal(view(), changes.at(-1));

    await lua('vim.cmd("doautocmd WinEnter")'); // Nothing changed: nothing sent.
    await delay(100);
    assert.equal(changes.length, before + 1);

    const count = changes.length;
    await lua('vim.api.nvim_buf_set_lines(0, 0, -1, true, { "a", "b", "c" }); vim.cmd("doautocmd TextChanged")');
    const typed = await eventually(() => changes.length > count && changes.at(-1));
    assert.equal(bufferOf(typed, typed.focus.buf)!.lines, 3);
    await lua('vim.api.nvim_win_set_cursor(0, { 3, 0 }); vim.cmd("doautocmd CursorMoved")');
    await eventually(() => windowOf(changes.at(-1)!, changes.at(-1)!.focus.win)!.cursor[0] === 3);

    await lua('vim.cmd("doautocmd FocusLost")');
    await eventually(() => changes.at(-1)!.editor.focused === false);
  } finally { await shutdown(); }
});

test('a window\'s directory is its own, else its tab\'s, else the editor\'s', async () => {
  const { view, shutdown } = await pi();
  try {
    const home = await realpath('/Users'), temp = await realpath('/tmp');
    await lua(`vim.cmd('tabnew | tcd ' .. ...)
      vim.cmd('vsplit | lcd ' .. select(2, ...))`, home, temp);
    const v = await eventually(async () => { const v = await view.refresh(); return v?.tabs.length === 2 && v; });
    assert.deepEqual(v.windows.map(w => w.cwd).sort(), [home, temp].sort()); // One of its own; one its tab's.
    await lua('vim.cmd("tabfirst")');
    const first = await eventually(async () => { const v = await view.refresh(); return v?.tabs[0].focused && v; });
    assert.deepEqual(first.windows.map(w => w.cwd), [first.editor.cwd]);
  } finally {
    await lua(`vim.cmd('cd ' .. ...)`, '/tmp');
    await shutdown();
  }
});

test('a float moved by the API is seen, yet an idle editor makes no views', async () => {
  const { view, changes, shutdown } = await pi();
  try {
    const win = await lua(`return vim.api.nvim_open_win(vim.api.nvim_create_buf(false, true), false, { relative = 'editor', row = 2, col = 3, width = 10, height = 3 })`);
    await eventually(() => view()?.windows.some(w => w.id === win));
    // Counted in the editor: how many snapshots it makes while nothing happens.
    const builds = () => lua(`for _, c in pairs(require('nvim_remote.v1').contexts) do
        local s = c.nvim_view
        if s and not s.counting then
          local snapshot = s.snapshot
          s.counting, s.builds = true, 0
          s.snapshot = function() s.builds = s.builds + 1 return snapshot() end
        end
        if s then return s.builds end
      end`);
    await builds();
    await delay(400);
    assert.ok(await builds() <= 1, `${await builds()} views made while idle`);

    await editor.request('nvim_win_set_config', [win, { relative: 'editor', row: 10, col: 12 }]);
    const moved = await eventually(() => changes.at(-1)?.windows.find(w => w.id === win && w.row === 11));
    assert.equal(moved.col, 13);
    // Nor only where: whatever the view gives of a float, changed by the API alone.
    await editor.request('nvim_win_set_config', [win, { border: 'double' }]);
    await eventually(() => changes.at(-1)?.windows.find(w => w.id === win)?.float?.border);
    await editor.request('nvim_win_set_config', [win, { focusable: false }]);
    await eventually(() => changes.at(-1)?.windows.find(w => w.id === win)?.float?.focusable === false);
  } finally { await shutdown(); }
});

test('changes on screen no event reports are seen: a cursor elsewhere, a buffer shown there edited', async () => {
  const { view, changes, shutdown } = await pi();
  try {
    const path = await file('beside.ts', 1);
    const [other, beside] = await lua(`vim.api.nvim_buf_set_lines(0, 0, -1, true, { 'a', 'b', 'c' })
      vim.cmd('split')
      local other = vim.fn.win_getid(vim.fn.winnr('#'))
      vim.cmd('enew')
      vim.api.nvim_win_set_buf(other, vim.fn.bufadd(...))
      vim.fn.bufload(vim.fn.bufadd(...))
      return { other, vim.api.nvim_win_get_buf(other) }`, path);
    await eventually(() => view()?.buffers.some(b => b.id === beside && b.loaded));
    await delay(100);
    const latest = () => changes.at(-1)!;

    await lua('vim.api.nvim_buf_set_lines(..., 0, -1, true, { "one", "two", "three" })', beside); // Not current.
    await eventually(() => bufferOf(latest(), beside)?.lines === 3);
    await editor.request('nvim_win_set_cursor', [other, [2, 0]]); // Not the current window.
    await eventually(() => windowOf(latest(), other)?.cursor[0] === 2);
    await lua('vim.api.nvim_buf_set_lines(..., 0, -1, true, { "again" })', beside); // Modified already.
    await eventually(() => bufferOf(latest(), beside)?.lines === 1);
  } finally { await shutdown(); }
});

test('with wrap, every line on screen is in the view, with the rows it takes, folds and virtual lines too', async () => {
  const { view, changes, shutdown } = await pi();
  try {
    // Every third line takes 4 rows of 80; with line 37 at the top, 48 has 2 of the 22 rows left.
    const win = await lua(`local lines = {}
      for i = 1, 60 do lines[i] = i % 3 == 0 and string.rep('x', 250) or 'line ' .. i end
      vim.api.nvim_buf_set_lines(0, 0, -1, true, lines)
      vim.cmd('normal! 37Gzt')
      return vim.api.nvim_get_current_win()`);
    const shown = await eventually(() => windowOf(view(), win)?.topline === 37 && windowOf(view(), win)!);
    assert.deepEqual([shown.height, shown.botline, shown.rows, shown.screenCursor], [22, 48, 22, [1, 1]]);
    const long = (line: number) => line % 3 === 0;
    let row = 1;
    assert.deepEqual(shown.shown, Array.from({ length: 12 }, (_, i) => {
      const line = 37 + i, rows = line === 48 ? 2 : long(line) ? 4 : 1;
      return { line, row: (row += rows) - rows, rows };
    }));
    assert.deepEqual([lineAtRow(shown, 4)?.line, lineAtRow(shown, 22)?.line, lineAtRow(shown, 23)], [39, 48, undefined]);

    // A fold closed by the API: one row, its lines hidden, the lines below it come up.
    await lua('vim.cmd("39,44fold")');
    const folded = await eventually(() => windowOf(changes.at(-1), win)?.shown[2].fold === 44 && windowOf(changes.at(-1), win)!);
    assert.deepEqual(folded.shown.slice(2, 4), [{ line: 39, row: 3, rows: 1, fold: 44 }, { line: 45, row: 4, rows: 4 }]);
    assert.deepEqual([isShown(folded, 39), isShown(folded, 40), shownLine(folded, 40)?.line, isShown(folded, 36)], [true, false, 39, false]);

    // Fewer lines than rows: the rest are empty. A line made long by the API wraps.
    await lua('vim.cmd("normal! zE") vim.api.nvim_buf_set_lines(0, 0, -1, true, { "a", "b" }) vim.cmd("normal! gg")');
    await eventually(() => windowOf(changes.at(-1), win)?.rows === 2);
    await lua('vim.api.nvim_buf_set_lines(0, 1, 2, true, { string.rep("y", 200) }) vim.api.nvim_win_set_cursor(0, { 2, 170 })');
    const wrapped = await eventually(() => windowOf(changes.at(-1), win)?.rows === 4 && windowOf(changes.at(-1), win)!);
    assert.deepEqual([wrapped.botline, wrapped.screenCursor, wrapped.shown], [2, [4, 11], [{ line: 1, row: 1, rows: 1 }, { line: 2, row: 2, rows: 3 }]]);

    // Virtual lines a plugin adds above it push its text down.
    await lua('vim.api.nvim_buf_set_extmark(0, vim.api.nvim_create_namespace("test"), 1, 0, { virt_lines = { { { "note" } } }, virt_lines_above = true })');
    const noted = await eventually(() => windowOf(changes.at(-1), win)?.rows === 5 && windowOf(changes.at(-1), win)!);
    assert.deepEqual(noted.shown[1], { line: 2, row: 3, rows: 3 });
    assert.equal(lineAtRow(noted, 2), undefined); // The virtual line's row.
  } finally { await shutdown(); }
});

test('a refresh brings every extension the view it made, and one from a Pi gone is none', async () => {
  const { api, view, shutdown } = await pi();
  try {
    await eventually(() => view());
    const other = useView(api); // Another extension's.
    other();
    // Moved, a float sends no view until the editor is idle: a refresh comes first.
    const win = await lua(`return vim.api.nvim_open_win(vim.api.nvim_create_buf(false, true), false, { relative = 'editor', row = 1, col = 1, width = 5, height = 2 })`);
    const fresh = await view.refresh();
    assert.ok(fresh!.windows.some(w => w.id === win));
    assert.deepEqual([view(), other()], [fresh, fresh]);
  } finally { await shutdown(); }
  // Answered, then the editor goes before the answer is taken: it is no view either.
  {
    const bus = new EventEmitter();
    const api = { events: { on: (c: string, h: (d: unknown) => void) => bus.on(c, h), emit: (c: string, d: unknown) => bus.emit(c, d) }, on() {} } as unknown as ExtensionAPI;
    const handle = useView(api);
    let answer!: (view: View) => void;
    bus.on('nvim-view:refresh', (request: { reply(view: Promise<View>): void }) => request.reply(new Promise(resolve => { answer = resolve; })));
    const asked = handle.refresh();
    answer({ windows: [], buffers: [] } as unknown as View); // nvim-view has its answer,
    bus.emit('nvim-view:stopped', {}); // and the editor goes before this extension takes it.
    assert.equal(await asked, undefined);
    assert.equal(handle(), undefined);
  }
  // Asked before a newer view came, its answer does not replace that view.
  {
    const bus = new EventEmitter();
    const api = { events: { on: (c: string, h: (d: unknown) => void) => bus.on(c, h), emit: (c: string, d: unknown) => bus.emit(c, d) }, on() {} } as unknown as ExtensionAPI;
    const handle = useView(api);
    const older = { windows: [], buffers: [], omitted: 0 } as unknown as View, newer = { ...older, omitted: 1 };
    let answer!: (view: View) => void;
    bus.on('nvim-view:refresh', (request: { reply(view: Promise<View>): void }) => request.reply(new Promise(resolve => { answer = resolve; })));
    const asked = handle.refresh();
    answer(older);
    bus.emit('nvim-view:changed', newer);
    assert.equal(await asked, older); // What the refresh found, as it found it;
    assert.equal(handle(), newer); // the latest, still the newer.
  }
  // Asked, then Pi goes before the answer: it is no view.
  const late = await pi();
  await eventually(() => late.view());
  const asked = late.view.refresh();
  await late.shutdown();
  assert.equal(await asked.catch(() => undefined), undefined);
  assert.equal(late.view(), undefined);
});

test('views keep coming while you type, not only once you stop', async () => {
  const { view, changes, shutdown } = await pi();
  try {
    await eventually(() => view());
    await delay(100);
    const before = changes.length;
    await editor.request('nvim_input', ['i']);
    // Keystrokes closer together than a view's interval, for half a second.
    for (let i = 0; i < 50; i++) {
      await editor.request('nvim_input', ['x']);
      await delay(10);
    }
    const during = changes.length - before;
    await editor.request('nvim_input', ['<Esc>']);
    assert.ok(during >= 5, `${during} views while typing`);
    // Then, once you stop: all of it, and the mode you left in.
    await eventually(() => { const v = changes.at(-1)!; return bufferOf(v, v.focus.buf)?.bytes === 51 && v.editor.mode === 'n'; });
  } finally { await shutdown(); }
});

test('only what is on screen is in the view: not hidden buffers, other tabs or hidden floats', async () => {
  const { view, changes, shutdown } = await pi();
  try {
    const [hidden, float, shown] = await lua(`vim.o.hidden = true
      local hidden = vim.api.nvim_create_buf(true, false)
      vim.api.nvim_buf_set_lines(hidden, 0, -1, true, { 'not on screen' })
      local float = vim.api.nvim_open_win(vim.api.nvim_create_buf(false, true), false, { relative = 'editor', row = 1, col = 1, width = 5, height = 2, hide = true })
      vim.cmd('tabnew')
      local shown = vim.api.nvim_get_current_buf()
      vim.cmd('vsplit | tabfirst')
      return { hidden, float, shown }`);
    const v = await eventually(async () => { const v = await view.refresh(); return v?.tabs.length === 2 && v; });
    assert.deepEqual([bufferOf(v, hidden), windowOf(v, float), bufferOf(v, shown)], [undefined, undefined, undefined]);
    assert.equal(v.windows.length, 1); // This tab's one window; the other tab's two are not on screen.
    assert.deepEqual(v.layout, { win: v.windows[0].id });
    assert.deepEqual(v.tabs.map(t => [t.number, t.focused]), [[1, true], [2, undefined]]);

    // Hidden things changing send nothing; shown, they are in the view, and followed.
    await delay(100);
    const before = changes.length;
    await lua('vim.api.nvim_buf_set_lines(..., 0, -1, true, { "still hidden" })', hidden);
    await delay(150);
    assert.equal(changes.length, before);
    await lua('vim.api.nvim_win_set_config(..., { hide = false })', float);
    await eventually(() => windowOf(view(), float));
    await lua('vim.api.nvim_win_set_buf(0, ...)', hidden);
    await eventually(() => bufferOf(view(), hidden)?.windows.length === 1);
    await lua('vim.api.nvim_buf_set_lines(..., 0, -1, true, { "one", "two" })', hidden);
    await eventually(() => bufferOf(view(), hidden)?.lines === 2);
  } finally {
    await lua('vim.o.hidden = false');
    await shutdown();
  }
});

test('Pi\'s own terminal, and the windows showing it, are marked', async () => {
  const term = await lua(`vim.cmd('terminal') return { buf = vim.api.nvim_get_current_buf(), pid = vim.fn.jobpid(vim.bo.channel) }`);
  // Attached as the process in that terminal would be.
  const remote = await attach(socket, { pid: term.pid, onError: () => {} });
  try {
    remote.on('nvim-view:changed', () => {});
    await remote.lua(readFileSync(new URL('./view.lua', import.meta.url), 'utf8'));
    const v = await remote.lua('return remote.nvim_view.snapshot()') as View;
    const win = v.windows.find(w => w.buf === term.buf)!;
    assert.deepEqual([v.pi?.buf, v.pi?.windows, win.pi, bufferOf(v, term.buf)!.pi], [term.buf, [win.id], true, true]);
    assert.equal(v.you, undefined); // The only window is Pi's.
  } finally { await remote.close(); }
});

test('without Neovim, or once it goes, there is no view; without nvim-view, none either', async () => {
  const { view, bus, shutdown } = await pi();
  await eventually(() => view());
  await shutdown();
  assert.equal(view(), undefined);
  assert.equal(await view.refresh(), undefined);
  bus.removeAllListeners();

  const alone = await pi({ view: false });
  try {
    assert.equal(alone.view(), undefined);
    assert.equal(await alone.view.refresh(), undefined);
  } finally { await alone.shutdown(); }
});

test('/nvim-view shows the view readably, all of it; /nvim-view-json exactly', async () => {
  const { view, run, shutdown } = await pi();
  try {
    const path = await file('shown.ts', 40);
    await lua('vim.cmd("edit " .. vim.fn.fnameescape(...) .. " | vsplit | 3,5fold")', path);
    const [text, type] = await eventually(async () => { const said = await run('nvim-view'); return said[0].includes('folded') && said; });
    assert.equal(type, 'info');
    const v = (await view.refresh())!;
    const [win, other] = [v.focus.win, v.windows.find(w => w.id !== v.focus.win)!.id];
    assert.match(text, /^Editor 80×24, cmdheight 1, mode n, cwd (\/private)?\/tmp$/m);
    assert.match(text, new RegExp(`^Focus: tab ${v.focus.tab}, window ${win}, buffer ${v.focus.buf}, previous ${other}; yours ${win}$`, 'm'));
    assert.match(text, /^Tab 1 of 1; ids \d+$/m);
    assert.match(text, new RegExp(`^Layout: row\\[${win}, ${other}\\]$`, 'm'));
    assert.match(text, new RegExp(`^Window ${win} \\(#1\\), normal, buffer ${v.focus.buf} {2}\\[yours, focused\\]$`, 'm'));
    assert.match(text, /^ {2}40×22 at 1,1, text 40 wide after a gutter of 0$/m);
    assert.match(text, /^ {2}lines 1–24 in 22 rows: 1–2, 3–5 folded, 6–24$/m);
    assert.match(text, /^ {2}cursor 1:0, at 1,1 on screen$/m);
    assert.match(text, /^ {2}colorcolumn= conceallevel=0 .* wrap$/m);
    assert.match(text, new RegExp(`^Buffer ${v.focus.buf} ${path.replace(/[.]/g, '\\.')}$`, 'm'));
    assert.match(text, new RegExp(`^ {2}40 lines, ${readFileSync(path).length} bytes, changedtick \\d+, in ${win}, ${other}$`, 'm'));
    assert.match(text, /^ {2}listed loaded nomodified noreadonly modifiable$/m);
    assert.match(text, /\n\nViews sent: \d+; the last took \d+\.\d\d ms to make$/);

  const [json] = await run('nvim-view-json');
    assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(await view.refresh())));
  } finally { await shutdown(); }
  const detached = await pi({ view: true });
  await detached.shutdown();
  assert.deepEqual(await detached.run('nvim-view'), ['Pi is not attached to Neovim', 'warning']);
});
