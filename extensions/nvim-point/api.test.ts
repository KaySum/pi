import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import registerRemote from '../nvim-remote/index.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { launch } from '../nvim-service/service.mjs';
import { attach, connect } from '../nvim-remote/remote.ts';
import { point, usePoint, type Pointed, type Shown } from './api.ts';

const service = launch({ cwd: '/tmp', init: 'NONE', graceMs: 100, killMs: 300 });
const { socket } = await service.ready;
after(() => service.stop());
const editor = await connect(socket); // The user.
after(() => editor.close());
const lua = (code: string, ...args: unknown[]): Promise<any> => editor.request('nvim_exec_lua', [code, args]);
const remote = await attach(socket, { onError: () => {} });
after(() => remote.close());
const { show } = point(remote, '/nowhere');

const dir = await realpath(await mkdtemp(join(tmpdir(), 'nvim-point-')));
after(() => rm(dir, { recursive: true, force: true }));
await lua('vim.cmd("filetype on")'); // As the user's config would.
afterEach(async () => {
  await editor.request('nvim_input', ['<C-\\><C-n><Esc>']);
  await lua(`vim.o.hidden, vim.o.wrap, vim.o.cmdheight = true, true, 1
    vim.cmd('silent! tabonly | silent! only | enew! | silent! %bwipeout!')`);
});

let files = 0;
/** A file of `n` numbered lines, or of `lines`. */
async function file(lines: number | string[] = 300, name = `file-${++files}.ts`) {
  const path = join(dir, name);
  const text = typeof lines === 'number' ? Array.from({ length: lines }, (_, i) => `line ${i + 1}`) : lines;
  await writeFile(path, text.join('\n') + '\n');
  return path;
}

/** Your file on the left, a terminal beside it focused, as Pi's would be: [your window, the terminal's]. */
async function layout(path: string): Promise<[number, number]> {
  return lua(`vim.cmd.edit(vim.fn.fnameescape(...))
    local yours = vim.api.nvim_get_current_win()
    vim.cmd('rightbelow vsplit | terminal')
    return { yours, vim.api.nvim_get_current_win() }`, path);
}

type State = { path: string; cursor: [number, number]; top: number; bottom: number; height: number };
/** What `win` shows: its buffer's file, cursor, first and last lines on screen, height. */
const state = (win: number): Promise<State> => lua(`local win = ...
  return vim.api.nvim_win_call(win, function()
    return { path = vim.api.nvim_buf_get_name(0), cursor = vim.api.nvim_win_get_cursor(0),
      top = vim.fn.line('w0'), bottom = vim.fn.line('w$'), height = vim.api.nvim_win_get_height(0) }
  end)`, win);
const current = (): Promise<number> => lua('return vim.api.nvim_get_current_win()');
const windows = (): Promise<number[]> => lua('return vim.api.nvim_tabpage_list_wins(0)');
const bufOf = (path: string): Promise<number> => lua('return vim.fn.bufnr(...)', path);
// Answered even at a prompt, unlike Lua.
const mode = async (): Promise<string> => (await editor.request('nvim_get_mode', []) as { mode: string }).mode;
const shown = (result: Pointed) => {
  assert.ok(result.shown, `busy: ${JSON.stringify(result)}`);
  return result as Shown;
};
/** In `win`, run Ex `command`. */
const inWin = (win: number, command: string) => lua('local win, command = ... vim.api.nvim_win_call(win, function() vim.cmd(command) end)', win, command);
/** The window's jumplist: [{ lnum, path }…] and where in it the window is. */
const jumps = (win: number): Promise<{ list: { lnum: number; path: string }[]; at: number }> => lua(`local win = ...
  local list, at = unpack(vim.fn.getjumplist(win))
  return { list = vim.tbl_map(function(j) return { lnum = j.lnum, path = vim.api.nvim_buf_get_name(j.bufnr) } end, list), at = at }`, win);

// --- Which window -----------------------------------------------------------------------------

test('your window is the one you are in, when it shows a file', async () => {
  const path = await file();
  const yours = await lua('vim.cmd.edit(vim.fn.fnameescape(...)) vim.cmd("vsplit") return vim.api.nvim_get_current_win()', await file());
  assert.equal(shown(await show({ path, line: 10 })).win, yours);
  assert.equal(await current(), yours);
  assert.equal((await state(yours)).path, path);
});

test('from Pi\'s terminal, your window is the one you came from', async () => {
  const [yours, term] = await layout(await file());
  const path = await file();
  assert.equal(shown(await show({ path, line: 10 })).win, yours);
  assert.equal(await current(), term);
});

test('help, quickfix, scratch and terminal windows are never yours; another showing a file is', async () => {
  const mine = await file();
  const yours = await lua('vim.cmd.edit(vim.fn.fnameescape(...)) return vim.api.nvim_get_current_win()', mine);
  // Others above it, the last one entered a scratch window, and a terminal focused.
  await lua(`vim.cmd('new | setlocal buftype=nofile')
    vim.cmd('new | setlocal buftype=help')
    vim.cmd('copen')
    vim.cmd('wincmd t | new | setlocal buftype=nofile | wincmd p')
    vim.cmd('terminal')`);
  const path = await file();
  assert.equal(shown(await show({ path, line: 10 })).win, yours);
});

test('a float is never used, even one showing the file', async () => {
  const path = await file();
  const [yours] = await layout(await file());
  await lua(`vim.api.nvim_open_win(vim.fn.bufadd(...), false, { relative = 'editor', row = 1, col = 1, width = 20, height = 5 })`, path);
  assert.equal(shown(await show({ path, line: 10 })).win, yours);
});

test('a window of another tab is never used, even one showing the file', async () => {
  const path = await file();
  await lua('vim.cmd.edit(vim.fn.fnameescape(...)) vim.cmd("tabnew")', path);
  const [yours] = await layout(await file());
  const result = shown(await show({ path, line: 10 }));
  assert.equal(result.win, yours);
  assert.equal(await lua('return vim.api.nvim_win_get_tabpage(...) == vim.api.nvim_get_current_tabpage()', result.win), true);
});

test('a window showing the file already is preferred to yours, which keeps its file', async () => {
  const mine = await file(), path = await file();
  const [yours, term] = await layout(mine);
  const there = await lua(`local yours, path = ...
    vim.api.nvim_set_current_win(yours)
    vim.cmd('split ' .. vim.fn.fnameescape(path))
    local there = vim.api.nvim_get_current_win()
    vim.api.nvim_set_current_win(select(3, ...))
    return there`, yours, path, term);
  assert.equal(shown(await show({ path, line: 10 })).win, there);
  assert.equal((await state(yours)).path, mine);
});

test('with no window showing a file, one opens left of the current one; nothing else moves', async () => {
  const term = await lua('vim.cmd("terminal") return vim.api.nvim_get_current_win()');
  const path = await file();
  const result = shown(await show({ path, line: 10 }));
  assert.equal(result.opened, true);
  assert.equal(await current(), term);
  assert.deepEqual(await windows(), [result.win, term]);
  assert.equal((await state(result.win)).path, path);
  // Pointing again uses it, not another.
  assert.equal(shown(await show({ path, line: 200 })).opened, false);
  assert.equal((await windows()).length, 2);
});

// --- Opening the file -------------------------------------------------------------------------

test('a file not loaded is loaded and listed, its filetype known, and your window shows it', async () => {
  const [yours] = await layout(await file());
  const path = await file();
  assert.equal(await bufOf(path), -1);
  const result = shown(await show({ path, line: 1 }));
  assert.equal(result.buf, await bufOf(path));
  assert.deepEqual(await lua('local buf = ... return { vim.api.nvim_buf_is_loaded(buf), vim.bo[buf].buflisted, vim.bo[buf].filetype }', result.buf), [true, true, 'typescript']);
  assert.equal((await state(yours)).path, path);
});

test('a file loaded but not listed (as other extensions load them) is listed once shown', async () => {
  const [yours] = await layout(await file());
  const path = await file();
  const buf = await lua('local buf = vim.fn.bufadd(...) vim.fn.bufload(buf) return buf', path);
  assert.equal(shown(await show({ path, line: 1 })).buf, buf);
  assert.equal(await lua('return vim.bo[...].buflisted', buf), true);
  assert.equal((await state(yours)).path, path);
});

