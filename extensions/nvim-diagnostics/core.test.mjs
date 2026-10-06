import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readFile, symlink, stat, utimes, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchNvimService } from '../nvim-service/service.mjs';
import { DiagnosticsClient, formatReport, validateParams } from './core.mjs';

async function fixture(t, init = fileURLToPath(new URL('./test/producer.lua', import.meta.url))) {
  const directory = await realpath(await mkdtemp('/tmp/pi-diag-test-'));
  const service = launchNvimService({ cwd: directory, init, graceMs: 100, killMs: 300 });
  const client = new DiagnosticsClient();
  t.after(async () => { client.close(); await service.stop(); await rm(directory, { recursive: true, force: true }); });
  const info = await service.ready;
  client.setService(info);
  return {
    directory, service, client, info,
    async file(name, text) { const path = join(directory, name); await writeFile(path, text); return path; },
    diagnose(files, opts) { return client.diagnose({ files, timeoutMs: 1800, ...opts }, directory); },
    async lua(code, args = []) {
      const signal = AbortSignal.timeout(3000);
      const rpc = await client.connect(signal);
      return rpc.request('nvim_exec_lua', [code, args], signal);
    },
  };
}

async function dynamicFixture(t, mode = 'dynamic', onAttach = '') {
  const initDir = await mkdtemp('/tmp/pi-diag-dynamic-init-');
  t.after(() => rm(initDir, { recursive: true, force: true }));
  const init = join(initDir, 'init.lua');
  const cmd = [process.execPath, fileURLToPath(new URL('./test/lsp.mjs', import.meta.url)), mode];
  await writeFile(init, `vim.api.nvim_create_autocmd('BufReadPost',{pattern='*.lsp',callback=function(ev)
    vim.lsp.start({name='fixture-dynamic',cmd=vim.json.decode([==[${JSON.stringify(cmd)}]==]),root_dir=vim.fn.getcwd(),
      on_attach=function(client) ${onAttach} end},{bufnr=ev.buf}) end})`);
  return fixture(t, init);
}

test('validates bounded arguments before accessing the service', () => {
  for (const params of [{}, { files: [] }, { files: Array(33).fill('a') }, { files: ['a\0b'] },
    { files: ['a'], severities: [] }, { files: ['a'], severities: ['fatal'] }, { files: ['a'], timeoutMs: 99 }]) {
    assert.throws(() => validateParams(params));
  }
  assert.equal(validateParams({ files: ['a'] }).timeoutMs, 10000);
});

test('opens multiple files, all severities and byte ranges; caches and filters without writing', async t => {
  const f = await fixture(t);
  const bad = await f.file('é "file".txt', 'éBAD\n');
  const good = await f.file('good.txt', 'clean\n');
  const before = await stat(bad);
  const report = await f.diagnose([bad, good]);
  assert.equal(report.completeness, 'best_effort');
  assert.equal(report.timedOut, false);
  assert.deepEqual(report.files[0].counts, { error: 1, warning: 1, info: 1, hint: 1 });
  assert.deepEqual(report.files[0].diagnostics.map(d => [d.line, d.column, d.endColumn]), Array(4).fill([1, 3, 6]));
  assert.equal(report.files[1].diagnostics.length, 0);
  assert.equal(report.files[1].status, 'updated'); // an observed empty publication, not a clean guarantee
  const filtered = await f.diagnose(['é "file".txt'], { severities: ['warning'] });
  assert.equal(filtered.files[0].status, 'cached');
  assert.equal(filtered.files[0].diagnostics.length, 1);
  assert.equal(filtered.files[0].counts.error, 1);
  assert.equal(filtered.files[0].diskVerified, true);
  const short = await f.diagnose([bad], { timeoutMs: 200 });
  assert.equal(short.timedOut, true, 'A deadline shorter than the quiet period is explicit even with cached results');
  assert.equal(short.files[0].diagnostics.length, 4);
  assert.equal((await stat(bad)).mtimeMs, before.mtimeMs);
  assert.equal(await f.lua('return vim.tbl_count(_G.__pi_diagnostics_v1.requests)'), 0);
  assert.match((await formatReport(report)).text, /not proof|not a substitute/);
});

