import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../nvim-service/service.mjs';
import { openNvim } from '../nvim-service/nvim.mjs';
import { diagnose, status, validate } from './core.mjs';

// A file's extension names the fake servers that attach to it: `a.pull`, `b.pull_push`.
async function fixture(t) {
  const directory = await realpath(await mkdtemp('/tmp/pi-diagnostics-test-'));
  const log = join(directory, 'lsp.log'), init = join(directory, 'init.lua');
  const [node, server] = [process.execPath, fileURLToPath(new URL('./test/lsp.mjs', import.meta.url))].map(path => JSON.stringify(path));
  await writeFile(init, `local known = { pull = 1, push = 1, phased = 1, late = 1, silent = 1, slow = 1, cancel = 1, dynamic = 1, error = 1, onchange = 1 }
-- Stands in for nvim-lint: lints the current buffer, asynchronously, into Neovim's store.
package.preload.lint = function()
  local running, ns = {}, vim.api.nvim_create_namespace('fakelint')
  return {
    get_running = function(buf) return running[buf] and { 'fakelint' } or {} end,
    try_lint = function()
      local buf = vim.api.nvim_get_current_buf()
      if not vim.api.nvim_buf_get_name(buf):find('lint') then return end
      running[buf] = true
      vim.defer_fn(function()
        local found = {}
        for i, line in ipairs(vim.api.nvim_buf_get_lines(buf, 0, -1, false)) do
          if line:find('TODO') then table.insert(found, { lnum = i - 1, col = line:find('TODO') - 1, severity = 2, message = 'todo left in', source = 'fakelint', code = 'L1' }) end
        end
        vim.diagnostic.set(ns, buf, found)
        running[buf] = nil
      end, 200)
    end,
  }
end
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
      const { trace, ...params } = options;
      const text = await diagnose(nvim, { files, ...params }, directory, signal, { trace });
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
  assert.equal(await f.nvim.lua('return vim.tbl_count(_G.__pi_nvim_diagnostics_v3.pulls)'), 0);
  const received = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(received.some(m => m.mode === 'cancel' && m.method === '$/cancelRequest'), 'the cancel server saw its pull cancelled');
  assert.ok(received.some(m => m.mode === 'dynamic' && m.method === 'textDocument/diagnostic' && m.identifier === 'late-provider'));
});

test('a failing or unfinished server leaves the file incomplete; a silent one is believed after its window', async t => {
  const f = await fixture(t);
  for (const name of ['a.silent', 'b.error', 'c.pull', 'd.slow']) await f.write(name, 'ERROR x');
  const early = await f.check(['a.silent', 'b.error', 'c.pull', 'd.slow'], { timeoutMs: 600 });
  assert.deepEqual([...early], [
    'a.silent: incomplete after 600 ms: no diagnostics — silent still working',
    'b.error: incomplete after 600 ms: no diagnostics — error failed: checker crashed',
    'c.pull: 1 error — pull answered',
    '  1:1 error [E0] x (fake)',
    'd.slow: incomplete after 600 ms: no diagnostics — slow starting',
  ]);
  // Nothing changed, so the wait continues where it left off instead of starting over.
  const first = await f.check(['a.silent']);
  assert.deepEqual([...first], ['a.silent: no diagnostics — silent silent']);
  // A server this new is not called silent until it has had five seconds to start reporting.
  assert.ok(first.ms > 3000 && first.ms < 5500, `took ${first.ms} ms`);
  // A server that stays silent through repeated changes stops costing a long wait.
  for (const text of ['one', 'two']) { await f.write('a.silent', text); await f.check(['a.silent']); }
  await f.write('a.silent', 'three');
  const later = await f.check(['a.silent']);
  assert.deepEqual([...later], ['a.silent: no diagnostics — silent silent']);
  assert.ok(later.ms < 1000, `took ${later.ms} ms`);
});

test('unchanged text is not re-sent, and a server with nothing new to say keeps its last report', async t => {
  const f = await fixture(t);
  await f.write('a.push', 'ERROR one');
  await f.write('b.onchange', 'ERROR stays\nfiller');
  assert.equal((await f.check(['a.push', 'b.onchange'])).length, 4);
  const sent = async () => (await readFile(f.log, 'utf8')).trim().split('\n').length;
  const before = await sent();
  const again = await f.check(['a.push', 'b.onchange']);
  assert.deepEqual([...again], ['a.push: 1 error — push reported', '  1:1 error [E0] one (fake)',
    'b.onchange: 1 error — onchange reported', '  1:1 error [E0] stays (fake)']);
  assert.ok(again.ms < 300, `took ${again.ms} ms`);
  assert.equal(await sent(), before);

  // The edit does not change this server's answer, so it publishes nothing.
  await f.write('b.onchange', 'ERROR stays\nedited filler');
  assert.deepEqual([...await f.check(['b.onchange'])], ['b.onchange: 1 error — onchange no new report', '  1:1 error [E0] stays (fake)']);
  await f.write('b.onchange', 'fixed');
  assert.deepEqual([...await f.check(['b.onchange'])], ['b.onchange: no diagnostics — onchange reported']);
});

test('linters that write to Neovim itself are run for the file and included', async t => {
  const f = await fixture(t);
  await f.write('lint.pull', 'ERROR typed\n  TODO later');
  assert.deepEqual([...await f.check(['lint.pull'])], ['lint.pull: 1 error, 1 warning — pull answered, fakelint linted',
    '  1:1 error [E0] typed (fake)', '  2:3 warning [L1] todo left in (fakelint)']);
  await f.write('lint.txt', 'TODO only a linter looks at this');
  assert.deepEqual([...await f.check(['lint.txt'])], ['lint.txt: 1 warning — fakelint linted', '  1:1 warning [L1] todo left in (fakelint)']);
  await f.write('lint.txt', 'done');
  assert.deepEqual([...await f.check(['lint.txt'])], ['lint.txt: no diagnostics — fakelint linted']);
  assert.match((await f.check(['lint.txt'], { timeoutMs: 100 })).text, /^lint\.txt: no diagnostics — fakelint linted$/);
});

test('files without a server and unreadable paths are stated plainly', async t => {
  const f = await fixture(t);
  await f.write('notes.txt', 'ERROR nobody is looking');
  await mkdir(join(f.directory, 'folder'));
  const first = await f.check(['notes.txt', 'missing.pull', 'folder', '/etc/hosts']);
  assert.deepEqual([...first], ['notes.txt: no language server or linter for this file', 'missing.pull: no such file',
    'folder: not a regular file', '/etc/hosts: no language server or linter for this file']);
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
    await f.write('a.pull', `ok ${i}`);
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

test('the timeline and server status explain what a check did', async t => {
  const f = await fixture(t);
  assert.match(await status(f.nvim), /^No language servers are running/);
  await f.write('a.cancel', 'ERROR real');
  await f.write('b.late', 'ok');
  const { text } = await f.check(['a.cancel', 'b.late'], { trace: true });
  const [result, timeline] = text.split('\n\nTimeline ');
  assert.equal(result, 'a.cancel: 1 error — cancel answered\n  1:1 error [E0] real (fake)\nb.late: no diagnostics — late reported');
  for (const line of [
    /^\(\d+ ms\):$/m,
    /^ +\d+ ms  a\.cancel: loaded, document version \d+$/m,
    /ms  a\.cancel: cancel is starting$/m,
    /ms  cancel pull #\d+ for a\.cancel sent$/m,
    /ms  cancel pull #\d+ for a\.cancel cancelled by Neovim$/m,
    /ms  cancel pull #\d+ for a\.cancel: reply discarded \(cancelled\)$/m,
    /ms  cancel pull #\d+ for a\.cancel sent \(attempt \d\)$/m,
    /ms  cancel pull #\d+ for a\.cancel: full, 1 diagnostics$/m,
    /ms  a\.cancel: cancel is answered$/m,
    /ms  late published 0 for b\.late$/m,
    /ms  b\.late: late is busy$/m,
    /ms  b\.late: late is reported$/m,
  ]) assert.match(timeline, line);
  assert.equal((await f.check(['a.cancel'])).text.includes('Timeline'), false);

  const servers = await status(f.nvim);
  assert.match(servers, /^Language servers in Pi's Neovim:\n/);
  assert.match(servers, /\n2 checked files kept open$/);
  assert.match(servers, /^  cancel \(\d\): pull, answers are definite; 1 buffer; root \/.*pi-diagnostics-test-/m);
  assert.match(servers, /^  late \(\d\): push only, given 2500 ms after a change; 1 buffer; root /m);
});

test('a long session keeps only the most recently checked buffers, and never unloads someone else\'s', async t => {
  const f = await fixture(t);
  const names = Array.from({ length: 80 }, (_, i) => `f${i}.txt`);
  for (const name of names) await f.write(name, 'text');
  const loaded = () => f.nvim.lua('return vim.tbl_map(function(n) local b = vim.fn.bufnr(n); return b > 0 and vim.api.nvim_buf_is_loaded(b) end, ...)', [names.map(name => join(f.directory, name))]);
  // Claims on three of the oldest: one is listed, one has unsaved changes, one was open before the tool saw it.
  await f.nvim.lua('vim.fn.bufload(vim.fn.bufadd(...))', [join(f.directory, 'f2.txt')]);
  await f.check(names.slice(0, 16));
  await f.nvim.lua(`local dir = ...
    vim.bo[vim.fn.bufnr(dir .. '/f0.txt')].buflisted = true
    vim.api.nvim_buf_set_lines(vim.fn.bufnr(dir .. '/f1.txt'), 0, -1, false, { 'unsaved' })`, [f.directory]);
  for (let i = 16; i < 80; i += 32) await f.check(names.slice(i, i + 32));
  const state = await loaded();
  assert.deepEqual(state.slice(0, 3), [true, true, true]);
  assert.equal(state.slice(3, 16).every(isLoaded => !isLoaded), true);
  assert.equal(state.slice(16).every(Boolean), true);
  assert.equal(await f.nvim.lua('return vim.tbl_count(_G.__pi_nvim_diagnostics_v3.buffers)'), 67);
  // An unloaded file is simply loaded again when it is next checked.
  assert.deepEqual([...await f.check(['f5.txt'])], ['f5.txt: no language server or linter for this file']);
  assert.equal((await loaded())[5], true);
});
