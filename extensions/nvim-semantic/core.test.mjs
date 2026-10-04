import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, writeFile, readFile, rm, stat, utimes, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launchNvimService } from '../nvim-service/service.mjs';
import { DiagnosticsClient } from '../nvim-diagnostics/core.mjs';
import { SemanticClient, validateParams, formatReport } from './core.mjs';
import { normalizeRange, byteIndex } from '../nvim-service/positions.mjs';

async function fixture(t, modes = ['normal'], attachDelay = 0) {
  const directory = await realpath(await mkdtemp('/tmp/pi-semantic-test-'));
  const log = join(directory, 'lsp.log'), init = join(directory, 'init.lua');
  const configs = modes.map(mode => ({ name: `fixture-${mode}`, cmd: [process.execPath, fileURLToPath(new URL('./test/lsp.mjs', import.meta.url)), mode, log], root_dir: directory }));
  await writeFile(init, `dofile(${JSON.stringify(fileURLToPath(new URL('../nvim-diagnostics/test/producer.lua', import.meta.url)))})
vim.api.nvim_create_autocmd('BufReadPost',{pattern='*.lsp',callback=function(ev)
  local start=function() for _,c in ipairs(vim.json.decode([==[${JSON.stringify(configs)}]==])) do vim.lsp.start(c,{bufnr=ev.buf}) end end
  ${attachDelay ? `vim.defer_fn(start,${attachDelay})` : 'start()'}
end})`);
  const service = launchNvimService({ cwd: directory, init, graceMs: 100, killMs: 300 });
  const client = new SemanticClient();
  t.after(async () => { client.close(); await service.stop(); await rm(directory, { recursive: true, force: true }); });
  const info = await service.ready; client.setService(info);
  const file = join(directory, 'é "source".lsp'); await writeFile(file, 'é😀 target\n');
  return { directory, client, info, service, file, log,
    query: (options = {}, signal) => client.query({ file, operation: 'definition', line: 1, column: 8, timeoutMs: 2500, ...options }, directory, signal),
    async lua(code, args = []) { const signal = AbortSignal.timeout(2000); return (await client.connect(signal)).request('nvim_exec_lua', [code, args], signal); },
  };
}
const items = report => report.providers.flatMap(p => p.items);

test('rejects invalid operations, queries, positions, paths and bounds before I/O', () => {
  const base = { operation: 'definition', file: 'a', line: 1, column: 1 };
  for (const change of [{ operation: 'workspace/executeCommand' }, { file: 'a\0b' }, { line: 0 }, { column: 1.5 }, { limit: 501 }, { timeoutMs: 99 }, { includeDeclaration: 1 }, { operation: 'workspace_symbols' }]) {
    assert.throws(() => validateParams({ ...base, ...change }));
  }
  assert.equal(validateParams(base).timeoutMs, 10000);
});

test('strict byte conversion handles astral Unicode, CRLF, BOM, and invalid positions', () => {
  for (const [encoding, start] of [['utf-8', 7], ['utf-16', 4], ['utf-32', 3]]) {
    assert.equal(byteIndex('é😀 target', start, encoding), 7);
    assert.deepEqual(normalizeRange('\uFEFFé😀 target\r\n', { start: { line: 0, character: start }, end: { line: 0, character: start + 6 } }, encoding),
      { line: 1, column: 8, endLine: 1, endColumn: 14 });
  }
  assert.throws(() => byteIndex('😀', 1, 'utf-16'));
  assert.throws(() => byteIndex('é', 1, 'utf-8'));
  assert.throws(() => byteIndex('é', 5, 'utf-32'));
  assert.throws(() => normalizeRange('x', { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, 'utf-16'));
});

for (const [mode, offset] of [['normal', 4], ['utf8', 7], ['utf32', 3]]) {
  test(`real ${mode} LSP request positions and LocationLinks normalize to byte ranges`, async t => {
    const f = await fixture(t, [mode]);
    const report = await f.query();
    assert.equal(report.status, 'ok', JSON.stringify(report));
    assert.equal(report.diskVerified, true);
    assert.equal(items(report)[0].range.column, 8);
    assert.equal(items(report)[0].fullRange.endColumn, 14);
    assert.equal(items(report)[0].targetDiskVerified, true);
    const hover = await f.query({ operation: 'hover' });
    assert.equal(JSON.parse(items(hover)[0].contents[0].text).position.character, offset);
    const records = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.some(r => /executeCommand|formatting|rename|didSave|codeAction/.test(r.method)), false);
  });
}

