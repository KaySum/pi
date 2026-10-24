import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launch } from '../nvim-service/service.mjs';
import { createScreen } from '../nvim-service/screen.mjs';
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
afterEach(async () => {
  await text.clear();
  await lua('vim.cmd("silent! only | silent! %bwipeout!")');
});

type Extmark = [id: number, row: number, col: number, details: Record<string, any>];
/** The extmarks of `group` in the buffer of `path`. */
const extmarks = (path: string, group = 'test'): Promise<Extmark[]> => lua(`local path, group = ...
  local ns = vim.api.nvim_get_namespaces()['nvim-virtual-text.${remote.channel}.' .. group]
  return vim.api.nvim_buf_get_extmarks(vim.fn.bufnr(path), ns, 0, -1, { details = true })`, path, group);
/** Those that show text: [row, col, details]. */
const shown = async (path: string, group?: string) =>
  (await extmarks(path, group)).filter(m => m[3].virt_text || m[3].virt_lines).map(([, row, col, details]) => [row, col, details] as const);
const words = (line: string[][]) => line.map(chunk => chunk[0]).join('');
const open = (path: string) => lua('vim.cmd.edit(...)', path);

test('text goes where it is asked to, in the highlights given', async () => {
  const path = await file();
  const ids = await text.place([
    { path, line: 1, text: 'after', hl: 'PiVirtualTextInfo' },
    { path, line: 2, col: 1, text: [['in', 'ErrorMsg'], ['line']], position: 'inline' },
    { path, line: 3, text: 'right', position: 'right' },
    { path, line: 3, text: 'aligned\nacross', position: 40 },
  ]);
  assert.equal(ids.length, 4);
  const found = await shown(path);
  const [eol, inline, right, column] = ['eol', 'inline', 'right_align', 'win_col'].map(pos => found.find(m => m[2].virt_text_pos === pos)!);
  assert.deepEqual([eol[0], eol[2].virt_text, eol[2].virt_text_pos], [0, [['after', 'PiVirtualTextInfo']], 'eol']);
  assert.deepEqual([inline[0], inline[1], inline[2].virt_text, inline[2].virt_text_pos], [1, 1, [['in', 'ErrorMsg'], ['line', 'PiVirtualText']], 'inline']);
  assert.equal(right[2].virt_text_pos, 'right_align');
  assert.deepEqual([column[2].virt_text_win_col, words(column[2].virt_text)], [40, 'aligned across']);
  // A file the user has not opened is loaded, not listed.
  assert.deepEqual(await lua('local b = vim.fn.bufnr(...); return { vim.api.nvim_buf_is_loaded(b), vim.bo[b].buflisted }', path), [true, false]);
});

test('lines above and below, split at newlines, below the last line marked', async () => {
  const path = await file();
  await text.place([
    { path, line: 1, text: 'first\nsecond', position: 'above' },
    { path, line: 1, endLine: 2, text: 'under', position: 'below', highlight: 'Visual' },
  ]);
  const [above, below] = await shown(path);
  assert.deepEqual([above[2].virt_lines, above[2].virt_lines_above], [[[['first', 'PiVirtualText']], [['second', 'PiVirtualText']]], true]);
  assert.equal(below[0], 1);
  const span = (await extmarks(path)).find(m => m[3].hl_group)!;
  assert.deepEqual([span[1], span[3].end_row, span[3].hl_eol], [0, 2, true]);
});

test('a span of characters, and a sign by the line', async () => {
  const path = await file('let answer = 42\n');
  await text.place({ path, line: 1, col: 4, endCol: 10, highlight: 'Search', sign: ['▶', 'WarningMsg'] });
  const found = await extmarks(path);
  const [, row, col, span] = found.find(m => m[3].hl_group)!;
  assert.deepEqual([row, col, span.end_row, span.end_col, span.hl_eol], [0, 4, 0, 10, false]);
  const [, signRow, , sign] = found.find(m => m[3].sign_text)!;
  assert.deepEqual([signRow, sign.sign_text.trim(), sign.sign_hl_group], [0, '▶', 'WarningMsg']);
});

