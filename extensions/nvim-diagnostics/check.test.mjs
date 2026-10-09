import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launchNvimService } from '../nvim-service/service.mjs';
import { DiagnosticsClient, formatReport, validateParams } from './core.mjs';

async function fixture(t, providers = [{ name: 'checker', mode: 'pull' }], extra = '') {
  const directory = await realpath(await mkdtemp('/tmp/pi-diag-check-'));
  const init = join(directory, 'init.lua');
  const definitions = providers.map(p => ({ ...p, cmd: [process.execPath, fileURLToPath(new URL('./test/lsp.mjs', import.meta.url)), p.mode] }));
  await writeFile(init, `local providers=vim.json.decode([==[${JSON.stringify(definitions)}]==])
vim.api.nvim_create_autocmd('BufReadPost',{pattern='*.lsp',callback=function(ev)
  for _,p in ipairs(providers) do
    if not p.file or p.file==vim.fn.fnamemodify(vim.api.nvim_buf_get_name(ev.buf),':t') then
      local start=function() if vim.api.nvim_buf_is_valid(ev.buf) then
        vim.lsp.start({name=p.name,cmd=p.cmd,root_dir=vim.fn.getcwd()},
          {bufnr=ev.buf,reuse_client=function(client,config)
            return client.name==config.name and vim.deep_equal(client.config.cmd,config.cmd)
          end})
      end end
      if p.delay and #vim.lsp.get_clients({name=p.name})==0 then vim.defer_fn(start,p.delay) else start() end
    end
  end
end})
${extra}`);
  const service = launchNvimService({ cwd: directory, init, graceMs: 100, killMs: 300 });
  const client = new DiagnosticsClient();
  t.after(async () => { client.close(); await service.stop(); await rm(directory, { recursive: true, force: true }); });
  const info = await service.ready; client.setService(info);
  return {
    directory, client, service, info,
    async file(name = 'bad.lsp', text = 'é BAD') { const path = join(directory, name); await writeFile(path, text); return path; },
    run(files, params = {}, signal) { return client.diagnose({ files, timeoutMs: 2500, mode: 'check', requiredClients: ['checker'], ...params }, directory, signal); },
    async lua(code, args = []) { const signal = AbortSignal.timeout(2000); return (await client.connect(signal)).request('nvim_exec_lua', [code, args], signal); },
  };
}
const required = row => row.requirements.find(r => r.name === 'checker');
async function dynamicEnumeration(t, f) {
  if (await f.lua("return vim.fn.has('nvim-0.12') == 1")) return true;
  t.skip('Complete dynamic enumeration requires Neovim 0.12; legacy coverage is tested separately');
  return false;
}

test('modes and required names are explicit, bounded, and validated before I/O', () => {
  assert.equal(validateParams({ files: ['a'] }).mode, 'snapshot');
  for (const input of [
    { mode: 'unknown' }, { mode: null }, { mode: 'check' },
    { mode: 'check', requiredClients: [] }, { requiredClients: ['checker'] },
    { mode: 'snapshot', requiredClients: ['checker'] },
    { mode: 'check', requiredClients: ['checker', 'checker'] },
    { mode: 'check', requiredClients: [''] }, { mode: 'check', requiredClients: ['   '] },
    { mode: 'check', requiredClients: ['bad\0name'] }, { mode: 'check', requiredClients: ['x'.repeat(513)] },
    { mode: 'check', requiredClients: Array.from({ length: 17 }, (_, i) => `c${i}`) },
  ]) assert.throws(() => validateParams({ files: ['a'], ...input }));
  assert.deepEqual(validateParams({ files: ['a'], mode: 'check', requiredClients: ['checker'] }).requiredClients, ['checker']);
});

const lateProviders = [{ name: 'fast-linter', mode: 'empty' }, { name: 'checker', mode: 'pull', delay: 1600 }];
test('a cold snapshot can observe only the fast empty provider, but never calls it a check', async t => {
  const f = await fixture(t, lateProviders);
  const report = await f.run([await f.file()], { mode: 'snapshot', requiredClients: undefined, timeoutMs: 1300 });
  assert.equal(report.check.status, 'not_requested');
  assert.equal(report.mode, 'snapshot');
  assert.equal(report.timedOut, false, JSON.stringify(report));
  assert.deepEqual(report.files[0].clients.map(c => c.name), ['fast-linter']);
  assert.equal(report.files[0].diagnostics.length, 0);
  assert.match((await formatReport(report)).text, /snapshot.*not.*check/i);
});

