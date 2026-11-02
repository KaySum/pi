import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { launch } from '../nvim-service/service.mjs';
import { attach, connect } from '../nvim-remote/remote.ts';
import registerRemote from '../nvim-remote/index.ts';
import registerPoint from './index.ts';
import { point, type Shown } from './api.ts';

const service = launch({ cwd: '/tmp', init: 'NONE', graceMs: 100, killMs: 300 });
const { socket } = await service.ready;
after(() => service.stop());
const editor = await connect(socket); // The user.
after(() => editor.close());
const lua = (code: string, ...args: unknown[]): Promise<any> => editor.request('nvim_exec_lua', [code, args]);
const remote = await attach(socket, { onError: () => {} });
after(() => remote.close());
const { show } = point(remote);

const dir = await realpath(await mkdtemp(join(tmpdir(), 'nvim-point-')));
after(() => rm(dir, { recursive: true, force: true }));
afterEach(() => lua('vim.o.hidden = true vim.cmd("silent! tabonly | silent! only | enew! | silent! %bwipeout!")'));
await lua('vim.cmd("filetype on")'); // As the user's config would.

/** A file of `n` numbered lines. */
async function file(name: string, n = 300) {
  const path = join(dir, name);
  await writeFile(path, Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  return path;
}

/** Your file on the left, a terminal beside it focused, as Pi's would be: [your window, the terminal's]. */
async function layout(path: string): Promise<[number, number]> {
  return lua(`vim.cmd.edit(vim.fn.fnameescape(...))
    local yours = vim.api.nvim_get_current_win()
    vim.cmd('rightbelow vsplit | terminal')
    return { yours, vim.api.nvim_get_current_win() }`, path);
}

/** What `win` shows: its buffer's file, cursor, first and last lines on screen. */
const state = (win: number) => lua(`local win = ...
  return vim.api.nvim_win_call(win, function()
    return { path = vim.api.nvim_buf_get_name(0), cursor = vim.api.nvim_win_get_cursor(0), top = vim.fn.line('w0'), bottom = vim.fn.line('w$') }
  end)`, win);
const current = () => lua('return vim.api.nvim_get_current_win()');

test('the place is shown in your window, not Pi\'s terminal, and focus stays in the terminal', async () => {
  const [yours, term] = await layout(await file('mine.ts'));
  const path = await file('there.ts');
  const shown = await show({ path, line: 150, col: 2 }) as Shown;
  assert.deepEqual(shown, { win: yours, buf: shown.buf, opened: false, scrolled: true });
  const now = await state(yours);
  assert.deepEqual([now.path, now.cursor], [path, [150, 2]]);
  assert.ok(now.top <= 150 && 150 <= now.bottom, `${now.top}–${now.bottom}`);
  assert.equal(await current(), term);
  // As the user would have it: listed, its type known.
  assert.deepEqual(await lua('local buf = ... return { vim.bo[buf].buflisted, vim.bo[buf].filetype }', shown.buf), [true, 'typescript']);
});

test('lines on screen already are not scrolled to; others are brought on whole, centered if they fit', async () => {
  const path = await file('code.ts');
  const [yours] = await layout(path);
  assert.deepEqual(await show({ path, line: 5, endLine: 8 }), { win: yours, buf: await lua('return vim.fn.bufnr(...)', path), opened: false, scrolled: false });
  assert.deepEqual((await state(yours)).cursor, [5, 0]);

  assert.equal((await show({ path, line: 200, endLine: 210 }) as Shown).scrolled, true);
  const centered = await state(yours);
  assert.ok(centered.top <= 200 && 210 <= centered.bottom, `${centered.top}–${centered.bottom}`);
  assert.ok(Math.abs((200 - centered.top) - (centered.bottom - 210)) <= 1, `${centered.top}–${centered.bottom}`);

  // Taller than the window: from its start, with 3 lines of context above.
  await show({ path, line: 100, endLine: 160 });
  assert.equal((await state(yours)).top, 97);
});

test('<C-o> in your window goes back to where you were', async () => {
  const mine = await file('mine.ts');
  const [yours] = await layout(mine);
  await lua('vim.api.nvim_win_set_cursor(..., { 40, 0 })', yours);
  await show({ path: await file('there.ts'), line: 100 });
  await lua('vim.api.nvim_win_call(..., function() vim.cmd([[execute "normal! \\<C-o>"]]) end)', yours);
  const back = await state(yours);
  assert.deepEqual([back.path, back.cursor[0]], [mine, 40]);
});

test('while you are typing in your window it waits, and changes nothing', async () => {
  const mine = await file('mine.ts');
  await lua('vim.cmd.edit(vim.fn.fnameescape(...))', mine);
  await editor.request('nvim_input', ['i']);
  assert.deepEqual(await show({ path: await file('there.ts'), line: 100 }), { busy: 'i' });
  assert.equal((await state(await current())).path, mine);
  await editor.request('nvim_input', ['<Esc>']);
});

test('your unsaved changes are kept: with \'hidden\' off, the file opens in a split', async () => {
  const mine = await file('mine.ts');
  const [yours, term] = await layout(mine);
  await lua('vim.o.hidden = false vim.api.nvim_buf_set_lines(vim.fn.bufnr(...), 0, 1, true, { "changed" })', mine);
  const path = await file('there.ts');
  const shown = await show({ path, line: 10 });
  assert.ok('win' in shown && shown.opened && shown.win !== yours);
  assert.equal((await state(yours)).path, mine);
  assert.equal((await state(shown.win)).path, path);
  assert.equal(await current(), term);
});

test('with no window showing a file, one opens beside Pi\'s terminal, focus staying there', async () => {
  const term = await lua('vim.cmd("terminal") return vim.api.nvim_get_current_win()');
  const path = await file('there.ts');
  const shown = await show({ path, line: 20 });
  assert.ok('win' in shown && shown.opened);
  assert.deepEqual([(await state(shown.win)).path, await current()], [path, term]);
  assert.equal(await lua('return #vim.api.nvim_tabpage_list_wins(0)'), 2);
});

test('a window showing the file already is the one used, and folds over the place open', async () => {
  const mine = await file('mine.ts'), path = await file('there.ts');
  const [yours] = await layout(mine);
  const there = await lua(`local yours, path = ...
    vim.api.nvim_set_current_win(yours)
    vim.cmd('split ' .. vim.fn.fnameescape(path) .. ' | 40,60fold | wincmd p')
    return vim.fn.win_getid(vim.fn.winnr('#'))`, yours, path);
  // In the window that showed it, not yours, which still shows your file.
  const shown = await show({ path, line: 50, endLine: 55 });
  assert.equal('win' in shown && shown.win, there);
  assert.equal((await state(yours)).path, mine);
  assert.equal(await lua('local win = ... return vim.api.nvim_win_call(win, function() return vim.fn.foldclosed(50) end)', there), -1);

  // Within a closed fold on screen: not on screen once the fold opens, so brought on, taller
  // than the window, from its start.
  await lua(`vim.api.nvim_win_call(..., function() vim.cmd('normal! zE') vim.cmd('5,250fold') vim.fn.winrestview({ topline = 1 }) end)`, there);
  await show({ path, line: 240, endLine: 249 });
  assert.equal((await state(there)).top, 237);
});

test('a place that is not there is an error, and nothing moves', async () => {
  const path = await file('short.ts', 10);
  await assert.rejects(show({ path: 'short.ts', line: 1 }), /absolute/);
  await assert.rejects(show({ path, line: 0 }), /from 1/);
  await assert.rejects(show({ path, line: 5, endLine: 4 }), /from line/);
  await assert.rejects(show({ path, line: 11 }), /past the end/);
  await assert.rejects(show({ path: join(dir, 'missing.ts'), line: 1 }), /no such file/);
});

type Command = { handler(args: string, ctx: object): Promise<void> };

/** Pi with nvim-remote (unless `!remote`) and nvim-point loaded, its session started. */
async function pi({ remote = true } = {}) {
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
  const ready = new Promise(resolve => bus.once('nvim-remote:ready', resolve));
  if (remote) registerRemote(api);
  registerPoint(api);
  await fire('session_start');
  if (remote) await ready;
  const run = async (args: string) => { await commands['nvim-point'].handler(args, ctx); return notes.at(-1)!; };
  return { run, shutdown: () => fire('session_shutdown') };
}

test('/nvim-point shows a place as path:line[-end][:column], columns from 1', async () => {
  const { run, shutdown } = await pi();
  try {
    const [yours] = await layout(await file('mine.ts'));
    await file('there.ts');
    assert.deepEqual(await run('there.ts:120-125:3'), [`Showed there.ts:120-125 in window ${yours} (scrolled)`, 'info']);
    assert.deepEqual((await state(yours)).cursor, [120, 2]);
    assert.deepEqual(await run('there.ts'), ['Usage: /nvim-point <path>:<line>[-<end line>][:<column>]', 'warning']);
    assert.deepEqual(await run('there.ts:999'), [`line 999 is past the end of ${join(dir, 'there.ts')}, at 300`, 'warning']);
  } finally { await shutdown(); }
  const detached = await pi({ remote: false });
  assert.deepEqual(await detached.run('there.ts:1'), ['Pi is not attached to Neovim', 'warning']);
});
