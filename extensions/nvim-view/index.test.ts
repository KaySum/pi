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
import { bufferFor, bufferOf, useView, windowOf, type View } from './api.ts';

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

test('the view shows the tabs, their splits, the windows and the buffers in them', async () => {
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

    const [tab] = v.tabs;
    assert.equal(v.tabs.length, 1);
    assert.equal(tab.focused, true);
    const code = v.windows.find(w => bufferOf(v, w.buf)?.name === path)!;
    const term = v.windows.find(w => w.kind === 'terminal')!;
    const scratch = v.windows.find(w => w.kind === 'nofile')!;
    const float = v.windows.find(w => w.kind === 'float')!;
    assert.deepEqual(tab.layout, { split: 'row', children: [{ split: 'col', children: [{ win: code.id }, { win: scratch.id }] }, { win: term.id }] });
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
    const tab = v.tabs.find(t => t.focused)!;
    const dirs = v.windows.filter(w => w.tab === tab.id).map(w => w.cwd).sort();
    assert.deepEqual(dirs, [home, temp].sort()); // One of its own; one its tab's.
    assert.equal(v.windows.find(w => w.tab !== tab.id)!.cwd, v.editor.cwd);
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

test('changes no event reports are seen: a cursor elsewhere, an unseen buffer edited or unloaded', async () => {
  const { view, changes, shutdown } = await pi();
  try {
    const path = await file('hidden.ts', 1);
    const [other, hidden] = await lua(`vim.o.hidden = true
      vim.api.nvim_buf_set_lines(0, 0, -1, true, { 'a', 'b', 'c' })
      vim.cmd('split')
      local other = vim.fn.win_getid(vim.fn.winnr('#'))
      vim.cmd('edit ' .. vim.fn.fnameescape(...))
      local hidden = vim.api.nvim_get_current_buf()
      vim.cmd('enew')
      return { other, hidden }`, path);
    await eventually(() => view()?.buffers.some(b => b.id === hidden && b.loaded && !b.windows.length));
    await delay(100);
    const latest = () => changes.at(-1)!;

    await editor.request('nvim_win_set_cursor', [other, [2, 0]]); // Not the current window.
    await eventually(() => windowOf(latest(), other)?.cursor[0] === 2);

    await lua('vim.api.nvim_buf_set_lines(..., 0, -1, true, { "first" })', hidden); // Modified, unseen.
    await eventually(() => bufferOf(latest(), hidden)?.modified);
    await lua('vim.api.nvim_buf_set_lines(..., 0, -1, true, { "second", "third" })', hidden); // Again.
    await eventually(() => bufferOf(latest(), hidden)?.lines === 2);

    await lua('vim.cmd("bunload! " .. ...)', hidden);
    const unloaded = await eventually(() => bufferOf(latest(), hidden)?.loaded === false && bufferOf(latest(), hidden));
    assert.deepEqual([unloaded.lines, unloaded.bytes], [undefined, undefined]);
  } finally {
    await lua('vim.o.hidden = false');
    await shutdown();
  }
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

test('buffers no one sees and no one listed are counted, not listed', async () => {
  const { view, shutdown } = await pi();
  try {
    await lua('for _ = 1, 5 do vim.api.nvim_create_buf(false, true) end; vim.api.nvim_create_buf(true, false)');
    const v = await eventually(() => view.refresh()); // Once attached.
    assert.equal(v.omitted, 5);
    assert.ok(v.buffers.some(buf => buf.listed && !buf.windows.length && buf.lines === 1));
  } finally { await shutdown(); }
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

test('/nvim-view shows the view readably, /nvim-view-json exactly', async () => {
  const { view, run, shutdown } = await pi();
  try {
    const path = await file('shown.ts', 40);
    await lua('vim.cmd("edit " .. vim.fn.fnameescape(...) .. " | vsplit")', path);
    const [text, type] = await eventually(async () => { const said = await run('nvim-view'); return said[0].includes('#') && said; });
    assert.equal(type, 'info');
    assert.match(text, /^Editor \d+×\d+, mode n, cwd (\/private)?\/tmp/);
    assert.match(text, /^Tab 1 \(focused\): \[#\d+ \| #\d+\]$/m);
    assert.match(text, /^ {2}#\d+ normal shown\.ts {2}\d+×\d+ at 1,1, text \d+ {2}lines 1–\d+ of 40 {2}cursor 1:0 {2}\[yours, focused\]$/m);
    assert.match(text, new RegExp(`^ {2}#\\d+ shown\\.ts {2}40 lines, ${readFileSync(path).length} B {2}in #\\d+, #\\d+$`, 'm'));
    assert.match(text, /^Views sent: \d+; the last took \d+\.\d\d ms to make$/m);

    const [json] = await run('nvim-view-json');
    assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(await view.refresh())));
  } finally { await shutdown(); }
  const detached = await pi({ view: true });
  await detached.shutdown();
  assert.deepEqual(await detached.run('nvim-view'), ['Pi is not attached to Neovim', 'warning']);
});