test('external edits clear stale diagnostics even with preserved size/mtime', async t => {
  const f = await fixture(t);
  const path = await f.file('a.txt', 'BAD');
  const old = await stat(path);
  assert.equal((await f.diagnose([path])).files[0].diagnostics.length, 4);
  await writeFile(path, 'OK!');
  await utimes(path, old.atime, old.mtime);
  const fixed = await f.diagnose([path]);
  assert.equal(fixed.files[0].refreshed, true);
  assert.equal(fixed.files[0].diagnostics.length, 0);
  assert.equal(fixed.files[0].status, 'updated');
});

test('deduplicates canonical paths and preserves individual input errors', async t => {
  const f = await fixture(t);
  const path = await f.file('a.txt', 'BAD');
  await symlink(path, join(f.directory, 'alias.txt'));
  const binary = await f.file('binary', Buffer.from([0, 1, 2]));
  const nonUtf8 = await f.file('non-utf8', Buffer.from([0xff]));
  const huge = await f.file('huge', Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  const report = await f.diagnose(['a.txt', path, 'alias.txt', 'missing', binary, nonUtf8, huge, f.directory]);
  assert.equal(report.files.length, 6);
  assert.deepEqual(report.files[0].requested, ['a.txt', path, 'alias.txt']);
  assert.equal(report.files[0].diagnostics.length, 4);
  assert.ok(report.files.slice(1).every(row => row.status === 'file_error'));
  assert.equal(existsSync(join(f.directory, 'missing')), false);
});

test('does not overwrite modified service buffers or touch pre-existing buffers on cleanup', async t => {
  const f = await fixture(t);
  const path = await f.file('a.txt', 'disk');
  const buf = await f.lua('local b=vim.fn.bufadd(...); vim.fn.bufload(b); vim.api.nvim_buf_set_lines(b,0,-1,false,{"unsaved"}); return b', [path]);
  const report = await f.diagnose([path]);
  assert.equal(report.files[0].status, 'buffer_modified');
  assert.equal(await readFile(path, 'utf8'), 'disk');
  assert.deepEqual(await f.lua('return vim.api.nvim_buf_get_lines(...,0,-1,false)', [buf]), ['unsaved']);
});

test('waits for delayed diagnostics; unsupported files are not marked clean', async t => {
  const f = await fixture(t);
  const path = await f.file('slow.txt', 'slow BAD');
  const report = await f.diagnose([path]);
  assert.equal(report.files[0].diagnostics.length, 4);
  assert.ok(report.elapsedMs >= 700);
  const none = await f.file('none.txt', 'none');
  const unknown = await f.diagnose([none], { timeoutMs: 350 });
  assert.equal(unknown.files[0].status, 'no_provider_observed');
  assert.equal(unknown.timedOut, true);
});

test('deadline retains results for completed files while other providers are pending', async t => {
  const f = await fixture(t);
  const fast = await f.file('fast.txt', 'BAD');
  const slow = await f.file('slow.txt', 'slow BAD');
  const report = await f.diagnose([fast, slow], { timeoutMs: 450 });
  assert.equal(report.timedOut, true);
  assert.equal(report.files[0].diagnostics.length, 4);
  assert.equal(report.files[1].diagnostics.length, 0);
  assert.notEqual(report.files[1].status, 'updated');
});

test('flags on-disk changes racing diagnosis', async t => {
  const f = await fixture(t);
  const path = await f.file('a.txt', 'slow BAD');
  const pending = f.diagnose([path]);
  await delay(200); await writeFile(path, 'changed outside Neovim');
  const report = await pending;
  assert.equal(report.files[0].status, 'disk_changed');
  assert.equal(report.files[0].diskVerified, false);
});

test('cancellation releases request state; a queued deadline does not wait for its predecessor', async t => {
  const f = await fixture(t);
  const path = await f.file('none.txt', 'none');
  const controller = new AbortController();
  const first = f.client.diagnose({ files: [path], timeoutMs: 3000 }, f.directory, controller.signal);
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await delay(100);
  const started = Date.now();
  const second = await f.diagnose([path], { timeoutMs: 150 });
  assert.ok(Date.now() - started < 500);
  assert.equal(second.timedOut, true);
  controller.abort();
  await rejected;
  assert.equal(await f.lua('return vim.tbl_count(_G.__pi_diagnostics_v1.requests)'), 0);
  assert.equal((await f.diagnose([await f.file('ok.txt', 'clean')])).files[0].status, 'updated');
});

test('serializes concurrent calls and rejects stale work when the service changes', async t => {
  const f = await fixture(t);
  const path = await f.file('bad.txt', 'BAD');
  const [first, second] = await Promise.all([f.diagnose([path]), f.diagnose([path])]);
  assert.equal(first.files[0].status, 'updated');
  assert.equal(second.files[0].status, 'cached');
  const pending = f.diagnose([await f.file('none.txt', 'none')]);
  const rejected = assert.rejects(pending, /stopped or changed/);
  await delay(100); f.client.setService(undefined);
  await rejected;
  await assert.rejects(f.diagnose([path]), /unavailable/);
  f.client.setService(f.info);
  assert.equal((await f.diagnose([path])).files[0].diagnostics.length, 4);
});

test('frozen Neovim is bounded without killing the shared service', async t => {
  const f = await fixture(t);
  const path = await f.file('a.txt', 'BAD');
  await f.diagnose([path]);
  process.kill(f.info.pid, 'SIGSTOP');
  const before = Date.now();
  const report = await f.diagnose([path], { timeoutMs: 250 });
  assert.ok(Date.now() - before < 1000);
  assert.equal(report.timedOut, true);
  assert.equal(report.files[0].status, 'timed_out');
  process.kill(f.info.pid, 0); // still owned by nvim-service, not killed by this consumer
});

test('refuses a socket whose identity does not match the advertised Pi-owned instance', async t => {
  const f = await fixture(t);
  const path = await f.file('bad.txt', 'BAD');
  f.client.setService({ ...f.info, pid: f.info.pid + 1 });
  await assert.rejects(f.diagnose([path]), /Refusing to use/);
  process.kill(f.info.pid, 0);
  f.client.setService(f.info);
  assert.equal((await f.diagnose([path])).files[0].diagnostics.length, 4);
});

test('unexpected service death produces an explicit error, not empty diagnostics', async t => {
  const f = await fixture(t);
  const path = await f.file('none.txt', 'none');
  const pending = f.diagnose([path]);
  const rejected = assert.rejects(pending, /closed|ECONNRESET/);
  await delay(150); process.kill(f.info.pid, 'SIGKILL');
  await rejected;
});

for (const mode of ['push', 'pull', 'default', 'hang']) {
  test(`real LSP ${mode} diagnostics for hidden files`, async t => {
    const initDir = await mkdtemp('/tmp/pi-diag-init-');
    t.after(() => rm(initDir, { recursive: true, force: true }));
    const init = join(initDir, 'init.lua');
    const cmd = [process.execPath, fileURLToPath(new URL('./test/lsp.mjs', import.meta.url)), mode];
    await writeFile(init, `vim.api.nvim_create_autocmd('BufReadPost',{pattern='*.lsp',callback=function(ev) vim.lsp.start({name='fixture-${mode}',cmd=vim.json.decode([==[${JSON.stringify(cmd)}]==]),root_dir=vim.fn.getcwd()},{bufnr=ev.buf}) end})`);
    const f = await fixture(t, init);
    const path = await f.file('a.lsp', 'é BAD');
    const report = await f.diagnose([path], { timeoutMs: mode === 'hang' ? 700 : 2500 });
    assert.equal(report.files[0].clients[0].name, `fixture-${mode}`);
    if (mode === 'hang') {
      assert.equal(report.files[0].status, 'timed_out');
      assert.equal(report.timedOut, true);
      assert.deepEqual(report.files[0].pendingPullClients, ['fixture-hang']);
      assert.match((await formatReport(report)).text, /Still waiting for diagnostic pulls: "fixture-hang"/);
    } else {
      assert.equal(report.timedOut, false);
      assert.equal(report.files[0].pullRetries, 0, 'Ordinary response callbacks must run before completion bookkeeping');
      assert.deepEqual(report.files[0].pullErrors, []);
      assert.equal(report.files[0].diagnostics.length, 1, JSON.stringify(report));
      assert.equal(report.files[0].diagnostics[0].column, 4, 'UTF-16 LSP offset converted by Neovim to UTF-8 byte column');
      await writeFile(path, 'OK');
      const fixed = await f.diagnose([path], { timeoutMs: 2500 });
      assert.equal(fixed.files[0].diagnostics.length, 0, JSON.stringify(fixed));
    }
    assert.equal(await f.lua('return vim.tbl_count(_G.__pi_diagnostics_v1.requests)'), 0);
  });
}

for (const mode of ['refresh', 'cancel']) {
  test(`LSP ${mode} cancellation acknowledgements cannot leave phantom pending pulls`, async t => {
    const initDir = await mkdtemp('/tmp/pi-diag-cancel-init-');
    t.after(() => rm(initDir, { recursive: true, force: true }));
    const init = join(initDir, 'init.lua');
    const cmd = [process.execPath, fileURLToPath(new URL('./test/lsp.mjs', import.meta.url)), mode];
    await writeFile(init, `vim.api.nvim_create_autocmd('BufReadPost',{pattern='*.lsp',callback=function(ev) vim.lsp.start({name='fixture-${mode}',cmd=vim.json.decode([==[${JSON.stringify(cmd)}]==]),root_dir=vim.fn.getcwd()},{bufnr=ev.buf}) end})`);
    const f = await fixture(t, init);
    const path = await f.file('a.lsp', 'é BAD');
    const report = await f.diagnose([path], { timeoutMs: 3000 });
    assert.equal(report.timedOut, false, JSON.stringify(report));
    assert.ok(report.elapsedMs < 2200, 'Do not wait for the deadline after a cancellation acknowledgement');
    const row = report.files[0];
    assert.equal(row.pendingPulls, 0);
    assert.equal(await f.lua('return vim.tbl_count(_G.__pi_diagnostics_v1.requests)'), 0);
    if (mode === 'refresh') {
      assert.equal(row.status, 'updated');
      assert.equal(row.diagnostics.length, 1);
      assert.equal(row.completedPulls, 1, 'A replacement owned pull must receive an actual response');
      assert.equal(row.pullRetries, 1);
      assert.match((await formatReport(report)).text, /pull retries after cancellation\/supersession: 1/);
      assert.deepEqual(row.pullErrors, []);
    } else {
      assert.equal(row.status, 'pull_error', 'Exhausted retries are not an empty success');
      assert.equal(row.completedPulls, 0);
      assert.equal(row.pullRetries, 2, 'At most three attempts per client');
      assert.equal(row.pullErrors.length, 1);
      assert.match(row.pullErrors[0].error, /cancelled|response callback/i);
    }
  });
}

for (const mode of ['dynamic', 'dynamic-selectors', 'dynamic-multi']) {
  test(`${mode} pulls use matching provider namespaces without hiding distinct providers`, async t => {
    const f = await dynamicFixture(t, mode);
    if (!await f.lua("return vim.fn.has('nvim-0.12') == 1")) return t.skip('Per-provider namespaces require Neovim 0.12');
    const path = await f.file('a.lsp', mode === 'dynamic-selectors' ? 'OK' : 'é BAD');
    // Bootstrap Neovim's pull state before testing selectors. In 0.12 its
    // registerCapability defaults check uses the current buffer, not the anchor.
    if (mode === 'dynamic-selectors') await f.diagnose([path], { timeoutMs: 3000 });
    const identifiers = mode === 'dynamic-multi' ? ['fixture-dynamic', 'fixture-other'] : ['fixture-dynamic'];
    for (const text of ['é BAD', 'OK', 'é BAD']) {
      await writeFile(path, text);
      const report = await f.diagnose([path], { timeoutMs: 3000 });
      const row = report.files[0];
      assert.equal(report.timedOut, false, JSON.stringify(report));
      assert.equal(row.status, 'updated', JSON.stringify(report));
      assert.equal(row.completedPulls, identifiers.length, 'One owned pull per distinct matching identifier');
      assert.deepEqual(row.pullErrors, []);
      const expected = text === 'OK' ? [] : identifiers.map(id => `nvim.lsp.fixture-dynamic.${row.clients[0].id}.${id}`).sort();
      assert.deepEqual(row.diagnostics.map(d => d.namespace).sort(), expected,
        'Do not introduce a nil/static namespace or deduplicate identical results from distinct providers');
      // A matching dynamic registration takes precedence over static capabilities.
      await f.lua(`local c=vim.lsp.get_clients({bufnr=vim.fn.bufnr(...)})[1]
        c.server_capabilities.diagnosticProvider={identifier='stale-static',interFileDependencies=false,workspaceDiagnostics=false}`, [path]);
    }
    assert.equal(await f.lua('return vim.tbl_count(_G.__pi_diagnostics_v1.requests)'), 0);
  });
}

test('supports the Neovim 0.11 method-keyed, single-registration accessor', async t => {
  const f = await dynamicFixture(t, 'dynamic-legacy', `
    if vim.fn.has('nvim-0.12') == 1 then
      local get=client.dynamic_capabilities.get
      client.dynamic_capabilities.get=function(self,method,opts)
        if method~='textDocument/diagnostic' then return nil end
        local registrations=get(self,'diagnosticProvider',opts)
        return registrations and registrations[1]
      end
    end`);
  const path = await f.file('a.lsp', 'é BAD');
  const report = await f.diagnose([path], { timeoutMs: 3000 });
  assert.equal(report.timedOut, false, JSON.stringify(report));
  assert.equal(report.files[0].status, 'updated', JSON.stringify(report));
  assert.equal(report.files[0].completedPulls, 1);
  assert.equal(report.files[0].diagnostics.length, 1);
  assert.deepEqual(report.files[0].pullErrors, []);
});

test('cancellation tracking and retries remain independent for each dynamic provider', async t => {
  const f = await dynamicFixture(t, 'dynamic-cancel');
  if (!await f.lua("return vim.fn.has('nvim-0.12') == 1")) return t.skip('Multiple registration accessors require Neovim 0.12');
  const report = await f.diagnose([await f.file('a.lsp', 'é BAD')], { timeoutMs: 3000 });
  const row = report.files[0];
  assert.equal(report.timedOut, false, JSON.stringify(report));
  assert.equal(row.status, 'pull_error');
  assert.equal(row.completedPulls, 1);
  assert.equal(row.pendingPulls, 0);
  assert.equal(row.pullRetries, 2);
  assert.equal(row.pullErrors.length, 1);
  assert.equal(row.pullErrors[0].identifier, 'fixture-other');
  assert.equal(row.diagnostics.length, 1, 'Keep the successful provider result');
  assert.equal(await f.lua('return vim.tbl_count(_G.__pi_diagnostics_v1.requests)'), 0);
});

for (const [name, override, error] of [
  ['unavailable accessor', 'c.dynamic_capabilities.get=nil', /registration.*unavailable/i],
  ['invalid identifier', `c.dynamic_capabilities.get=function() return {{registerOptions={identifier=42}}} end`, /identifier/i],
  ['false identifier', `c.dynamic_capabilities.get=function() return {{registerOptions={identifier=false}}} end`, /identifier/i],
  ['provider limit', `c.dynamic_capabilities.get=function() local r={} for i=1,17 do r[i]={registerOptions={identifier='id-'..i}} end return r end`, /limit.*16/i],
]) {
  test(`dynamic provider ${name} is explicit, never guessed as a default identifier`, async t => {
    const f = await dynamicFixture(t);
    const path = await f.file('a.lsp', 'é BAD');
    await f.diagnose([path], { timeoutMs: 3000 });
    await f.lua(`local c=vim.lsp.get_clients({bufnr=vim.fn.bufnr(...)})[1]; ${override}`, [path]);
    const report = await f.diagnose([path], { timeoutMs: 3000 });
    assert.equal(report.timedOut, false, JSON.stringify(report));
    assert.equal(report.files[0].status, 'pull_error');
    assert.equal(report.files[0].completedPulls, 0);
    assert.equal(report.files[0].pendingPulls, 0);
    assert.equal(report.files[0].pullErrors.length, 1);
    assert.match(report.files[0].pullErrors[0].error, error);
  });
}

test('bounded cache unloads old tool buffers but protects modified/listed/pre-existing buffers', async t => {
  const f = await fixture(t);
  const existing = await f.file('existing.txt', 'clean');
  const buf = await f.lua('local b=vim.fn.bufadd(...); vim.fn.bufload(b); return b', [existing]);
  await f.diagnose([existing]);
  const paths = [];
  for (let i = 0; i < 140; i++) paths.push(await f.file(`${i}.txt`, 'clean'));
  for (let i = 0; i < paths.length; i += 32) {
    await f.diagnose(paths.slice(i, i + 32));
    if (i === 0) {
      await f.lua('local a,b=...; vim.api.nvim_buf_set_lines(vim.fn.bufnr(a),0,-1,false,{"unsaved"}); vim.bo[vim.fn.bufnr(b)].buflisted=true', paths.slice(0, 2));
    }
  }
  assert.equal(await f.lua('return vim.api.nvim_buf_is_loaded(...)', [buf]), true);
  for (const path of paths.slice(0, 2)) assert.equal(await f.lua('return vim.api.nvim_buf_is_loaded(vim.fn.bufnr(...))', [path]), true);
  assert.equal(await f.lua('return vim.api.nvim_buf_is_loaded(vim.fn.bufnr(...))', [paths[2]]), false);
  assert.ok(await f.lua('return vim.tbl_count(_G.__pi_diagnostics_v1.entries)') <= 128);
});

test('large output has a private full report, counts, and explicit truncation', async t => {
  const f = await fixture(t);
  const path = await f.file('a.txt', 'BAD');
  const report = await f.diagnose([path]);
  report.files[0].diagnostics = Array.from({ length: 200 }, (_, i) => ({ ...report.files[0].diagnostics[0], message: 'x'.repeat(300), line: i + 1 }));
  const result = await formatReport(report);
  t.after(() => rm(dirname(result.details.fullOutputPath), { recursive: true, force: true }));
  assert.ok(Buffer.byteLength(result.text) <= 16384);
  assert.equal(result.details.truncated, true);
  assert.match(result.text, /Output truncated/);
  assert.equal((await stat(result.details.fullOutputPath)).mode & 0o777, 0o600);
  const full = JSON.parse(await readFile(result.details.fullOutputPath, 'utf8'));
  assert.equal(full.files[0].diagnostics.length, 200);
  assert.equal(result.details.files[0].diagnostics, undefined);
});

test('an idle diagnostics socket does not keep its owner process alive', async () => {
  const code = `import {launchNvimService} from ${JSON.stringify(new URL('../nvim-service/service.mjs', import.meta.url).href)};
    import {DiagnosticsClient} from ${JSON.stringify(new URL('./core.mjs', import.meta.url).href)};
    const s=launchNvimService({cwd:process.cwd(),init:'NONE'}); const c=new DiagnosticsClient();
    const info=await s.ready; console.log(JSON.stringify(info)); c.setService(info);
    await c.diagnose({files:[${JSON.stringify(fileURLToPath(new URL('./index.ts', import.meta.url)))}],timeoutMs:250},process.cwd());`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { timeout: 5000 });
  const info = JSON.parse(stdout.trim());
  for (let i = 0; i < 100 && existsSync(info.socket); i++) await delay(20);
  assert.equal(existsSync(info.socket), false);
});
