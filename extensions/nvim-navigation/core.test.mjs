import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../nvim-service/service.mjs';
import { openNvim } from '../nvim-service/nvim.mjs';
import { navigate, parse, status, validate } from './core.mjs';

// A file's extension names the fake servers that attach to it: `a.normal`, `b.normal_plain`.
async function fixture(t) {
  const directory = await realpath(await mkdtemp('/tmp/pi-navigation-test-'));
  const log = join(directory, 'lsp.log'), init = join(directory, 'init.lua');
  const [node, server] = [process.execPath, fileURLToPath(new URL('./test/lsp.mjs', import.meta.url))].map(path => JSON.stringify(path));
  await writeFile(init, `local known = { normal = 1, links = 1, loading = 1, flaky = 1, broken = 1, plain = 1 }
vim.api.nvim_create_autocmd('BufReadPost', { callback = function(ev)
  for mode in vim.fn.fnamemodify(ev.file, ':e'):gmatch('[^_]+') do
    if known[mode] then
      vim.lsp.start({ name = mode, cmd = { ${node}, ${server}, mode, ${JSON.stringify(log)} }, root_dir = ${JSON.stringify(directory)} }, { bufnr = ev.buf })
    end
  end
end })`);
  const service = launch({ cwd: directory, init, graceMs: 100, killMs: 300 });
  const nvim = await openNvim(await service.ready);
  t.after(async () => { nvim.close(); await service.stop(); await rm(directory, { recursive: true, force: true }); });
  return { directory, nvim, log,
    write: (name, text) => writeFile(join(directory, name), text),
    async ask(action, file, options = {}) {
      const started = Date.now();
      const { trace, ...params } = options;
      const text = await navigate(nvim, { action, file, ...params }, directory, undefined, { trace });
      return Object.assign(text.split('\n'), { text, ms: Date.now() - started });
    },
  };
}

test('rejects questions that cannot be asked, before touching the editor', () => {
  for (const params of [undefined, {}, { action: 'rename', file: 'a' }, { action: 'hover', file: '' }, { action: 'hover', file: 'a' },
    { action: 'definition', file: 'a', line: 1 }, { action: 'definition', file: 'a', line: 0, symbol: 'x' }, { action: 'hover', file: 'a', line: 1, column: 0 },
    { action: 'hover', file: 'a', line: 1, symbol: '' }, { action: 'workspace_symbols', file: 'a' }, { action: 'workspace_symbols', file: 'a', query: ' ' },
    { action: 'symbols', file: 'a', timeoutMs: 50 }]) {
    assert.throws(() => validate(params));
  }
  assert.deepEqual(validate({ action: 'symbols', file: 'a' }), { action: 'symbols', file: 'a', line: undefined, symbol: undefined, column: undefined, query: undefined, timeoutMs: 10000 });
});