test('a file being edited by another Neovim opens without a prompt', async () => {
  const path = await file();
  const other = launch({ cwd: dir, init: 'NONE', graceMs: 100, killMs: 300 });
  const otherEditor = await connect((await other.ready).socket);
  try {
    // Its swap file.
    await otherEditor.request('nvim_command', [`edit ${path}`]);
    await layout(await file());
    assert.equal(shown(await show({ path, line: 5 })).opened, false);
    assert.equal(await mode(), 'nt');
  } finally {
    otherEditor.close();
    await other.stop();
  }
});

test('names with spaces, %, # and other scripts are opened as they are', async () => {
  const [yours] = await layout(await file());
  for (const name of ['with space.ts', '100%.ts', '#hash.ts', 'café ☕.ts', 'a$HOME.ts']) {
    const path = await file(20, name);
    shown(await show({ path, line: 3 }));
    assert.equal((await state(yours)).path, path, name);
  }
});

test('your unsaved changes are kept: the buffer shown already is not reloaded', async () => {
  const path = await file();
  const [yours] = await layout(path);
  await lua('vim.api.nvim_buf_set_lines(vim.fn.bufnr(...), 0, 1, true, { "unsaved" })', path);
  shown(await show({ path, line: 20 }));
  assert.equal(await lua('return vim.api.nvim_buf_get_lines(vim.fn.bufnr(...), 0, 1, true)[1]', path), 'unsaved');
  assert.equal((await state(yours)).cursor[0], 20);
});

test('with \'hidden\' off, your unsaved changes keep your window, the file opening in a split above it', async () => {
  const mine = await file();
  const [yours, term] = await layout(mine);
  await lua('vim.o.hidden = false vim.api.nvim_buf_set_lines(vim.fn.bufnr(...), 0, 1, true, { "changed" })', mine);
  const path = await file();
  const result = shown(await show({ path, line: 10 }));
  assert.equal(result.opened, true);
  assert.deepEqual([(await state(yours)).path, (await state(result.win)).path, await current()], [mine, path, term]);
  assert.equal(await lua('local a, b = ... return vim.fn.win_screenpos(a)[1] < vim.fn.win_screenpos(b)[1]', result.win, yours), true);
});

test('with \'hidden\' off and nothing unsaved, your window shows the file', async () => {
  const [yours] = await layout(await file());
  await lua('vim.o.hidden = false');
  const path = await file();
  assert.deepEqual(shown(await show({ path, line: 10 })).opened, false);
  assert.equal((await state(yours)).path, path);
});

test('a buffer whose file is gone from disk is still shown', async () => {
  const path = await file();
  await lua('vim.fn.bufload(vim.fn.bufadd(...))', path);
  await rm(path);
  const [yours] = await layout(await file());
  shown(await show({ path, line: 10 }));
  assert.equal((await state(yours)).path, path);
});

// --- The cursor -------------------------------------------------------------------------------

test('the cursor goes to the first non-blank of the line, past spaces or tabs, or 0 on a blank line', async () => {
  const path = await file(['    four', '\t\ttabs', '', '   ', 'none']);
  const [yours] = await layout(await file());
  for (const [line, col] of [[1, 4], [2, 2], [3, 0], [4, 2], [5, 0]]) { // A line of blanks: its last, as `^`.
    shown(await show({ path, line }));
    assert.deepEqual((await state(yours)).cursor, [line, col], `line ${line}`);
  }
});

test('a column is a byte, kept within the line, and on a character\'s first byte', async () => {
  const path = await file(['abcdef', 'é😀x', '']);
  const [yours] = await layout(await file());
  const at = async (line: number, col: number) => {
    shown(await show({ path, line, col }));
    return (await state(yours)).cursor;
  };
  assert.deepEqual(await at(1, 3), [1, 3]);
  assert.deepEqual(await at(1, 99), [1, 5]); // The last character.
  assert.deepEqual(await at(2, 2), [2, 2]); // 😀, after é's two bytes.
  assert.deepEqual(await at(2, 4), [2, 2]); // Within 😀: its first byte.
  assert.deepEqual(await at(2, 1), [2, 0]); // Within é.
  assert.deepEqual(await at(3, 5), [3, 0]); // An empty line.
});

test('the first line and the last line can be shown', async () => {
  const path = await file(50);
  const [yours] = await layout(await file());
  shown(await show({ path, line: 50 }));
  assert.equal((await state(yours)).cursor[0], 50);
  assert.equal((await state(yours)).bottom, 50);
  shown(await show({ path, line: 1, endLine: 50 }));
  assert.deepEqual([(await state(yours)).cursor[0], (await state(yours)).top], [1, 1]);
});

// --- Scrolling --------------------------------------------------------------------------------

test('lines on screen already do not scroll the window, wherever on it they are', async () => {
  const path = await file();
  const [yours] = await layout(path);
  await lua('vim.api.nvim_win_call(..., function() vim.fn.winrestview({ topline = 100, lnum = 110 }) end)', yours);
  const { top, bottom } = await state(yours);
  for (const [line, endLine] of [[top, top], [bottom, bottom], [top, bottom], [top + 3, top + 6]]) {
    assert.equal(shown(await show({ path, line, endLine })).scrolled, false, `${line}-${endLine}`);
    assert.deepEqual([(await state(yours)).top, (await state(yours)).cursor[0]], [top, line]);
  }
});

test('lines partly on screen are brought on whole', async () => {
  const path = await file();
  const [yours] = await layout(path);
  const { bottom } = await state(yours);
  assert.equal(shown(await show({ path, line: bottom - 1, endLine: bottom + 2 })).scrolled, true);
  const now = await state(yours);
  assert.ok(now.top <= bottom - 1 && bottom + 2 <= now.bottom, `${now.top}–${now.bottom}`);
});

test('lines off screen, below or above, are centered when they fit with their context', async () => {
  const path = await file();
  const [yours] = await layout(path);
  for (const [line, endLine] of [[200, 205], [150, 150], [20, 24]]) {
    assert.equal(shown(await show({ path, line, endLine })).scrolled, true, `${line}`);
    const { top, bottom } = await state(yours);
    assert.ok(Math.abs((line - top) - (bottom - endLine)) <= 1, `${line}-${endLine} in ${top}–${bottom}`);
  }
});

test('lines too tall for the window start from the top, after their context', async () => {
  const path = await file();
  const [yours] = await layout(path);
  shown(await show({ path, line: 100, endLine: 180 }));
  assert.equal((await state(yours)).top, 97);
  shown(await show({ path, line: 220, endLine: 280, context: 0 }));
  assert.equal((await state(yours)).top, 220);
  shown(await show({ path, line: 30, endLine: 90, context: 8 }));
  assert.equal((await state(yours)).top, 22);
});

test('scroll: top brings the lines to the top, after their context', async () => {
  const path = await file();
  const [yours] = await layout(path);
  shown(await show({ path, line: 200, endLine: 202 }, { scroll: 'top' }));
  assert.equal((await state(yours)).top, 197);
  shown(await show({ path, line: 50 }, { scroll: 'top' }));
  assert.equal((await state(yours)).top, 47);
});

test('scroll: minimal moves the screen least: just past the edge the lines were off', async () => {
  const path = await file();
  const [yours] = await layout(path);
  const { bottom, height } = await state(yours);
  // Below: their last line and its context at the bottom.
  assert.equal(shown(await show({ path, line: 100, endLine: 102 }, { scroll: 'minimal' })).scrolled, true);
  assert.equal((await state(yours)).bottom, 105);
  // Above: their first line after its context at the top.
  shown(await show({ path, line: 60 }, { scroll: 'minimal' }));
  assert.equal((await state(yours)).top, 57);
  // Partly on screen, below: as far as needed.
  const now = await state(yours);
  shown(await show({ path, line: now.bottom - 1, endLine: now.bottom + 1 }, { scroll: 'minimal' }));
  assert.equal((await state(yours)).bottom, now.bottom + 4);
  // On screen: still, as ever.
  assert.equal(shown(await show({ path, line: now.bottom }, { scroll: 'minimal' })).scrolled, false);
  // Too tall for the window: from their start.
  shown(await show({ path, line: 200, endLine: 200 + height + 5 }, { scroll: 'minimal' }));
  assert.equal((await state(yours)).top, 197);
  assert.ok(bottom < 100);
});

