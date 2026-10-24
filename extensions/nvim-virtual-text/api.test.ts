import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launch } from '../nvim-service/service.mjs';
import { attach, connect } from '../nvim-remote/remote.ts';
import { virtualText } from './api.ts';

const service = launch({ cwd: '/tmp', init: 'NONE', graceMs: 100, killMs: 300 });
const { socket } = await service.ready;
after(() => service.stop());
const editor = await connect(socket); // The user.
after(() => editor.close());
const lua = (code: string, ...args: unknown[]): Promise<any> => editor.request('nvim_exec_lua', [code, args]);
const remote = await attach(socket, { onError: () => {} });
after(() => remote.close());

const dir = await realpath(await mkdtemp(join(tmpdir(), 'nvim-virtual-text-')));
after(() => rm(dir, { recursive: true, force: true }));
let files = 0;
async function file(text = 'one\ntwo\nthree\n') {
  const path = join(dir, `file-${++files}.txt`);
  await writeFile(path, text);
  return path;
}

const text = virtualText(remote, 'test');
afterEach(() => text.clear());

/** The marks of `group` in the buffer of `path`: [row, col, details]. */
const marks = (path: string, group = 'test') => lua(`local path, group = ...
  local ns = vim.api.nvim_get_namespaces()['nvim-virtual-text.${remote.channel}.' .. group]
  return vim.api.nvim_buf_get_extmarks(vim.fn.bufnr(path), ns, 0, -1, { details = true })`, path, group);

test('text goes where it is asked to, in the highlights given', async () => {
  const path = await file();
  const ids = await text.place([
    { path, line: 1, text: 'after', hl: 'PiVirtualTextInfo' },
    { path, line: 2, col: 1, text: [['in', 'ErrorMsg'], ['line']], position: 'inline' },
    { path, line: 3, text: 'right', position: 'right' },
  ]);
  assert.equal(ids.length, 3);
  const [eol, inline, right] = await marks(path);
  assert.deepEqual([eol[1], eol[3].virt_text, eol[3].virt_text_pos], [0, [['after', 'PiVirtualTextInfo']], 'eol']);
  assert.deepEqual([inline[1], inline[2], inline[3].virt_text, inline[3].virt_text_pos], [1, 1, [['in', 'ErrorMsg'], ['line', 'PiVirtualText']], 'inline']);
  assert.equal(right[3].virt_text_pos, 'right_align');
  // A file the user has not opened is loaded, not listed.
  assert.deepEqual(await lua('local b = vim.fn.bufnr(...); return { vim.api.nvim_buf_is_loaded(b), vim.bo[b].buflisted }', path), [true, false]);
});

test('lines above and below, split at newlines, below the last line marked', async () => {
  const path = await file();
  await text.place([
    { path, line: 1, text: 'first\nsecond', position: 'above' },
    { path, line: 1, endLine: 2, text: 'under', position: 'below', highlight: 'Visual' },
  ]);
  const found = await marks(path);
  const above = found.find((m: any) => m[3].virt_lines_above);
  const below = found.find((m: any) => m[3].virt_lines && !m[3].virt_lines_above);
  const span = found.find((m: any) => m[3].hl_group);
  assert.deepEqual(above[3].virt_lines, [[['first', 'PiVirtualText']], [['second', 'PiVirtualText']]]);
  assert.equal(below[1], 1);
  assert.deepEqual([span[1], span[3].end_row, span[3].hl_eol], [0, 2, true]);
});

test('a style of its own becomes a highlight group, kept across a colorscheme', async () => {
  const path = await file();
  await text.place({ path, line: 1, text: 'hi', hl: { fg: '#ff0000', bold: true } });
  const [[, , , details]] = await marks(path);
  const name = details.virt_text[0][1];
  assert.match(name, /^PiVirtualText_/);
  await lua('vim.cmd.colorscheme("default")');
  const { fg, bold } = await lua('return vim.api.nvim_get_hl(0, { name = ... })', name);
  assert.deepEqual({ fg, bold }, { fg: 0xff0000, bold: true });
});

test('marks go by id, by file, after their ttl, and with each group apart', async () => {
  const a = await file(), b = await file();
  const other = virtualText(remote, 'other');
  const [first] = await text.place([{ path: a, line: 1, text: 'x' }, { path: a, line: 2, text: 'y' }]);
  await text.place({ path: b, line: 1, text: 'z' });
  await other.place({ path: a, line: 3, text: 'theirs' });
  await text.remove(first);
  assert.equal((await marks(a)).length, 1);
  assert.equal(await text.clear({ path: b }), 1);
  assert.equal((await marks(b)).length, 0);
  assert.equal(await text.clear(), 1);
  assert.equal((await marks(a, 'other')).length, 1);
  await other.clear();

  await text.place({ path: a, line: 1, text: 'brief', ttl: 50 });
  assert.equal((await marks(a)).length, 1);
  await delay(150);
  assert.equal((await marks(a)).length, 0);
});

test('fill pads virtual lines to the window showing the buffer', async () => {
  const path = await file();
  await lua('vim.cmd("silent! only | edit " .. vim.fn.fnameescape(...))', path);
  await text.place({ path, line: 1, text: 'wide', position: 'above', fill: true, hl: 'DiffDelete' });
  const [[, , , details]] = await marks(path);
  const width = await lua('return vim.api.nvim_win_get_width(0) - vim.fn.getwininfo(vim.api.nvim_get_current_win())[1].textoff');
  assert.equal(details.virt_lines[0].map((c: string[]) => c[0]).join('').length, width);
  await lua('vim.cmd("silent! %bwipeout!")');
});

test('lines past the end are clamped, and bad marks are refused', async () => {
  const path = await file();
  await text.place({ path, line: 99, text: 'end' });
  assert.equal((await marks(path))[0][1], 2);
  await assert.rejects(text.place({ path: 'relative.txt', line: 1 }), /absolute/);
  await assert.rejects(text.place({ path, line: 0 }), /line/);
  await assert.rejects(text.place({ path: join(dir, 'missing.txt'), line: 1, text: 'x' }), /no such file/);
  assert.throws(() => virtualText(remote, 'bad name'), /group/);
});

test('everything goes when Pi detaches', async () => {
  const path = await file();
  const other = await attach(socket, { onError: () => {} });
  await virtualText(other, 'test').place({ path, line: 1, text: 'gone', highlight: 'Visual' });
  const count = () => lua(`local b = vim.fn.bufnr(...)
    local n = 0
    for name, ns in pairs(vim.api.nvim_get_namespaces()) do
      if name:find('^nvim%-virtual%-text%.${other.channel}%.') then n = n + #vim.api.nvim_buf_get_extmarks(b, ns, 0, -1, {}) end
    end
    return n`, path);
  assert.equal(await count(), 2);
  assert.deepEqual(await other.close(), []);
  assert.equal(await count(), 0);
});
