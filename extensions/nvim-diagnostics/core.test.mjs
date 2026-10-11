import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../nvim-service/service.mjs';
import { openNvim } from '../nvim-service/nvim.mjs';
import { diagnose, validate } from './core.mjs';

// A file's extension names the fake servers that attach to it: `a.pull`, `b.pull_push`.
async function fixture(t) {
  const directory = await realpath(await mkdtemp('/tmp/pi-diagnostics-test-'));
  const log = join(directory, 'lsp.log'), init = join(directory, 'init.lua');
  const [node, server] = [process.execPath, fileURLToPath(new URL('./test/lsp.mjs', import.meta.url))].map(path => JSON.stringify(path));
  await writeFile(init, `local known = { pull = 1, push = 1, phased = 1, late = 1, silent = 1, slow = 1, cancel = 1, dynamic = 1, error = 1, stale = 1 }
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
    async check(files, options = {}, signal) {
      const started = Date.now();
      const text = await diagnose(nvim, { files, ...options }, directory, signal);
      return Object.assign(text.split('\n'), { text, ms: Date.now() - started });
    },
  };
}

test('rejects bad arguments before touching the editor', () => {
  for (const params of [undefined, {}, { files: [] }, { files: Array(33).fill('a') }, { files: ['a\0'] }, { files: [1] },
    { files: ['a'], severity: 'fatal' }, { files: ['a'], timeoutMs: 99 }, { files: ['a'], timeoutMs: 1.5 }]) {
    assert.throws(() => validate(params));
  }
  assert.deepEqual(validate({ files: ['a'] }), { files: ['a'], severity: 'warning', timeoutMs: 10000 });
});

test('pull and push servers: errors are found, and gone once the file is fixed on disk', async t => {
  const f = await fixture(t);
  await f.write('a.pull', 'ok\né ERROR bad thing\nWARN careful\nHINT maybe');
  await f.write('b.push', 'ERROR pushed');
  let lines = await f.check(['a.pull', 'b.push', 'a.pull', join(f.directory, 'a.pull')]);
  assert.deepEqual([...lines], [
    'a.pull: 1 error, 1 warning, 1 hint — pull answered',
    '  2:4 error [E1] bad thing (fake)',
    '  3:1 warning [W2] careful (fake)',
    'b.push: 1 error — push reported',
    '  1:1 error [E0] pushed (fake)',
  ]);
  assert.equal((await f.check(['a.pull'], { severity: 'error' })).length, 2);
  assert.equal((await f.check(['a.pull'], { severity: 'hint' })).at(-1), '  4:1 hint [H3] maybe (fake)');

  await f.write('a.pull', 'ok');
  await f.write('b.push', 'ok');
  lines = await f.check(['a.pull', 'b.push']);
  assert.deepEqual([...lines], ['a.pull: no diagnostics — pull answered', 'b.push: no diagnostics — push reported']);
  // A pull reply is definite and immediate; only push servers cost a quiet period.
  assert.ok((await f.check(['a.pull'])).ms < 500);
});

test('a push server that clears first and reports later is not mistaken for clean', async t => {
  const f = await fixture(t);
  await f.write('a.late', 'ERROR arrives after a pause');
  await f.write('b.phased', 'ERROR arrives after progress ends');
  const lines = await f.check(['a.late', 'b.phased']);
  assert.equal(lines[0], 'a.late: 1 error — late reported');
  assert.equal(lines[2], 'b.phased: 1 error — phased reported');
  assert.ok(lines.ms >= 2500, `waited ${lines.ms} ms`);
});

test('replies to cancelled pulls never count; late pull registration and slow starts are waited for', async t => {
  const f = await fixture(t);
  for (const name of ['a.cancel', 'b.dynamic', 'c.slow']) await f.write(name, 'ERROR real');
  assert.deepEqual([...await f.check(['a.cancel', 'b.dynamic', 'c.slow'])], [
    'a.cancel: 1 error — cancel answered', '  1:1 error [E0] real (fake)',
    'b.dynamic: 1 error — dynamic answered', '  1:1 error [E0] real (fake)',
    'c.slow: 1 error — slow answered', '  1:1 error [E0] real (fake)',
  ]);
  assert.equal(await f.nvim.lua('return vim.tbl_count(_G.__pi_nvim_diagnostics_v1.pulls)'), 0);
  const received = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(received.some(m => m.mode === 'cancel' && m.method === '$/cancelRequest'), 'the cancel server saw its pull cancelled');
  assert.ok(received.some(m => m.mode === 'dynamic' && m.method === 'textDocument/diagnostic' && m.identifier === 'late-provider'));
});

test('servers that stay silent, fail, or report for old text leave the file incomplete, not clean', async t => {
  const f = await fixture(t);
  for (const name of ['a.silent', 'b.error', 'c.stale', 'd.pull']) await f.write(name, 'ERROR x');
  const lines = await f.check(['a.silent', 'b.error', 'c.stale', 'd.pull'], { timeoutMs: 800 });
  assert.deepEqual([...lines], [
    'a.silent: incomplete after 800 ms: no diagnostics — silent silent',
    'b.error: incomplete after 800 ms: no diagnostics — error failed: checker crashed',
    'c.stale: incomplete after 800 ms: no diagnostics — stale silent',
    'd.pull: 1 error — pull answered',
    '  1:1 error [E0] x (fake)',
  ]);
  assert.ok(lines.ms >= 800 && lines.ms < 1500, `took ${lines.ms} ms`);
});

test('files without a server and unreadable paths are stated plainly', async t => {
  const f = await fixture(t);
  await f.write('notes.txt', 'ERROR nobody is looking');
  await mkdir(join(f.directory, 'folder'));
  const first = await f.check(['notes.txt', 'missing.pull', 'folder', '/etc/hosts']);
  assert.deepEqual([...first], ['notes.txt: no language server attached', 'missing.pull: no such file',
    'folder: not a regular file', '/etc/hosts: no language server attached']);
  // The longer wait for a server to appear is only paid on a filetype's first use.
  assert.ok((await f.check(['notes.txt'])).ms < first.ms / 2);
});

test('an unsaved buffer is checked as it is, and never reloaded or saved', async t => {
  const f = await fixture(t);
  await f.write('a.pull', 'ok');
  await f.check(['a.pull']);
  await f.nvim.lua('vim.api.nvim_buf_set_lines(vim.fn.bufnr(...), 0, -1, false, { "ERROR only in the buffer" })', [join(f.directory, 'a.pull')]);
  assert.deepEqual([...await f.check(['a.pull'])], ['a.pull: 1 error (unsaved buffer) — pull answered', '  1:1 error [E0] only in the buffer (fake)']);
  assert.deepEqual(await f.nvim.lua('local b = vim.fn.bufnr(...); return { vim.bo[b].modified, vim.api.nvim_buf_get_lines(b, 0, -1, false) }', [join(f.directory, 'a.pull')]),
    [true, ['ERROR only in the buffer']]);
  assert.equal(await readFile(join(f.directory, 'a.pull'), 'utf8'), 'ok');
});

test('every check reaches the server under a newer document version, without disturbing the editor', async t => {
  const f = await fixture(t);
  await f.write('a.pull', 'ok');
  await f.write('mine.txt', 'one\ntwo\nthree');
  await f.nvim.keys(`:edit ${join(f.directory, 'mine.txt')}<CR>jl`);
  const snapshot = () => f.nvim.lua('return { vim.api.nvim_get_current_buf(), vim.api.nvim_win_get_cursor(0), vim.api.nvim_list_wins(), vim.api.nvim_get_mode(), vim.fn.getbufinfo({ buflisted = 1 })[1].name }');
  const before = await snapshot();
  const versions = [];
  for (let i = 0; i < 3; i++) {
    await f.check(['a.pull', 'mine.txt']);
    const sent = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse).filter(m => m.version !== undefined);
    versions.push(sent.at(-1).version);
  }
  assert.ok(versions[0] < versions[1] && versions[1] < versions[2], `versions ${versions}`);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await f.nvim.state()).prompt, false);
});

test('long results are capped per file, and a caller can give up', async t => {
  const f = await fixture(t);
  await f.write('many.pull', Array.from({ length: 60 }, (_, i) => `ERROR number ${i}`).join('\n'));
  const lines = await f.check(['many.pull']);
  assert.equal(lines[0], 'many.pull: 60 errors — pull answered');
  assert.equal(lines.length, 52);
  assert.equal(lines.at(-1), '  +10 more');
  await f.write('a.silent', 'x');
  await assert.rejects(f.check(['a.silent'], {}, AbortSignal.timeout(200)), { name: 'TimeoutError' });
});