test('scroll is center, top or minimal', async () => {
  await assert.rejects(show({ path: await file(), line: 1 }, { scroll: 'middle' as never }), /scroll is center, top or minimal/);
});

test('context counts in centering: more context, lines that no longer fit start from the top', async () => {
  const path = await file();
  const [yours] = await layout(path);
  const { height } = await state(yours);
  // Fits with 3 lines of context each side, not with 10.
  const endLine = 150 + height - 8;
  shown(await show({ path, line: 150, endLine }));
  const centered = await state(yours);
  assert.ok(centered.top <= 147, `${centered.top}`);
  await show({ path, line: 1 });
  shown(await show({ path, line: 150, endLine, context: 10 }));
  assert.equal((await state(yours)).top, 140);
});

test('near the start of the file there is no room above: the window starts at line 1', async () => {
  const path = await file();
  const [yours] = await layout(path);
  await inWin(yours, 'normal! 200Gzt');
  shown(await show({ path, line: 2, endLine: 3 }));
  assert.equal((await state(yours)).top, 1);
});

test('near the end of the file the lines are on screen', async () => {
  const path = await file();
  const [yours] = await layout(path);
  shown(await show({ path, line: 295, endLine: 300 }));
  const now = await state(yours);
  assert.ok(now.top <= 295 && now.bottom === 300, `${now.top}–${now.bottom}`);
});

test('wrapped lines are counted by the rows they take', async () => {
  // Every line wraps over 3 rows of the window (about 40 columns wide).
  const path = await file(Array.from({ length: 100 }, (_, i) => `${i + 1} ${'x'.repeat(100)}`));
  const [yours] = await layout(path);
  shown(await show({ path, line: 50, endLine: 51 }));
  const now = await state(yours);
  assert.ok(now.top <= 50 && 51 <= now.bottom, `${now.top}–${now.bottom}`);
  // Centered by rows: about as many lines above as below, far fewer than by line count.
  assert.ok(Math.abs((50 - now.top) - (now.bottom - 51)) <= 1, `${now.top}–${now.bottom}`);
  assert.ok(now.bottom - now.top < now.height / 2, `${now.top}–${now.bottom}`);
});

test('a closed fold above the lines takes one row', async () => {
  const path = await file();
  const [yours] = await layout(path);
  await inWin(yours, '100,190fold');
  shown(await show({ path, line: 195, endLine: 196, context: 5 }));
  const now = await state(yours);
  // Context: 5 rows above, the fold one of them.
  assert.ok(now.top < 100, `${now.top}`);
  assert.equal(await lua('return vim.api.nvim_win_call(..., function() return vim.fn.foldclosed(150) end)', yours), 100);
});

test('a window smooth-scrolled within a long line is scrolled to the lines whole', async () => {
  const path = await file(Array.from({ length: 60 }, (_, i) => `${i + 1} ${'y'.repeat(i === 30 ? 2000 : 10)}`));
  const [yours] = await layout(path);
  await lua('vim.api.nvim_win_call(..., function() vim.wo.smoothscroll = true vim.fn.winrestview({ topline = 31, skipcol = 400, lnum = 31 }) end)', yours);
  shown(await show({ path, line: 10 }));
  const view = await lua('return vim.api.nvim_win_call(..., function() return vim.fn.winsaveview() end)', yours);
  assert.equal(view.skipcol, 0);
  assert.ok(view.topline <= 10);
});

// --- Folds ------------------------------------------------------------------------------------

test('folds over the lines open, nested ones too; folds elsewhere stay closed', async () => {
  const path = await file();
  const [yours] = await layout(path);
  await inWin(yours, '50,60fold | 40,80fold | 120,130fold');
  shown(await show({ path, line: 55, endLine: 56 }));
  const closed = (line: number) => lua('local win, line = ... return vim.api.nvim_win_call(win, function() return vim.fn.foldclosed(line) end)', yours, line);
  assert.deepEqual([await closed(55), await closed(45), await closed(125)], [-1, -1, 120]);
});

test('lines in a closed fold on screen, too tall once it opens, are scrolled to from their start', async () => {
  const path = await file();
  const [yours] = await layout(path);
  await inWin(yours, '5,250fold');
  shown(await show({ path, line: 240, endLine: 280 }));
  assert.equal((await state(yours)).top, 237);
});

// --- The jumplist -----------------------------------------------------------------------------

test('<C-o> goes back: from another file, and within the same file', async () => {
  const mine = await file(), path = await file();
  const [yours] = await layout(mine);
  await lua('vim.api.nvim_win_set_cursor(..., { 40, 0 })', yours);
  shown(await show({ path, line: 100 }));
  shown(await show({ path, line: 200 }));
  await inWin(yours, 'execute "normal! \\<C-o>"');
  assert.deepEqual([(await state(yours)).path, (await state(yours)).cursor[0]], [path, 100]);
  await inWin(yours, 'execute "normal! \\<C-o>"');
  assert.deepEqual([(await state(yours)).path, (await state(yours)).cursor[0]], [mine, 40]);
});

test('pointing at the line the cursor is on adds no jump', async () => {
  const path = await file();
  const [yours] = await layout(path);
  shown(await show({ path, line: 100 }));
  const before = await jumps(yours);
  shown(await show({ path, line: 100, col: 3 }));
  assert.deepEqual(await jumps(yours), before);
});

test('a window opened for the file starts with no jumps', async () => {
  await lua('vim.cmd("terminal")');
  const result = shown(await show({ path: await file(), line: 100 }));
  assert.equal(result.opened, true);
  assert.deepEqual((await jumps(result.win)).list, []);
});

/** The alternate file of `win`, as <C-^> would go to. */
const alternate = (win: number): Promise<string> => lua('return vim.api.nvim_win_call(..., function() return vim.fn.bufname("#") end)', win);

test('with jump: false, switching files leaves your jumplist and alternate file as they were', async () => {
  const mine = await file(), before = await file();
  const [yours] = await layout(mine);
  // A history of your own: the other file, then back to yours.
  await inWin(yours, `edit ${before} | normal! 50G`);
  await inWin(yours, `edit ${mine} | normal! 20G`);
  const history = await jumps(yours), alt = await alternate(yours);
  assert.equal(alt, before);
  const path = await file();
  for (const line of [100, 200]) shown(await show({ path, line }, { jump: false }));
  assert.deepEqual([(await state(yours)).path, (await state(yours)).cursor[0]], [path, 200]);
  assert.deepEqual([await jumps(yours), await alternate(yours)], [history, alt]);
});

test('with jump: false, moving within the file adds no jump', async () => {
  const path = await file();
  const [yours] = await layout(path);
  const history = await jumps(yours);
  for (const line of [250, 10, 150]) shown(await show({ path, line }, { jump: false }));
  assert.equal((await state(yours)).cursor[0], 150);
  assert.deepEqual(await jumps(yours), history);
});

test('with jump: false, unsaved changes and \'hidden\' off still open a split, yours untouched', async () => {
  const mine = await file();
  const [yours] = await layout(mine);
  await lua('vim.o.hidden = false vim.api.nvim_buf_set_lines(vim.fn.bufnr(...), 0, 1, true, { "changed" })', mine);
  const history = await jumps(yours);
  const result = shown(await show({ path: await file(), line: 10 }, { jump: false }));
  assert.equal(result.opened, true);
  assert.deepEqual([(await state(yours)).path, await jumps(yours)], [mine, history]);
});

// --- While you are busy -----------------------------------------------------------------------

test('while you are inserting, replacing, selecting, mid-command or typing a command, nothing changes', async () => {
  const mine = await file();
  const yours = await lua('vim.cmd.edit(vim.fn.fnameescape(...)) return vim.api.nvim_get_current_win()', mine);
  const path = await file();
  for (const [keys, expected] of [['i', 'i'], ['R', 'R'], ['v', 'v'], ['V', 'V'], ['<C-v>', '\x16'], ['d', 'no'], [':', 'c']]) {
    await editor.request('nvim_input', [keys]);
    assert.equal(await mode(), expected, keys);
    assert.deepEqual(await show({ path, line: 100 }), { shown: false, busy: expected }, keys);
    assert.deepEqual([(await state(yours)).path, (await windows()).length], [mine, 1], keys);
    await editor.request('nvim_input', ['<Esc><Esc>']);
    assert.equal(await mode(), 'n');
  }
});