test('a cold check waits for the declared late checker with an error already present', async t => {
  const f = await fixture(t, lateProviders);
  const path = await f.file(); // No clean-file warmup or prior semantic/diagnostic call.
  const report = await f.run([path], { timeoutMs: 3500 });
  assert.equal(report.check.status, 'complete', JSON.stringify(report));
  assert.equal(report.timedOut, false);
  assert.ok(report.elapsedMs >= 1600);
  assert.equal(report.files[0].diagnostics.length, 1);
  assert.equal(report.files[0].diagnostics[0].column, 4, 'UTF-16 response becomes a UTF-8 byte column');
  assert.equal(required(report.files[0]).state, 'responded');
  assert.equal(report.files[0].diskVerified, true);
  assert.match(report.files[0].sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(report.service.pid, f.info.pid);
  assert.equal(report.service.socket, f.info.socket);
  assert.equal(report.service.identityVerified, true);
  assert.equal(report.schemaVersion, 2);
  const text = (await formatReport(report)).text;
  for (const value of [report.requestId, String(f.info.pid), f.info.socket, 'checker', 'fixture', 'responded']) assert.ok(text.includes(value), value);
  assert.match(text, /elapsed.*ms/i);
  assert.match(text, /complete.*not.*pass/i);
  await writeFile(path, 'OK');
  const fixed = await f.run([path]);
  assert.equal(fixed.check.status, 'complete', JSON.stringify(fixed));
  assert.equal(fixed.files[0].diagnostics.length, 0);
  assert.notEqual(fixed.requestId, report.requestId);
  assert.notEqual(fixed.files[0].sourceHash, report.files[0].sourceHash);
});

for (const [label, providers, expected] of [
  ['missing', [{ name: 'fast-linter', mode: 'empty' }], 'missing'],
  // Neovim's public discovery hides clients still awaiting initialize. Missing
  // means not observed, never proof that the configured checker is absent.
  ['initializing but not yet publicly discoverable', [{ name: 'checker', mode: 'init-hang' }], 'missing'],
  ['push-only', [{ name: 'checker', mode: 'push' }], 'unconfirmed'],
  ['hanging', [{ name: 'checker', mode: 'hang' }], 'pending'],
]) {
  test(`a ${label} required client cannot become a complete zero-diagnostic check`, async t => {
    const f = await fixture(t, providers);
    const report = await f.run([await f.file()], { timeoutMs: 800 });
    assert.equal(report.check.status, 'incomplete', JSON.stringify(report));
    assert.equal(report.timedOut, true);
    assert.equal(required(report.files[0]).state, expected);
    assert.match((await formatReport(report)).text, /incomplete/i);
  });
}

test('dynamic capability arrival can satisfy an initialized but initially unconfirmed client', async t => {
  const f = await fixture(t, [{ name: 'checker', mode: 'dynamic-late' }]);
  if (!await dynamicEnumeration(t, f)) return;
  const report = await f.run([await f.file()]);
  assert.equal(report.check.status, 'complete', JSON.stringify(report));
  assert.ok(report.elapsedMs >= 800);
  assert.equal(report.files[0].diagnostics[0].identifier, 'fixture-dynamic');
});

test('an unrelated hanging client cannot block a required checker', async t => {
  const f = await fixture(t, [{ name: 'unrelated', mode: 'hang' }, { name: 'checker', mode: 'pull' }]);
  const report = await f.run([await f.file()]);
  assert.equal(report.check.status, 'complete', JSON.stringify(report));
  assert.equal(report.timedOut, false);
  const other = report.files[0].providers.find(c => c.name === 'unrelated');
  assert.equal(other.required, false);
  assert.deepEqual(other.pulls, []);
});

for (const mode of ['error', 'cancel', 'unchanged', 'malformed', 'bad-range', 'many']) {
  test(`${mode} required responses fail explicitly instead of becoming a complete check`, async t => {
    const f = await fixture(t, [{ name: 'checker', mode }]);
    const report = await f.run([await f.file()], { timeoutMs: 3500 });
    assert.equal(report.check.status, 'failed', JSON.stringify({ check: report.check, files: report.files.map(({ diagnostics, ...file }) => file) }));
    assert.equal(report.files[0].check.status, 'failed');
    if (mode === 'cancel') assert.equal(report.files[0].pullRetries, 2);
    if (mode === 'many') assert.ok(report.files[0].omittedDiagnostics > 0);
    if (mode === 'bad-range') assert.equal(report.files[0].diagnostics[0].locationStatus, 'unconvertible');
    assert.equal(await f.lua('return vim.tbl_count(_G.__pi_diagnostics_v1.requests)'), 0);
  });
}

test('malformed snapshot replies remain explicit pull errors', async t => {
  const f = await fixture(t, [{ name: 'checker', mode: 'malformed' }]);
  const report = await f.run([await f.file()], { mode: 'snapshot', requiredClients: undefined });
  assert.equal(report.files[0].status, 'pull_error', JSON.stringify(report));
  assert.ok(report.files[0].pullErrors.length > 0);
  assert.equal(report.timedOut, false);
});

test('every matching client instance and distinct provider must answer', async t => {
  const f = await fixture(t, [{ name: 'checker', mode: 'dynamic-multi' }]);
  if (!await dynamicEnumeration(t, f)) return;
  const report = await f.run([await f.file()]);
  assert.equal(report.check.status, 'complete', JSON.stringify(report));
  assert.deepEqual(report.files[0].diagnostics.map(d => d.identifier).sort(), ['fixture-dynamic', 'fixture-other']);
  const other = await fixture(t, [{ name: 'checker', mode: 'pull' }, { name: 'checker', mode: 'error' }]);
  const failed = await other.run([await other.file()]);
  assert.equal(failed.check.status, 'failed', JSON.stringify(failed));
  assert.equal(required(failed.files[0]).clientIds.length, 2);
});

test('required clients apply to each file, not the union of clients in the batch', async t => {
  const f = await fixture(t, [{ name: 'checker', mode: 'pull', file: 'a.lsp' }, { name: 'fast-linter', mode: 'empty' }]);
  const report = await f.run([await f.file('a.lsp'), await f.file('b.lsp')], { timeoutMs: 900 });
  assert.equal(report.check.status, 'incomplete');
  assert.equal(report.files[0].check.status, 'complete');
  assert.equal(report.files[1].check.status, 'incomplete');
  assert.equal(required(report.files[1]).state, 'missing');
});

test('checks retain owned replies instead of trusting an unrelated diagnostic cache', async t => {
  const f = await fixture(t, [{ name: 'checker', mode: 'empty' }], `
vim.api.nvim_create_autocmd('BufReadPost',{pattern='*.lsp',callback=function(ev)
  vim.defer_fn(function() vim.diagnostic.set(vim.api.nvim_create_namespace('unrelated-cache'),ev.buf,
    {{lnum=0,col=0,message='stale cache error',severity=1}}) end,100)
end})`);
  const path = await f.file();
  const report = await f.run([path]);
  assert.equal(report.check.status, 'complete', JSON.stringify(report));
  assert.equal(report.files[0].diagnostics.length, 0);
  assert.ok(await f.lua('return #vim.diagnostic.get(vim.fn.bufnr(...))', [path]) > 0);
  const snapshot = await f.run([path], { mode: 'snapshot', requiredClients: undefined });
  assert.equal(snapshot.check.status, 'not_requested');
  assert.ok(snapshot.files[0].diagnostics.some(d => d.namespace === 'unrelated-cache'));
});

for (const kind of ['disk', 'buffer']) {
  test(`${kind} changes while a required response is pending invalidate completion`, async t => {
    const f = await fixture(t, [{ name: 'checker', mode: 'delay' }]);
    const path = await f.file();
    const pending = f.run([path]);
    await delay(200);
    if (kind === 'disk') await writeFile(path, 'OK');
    else await f.lua('vim.api.nvim_buf_set_lines(vim.fn.bufnr(...),0,-1,false,{"unsaved"})', [path]);
    const report = await pending;
    assert.equal(report.check.status, 'failed', JSON.stringify(report));
    assert.equal(report.files[0].status, kind === 'disk' ? 'disk_changed' : 'buffer_modified');
    if (kind === 'buffer') assert.equal(await readFile(path, 'utf8'), 'é BAD');
  });
}

test('a loaded buffer with different logical contents cannot validate the disk snapshot', async t => {
  const f = await fixture(t, [], `vim.api.nvim_create_autocmd('BufReadPost',{pattern='*.lsp',callback=function(ev)
    vim.api.nvim_buf_set_lines(ev.buf,0,-1,false,{'different'}); vim.bo[ev.buf].modified=false end})`);
  const report = await f.run([await f.file()]);
  assert.equal(report.check.status, 'failed');
  assert.equal(report.files[0].status, 'buffer_changed');
});

test('queued checks expose an uncontacted service and caller cancellation releases state', async t => {
  const f = await fixture(t, [{ name: 'checker', mode: 'hang' }]);
  const path = await f.file();
  const controller = new AbortController();
  const first = f.run([path], { timeoutMs: 3000 }, controller.signal);
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await delay(200);
  const queued = await f.run([path], { timeoutMs: 150 });
  assert.equal(queued.check.status, 'incomplete');
  assert.equal(queued.service.identityVerified, false);
  assert.equal(queued.timedOut, true);
  controller.abort(); await rejected;
  assert.equal(await f.lua('return vim.tbl_count(_G.__pi_diagnostics_v1.requests)'), 0);
});

for (const mode of ['dynamic-switch', 'dynamic-replace']) {
  test(`${mode} retires superseded owned work, including reused provider identifiers`, async t => {
    const f = await fixture(t, [{ name: 'checker', mode }]);
    if (!await dynamicEnumeration(t, f)) return;
    const path = await f.file();
    const pending = f.run([path], { timeoutMs: 3500 });
    void pending.catch(() => {}); // Cleanup must not leave an unhandled rejection if a barrier assertion fails.
    const before = Date.now();
    let observed = false;
    while (Date.now() - before < 1500) {
      observed = await f.lua(`for _,r in pairs(_G.__pi_diagnostics_v1.requests) do
        for _,file in ipairs(r.files) do for _,p in pairs(file.pulls) do
          if p.id and not p.done and p.identifier=='fixture-dynamic' then return true end
        end end end; return false`);
      if (observed) break;
      await delay(20);
    }
    assert.equal(observed, true, 'Own old-registration request must be pending before switching');
    await f.lua("vim.lsp.get_clients({name='checker'})[1]:request('fixture/switch',{},function() end)");
    const report = await pending;
    assert.equal(report.check.status, 'complete', JSON.stringify(report));
    assert.equal(report.files[0].diagnostics.length, 1);
    const pulls = report.files[0].providers[0].pulls;
    if (mode === 'dynamic-switch') {
      assert.equal(report.files[0].diagnostics[0].identifier, 'fixture-replacement');
      assert.ok(pulls.some(p => p.state === 'retired'));
    } else {
      assert.equal(pulls.length, 1);
      assert.equal(pulls[0].attempts, 2);
    }
  });
}

test('legacy single-match dynamic enumeration cannot certify complete client coverage', async t => {
  const f = await fixture(t, [{ name: 'checker', mode: 'dynamic-multi' }], `
vim.api.nvim_create_autocmd('LspAttach',{callback=function(ev)
  local c=vim.lsp.get_client_by_id(ev.data.client_id); local get=c.dynamic_capabilities.get
  c.dynamic_capabilities.get=function(self,method,options)
    if method=='diagnosticProvider' then return nil end
    local registrations=get(self,vim.fn.has('nvim-0.12')==1 and 'diagnosticProvider' or method,options)
    return registrations and (registrations.method and registrations or registrations[1])
  end
end})`);
  const report = await f.run([await f.file()], { timeoutMs: 900 });
  assert.equal(report.check.status, 'incomplete', JSON.stringify(report));
  assert.equal(required(report.files[0]).state, 'unconfirmed');
  assert.equal(report.files[0].providers[0].enumeration, 'single_match');
});

test('selector-only dynamic checks do not depend on Neovim diagnostic-cache pull state', async t => {
  const f = await fixture(t, [{ name: 'checker', mode: 'dynamic-selectors-only' }]);
  if (!await dynamicEnumeration(t, f)) return;
  const report = await f.run([await f.file()]);
  assert.equal(report.check.status, 'complete', JSON.stringify(report));
  assert.equal(report.files[0].diagnostics[0].identifier, 'fixture-dynamic');
});

test('required client observation limits fail rather than hiding another matching instance', async t => {
  const f = await fixture(t, [], `vim.lsp.get_clients=function()
    local clients={}; for id=1,17 do clients[id]={id=id,name='checker',initialized=true,config={},
      supports_method=function() return false end} end; return clients end`);
  const report = await f.run([await f.file()]);
  assert.equal(report.check.status, 'failed', JSON.stringify(report));
  assert.equal(report.files[0].extraClients, 1);
  assert.equal(report.files[0].providers.length, 16);
  assert.match(required(report.files[0]).reason, /limit/);
});

for (const [label, body, expected] of [
  ['registration churn', `return {{method='textDocument/diagnostic',registerOptions={identifier='churn'}}}`, /attempt limit/],
  ['registration count', `local list={}; for i=1,129 do list[i]={registerOptions={identifier='same'}} end; return list`, /128 matching/],
  ['identifier size', `return {{registerOptions={identifier=string.rep('x',513)}}}`, /512 bytes/],
]) {
  test(`${label} is an explicit required-provider failure at the final boundary`, async t => {
    const f = await fixture(t, undefined, `vim.api.nvim_create_autocmd('LspAttach',{callback=function(ev)
      local c=vim.lsp.get_client_by_id(ev.data.client_id)
      c.dynamic_capabilities.get=function() ${body} end
    end})`);
    const report = await f.run([await f.file()]);
    assert.equal(report.check.status, 'failed', JSON.stringify(report));
    assert.ok(report.files[0].pullErrors.some(e => expected.test(e.error)));
    if (label === 'registration churn') {
      assert.equal(report.files[0].pullRetries, 2);
      await delay(200); // Let obsolete full replies arrive after their requests were retired.
      assert.equal(await f.lua('return vim.tbl_count(_G.__pi_diagnostics_v1.requests)'), 0);
    }
  });
}

test('a source conflict at the final verification boundary invalidates completed replies', async t => {
  const f = await fixture(t);
  const path = await f.file();
  await f.lua(`local m=_G.__pi_diagnostics_v1; local verify=m.verify
    m.verify=function(token)
      local file=m.requests[token].files[1]
      vim.api.nvim_buf_set_lines(file.entry.buf,0,-1,false,{'unsaved final race'})
      return verify(token)
    end`);
  const report = await f.run([path]);
  assert.equal(report.check.status, 'failed', JSON.stringify(report));
  assert.equal(report.files[0].status, 'buffer_modified');
  assert.equal(report.files[0].diagnostics.length, 1, 'Retain useful owned replies with the explicit conflict');
  assert.equal(report.files[0].bufferVerified, false);
  assert.equal(await readFile(path, 'utf8'), 'é BAD');
});

for (const text of ['😀 BAD\r\n', '\uFEFFé BAD\n', '\uFEFF\uFEFFBAD\n']) {
  test(`logical UTF-8 source fencing and byte ranges: ${JSON.stringify(text)}`, async t => {
    const f = await fixture(t);
    const report = await f.run([await f.file('encoded.lsp', text)]);
    assert.equal(report.check.status, 'complete', JSON.stringify(report));
    assert.equal(report.files[0].diagnostics[0].column, Buffer.byteLength(text.replace(/^\uFEFF/, '').split('BAD')[0]) + 1);
  });
}

test('a stale helper protocol requests reload rather than returning a misleading report', async t => {
  const f = await fixture(t);
  await f.lua('_G.__pi_diagnostics_v1.protocolVersion=1');
  await assert.rejects(f.run([await f.file()]), /reload/i);
});