test('definitions, references, hover and symbols, pointed at by the text on a line', async t => {
  const f = await fixture(t);
  await f.write('lib.normal', 'def greet\n  def inner\n\ndef Other\n');
  await f.write('use.normal', '-- é😀 greet and greet again\ncall greet inner\n');
  // The file with the definition has not been opened: its line is read from disk.
  assert.deepEqual([...await f.ask('references', 'use.normal', { line: 2, symbol: 'greet' })], [
    '3 references for greet — normal', 'use.normal', '  1:11  -- é😀 greet and greet again', '  1:21  -- é😀 greet and greet again', '  2:6  call greet inner']);
  await f.ask('symbols', 'lib.normal');
  assert.deepEqual([...await f.ask('definition', 'use.normal', { line: 2, symbol: 'greet' })], ['1 definition for greet — normal', 'lib.normal', '  1:5  def greet']);
  assert.deepEqual([...await f.ask('references', 'lib.normal', { line: 1, symbol: 'greet' })], [
    '4 references for greet — normal', 'use.normal', '  1:11  -- é😀 greet and greet again', '  1:21  -- é😀 greet and greet again', '  2:6  call greet inner', 'lib.normal', '  1:5  def greet']);
  // A column picks a later occurrence, or stands in for the symbol; both count bytes, as the output does.
  assert.equal((await f.ask('hover', 'use.normal', { line: 1, symbol: 'greet', column: 20 })).text, 'greet — normal\n**greet**: defined here');
  assert.equal((await f.ask('hover', 'use.normal', { line: 2, column: 12 })).text, 'inner — normal\n**inner**: defined here');
  assert.deepEqual([...await f.ask('symbols', 'lib.normal')], ['3 symbols in lib.normal — normal', '  1: function greet', '    2: method inner', '  4: function Other']);
  assert.deepEqual([...await f.ask('symbols', 'lib.normal', { query: 'INN' })], ['1 symbols in lib.normal — normal', '    2: method inner']);
  assert.deepEqual([...await f.ask('workspace_symbols', 'use.normal', { query: 'e' })], [
    '3 symbols matching "e" — normal', '  function Other  lib.normal:4', '  function greet  lib.normal:1', '  method inner  lib.normal:2']); // The server's own ranking is kept.
  assert.equal((await f.ask('definition', 'use.normal', { line: 2, symbol: 'call' })).text, 'No definitions for call — normal');
  assert.equal((await f.ask('type', 'use.normal', { line: 2, symbol: 'greet' })).text, 'No server for use.normal supports this: normal.');
});

test('the answer follows the file on disk, and an unsaved buffer is used as it is', async t => {
  const f = await fixture(t);
  await f.write('a.links', 'def old\nuse old\n');
  assert.deepEqual([...await f.ask('definition', 'a.links', { line: 2, symbol: 'old' })], ['1 definition for old — links', 'a.links', '  1:5  def old']);
  await f.write('a.links', '\n\ndef renamed\nuse renamed\n');
  assert.deepEqual([...await f.ask('definition', 'a.links', { line: 4, symbol: 'renamed' })], ['1 definition for renamed — links', 'a.links', '  3:5  def renamed']);
  const versions = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse).filter(m => m.version !== undefined).map(m => m.version);
  assert.ok(versions.at(-1) > versions[0], `the reload reached the server under a newer version: ${versions}`);

  await f.nvim.lua('vim.api.nvim_buf_set_lines(vim.fn.bufnr(...), 0, -1, false, { "def typed", "use typed" })', [join(f.directory, 'a.links')]);
  assert.deepEqual([...await f.ask('definition', 'a.links', { line: 2, symbol: 'typed' })], ['1 definition for typed — links (unsaved buffer)', 'a.links', '  1:5  def typed']);
  assert.equal(await readFile(join(f.directory, 'a.links'), 'utf8'), '\n\ndef renamed\nuse renamed\n');
});

test('a server that is still loading, or stumbles, is asked again instead of believed', async t => {
  const f = await fixture(t);
  await f.write('a.loading', 'def slow\nuse slow\n');
  const first = await f.ask('definition', 'a.loading', { line: 2, symbol: 'slow' });
  assert.deepEqual([...first], ['1 definition for slow — loading', 'a.loading', '  1:5  def slow']);
  assert.ok(first.ms >= 1500, `took ${first.ms} ms`);
  assert.ok((await f.ask('references', 'a.loading', { line: 1, symbol: 'slow' })).ms < 500);

  await f.write('b.flaky', 'def shaky\nuse shaky\n');
  assert.deepEqual([...await f.ask('definition', 'b.flaky', { line: 2, symbol: 'shaky' })], ['1 definition for shaky — flaky', 'b.flaky', '  1:5  def shaky']);
  await f.write('c.broken_normal', 'def half\nuse half\n');
  assert.deepEqual([...await f.ask('definition', 'c.broken_normal', { line: 2, symbol: 'half' })], [
    '1 definition for half — normal (broken failed: index corrupt)', 'c.broken_normal', '  1:5  def half']);
});