/** The editor's screen as the user sees it, 60 by 8, while `work` runs; `resize` resizes it. */
async function screen<T>(work: (rows: () => Promise<string[]>, resize: (width: number, height: number) => Promise<unknown>) => Promise<T>) {
  const ui = await connect(socket);
  const grid = createScreen();
  ui.on('redraw', (...batches: unknown[]) => grid.apply(batches));
  try {
    await ui.request('nvim_ui_attach', [60, 8, { ext_linegrid: true }]);
    return await work(
      async () => { await lua('vim.cmd.redraw()'); await delay(50); return grid.lines(); },
      (width, height) => ui.request('nvim_ui_try_resize', [width, height]),
    );
  } finally { ui.close(); }
}

test('a sign shows by its first line only, however many it marks', async () => {
  const path = await file('a\ntarget\nb\nc\n');
  await open(path);
  await text.place({ path, line: 2, endLine: 3, sign: '!', highlight: 'Visual' });
  const rows = await screen(rows => rows());
  assert.deepEqual(rows.slice(0, 4).map(row => row.trimEnd()), ['  a', '! target', '  b', '  c']);
});

test('indent lines up with the code, and wrap breaks at spaces', async () => {
  const path = await file('top\n\t  nested\n');
  await lua('vim.o.tabstop = 4');
  await text.place([
    { path, line: 2, text: 'about nested', position: 'above', indent: true },
    { path, line: 1, text: 'one two three four five', position: 'below', indent: 2, wrap: 12 },
  ]);
  const [[, , below], [, , above]] = await shown(path);
  assert.deepEqual(above.virt_lines, [[['      '], ['about nested', 'PiVirtualText']]]);
  assert.deepEqual(below.virt_lines.map(words), ['  one two ', '  three four ', '  five']);
});

test('wrap keeps a word whole across highlights', async () => {
  const path = await file();
  await text.place({ path, line: 1, text: [['hel', 'Title'], ['lo world', 'ErrorMsg']], position: 'below', wrap: 4 });
  const [[, , details]] = await shown(path);
  assert.deepEqual(details.virt_lines, [[['hel', 'Title'], ['lo ', 'ErrorMsg']], [['world', 'ErrorMsg']]]);
});

test('wrap measures tabs where they fall, so text that fits stays on one line', async () => {
  for (const tabstop of [2, 4, 8]) {
    const path = await file();
    await lua('local path, tabstop = ...; local b = vim.fn.bufadd(path); vim.fn.bufload(b); vim.bo[b].tabstop = tabstop', path, tabstop);
    const width = await lua('return vim.api.nvim_buf_call(vim.fn.bufnr(...), function() return vim.fn.strdisplaywidth("a\\tb") end)', path);
    await text.place([
      { path, line: 1, text: 'a\tb', position: 'below', wrap: width },
      { path, line: 2, text: 'a\tb', position: 'below', wrap: width - 1 },
    ]);
    const [[, , fits], [, , over]] = await shown(path);
    assert.equal(fits.virt_lines.length, 1, `tabstop ${tabstop}`);
    assert.equal(over.virt_lines.length, 2, `tabstop ${tabstop}`);
    await text.clear();
  }
});

test('wrap fits the window showing the buffer', async () => {
  const path = await file();
  await open(path);
  const width = await lua('return vim.api.nvim_win_get_width(0) - vim.fn.getwininfo(vim.api.nvim_get_current_win())[1].textoff');
  await text.place({ path, line: 1, text: 'word '.repeat(width), position: 'below', wrap: true });
  const [[, , details]] = await shown(path);
  assert.ok(details.virt_lines.length > 1);
  for (const line of details.virt_lines) assert.ok(words(line).trimEnd().length <= width);
});

test('fill pads virtual lines to the editor, cut at the edge of narrower windows', async () => {
  const path = await file();
  await open(path);
  await text.place({ path, line: 2, text: 'removed', position: 'above', fill: true, hl: 'DiffDelete' });
  const [[, , details]] = await shown(path);
  assert.equal(words(details.virt_lines[0]).length, await lua('return vim.o.columns'));

  // As the user sees it, beside another window.
  const ui = await connect(socket);
  const screen = createScreen();
  ui.on('redraw', (...batches: unknown[]) => screen.apply(batches));
  try {
    await ui.request('nvim_ui_attach', [60, 8, { ext_linegrid: true }]);
    await lua(`vim.cmd('rightbelow vnew'); vim.api.nvim_buf_set_lines(0, 0, -1, true, { 'beside' }); vim.cmd('wincmd p')`);
    await delay(100);
    const rows = screen.lines();
    assert.match(rows[1], /^removed +│~/);
    assert.match(rows[0], /^one +│beside/);
  } finally { ui.close(); }
});