test('all navigation kinds, reference declarations and explicit empty responses', async t => {
  const f = await fixture(t);
  for (const operation of ['declaration', 'type_definition', 'implementation']) assert.equal((await f.query({ operation })).status, 'ok');
  assert.equal(items(await f.query({ operation: 'references' })).length, 2);
  assert.equal(items(await f.query({ operation: 'references', includeDeclaration: false })).length, 1);
  await writeFile(f.file, 'EMPTY');
  const empty = await f.query({ column: 1 });
  assert.equal(empty.status, 'ok'); assert.equal(empty.providers[0].status, 'empty');
  assert.equal(items(empty).length, 0);
});

test('document hierarchies, filtering and anchored workspace symbols', async t => {
  const f = await fixture(t);
  const outline = await f.query({ operation: 'document_symbols' });
  assert.deepEqual(items(outline).map(i => [i.name, i.container]), [['target', undefined], ['child', 'target']]);
  assert.equal(items(await f.query({ operation: 'document_symbols', query: 'CHILD' })).length, 1);
  const workspace = await f.query({ operation: 'workspace_symbols', query: 'Lookup' });
  assert.equal(items(workspace)[0].name, 'Lookup');
  assert.equal(items(workspace)[1].range, undefined);
  assert.equal(items(workspace)[1].locationStatus, 'range_unresolved');
  assert.equal(workspace.providers[0].root, f.directory);
});

test('disk edits with preserved mtime/size refresh LSP text; canonical aliases reuse one buffer', async t => {
  const f = await fixture(t);
  const first = await f.query({ operation: 'hover' });
  const old = await stat(f.file);
  await writeFile(f.file, 'é😀 TARGET\n'); await utimes(f.file, old.atime, old.mtime);
  const fixed = await f.query({ operation: 'hover' });
  assert.equal(fixed.refreshed, true);
  assert.notEqual(JSON.parse(items(first)[0].contents[0].text).text, JSON.parse(items(fixed)[0].contents[0].text).text);
  await symlink(f.file, join(f.directory, 'alias.lsp'));
  const alias = await f.query({ file: 'alias.lsp', operation: 'hover' });
  assert.equal(alias.path, f.file); assert.equal(alias.refreshed, false);
  assert.equal(await f.lua('return vim.tbl_count(_G.__pi_nvim_buffers_v1.entries)'), 1);
});

test('invalid byte positions and modified buffers are explicit, never overwritten', async t => {
  const f = await fixture(t);
  assert.equal((await f.query({ column: 2 })).status, 'invalid_position');
  assert.equal((await f.query({ line: 100 })).status, 'invalid_position');
  await f.lua('local b=vim.fn.bufnr(...); vim.api.nvim_buf_set_lines(b,0,-1,false,{"unsaved"})', [f.file]);
  assert.equal((await f.query()).status, 'buffer_modified');
  assert.equal(await readFile(f.file, 'utf8'), 'é😀 target\n');
});

test('target files are normalized without loading buffers; modified targets keep raw ranges', async t => {
  const f = await fixture(t, ['cross']);
  const target = join(f.directory, 'target.lsp'); await writeFile(target, 'é😀 target\n');
  const first = await f.query();
  assert.equal(items(first)[0].range.column, 8);
  assert.equal(await f.lua('return vim.fn.bufnr(...)', [target]), -1);
  await f.lua('local b=vim.fn.bufadd(...); vim.fn.bufload(b); vim.api.nvim_buf_set_lines(b,0,-1,false,{"unsaved"})', [target]);
  const conflict = items(await f.query())[0];
  assert.equal(conflict.locationStatus, 'target_buffer_modified'); assert.equal(conflict.range, undefined);
});

test('accepts a single Location response, not only arrays or LocationLinks', async t => {
  const f = await fixture(t, ['single']);
  assert.equal(items(await f.query())[0].range.column, 8);
});

test('non-file URIs and malformed server responses never get invented file positions', async t => {
  const f = await fixture(t, ['virtual', 'malformed']);
  const report = await f.query();
  assert.equal(report.status, 'partial');
  assert.equal(items(report)[0].locationStatus, 'non_file_uri');
  assert.equal(items(report)[0].range, undefined);
  assert.equal(report.providers.find(p => p.name === 'fixture-malformed').status, 'error');
});