test('at a prompt (press Enter, or a choice), nothing changes', async () => {
  const mine = await file();
  const yours = await lua('vim.cmd.edit(vim.fn.fnameescape(...)) return vim.api.nvim_get_current_win()', mine);
  // Without a screen, nothing waits.
  const ui = await connect(socket);
  await ui.request('nvim_ui_attach', [80, 24, { ext_linegrid: true }]);
  try {
    const path = await file();
    for (const [keys, expected] of [[':echo "one\\ntwo\\nthree"<CR>', 'r'], [':call confirm("Sure?", "&Yes\\n&No")<CR>', 'r?']]) {
      await editor.request('nvim_input', [keys]);
      // Input is taken in its own time.
      for (let i = 0; i < 50 && await mode() !== expected; i++) await delay(10);
      assert.deepEqual(await show({ path, line: 100 }), { shown: false, busy: expected }, keys);
      await editor.request('nvim_input', ['<Esc>']);
      for (let i = 0; i < 50 && await mode() !== 'n'; i++) await delay(10);
      assert.equal((await state(yours)).path, mine);
    }
  } finally {
    await ui.request('nvim_ui_detach', []);
    ui.close();
  }
});

test('typing to Pi in its terminal is not busy: your window is shown the place', async () => {
  const [yours, term] = await layout(await file());
  await editor.request('nvim_input', ['i']);
  assert.equal(await mode(), 't');
  const path = await file();
  assert.equal(shown(await show({ path, line: 10 })).win, yours);
  assert.deepEqual([await mode(), await current()], ['t', term]);
});

// --- Waiting until you are free ---------------------------------------------------------------

/** You, typing in your file: your window. */
async function typing() {
  const yours = await lua('vim.cmd.edit(vim.fn.fnameescape(...)) return vim.api.nvim_get_current_win()', await file());
  await editor.request('nvim_input', ['i']);
  for (let i = 0; i < 50 && await mode() !== 'i'; i++) await delay(10);
  return yours;
}

test('waiting, it shows the place as soon as you stop typing', async () => {
  const yours = await typing();
  const path = await file();
  const started = performance.now();
  const pending = show({ path, line: 120 }, { wait: 5000 });
  await delay(300);
  assert.equal((await state(yours)).cursor[0], 1); // Not while you type.
  await editor.request('nvim_input', ['<Esc>']);
  const result = shown(await pending);
  assert.equal(result.win, yours);
  assert.deepEqual([(await state(yours)).path, (await state(yours)).cursor[0]], [path, 120]);
  assert.ok(performance.now() - started < 1000, `${performance.now() - started} ms`);
});

test('waiting no longer than it may, it says you are busy, and nothing moves', async () => {
  const yours = await typing();
  const started = performance.now();
  assert.deepEqual(await show({ path: await file(), line: 120 }, { wait: 300 }), { shown: false, busy: 'i' });
  assert.ok(performance.now() - started >= 300);
  await editor.request('nvim_input', ['<Esc>']);
  await delay(250);
  assert.equal((await state(yours)).cursor[0], 1);
});

test('a later show ends an earlier one\'s wait: only the newest place is shown', async () => {
  const yours = await typing();
  const path = await file();
  const first = show({ path, line: 50 }, { wait: Infinity });
  await delay(150);
  const second = show({ path, line: 150 }, { wait: Infinity });
  assert.deepEqual(await first, { shown: false, busy: 'i', superseded: true });
  await editor.request('nvim_input', ['<Esc>']);
  shown(await second);
  assert.equal((await state(yours)).cursor[0], 150);
});

test('even a show that does not wait ends an earlier one\'s', async () => {
  await typing();
  const path = await file();
  const first = show({ path, line: 50 }, { wait: Infinity });
  await delay(150);
  assert.deepEqual(await show({ path, line: 150 }), { shown: false, busy: 'i' });
  assert.equal((await first as { superseded?: true }).superseded, true);
});

test('an abort ends the wait: it rejects, and nothing is shown after', async () => {
  const yours = await typing();
  const controller = new AbortController();
  const pending = show({ path: await file(), line: 120 }, { wait: Infinity, signal: controller.signal });
  await delay(150);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await editor.request('nvim_input', ['<Esc>']);
  await delay(250);
  assert.equal((await state(yours)).cursor[0], 1);
});

test('when you are free already, waiting changes nothing: shown at once', async () => {
  const [yours] = await layout(await file());
  const started = performance.now();
  shown(await show({ path: await file(), line: 70 }, { wait: Infinity }));
  assert.ok(performance.now() - started < 100);
  assert.equal((await state(yours)).cursor[0], 70);
  await assert.rejects(show({ path: await file(), line: 1 }, { wait: -1 }), /wait must be milliseconds/);
  await assert.rejects(show({ path: await file(), line: 1 }, { wait: Number.NaN }), /wait must be milliseconds/);
});

// --- What it resolves to ----------------------------------------------------------------------

test('it resolves to the window, the buffer, and whether it opened a window or scrolled', async () => {
  const path = await file();
  const [yours] = await layout(path);
  const buf = await bufOf(path);
  assert.deepEqual(await show({ path, line: 5 }), { shown: true, win: yours, buf, opened: false, scrolled: false });
  assert.deepEqual(await show({ path, line: 250 }), { shown: true, win: yours, buf, opened: false, scrolled: true });
});

// --- Attachments ------------------------------------------------------------------------------

test('each attachment installs its own, and they work side by side', async () => {
  const other = await attach(socket, { onError: () => {} });
  try {
    const [yours] = await layout(await file());
    const path = await file();
    assert.equal(shown(await point(other).show({ path, line: 30 })).win, yours);
    assert.equal(shown(await show({ path, line: 60 })).win, yours);
    assert.equal((await state(yours)).cursor[0], 60);
  } finally { other.close(); }
});

// --- Other windows, as plugins and configs make them -------------------------------------------

test('with Pi\'s terminal in a float, your window is the one beneath it you came from', async () => {
  const mine = await file();
  const yours = await lua('vim.cmd.edit(vim.fn.fnameescape(...)) return vim.api.nvim_get_current_win()', mine);
  const float = await lua(`local win = vim.api.nvim_open_win(vim.api.nvim_create_buf(false, true), true, { relative = 'editor', row = 2, col = 2, width = 40, height = 10 })
    vim.cmd('terminal')
    return win`);
  const result = shown(await show({ path: await file(), line: 10 }));
  assert.equal(result.win, yours);
  assert.equal(await current(), float);
});

test('with Pi\'s terminal in a float over no file, a window opens beside the windows beneath it', async () => {
  const scratch = await lua('vim.cmd("setlocal buftype=nofile") return vim.api.nvim_get_current_win()');
  const float = await lua(`local win = vim.api.nvim_open_win(vim.api.nvim_create_buf(false, true), true, { relative = 'editor', row = 2, col = 2, width = 40, height = 10 })
    vim.cmd('terminal')
    return win`);
  const path = await file();
  const result = shown(await show({ path, line: 10 }));
  assert.equal(result.opened, true);
  assert.equal(await lua('return vim.api.nvim_win_get_config(...).relative', result.win), '');
  assert.deepEqual([(await state(result.win)).path, await current()], [path, float]);
  assert.ok((await windows()).includes(scratch));
});

test('the window you came from, closed since, is passed over for another showing a file', async () => {
  const [yours] = await layout(await file());
  // From the terminal to a split of it, back, and the split closed: '#' is gone.
  await lua(`vim.cmd('split')
    local gone = vim.api.nvim_get_current_win()
    vim.cmd('wincmd p')
    vim.api.nvim_win_close(gone, true)`);
  assert.equal(await lua('return vim.fn.win_getid(vim.fn.winnr("#"))'), 0);
  assert.equal(shown(await show({ path: await file(), line: 10 })).win, yours);
});

test('of two windows showing the file, the one you came from is used', async () => {
  const path = await file();
  const [first, second] = await lua(`vim.cmd.edit(vim.fn.fnameescape(...))
    local first = vim.api.nvim_get_current_win()
    vim.cmd('vsplit')
    local second = vim.api.nvim_get_current_win()
    vim.cmd('rightbelow vsplit | terminal')
    return { first, second }`, path);
  // The second is left of the first in the tab; you came from it.
  assert.equal(shown(await show({ path, line: 100 })).win, second);
  assert.deepEqual((await state(first)).cursor, [1, 0]);
});