test('what cannot be answered is said plainly', async t => {
  const f = await fixture(t);
  await f.write('a.plain', 'def x\n');
  await f.write('notes.txt', 'plain text\n');
  await f.write('b.normal', 'def x\nuse x\n');
  assert.equal((await f.ask('hover', 'a.plain', { line: 1, symbol: 'x' })).text, 'No server for a.plain supports this: plain.');
  assert.equal((await f.ask('symbols', 'notes.txt')).text, 'No language server for notes.txt.');
  await assert.rejects(f.ask('symbols', 'missing.normal'), { message: 'no such file' });
  await assert.rejects(f.ask('hover', 'b.normal', { line: 2, symbol: 'nope' }), { message: '"nope" is not on line 2, which reads: use x' });
  await assert.rejects(f.ask('hover', 'b.normal', { line: 9, symbol: 'x' }), { message: 'line 9 is past the end of the file (2 lines)' });
  // Nothing about the editor a person would see has moved.
  assert.deepEqual(await f.nvim.lua('return { vim.api.nvim_buf_get_name(0), #vim.api.nvim_list_wins(), vim.api.nvim_get_mode().mode }'), ['', 1, 'n']);
});

test('the timeline, the server list and the command line explain and reproduce a question', async t => {
  const f = await fixture(t);
  assert.match(await status(f.nvim), /^No language servers are running/);
  await f.write('a.loading_plain', 'def slow\nuse slow\n');
  const { text } = await f.ask('definition', 'a.loading_plain', { line: 2, symbol: 'slow', trace: true });
  const [answer, timeline] = text.split('\n\nTimeline ');
  assert.equal(answer, '1 definition for slow — loading\na.loading_plain\n  1:5  def slow');
  for (const line of [
    /^\(\d+ ms\):$/m,
    /ms  a\.loading_plain: loaded$/m,
    /ms  asking about "slow" at 2:5$/m,
    /ms  loading is starting$/m,
    /ms  loading is just started$/m,
    /ms  loading is ready$/m,
    /ms  loading asked for textDocument\/definition$/m,
    /ms  loading answered with nothing$/m,
    /ms  nothing from a server that started recently; waiting for it to stay calm, then asking again$/m,
    /ms  loading answered with a result$/m,
  ]) assert.match(timeline, line);
  assert.doesNotMatch(timeline, /plain asked/);
  assert.equal((await f.ask('definition', 'a.loading_plain', { line: 2, symbol: 'slow' })).text.includes('Timeline'), false);
  await f.write('a.loading_plain', 'def slow\nuse slow\n\n');
  assert.match((await f.ask('symbols', 'a.loading_plain', { trace: true })).text, /ms  a\.loading_plain: reloaded from disk, sent under a new document version$/m);

  const servers = await status(f.nvim);
  assert.match(servers, /^Language servers in Pi's Neovim:\n/);
  assert.match(servers, /^  loading \(\d\): ready; 1 buffer; root \/.*\n    answers: definition, hover, references, symbols, workspace_symbols$/m);
  assert.match(servers, /^  plain \(\d\): ready; 1 buffer; root \/.*\n    answers: none of the actions$/m);

  assert.deepEqual(parse('definition src/a.ts 3 greet'), { action: 'definition', file: 'src/a.ts', line: 3, symbol: 'greet', column: undefined });
  assert.deepEqual(parse(' references  a.ts 3 greet 20 '), { action: 'references', file: 'a.ts', line: 3, symbol: 'greet', column: 20 });
  assert.deepEqual(parse('hover a.ts 3 14'), { action: 'hover', file: 'a.ts', line: 3, column: 14 });
  assert.deepEqual(parse('symbols a.ts'), { action: 'symbols', file: 'a.ts', query: undefined });
  assert.deepEqual(parse('workspace_symbols a.ts Greeter'), { action: 'workspace_symbols', file: 'a.ts', query: 'Greeter' });
});