test('fill gives blank lines and indentation the background too', async () => {
  const path = await file();
  await text.place({ path, line: 1, text: 'first\n\nlast', position: 'below', indent: 4, fill: true, hl: 'DiffDelete' });
  const [[, , details]] = await shown(path);
  const columns = await lua('return vim.o.columns');
  for (const line of details.virt_lines) {
    assert.equal(words(line).length, columns);
    assert.ok(line.every((chunk: string[]) => chunk[1] === 'DiffDelete'), JSON.stringify(line));
  }
});

test('fill measures a tab where it falls, and fills again when the editor grows', async () => {
  const path = await file();
  await open(path);
  const padded = async () => {
    const [[, , details]] = await shown(path);
    return lua('local width = 0; for _, c in ipairs(...) do width = width + vim.fn.strdisplaywidth(c[1], width) end; return width', details.virt_lines[0]);
  };
  await text.place({ path, line: 2, text: [['a', 'Title'], ['\t', 'ErrorMsg']], position: 'below', fill: true });
  assert.equal(await padded(), await lua('return vim.o.columns'));
  await screen(async (_rows, resize) => {
    await resize(100, 8);
    await delay(50);
    assert.equal(await lua('return vim.o.columns'), 100);
    assert.equal(await padded(), 100);
  });
});

test('fill measures tabs as the buffer it is in shows them, not the current one', async () => {
  const path = await file('a\nb\n');
  await lua('local b = vim.fn.bufadd(...); vim.fn.bufload(b); vim.bo[b].tabstop = 2; vim.cmd.enew(); vim.bo.tabstop = 8', path);
  await text.place({ path, line: 1, text: [['a', 'Title'], ['\tb', 'ErrorMsg']], position: 'below', fill: true });
  const [[, , details]] = await shown(path);
  const width = await lua(`local b, chunks = ...
    return vim.api.nvim_buf_call(b, function()
      local width = 0
      for _, c in ipairs(chunks) do width = width + vim.fn.strdisplaywidth(c[1], width) end
      return width
    end)`, await lua('return vim.fn.bufnr(...)', path), details.virt_lines[0]);
  assert.equal(width, await lua('return vim.o.columns'));
});

test('a style of its own becomes a highlight group, kept across a colorscheme', async () => {
  const path = await file();
  await text.place({ path, line: 1, text: 'hi', hl: { fg: '#ff0000', bold: true } });
  const [[, , details]] = await shown(path);
  const name = details.virt_text[0][1];
  assert.match(name, /^PiVirtualText_/);
  await lua('vim.cmd.colorscheme("default")');
  const { fg, bold } = await lua('return vim.api.nvim_get_hl(0, { name = ... })', name);
  assert.deepEqual({ fg, bold }, { fg: 0xff0000, bold: true });
});

test('list gives the marks as placed, where edits have moved them', async () => {
  const path = await file('a\nb\nc\nd\n');
  const [id] = await text.place({ path, line: 2, endLine: 3, text: 'note', highlight: 'Visual', position: 'below' });
  await lua('local b = vim.fn.bufnr(...); vim.api.nvim_buf_set_lines(b, 0, 0, true, { "new", "new" })', path);
  const [mark] = await text.list();
  assert.deepEqual(
    { id: mark.id, group: mark.group, path: mark.path, line: mark.line, endLine: mark.endLine, text: mark.text },
    { id, group: 'test', path, line: 4, endLine: 5, text: 'note' },
  );
  assert.deepEqual(await text.list({ path: join(dir, 'elsewhere.txt') }), []);
});

test('update changes a mark in place, keeping its id and where it moved', async () => {
  const path = await file('a\nb\nc\n');
  const [id] = await text.place({ path, line: 2, text: 'before', highlight: 'Visual' });
  await lua('local b = vim.fn.bufnr(...); vim.api.nvim_buf_set_lines(b, 0, 0, true, { "new" })', path);
  assert.equal(await text.update(id, { text: 'after', highlight: null, hl: 'PiVirtualTextWarn' }), true);
  const [mark] = await text.list();
  assert.deepEqual([mark.id, mark.line, mark.text, mark.highlight], [id, 3, 'after', undefined]);
  const [[row, , details]] = await shown(path);
  assert.deepEqual([row, details.virt_text], [2, [['after', 'PiVirtualTextWarn']]]);
  assert.equal((await extmarks(path)).filter(m => m[3].hl_group).length, 0);

  assert.equal(await text.update(id, { line: 1 }), true);
  assert.equal((await shown(path))[0][0], 0);
  assert.equal(await text.update(999, { text: 'x' }), false);
  assert.equal(await virtualText(remote, 'other').update(id, { text: 'theirs' }), false);
});