test('a window fixed to its buffer (winfixbuf) keeps it: the file opens in a split above', async () => {
  const mine = await file();
  const [yours] = await layout(mine);
  await lua('vim.wo[...].winfixbuf = true', yours);
  const path = await file();
  const result = shown(await show({ path, line: 10 }));
  assert.equal(result.opened, true);
  assert.deepEqual([(await state(yours)).path, (await state(result.win)).path], [mine, path]);
});

// --- Paths and buffers ------------------------------------------------------------------------

test('a file you opened through a link is found by its real path, and the other way round: one buffer', async () => {
  const path = await file();
  const link = join(dir, `link-${files}.ts`);
  await symlink(path, link);
  const [yours] = await layout(link);
  const buf = await bufOf(link);
  assert.equal(shown(await show({ path, line: 50 })).buf, buf);
  assert.equal(await lua('return #vim.tbl_filter(function(b) return vim.api.nvim_buf_get_name(b) ~= "" and vim.bo[b].buftype == "" end, vim.api.nvim_list_bufs())'), 1);
  assert.equal((await state(yours)).cursor[0], 50);
});

test('a path with . and .. in it is the file it names', async () => {
  const path = await file();
  const [yours] = await layout(path);
  const buf = await bufOf(path);
  await mkdir(join(dir, 'sub'), { recursive: true });
  assert.equal(shown(await show({ path: `${dir}/sub/.././${path.slice(dir.length + 1)}`, line: 60 })).buf, buf);
  assert.equal((await state(yours)).cursor[0], 60);
});

test('<C-^> in your window goes back to your file', async () => {
  const mine = await file();
  const [yours] = await layout(mine);
  shown(await show({ path: await file(), line: 10 }));
  await inWin(yours, 'execute "normal! \\<C-^>"');
  assert.equal((await state(yours)).path, mine);
});

test('your config moving the cursor as a file opens does not move it off the place', async () => {
  await lua(`vim.api.nvim_create_augroup('restore', {})
    vim.api.nvim_create_autocmd({ 'BufReadPost', 'BufWinEnter' }, { group = 'restore', command = 'normal! G' })`);
  try {
    const [yours] = await layout(await file());
    shown(await show({ path: await file(), line: 42 }));
    assert.equal((await state(yours)).cursor[0], 42);
  } finally { await lua('vim.api.nvim_del_augroup_by_name("restore")'); }
});

test('a buffer wiped when hidden, with unsaved changes, is kept: the file opens in a split', async () => {
  const [yours] = await layout(await file());
  await lua(`local win = ...
    local buf = vim.api.nvim_create_buf(false, true)
    vim.bo[buf].bufhidden = 'wipe'
    vim.bo[buf].buftype = ''
    vim.api.nvim_buf_set_lines(buf, 0, -1, true, { 'scratch' })
    vim.api.nvim_win_set_buf(win, buf)`, yours);
  const result = shown(await show({ path: await file(), line: 5 }));
  assert.equal(await lua('return vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(...), 0, 1, true)[1]', yours), 'scratch');
  assert.notEqual(result.win, yours);
});

// --- Size and options -------------------------------------------------------------------------

test('a file of 100,000 lines is shown at its end promptly', async () => {
  const path = await file(100_000);
  const [yours] = await layout(await file());
  const start = performance.now();
  shown(await show({ path, line: 99_990, endLine: 99_995 }));
  assert.ok(performance.now() - start < 500, `${performance.now() - start} ms`);
  const now = await state(yours);
  assert.ok(now.top <= 99_990 && 99_995 <= now.bottom, `${now.top}–${now.bottom}`);
});

/** Where the cursor of `win` is drawn, once the screen is updated: 0 if not on screen. */
const drawn = (win: number) => lua(`local win = ... vim.cmd('redraw')
  local cursor = vim.api.nvim_win_get_cursor(win)
  return vim.fn.screenpos(win, cursor[1], cursor[2] + 1).row`, win);

test('in a line longer than the window, wrapped or not, the cursor ends on screen', async () => {
  const path = await file(['short', 'x'.repeat(100_000), 'short']);
  const [yours] = await layout(await file());
  shown(await show({ path, line: 2, col: 50_000 }));
  assert.deepEqual((await state(yours)).cursor, [2, 50_000]);
  assert.notEqual(await drawn(yours), 0);
  await lua('vim.wo[...].wrap = false', yours);
  shown(await show({ path, line: 2, col: 90_000 }));
  assert.notEqual(await drawn(yours), 0);
});

test('with scrolloff keeping the cursor centered, the lines are still on screen', async () => {
  const path = await file();
  const [yours] = await layout(path);
  await lua('vim.wo[...].scrolloff = 999', yours);
  shown(await show({ path, line: 200, endLine: 204 }));
  await drawn(yours);
  const now = await state(yours);
  assert.ok(now.top <= 200 && 204 <= now.bottom, `${now.top}–${now.bottom}`);
});

test('in a diff, with filler lines above, the lines are on screen', async () => {
  const path = await file();
  const other = await file(Array.from({ length: 300 }, (_, i) => (i % 20 === 0 ? ['extra a', 'extra b'] : []).concat(`line ${i + 1}`)).flat());
  const [yours] = await layout(path);
  await lua(`local yours, other = ...
    vim.api.nvim_win_call(yours, function() vim.cmd('diffthis | vsplit ' .. vim.fn.fnameescape(other) .. ' | diffthis') end)`, yours, other);
  shown(await show({ path, line: 250, endLine: 254 }));
  const now = await state(yours);
  assert.ok(now.top <= 250 && 254 <= now.bottom, `${now.top}–${now.bottom}`);
});

// --- Calls ------------------------------------------------------------------------------------

test('two calls at once both resolve, the later one where the window ends', async () => {
  const path = await file();
  const [yours] = await layout(await file());
  const [a, b] = await Promise.all([show({ path, line: 50 }), show({ path, line: 250 })]);
  assert.deepEqual([shown(a).win, shown(b).win], [yours, yours]);
  assert.equal((await state(yours)).cursor[0], 250);
});

test('once the editor is gone, it rejects', async () => {
  const other = await attach(socket, { onError: () => {} });
  other.close();
  await assert.rejects(point(other).show({ path: await file(), line: 1 }));
});

// --- Harmless to the session -----------------------------------------------------------------

test('Pi\'s terminal is left as it was: its buffer, its scroll, its mode', async () => {
  const [, term] = await layout(await file());
  const before = await lua('return vim.api.nvim_win_call(..., function() return { vim.api.nvim_get_current_buf(), vim.fn.winsaveview() } end)', term);
  shown(await show({ path: await file(), line: 200 }));
  assert.deepEqual(await lua('return vim.api.nvim_win_call(..., function() return { vim.api.nvim_get_current_buf(), vim.fn.winsaveview() } end)', term), before);
  assert.equal(await mode(), 'nt');
});

test('in the command-line window (q:), it waits: no other window can change then', async () => {
  const mine = await file();
  const yours = await lua('vim.cmd.edit(vim.fn.fnameescape(...)) return vim.api.nvim_get_current_win()', mine);
  await editor.request('nvim_input', ['q:']);
  for (let i = 0; i < 50 && await lua('return vim.fn.getcmdwintype()') === ''; i++) await delay(10);
  assert.deepEqual(await show({ path: await file(), line: 10 }), { shown: false, busy: 'cmdwin' });
  await editor.request('nvim_input', [':quit<CR>']);
  for (let i = 0; i < 50 && await lua('return vim.fn.getcmdwintype()') !== ''; i++) await delay(10);
  assert.equal((await state(yours)).path, mine);
});

test('an error in your autocommands does not stop the file being shown in your window', async () => {
  const [yours] = await layout(await file());
  const path = await file();
  await lua(`vim.api.nvim_create_augroup('broken', {})
    vim.api.nvim_create_autocmd('BufWinEnter', { group = 'broken', callback = function() error('broken config') end })`);
  try {
    const result = shown(await show({ path, line: 30 }));
    assert.deepEqual([result.win, result.opened, (await state(yours)).path, (await state(yours)).cursor[0]], [yours, false, path, 30]);
  } finally { await lua('vim.api.nvim_del_augroup_by_name("broken")'); }
});