test('late attachment works; unsupported and absent providers are not empty success', async t => {
  const late = await fixture(t, ['normal'], 350);
  assert.equal((await late.query()).status, 'ok');
  const unsupported = await fixture(t, ['unsupported']);
  assert.equal((await unsupported.query()).status, 'unsupported');
  const absent = await fixture(t, []);
  const report = await absent.query({ timeoutMs: 350 });
  assert.equal(report.status, 'no_provider_observed'); assert.equal(report.timedOut, true);
});

test('partial results survive a hanging provider; all-error responses remain explicit', async t => {
  const f = await fixture(t, ['normal', 'hang']);
  const report = await f.query({ timeoutMs: 650 });
  assert.equal(report.status, 'partial'); assert.equal(report.timedOut, true);
  assert.equal(items(report).length, 1);
  const failure = await fixture(t, ['error']);
  assert.equal((await failure.query()).status, 'provider_error');
});

test('cancellation cleans leases and sends cancellation to only its own LSP requests', async t => {
  const f = await fixture(t, ['hang']);
  const controller = new AbortController();
  const rejected = assert.rejects(f.query({}, controller.signal), { name: 'AbortError' });
  await delay(300); controller.abort(); await rejected;
  assert.equal(await f.lua('return vim.tbl_count(_G.__pi_semantic_v1.requests)'), 0);
  assert.equal(await f.lua('return vim.tbl_count(_G.__pi_nvim_buffers_v1.requests)'), 0);
  await delay(50);
  assert.match(await readFile(f.log, 'utf8'), /\$\/cancelRequest/);
});

test('diagnostics and semantic calls share queue, buffer cache and modification guards', async t => {
  const f = await fixture(t, ['delay']);
  const diagnostics = new DiagnosticsClient(); diagnostics.setService(f.info); t.after(() => diagnostics.close());
  const first = f.query();
  await delay(80);
  const start = Date.now();
  const queued = await diagnostics.diagnose({ files: [f.file], timeoutMs: 150 }, f.directory);
  assert.equal(queued.timedOut, true); assert.ok(Date.now() - start < 500);
  assert.equal((await first).status, 'ok');
  const result = await diagnostics.diagnose({ files: [f.file], timeoutMs: 1500 }, f.directory);
  assert.equal(result.files[0].refreshed, false);
  assert.equal(await f.lua('return _G.__pi_diagnostics_v1.entries == _G.__pi_nvim_buffers_v1.entries'), true);
});

test('disk and buffer races during a response are surfaced', async t => {
  const f = await fixture(t, ['delay']);
  const pending = f.query(); await delay(250); await writeFile(f.file, 'changed target\n');
  const report = await pending;
  assert.equal(report.status, 'disk_changed'); assert.equal(report.diskVerified, false);
  const again = f.query({ column: 1 }); await delay(150);
  await f.lua('vim.api.nvim_buf_set_lines(vim.fn.bufnr(...),0,-1,false,{"modified"})', [f.file]);
  assert.equal((await again).status, 'buffer_modified');
});

test('service loss, replacement and a frozen service do not become empty successes', async t => {
  const f = await fixture(t, ['hang']);
  const pending = assert.rejects(f.query(), /stopped or changed/);
  await delay(150); f.client.setService(undefined); await pending;
  await assert.rejects(f.query(), /unavailable/);
  f.client.setService(f.info);
  process.kill(f.info.pid, 'SIGSTOP');
  const report = await f.query({ timeoutMs: 250 });
  assert.equal(report.status, 'timed_out');
  process.kill(f.info.pid, 0);
});

test('file errors, output limits and private full reports are explicit', async t => {
  const f = await fixture(t, ['large']);
  assert.equal((await f.query({ file: 'missing' })).status, 'file_error');
  const report = await f.query({ operation: 'workspace_symbols', query: 'name', limit: 80 });
  assert.equal(items(report).length, 80); assert.equal(report.truncated, true);
  const result = await formatReport(report);
  assert.ok(Buffer.byteLength(result.text) <= 16384);
  assert.equal(result.details.truncated, true);
  t.after(() => rm(dirname(result.details.fullOutputPath), { recursive: true, force: true }));
  assert.equal((await stat(result.details.fullOutputPath)).mode & 0o777, 0o600);
  assert.equal(result.details.providers[0].items, undefined);
  assert.equal(JSON.parse(await readFile(result.details.fullOutputPath, 'utf8')).providers[0].items.length, 80);
});