test('match finds code by its text, the occurrence nearest line', async () => {
  const path = await file('function a() {\n  return 1;\n}\nfunction b() {\n  return 1;\n}\n');
  const [first, near] = await text.place([
    { path, match: 'return 1;' },
    { path, match: 'return 1;', line: 6 },
  ]);
  await text.place({ path, match: '\nfunction b() {\n    return 1;\n', highlight: 'Visual' }); // Indented otherwise.
  const marks = await text.list();
  assert.deepEqual(marks.map(m => [m.id, m.line, m.endLine]), [[first, 2, 2], [near, 5, 5], [near + 1, 4, 5]]);
  await assert.rejects(text.place({ path, match: 'return 2;' }), /not found/);
  await assert.rejects(text.place({ path, match: '\n  \n' }), /only space/);
  await assert.rejects(text.place({ path }), /line or a match/);
});

test('reloaded from disk, marks move back onto their text', async () => {
  const path = await file('a\nb\nc\nd\n');
  await open(path);
  const [byLine, byMatch, span] = await text.place([
    { path, line: 3, text: 'on c' },
    { path, match: 'd', text: 'on d' },
    { path, line: 2, endLine: 3, highlight: 'Visual' },
  ]);
  const lines = async () => Object.fromEntries((await text.list()).map(m => [m.id, [m.line, m.endLine]]));

  await writeFile(path, 'new\nnew\na\nb\nc\nd\n');
  await lua('vim.cmd.edit()');
  assert.deepEqual(await lines(), { [byLine]: [5, 5], [byMatch]: [6, 6], [span]: [4, 5] });

  // As autoread reloads it.
  await delay(1100); // A change within the same second can go unseen.
  await writeFile(path, 'new\na\nb\nc\nd\n');
  await lua('vim.o.autoread = true; vim.cmd.checktime()');
  assert.deepEqual(await lines(), { [byLine]: [4, 4], [byMatch]: [5, 5], [span]: [3, 4] });

  // Text that is gone leaves its mark where it was.
  await writeFile(path, 'x\ny\nz\nw\nv\n');
  await lua('vim.cmd.edit()');
  assert.deepEqual(await lines(), { [byLine]: [4, 4], [byMatch]: [5, 5], [span]: [3, 4] });
});

test('invalidate hides a mark while its lines are deleted, and removes it when a reload loses its text', async () => {
  const path = await file('a\nb\nc\nd\n');
  await open(path);
  const [hidden, kept] = await text.place([
    { path, line: 2, endLine: 3, text: 'note', highlight: 'Visual', invalidate: true },
    { path, line: 4, text: 'stays' },
  ]);
  const invalid = async () => Object.fromEntries((await text.list()).map(m => [m.id, m.invalid ?? false]));
  await lua('vim.cmd("normal! 2Gdj")');
  assert.deepEqual(await invalid(), { [hidden]: true, [kept]: false });
  assert.ok((await extmarks(path)).filter(m => m[3].invalid).length >= 2);
  await lua('vim.cmd.undo()');
  assert.deepEqual(await invalid(), { [hidden]: false, [kept]: false });

  await writeFile(path, 'a\nd\n');
  await lua('vim.cmd.edit()');
  assert.deepEqual((await text.list()).map(m => [m.id, m.line]), [[kept, 2]]);
});

test('a mark whose lines are partly deleted shows on what is left of them, and back on undo', async () => {
  for (const [position, deleted, survivor] of [
    ['eol', 2, 'second'], ['inline', 2, 'second'], ['overlay', 2, 'second'], ['above', 2, 'second'], ['below', 3, 'first'],
  ] as const) {
    const path = await file('head\nfirst\nsecond\ntail\n');
    await open(path);
    await text.place({ path, line: 2, endLine: 3, col: 0, text: 'NOTE', position, invalidate: true });
    await screen(async rows => {
      await lua(`vim.cmd("normal! ${deleted}Gdd")`);
      const after = (await rows()).join('\n');
      assert.match(after, /NOTE/, `${position}: ${after}`);
      assert.equal((await text.list())[0].invalid, undefined);
      assert.ok((await extmarks(path)).every(m => !m[3].invalid), position);
      const [[row]] = await shown(path);
      assert.equal(row, 1, `${position} on ${survivor}`);
      await lua('vim.cmd.undo()');
      assert.match((await rows()).join('\n'), /NOTE/, position);
      assert.equal((await shown(path))[0][0], position === 'below' ? 2 : 1, `${position} after undo`);
    });
    await text.clear();
  }
});