test('a file changed on disk since it was loaded is shown, reloaded if you had not changed it', async () => {
  const path = await file(['old']);
  await lua('vim.fn.bufload(vim.fn.bufadd(...))', path);
  await writeFile(path, 'new one\nnew two\n');
  await utimes(path, new Date(), new Date(Date.now() + 5000));
  const [yours] = await layout(await file());
  shown(await show({ path, line: 1 }));
  await lua('vim.cmd("checktime")');
  assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(vim.fn.bufnr(...), 0, -1, true)', path), ['new one', 'new two']);
  assert.equal((await state(yours)).path, path);
});

test('a file changed on disk and in Neovim does not leave it at a warning: your changes stay', async () => {
  const ui = await connect(socket);
  await ui.request('nvim_ui_attach', [80, 24, { ext_linegrid: true }]);
  try {
    const path = await file(['old', 'two']);
    const [yours] = await layout(await file());
    await lua('local buf = vim.fn.bufadd(...) vim.fn.bufload(buf) vim.api.nvim_buf_set_lines(buf, 0, 1, true, { "yours" })', path);
    await writeFile(path, 'theirs\ntwo\n');
    await utimes(path, new Date(), new Date(Date.now() + 5000));
    shown(await show({ path, line: 2 }));
    await delay(50); // The warning, told after.
    assert.equal((await editor.request('nvim_get_mode', []) as { blocking: boolean }).blocking, false);
    assert.equal(await lua('return vim.api.nvim_buf_get_lines(vim.fn.bufnr(...), 0, 1, true)[1]', path), 'yours');
    assert.equal((await state(yours)).cursor[0], 2);
    // Told as a message instead.
    await delay(50);
    assert.match(await lua('return vim.api.nvim_exec2("messages", { output = true }).output'), /changed on disk and here: :e! loads it/);
  } finally {
    await editor.request('nvim_input', ['<Esc>']);
    await ui.request('nvim_ui_detach', []);
    ui.close();
  }
});

test('a buffer named like a path that is not a file (scratch, acwrite) is not shown', async () => {
  await layout(await file());
  const scratch = join(dir, 'scratch.ts'), written = join(dir, 'acwrite.ts');
  await lua(`local scratch, written = ...
    local a = vim.api.nvim_create_buf(true, false) vim.api.nvim_buf_set_name(a, scratch) vim.bo[a].buftype = 'nofile'
    local b = vim.api.nvim_create_buf(true, false) vim.api.nvim_buf_set_name(b, written) vim.bo[b].buftype = 'acwrite'`, scratch, written);
  for (const path of [scratch, written]) await assert.rejects(show({ path, line: 1 }), /not a file/, path);
});

// --- Files changed on disk ---------------------------------------------------------------------

/** A file loaded in Neovim, then changed on disk, after `layout`; with `edit`, changed in Neovim too. */
async function changed({ edit = false, remove = false } = {}) {
  const path = await file(['old', 'two']);
  const [yours] = await layout(await file());
  await lua(`local path, edit = ...
    local buf = vim.fn.bufadd(path) vim.fn.bufload(buf)
    if edit then vim.api.nvim_buf_set_lines(buf, 0, 1, true, { 'yours' }) end`, path, edit);
  if (remove) await rm(path);
  else {
    await writeFile(path, 'theirs\ntwo\n');
    await utimes(path, new Date(), new Date(Date.now() + 5000));
  }
  return { path, yours };
}
const messages = (): Promise<string> => lua('return vim.api.nvim_exec2("messages", { output = true }).output');
const handlers = (): Promise<number> => lua('return #vim.api.nvim_get_autocmds({ event = "FileChangedShell" })');

test('a file changed on disk, with \'autoread\' off: left as it was, and you are told', async () => {
  await lua('vim.o.autoread = false vim.cmd("messages clear")');
  try {
    const { path } = await changed();
    shown(await show({ path, line: 1 }));
    await delay(50);
    assert.equal(await lua('return vim.api.nvim_buf_get_lines(vim.fn.bufnr(...), 0, 1, true)[1]', path), 'old');
    assert.match(await messages(), /changed on disk \(changed\): :e! loads it/);
  } finally { await lua('vim.o.autoread = true'); }
});

test('a file deleted on disk with your changes: kept, and you are told', async () => {
  await lua('vim.cmd("messages clear")');
  const { path, yours } = await changed({ edit: true, remove: true });
  shown(await show({ path, line: 2 }));
  await delay(50);
  assert.deepEqual([(await state(yours)).path, await lua('return vim.api.nvim_buf_get_lines(vim.fn.bufnr(...), 0, 1, true)[1]', path)], [path, 'yours']);
  assert.match(await messages(), /changed on disk \(deleted\)/);
});

test('your own FileChangedShell handler is used, not one of ours', async () => {
  await lua(`vim.g.handled = nil
    vim.api.nvim_create_augroup('mine', {})
    vim.api.nvim_create_autocmd('FileChangedShell', { group = 'mine', callback = function() vim.g.handled = vim.v.fcs_reason vim.v.fcs_choice = '' end })`);
  try {
    const { path } = await changed({ edit: true });
    shown(await show({ path, line: 1 }));
    assert.equal(await lua('return vim.g.handled'), 'conflict');
    assert.equal(await handlers(), 1);
  } finally { await lua('vim.api.nvim_del_augroup_by_name("mine")'); }
});

test('nothing of ours is left handling files changed on disk, after or on failure', async () => {
  const { path } = await changed({ edit: true });
  shown(await show({ path, line: 1 }));
  await assert.rejects(show({ path, line: 99 }));
  assert.equal(await handlers(), 0);
});

// --- No traces --------------------------------------------------------------------------------

test('your options, registers, search, histories and buffers are as they were', async () => {
  const mine = await file();
  const [yours] = await layout(mine);
  const snapshot = () => lua(`local mine = ...
    return { shortmess = vim.o.shortmess, unnamed = vim.fn.getreg('"'), search = vim.fn.getreg('/'), cmd = vim.fn.histget(':', -1),
      searches = vim.fn.histget('/', -1), tick = vim.api.nvim_buf_get_changedtick(vim.fn.bufnr(mine)), modified = vim.bo[vim.fn.bufnr(mine)].modified,
      eventignore = vim.o.eventignore, winid = vim.api.nvim_get_current_win() }`, mine);
  await lua('vim.fn.setreg(\'"\', "kept") vim.fn.setreg("/", "pattern") vim.fn.histadd(":", "echo 1") vim.fn.histadd("/", "pattern")');
  const before = await snapshot();
  const path = await file();
  shown(await show({ path, line: 100, endLine: 104 }));
  shown(await show({ path, line: 10 }));
  shown(await show({ path: mine, line: 250 }));
  assert.deepEqual(await snapshot(), { ...before, tick: before.tick });
  assert.equal(await lua('return vim.api.nvim_buf_get_changedtick(vim.fn.bufnr(...))', path), await lua('return vim.api.nvim_buf_get_changedtick(vim.fn.bufnr(...))', path));
  assert.equal(await lua('return vim.bo[vim.fn.bufnr(...)].modified', path), false);
  assert.equal((await state(yours)).cursor[0], 250);
});

test('a file loaded only to find the lines past its end is not left loaded', async () => {
  const path = await file(10);
  await layout(await file());
  await assert.rejects(show({ path, line: 20 }), /past the end/);
  assert.equal(await lua('local buf = vim.fn.bufnr(...) return buf == -1 or not vim.api.nvim_buf_is_loaded(buf)', path), true);
  // One you had loaded stays.
  await lua('vim.fn.bufload(vim.fn.bufadd(...))', path);
  await assert.rejects(show({ path, line: 20 }), /past the end/);
  assert.equal(await lua('return vim.api.nvim_buf_is_loaded(vim.fn.bufnr(...))', path), true);
});

test('an unnamed buffer of yours with unsaved text is kept, and <C-o> goes back to it', async () => {
  const [yours] = await layout(await file());
  const scratch = await lua(`local win = ...
    local buf = vim.api.nvim_create_buf(true, false)
    vim.api.nvim_buf_set_lines(buf, 0, -1, true, { 'notes' })
    vim.api.nvim_win_set_buf(win, buf)
    return buf`, yours);
  shown(await show({ path: await file(), line: 10 }));
  await inWin(yours, 'execute "normal! \\<C-o>"');
  assert.equal(await lua('return vim.api.nvim_win_get_buf(...)', yours), scratch);
  assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(..., 0, -1, true)', scratch), ['notes']);
});

