import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launch } from '../nvim-service/service.mjs';
import { attach, connect } from '../nvim-remote/remote.ts';
import { point, type Pointed, type Shown } from './api.ts';

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
await lua('vim.cmd("filetype on")'); // As the user's config would.
afterEach(async () => {
  await editor.request('nvim_input', ['<C-\\><C-n><Esc>']);
  await lua(`vim.o.hidden, vim.o.wrap = true, true
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
  assert.ok('win' in result, `busy: ${JSON.stringify(result)}`);
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

// --- While you are busy -----------------------------------------------------------------------

test('while you are inserting, replacing, selecting, mid-command or typing a command, nothing changes', async () => {
  const mine = await file();
  const yours = await lua('vim.cmd.edit(vim.fn.fnameescape(...)) return vim.api.nvim_get_current_win()', mine);
  const path = await file();
  for (const [keys, expected] of [['i', 'i'], ['R', 'R'], ['v', 'v'], ['V', 'V'], ['<C-v>', '\x16'], ['d', 'no'], [':', 'c']]) {
    await editor.request('nvim_input', [keys]);
    assert.equal(await mode(), expected, keys);
    assert.deepEqual(await show({ path, line: 100 }), { busy: expected }, keys);
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
      assert.deepEqual(await show({ path, line: 100 }), { busy: expected }, keys);
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

// --- What it resolves to ----------------------------------------------------------------------

test('it resolves to the window, the buffer, and whether it opened a window or scrolled', async () => {
  const path = await file();
  const [yours] = await layout(path);
  const buf = await bufOf(path);
  assert.deepEqual(await show({ path, line: 5 }), { win: yours, buf, opened: false, scrolled: false });
  assert.deepEqual(await show({ path, line: 250 }), { win: yours, buf, opened: false, scrolled: true });
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

// --- Errors -----------------------------------------------------------------------------------

test('what cannot be shown is an error, and nothing moves', async () => {
  const path = await file(10);
  const folder = join(dir, 'folder');
  await mkdir(folder);
  const [yours, term] = await layout(await file());
  const before = await state(yours);
  for (const [place, message] of [
    [{ path: 'relative.ts', line: 1 }, /absolute/],
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