test('a mark changed while hidden stays hidden until undo, then shows the change', async () => {
  const path = await file('a\ntarget\nb\n');
  await open(path);
  const [id] = await text.place({ path, line: 2, text: 'NOTE', invalidate: true });
  await lua('vim.cmd("normal! 2Gdd")');
  await screen(async rows => {
    assert.equal(await text.update(id, { text: 'CHANGED' }), true);
    await assert.rejects(text.update(id, { match: 'nowhere' }), /not found/);
    assert.equal((await text.list())[0].invalid, true);
    assert.ok(!(await rows()).some(row => /NOTE|CHANGED/.test(row)));
    await lua('vim.cmd.undo()');
    const after = await rows();
    assert.ok(after.some(row => /^target +CHANGED/.test(row)), after.join('\n'));
  });
  const [mark] = await text.list();
  assert.deepEqual([mark.line, mark.text, mark.invalid], [2, 'CHANGED', undefined]);
  assert.equal((await shown(path)).length, 1);
});

test('a mark changed while hidden comes back with every undo, not only the first', async () => {
  const path = await file('head\ntarget\ntail\n');
  await open(path);
  const [id] = await text.place({ path, line: 2, text: 'OLD', invalidate: true });
  await lua('vim.cmd("normal! 2Gdd")');
  await text.update(id, { text: 'NEW' });
  await screen(async rows => {
    for (const cycle of [1, 2, 3]) {
      await lua('vim.cmd.undo()');
      assert.ok((await rows()).some(row => /^target +NEW/.test(row)), `undo ${cycle}`);
      assert.equal((await text.list())[0].invalid, undefined);
      await lua('vim.cmd.redo()');
      assert.ok(!(await rows()).some(row => /NEW|OLD/.test(row)), `redo ${cycle}`);
      assert.equal((await text.list())[0].invalid, true);
    }
  });
  assert.deepEqual((await text.list()).map(m => m.id), [id]);
});

test('a reload that brings back a hidden mark\'s text shows it again, where it was', async () => {
  const path = await file('a\ntarget\nb\n');
  await open(path);
  await text.place({ path, line: 2, text: 'NOTE', invalidate: true });
  await lua('vim.cmd("normal! 2Gdd")');
  await lua('vim.cmd("edit!")');
  const [mark] = await text.list();
  assert.deepEqual([mark.line, mark.invalid], [2, undefined]);
  assert.ok((await extmarks(path)).every(m => !m[3].invalid));
});

test('a mark that cannot be drawn leaves nothing drawn, placed or updated', async () => {
  const path = await file();
  const bad = { text: [['x', { fg: 'definitely-not-a-color' }]] as [string, { fg: string }][], highlight: 'Visual' };
  await assert.rejects(text.place({ path, line: 1, ...bad }));
  assert.deepEqual([await text.list(), await extmarks(path)], [[], []]);
  const [id] = await text.place({ path, line: 1, text: 'fine', highlight: 'Visual' });
  await assert.rejects(text.update(id, bad));
  assert.equal((await extmarks(path)).length, 2);
  assert.equal((await text.list())[0].text, 'fine');
});

test('a matched mark keeps to its lines once their text is edited, through redraws', async () => {
  const path = await file('head\ntarget\nseparator\ntarget\ntail\n');
  await open(path);
  const [id] = await text.place({ path, match: 'target', line: 2, text: 'NOTE', position: 'below', fill: true });
  await lua('vim.api.nvim_buf_set_text(0, 1, 0, 1, 6, { "changed" })');
  await screen(async (_rows, resize) => {
    await resize(100, 8);
    await delay(50);
  });
  assert.equal((await text.list())[0].line, 2);
  await text.update(id, { text: 'UPDATED' });
  assert.equal((await text.list())[0].line, 2);
  await text.update(id, { line: 4 }); // Moved, it looks for its text again.
  assert.equal((await text.list())[0].line, 4);
});