// --- Files that cannot be shown ---------------------------------------------------------------

test('a file that cannot be read is an error, not an empty buffer', async () => {
  const path = await file(10);
  await chmod(path, 0o000);
  try {
    await layout(await file());
    await assert.rejects(show({ path, line: 1 }), /cannot read/);
  } finally { await chmod(path, 0o644); }
});

test('a device or a pipe is not a file', async () => {
  await layout(await file());
  await assert.rejects(show({ path: '/dev/null', line: 1 }), /not a file/);
});

// --- More shapes ------------------------------------------------------------------------------

test('folds by indent, nested, open over the lines; the rest stay closed', async () => {
  const lines = ['top', ...Array.from({ length: 50 }, (_, i) => `  outer ${i}`), ...Array.from({ length: 50 }, (_, i) => `    inner ${i}`), 'bottom', '  other', '  other'];
  const path = await file(lines);
  const [yours] = await layout(path);
  // Levels counted in shiftwidths: two spaces each here.
  await lua('vim.api.nvim_win_call(..., function() vim.bo.shiftwidth = 2 vim.wo.foldmethod = "indent" vim.wo.foldlevel = 0 end)', yours);
  shown(await show({ path, line: 80 }));
  const closed = (line: number) => lua('local win, line = ... return vim.api.nvim_win_call(win, function() return vim.fn.foldclosed(line) end)', yours, line);
  assert.deepEqual([await closed(80), await closed(20), await closed(lines.length)], [-1, -1, lines.length - 1]);
  assert.notEqual(await drawn(yours), 0);
});

test('a context larger than the window is kept within it: the lines are on screen', async () => {
  const path = await file();
  const [yours] = await layout(path);
  shown(await show({ path, line: 150, endLine: 152, context: 1000 }));
  const now = await state(yours);
  assert.ok(now.top <= 150 && 152 <= now.bottom, `${now.top}–${now.bottom}`);
});

// --- Details ----------------------------------------------------------------------------------

test('moving up and down from the place keeps its column', async () => {
  const path = await file(['0123456789', '0123456789', 'ab', '0123456789']);
  const [yours] = await layout(await file());
  shown(await show({ path, line: 1, col: 7 }));
  await inWin(yours, 'normal! jjj');
  assert.deepEqual((await state(yours)).cursor, [4, 7]);
});

test('in a window too small for the context, the place is still on screen', async () => {
  const path = await file();
  const [yours] = await layout(await file());
  await lua('vim.api.nvim_win_set_height(..., 2)', yours);
  shown(await show({ path, line: 150, endLine: 152 }));
  assert.notEqual(await drawn(yours), 0);
  const now = await state(yours);
  assert.ok(now.top <= 150 && 150 <= now.bottom, `${now.top}–${now.bottom}`);
});

test('a read-only file is shown, read-only', async () => {
  const path = await file();
  await chmod(path, 0o444);
  const [yours] = await layout(await file());
  const result = shown(await show({ path, line: 10 }));
  assert.equal((await state(yours)).path, path);
  assert.equal(await lua('return vim.bo[...].readonly', result.buf), true);
});

test('a file with CRLF line ends: lines and columns as in Neovim, no \\r', async () => {
  const path = join(dir, 'dos.ts');
  await writeFile(path, '  one\r\n  two\r\nthree\r\n');
  const [yours] = await layout(await file());
  shown(await show({ path, line: 3, col: 99 }));
  assert.deepEqual((await state(yours)).cursor, [3, 4]);
  shown(await show({ path, line: 2 }));
  assert.deepEqual((await state(yours)).cursor, [2, 2]);
});

test('with only Pi\'s terminal in this tab, a window opens here, not in the tab with your file', async () => {
  const mine = await file();
  await lua('vim.cmd.edit(vim.fn.fnameescape(...)) vim.cmd("tabnew | terminal")', mine);
  const tab = await lua('return vim.api.nvim_get_current_tabpage()');
  const path = await file();
  const result = shown(await show({ path, line: 10 }));
  assert.equal(result.opened, true);
  assert.deepEqual([await lua('return vim.api.nvim_win_get_tabpage(...)', result.win), await lua('return vim.api.nvim_get_current_tabpage()')], [tab, tab]);
});

// --- Many calls -------------------------------------------------------------------------------

/** Numbers from a seed, the same each run: xorshift32. */
function random(seed: number) {
  let x = seed;
  return (n: number) => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) % n;
  };
}

test('200 calls over files, wraps and folds: each place on screen, nothing else moved', async () => {
  const seed = 0x5eed1234, next = random(seed);
  const paths = [
    await file(400),
    await file(Array.from({ length: 300 }, (_, i) => `${i + 1} ${'w'.repeat(i % 7 === 0 ? 150 : i % 5)}`)),
    await file(Array.from({ length: 200 }, (_, i) => `${i % 9 === 0 ? '' : '  '.repeat(i % 4)}line ${i + 1}`)),
  ];
  const [yours, term] = await layout(paths[0]);
  // Closed folds here and there, in the third file.
  await lua(`local yours, path = ...
    vim.api.nvim_win_call(yours, function() vim.cmd.edit(vim.fn.fnameescape(path)) vim.cmd('20,40fold | 100,150fold | 160,170fold') end)`, yours, paths[2]);
  for (let step = 0; step < 200; step++) {
    const path = paths[next(3)];
    const count = await lua('local buf = vim.fn.bufnr(...) return buf ~= -1 and vim.api.nvim_buf_is_loaded(buf) and vim.api.nvim_buf_line_count(buf) or 0', path)
      || (path === paths[0] ? 400 : path === paths[1] ? 300 : 200);
    const line = 1 + next(count), endLine = Math.min(count, line + next(4) * next(8)), context = next(6);
    const where = `step ${step} (seed ${seed}): ${path.slice(dir.length + 1)}:${line}-${endLine} context ${context}`;
    const before = await state(yours);
    const wasOnScreen = before.path === path && before.top <= line && endLine <= before.bottom
      && await lua('local win, a, b = ... return vim.api.nvim_win_call(win, function() for l = a, b do if vim.fn.foldclosed(l) ~= -1 then return false end end return true end)', yours, line, endLine);
    const result = shown(await show({ path, line, endLine, context }));
    const now = await state(yours);
    assert.equal(result.win, yours, where);
    assert.deepEqual([now.path, now.cursor[0]], [path, line], where);
    assert.ok(now.top <= line && line <= now.bottom, `${where}: ${now.top}–${now.bottom}`);
    if (wasOnScreen) assert.equal(result.scrolled, false, where);
    assert.deepEqual([await current(), (await windows()).length, await mode()], [term, 2, 'nt'], where);
  }
});

test('calls on a fresh attachment at once all install it, and all resolve', async () => {
  const fresh = await attach(socket, { onError: () => {} });
  try {
    const [yours] = await layout(await file());
    const path = await file();
    const results = await Promise.all([10, 20, 30, 40, 50].map(line => point(fresh).show({ path, line })));
    assert.deepEqual(results.map(r => shown(r).win), [yours, yours, yours, yours, yours]);
    assert.equal((await state(yours)).cursor[0], 50);
  } finally { fresh.close(); }
});

test('an aborted call rejects, and nothing moves', async () => {
  const [yours] = await layout(await file());
  const before = await state(yours);
  const signal = AbortSignal.abort();
  await assert.rejects(show({ path: await file(), line: 100 }, { signal }));
  assert.deepEqual(await state(yours), before);
});