test('redraws keep what a reload looks for: the text the mark was placed on', async () => {
  for (const invalidate of [false, true]) {
    const path = await file('head\ntarget\ntail\n');
    await open(path);
    const [id] = await text.place({ path, line: 2, text: 'NOTE', position: 'below', fill: true, invalidate });
    await lua('vim.api.nvim_buf_set_text(0, 1, 0, 1, 6, { "changed" })');
    await screen(async (_rows, resize) => { await resize(100, 8); await delay(50); });
    await text.update(id, { text: 'UPDATED' });
    await writeFile(path, 'prefix\nhead\ntarget\ntail\n');
    await lua('vim.cmd("edit!")');
    assert.deepEqual((await text.list()).map(m => m.line), [3], `invalidate: ${invalidate}`);
    await text.clear();
  }
});

test('an update whose match is not found leaves the mark as it was', async () => {
  const path = await file();
  const [id] = await text.place({ path, match: 'two', text: 'note' });
  await assert.rejects(text.update(id, { match: 'four', text: 'changed' }), /not found/);
  const [mark] = await text.list();
  assert.deepEqual([mark.id, mark.line, mark.match, mark.text], [id, 2, 'two', 'note']);
  assert.equal((await shown(path)).length, 1);
});

test('marks go by id, by file, after their ttl, and with each group apart', async () => {
  const a = await file(), b = await file();
  const other = virtualText(remote, 'other');
  const [first] = await text.place([{ path: a, line: 1, text: 'x' }, { path: a, line: 2, text: 'y' }]);
  await text.place({ path: b, line: 1, text: 'z' });
  const [theirs] = await other.place({ path: a, line: 3, text: 'theirs' });
  await text.remove([first, theirs]); // Another group's id is not this one's to remove.
  assert.equal((await text.list({ path: a })).length, 1);
  assert.equal(await text.clear({ path: b }), 1);
  assert.equal((await text.list({ path: b })).length, 0);
  assert.equal(await text.clear(), 1);
  assert.equal((await other.list()).length, 1);
  await other.clear();

  const [brief] = await text.place({ path: a, line: 1, text: 'brief', ttl: 100 });
  await delay(60);
  await text.update(brief, { text: 'renewed' }); // Starts its ttl again.
  await delay(60);
  assert.equal((await shown(a)).length, 1);
  await delay(100);
  assert.equal((await shown(a)).length, 0);
  assert.deepEqual(await text.list(), []);
});

test('lines past the end are clamped, and bad marks are refused', async () => {
  const path = await file();
  await text.place({ path, line: 99, text: 'end' });
  assert.equal((await shown(path))[0][0], 2);
  await assert.rejects(text.place({ path: 'relative.txt', line: 1 }), /absolute/);
  await assert.rejects(text.place({ path, line: 0 }), /line/);
  await assert.rejects(text.place({ path, buf: 1, line: 1 }), /not both/);
  await assert.rejects(text.place({ path: join(dir, 'missing.txt'), line: 1, text: 'x' }), /no such file/);
  assert.throws(() => virtualText(remote, 'bad name'), /group/);
});

test('a deleted buffer, opened again, shows its marks again', async () => {
  for (const content of ['head\ntarget\ntail\n', 'head\nother\ntail\n']) {
    const path = await file('head\ntarget\ntail\n');
    await open(path);
    const [id] = await text.place({ path, line: 2, text: 'NOTE', sign: '!', highlight: 'Visual' });
    await lua('local b = vim.fn.bufnr(...); vim.cmd.enew(); vim.cmd.bdelete({ b, bang = true })', path);
    await writeFile(path, content); // Its text where it was, or nowhere.
    await open(path);
    assert.equal((await shown(path)).length, 1, content);
    await text.update(id, { text: 'EDITED' }); // Watched again: an edit to it is synced.
    await lua('vim.api.nvim_buf_set_lines(0, 0, 0, true, { "new" })');
    await delay(20);
    assert.deepEqual((await text.list()).map(m => [m.id, m.line]), [[id, 3]]);
    const found = await extmarks(path);
    assert.deepEqual(['span', 'sign', 'text'].map((_, i) => found.filter(m => i === 0 ? m[3].hl_group : i === 1 ? m[3].sign_text : m[3].virt_text).length), [1, 1, 1]);
    assert.ok(found.every(m => m[1] === 2));
    await text.clear();
  }
});

test('a wiped buffer takes its marks with it', async () => {
  const path = await file();
  await text.place({ path, line: 1, text: 'x' });
  await lua('vim.cmd.bwipeout({ vim.fn.bufnr(...), bang = true })', path);
  assert.deepEqual(await text.list(), []);
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