test('usePoint gives a pointer while Pi is attached, none before or after, a new one on reconnecting', async () => {
  process.env.NVIM = socket;
  delete process.env.PI_NVIM_REMOTE;
  const bus = new EventEmitter(), hooks = new EventEmitter();
  const commands: Record<string, { handler(args: string, ctx: object): Promise<void> }> = {};
  const api = {
    events: { on: (channel: string, handler: (data: unknown) => void) => bus.on(channel, handler), emit: (channel: string, data: unknown) => bus.emit(channel, data) },
    on: (event: string, handler: () => void) => hooks.on(event, handler),
    registerCommand: (name: string, command: { handler(args: string, ctx: object): Promise<void> }) => { commands[name] = command; },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, hasUI: false, ui: { setStatus() {}, notify() {} } };
  const fire = (event: string) => Promise.all(hooks.listeners(event).map(handler => handler({}, ctx)));
  const pointer = usePoint(api);
  assert.equal(pointer(), undefined);
  registerRemote(api);
  const [yours] = await layout(await file());
  const path = await file();

  let ready = new Promise(resolve => bus.once('nvim-remote:ready', resolve));
  await fire('session_start');
  await ready;
  const first = pointer();
  assert.ok(first);
  assert.equal(pointer(), first); // The same, while attached.
  assert.equal(shown(await first.show({ path: path.slice(dir.length + 1), line: 30 })).win, yours); // From Pi's directory.

  // Another attachment: another pointer, its own module installed there.
  ready = new Promise(resolve => bus.once('nvim-remote:ready', resolve));
  await commands['nvim-remote'].handler('reconnect', ctx);
  await ready;
  const second = pointer();
  assert.ok(second && second !== first);
  assert.equal(shown(await second.show({ path, line: 60 })).win, yours);
  assert.equal((await state(yours)).cursor[0], 60);

  await fire('session_shutdown');
  assert.equal(pointer(), undefined);
});

// --- Odd names and buffers --------------------------------------------------------------------

test('a file named with a newline is shown, or refused, but never mistaken for another', async () => {
  const path = await file(20, 'two\nlines.ts');
  const [yours] = await layout(await file());
  const result = await show({ path, line: 3 }).catch((error: Error) => error);
  if (result instanceof Error) assert.doesNotMatch(result.message, /past the end/);
  else assert.equal((await state(yours)).path, path);
});

test('a buffer you added but did not load stays in your list, unloaded, if its lines are past the end', async () => {
  const path = await file(10);
  await layout(await file());
  const buf = await lua('vim.cmd.badd(vim.fn.fnameescape(...)) return vim.fn.bufnr(...)', path);
  await assert.rejects(show({ path, line: 20 }), /past the end/);
  assert.deepEqual(await lua('local buf = ... return { vim.api.nvim_buf_is_valid(buf), vim.api.nvim_buf_is_loaded(buf), vim.bo[buf].buflisted }', buf), [true, false, true]);
});

test('pointing again and again at the same place adds no windows, jumps or scrolling', async () => {
  const path = await file();
  const [yours] = await layout(await file());
  shown(await show({ path, line: 150, endLine: 155 }));
  const jumpsBefore = await jumps(yours), stateBefore = await state(yours);
  for (let i = 0; i < 10; i++) assert.equal(shown(await show({ path, line: 150, endLine: 155 })).scrolled, false);
  assert.deepEqual([await jumps(yours), await state(yours), (await windows()).length], [jumpsBefore, stateBefore, 2]);
});

// --- By its code ------------------------------------------------------------------------------

test('a match is found: the cursor where its code starts, its lines on screen', async () => {
  const path = await file([...Array.from({ length: 150 }, (_, i) => `line ${i + 1}`), '  async function retry(times) {', '    return times;', '  }', ...Array.from({ length: 100 }, (_, i) => `after ${i}`)]);
  const [yours] = await layout(await file());
  shown(await show({ path, match: 'function retry(' }));
  assert.deepEqual((await state(yours)).cursor, [151, 8]);
  // Several lines, the space around each aside: all of them brought on, from where the first starts.
  shown(await show({ path, match: 'async function retry(times) {\n      return times;\n}' }));
  const now = await state(yours);
  assert.deepEqual(now.cursor, [151, 2]);
  assert.ok(now.top <= 151 && 153 <= now.bottom, `${now.top}–${now.bottom}`);
});

test('of several, the one nearest the line given wins, the earlier on a tie; else the first', async () => {
  const path = await file(Array.from({ length: 100 }, (_, i) => (i + 1) % 20 === 0 ? 'target();' : `line ${i + 1}`));
  const [yours] = await layout(await file());
  const at = async (place: { line?: number }) => {
    shown(await show({ path, match: 'target()', ...place }));
    return (await state(yours)).cursor[0];
  };
  assert.deepEqual([await at({}), await at({ line: 1 }), await at({ line: 58 }), await at({ line: 62 }), await at({ line: 50 }), await at({ line: 99 })], [20, 20, 60, 60, 40, 100]);
});

test('a match spanning lines must have them in order, one after another', async () => {
  const path = await file(['a();', 'x();', 'b();', 'a();', 'b();']);
  const [yours] = await layout(await file());
  shown(await show({ path, match: 'a();\nb();' }));
  assert.equal((await state(yours)).cursor[0], 4);
});

test('a match in other scripts puts the cursor on its first byte', async () => {
  const path = await file(['const s = "café ☕";', '// über naïve']);
  const [yours] = await layout(await file());
  shown(await show({ path, match: '☕' }));
  assert.deepEqual((await state(yours)).cursor, [1, 17]); // After é's two bytes.
  shown(await show({ path, match: 'naïve' }));
  assert.deepEqual((await state(yours)).cursor, [2, 9]);
});

test('a match not there, or only space, is an error; a file loaded for it is not left loaded', async () => {
  const path = await file(20);
  await layout(await file());
  await assert.rejects(show({ path, match: 'nowhere()' }), /not found in .*: nowhere\(\)/);
  assert.equal(await lua('local buf = vim.fn.bufnr(...) return buf == -1 or not vim.api.nvim_buf_is_loaded(buf)', path), true);
  await assert.rejects(show({ path, match: '  \n  ' }), /match must be some code/);
  await assert.rejects(show({ path, match: 'line 3', col: 2 } as never), /no endLine or col/);
  await assert.rejects(show({ path, match: 'line 3', endLine: 5 } as never), /no endLine or col/);
  await assert.rejects(show({ path } as never), /needs a line or a match/);
});

test('a match in a file of 100,000 lines is found promptly', async () => {
  const path = await file([...Array.from({ length: 99_990 }, (_, i) => `line ${i + 1}`), 'needle()', ...Array.from({ length: 9 }, () => 'x')]);
  const [yours] = await layout(path);
  const start = performance.now();
  shown(await show({ path, match: 'needle()' }));
  assert.ok(performance.now() - start < 200, `${performance.now() - start} ms`);
  assert.equal((await state(yours)).cursor[0], 99_991);
});

// --- Relative paths ---------------------------------------------------------------------------

test('a relative path is from the directory given, else the process\'s', async () => {
  const path = await file();
  const [yours] = await layout(await file());
  const name = path.slice(dir.length + 1);
  shown(await point(remote, dir).show({ path: name, line: 7 }));
  assert.equal((await state(yours)).path, path);
  shown(await point(remote, join(dir, 'sub')).show({ path: `../${name}`, line: 8 }));
  assert.deepEqual([(await state(yours)).path, (await state(yours)).cursor[0]], [path, 8]);
  // Absolute paths are as they are, whatever the directory.
  shown(await show({ path, line: 9 }));
  assert.equal((await state(yours)).cursor[0], 9);
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    shown(await point(remote).show({ path: name, line: 10 }));
    assert.equal((await state(yours)).cursor[0], 10);
  } finally { process.chdir(cwd); }
});

// --- Errors -----------------------------------------------------------------------------------

test('what cannot be shown is an error, and nothing moves', async () => {
  const path = await file(10);
  const folder = join(dir, 'folder');
  await mkdir(folder);
  const [yours, term] = await layout(await file());
  const before = await state(yours);
  for (const [place, message] of [
    [{ path, line: 0 }, /line must be a whole number from 1/],
    [{ path, line: 1.5 }, /line must be a whole number from 1/],
    [{ path, line: 5, endLine: 4 }, /endLine must be a whole number from line/],
    [{ path, line: 1, col: -1 }, /col must be a whole number from 0/],
    [{ path, line: 1, col: 0.5 }, /col must be a whole number from 0/],
    [{ path, line: 1, context: -2 }, /context must be a whole number from 0/],
    [{ path, line: 11 }, /line 11 is past the end/],
    [{ path, line: 5, endLine: 12 }, /line 12 is past the end/],
    [{ path: join(dir, 'missing.ts'), line: 1 }, /no such file/],
    [{ path: folder, line: 1 }, /not a file/],
  ] as const) {
    await assert.rejects(show(place), message, JSON.stringify(place));
  }
  assert.deepEqual([await state(yours), await current(), (await windows()).length], [before, term, 2]);
});
