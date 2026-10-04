import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const binary = realpathSync(process.env.PI_TEST_BINARY || execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const wrapper = resolve(dirname(binary), '../libexec/bin/pi');
let root = dirname(existsSync(wrapper) ? realpathSync(wrapper) : binary);
while (!existsSync(join(root, 'dist/core/extensions/loader.js'))) {
  const parent = dirname(root);
  assert.notEqual(parent, root, 'Cannot locate installed Pi loader; set PI_TEST_BINARY');
  root = parent;
}
const { loadExtensions } = await import(pathToFileURL(join(root, 'dist/core/extensions/loader.js')).href);
const { createEventBus } = await import(pathToFileURL(join(root, 'dist/core/event-bus.js')).href);

test('actual Pi loader shares consumers safely and reconnects them after service restart', async () => {
  const directory = await realpath(await mkdtemp('/tmp/pi-semantic-loader-'));
  const init = join(directory, 'init.lua');
  const cmd = [process.execPath, fileURLToPath(new URL('./test/lsp.mjs', import.meta.url)), 'delay'];
  const producer = fileURLToPath(new URL('../nvim-diagnostics/test/producer.lua', import.meta.url));
  await writeFile(init, `dofile(${JSON.stringify(producer)})
vim.api.nvim_create_autocmd('BufReadPost',{pattern='*.lsp',callback=function(ev)
vim.lsp.start({name='loader-fixture',cmd=vim.json.decode([==[${JSON.stringify(cmd)}]==]),root_dir=vim.fn.getcwd()},{bufnr=ev.buf}) end})`);
  const file = join(directory, 'sample.lsp'); await writeFile(file, 'é😀 target BAD\n');
  const oldInit = process.env.PI_NVIM_INIT;
  process.env.PI_NVIM_INIT = init;
  const bus = createEventBus(), ctx = { cwd: directory, hasUI: false };
  let extensions = [];
  const emit = async name => { for (const e of extensions) for (const handler of e.handlers.get(name) ?? []) await handler({ type: name }, ctx); };
  const serviceInfo = () => { let value; bus.emit('nvim-service:get', { reply: info => { value = info; } }); return value; };
  try {
    const loaded = await loadExtensions(['nvim-semantic', 'nvim-diagnostics', 'nvim-service'].map(n => fileURLToPath(new URL(`../${n}/index.ts`, import.meta.url))), directory, bus);
    assert.deepEqual(loaded.errors, []); extensions = loaded.extensions;
    const tools = new Map(extensions.flatMap(e => [...e.tools].map(([name, tool]) => [name, tool.definition])));
    assert.equal(tools.size, 4);
    const run = (name, params) => tools.get(name).execute('id', params, undefined, undefined, ctx);
    assert.equal(serviceInfo(), undefined, 'Registration must not start Neovim');
    await emit('session_start');
    const first = serviceInfo();
    const navigation = run('nvim_navigate', { file, kind: 'definition', line: 1, column: 8, timeoutMs: 3000 });
    await delay(80);
    const queued = await run('nvim_diagnostics', { files: [file], timeoutMs: 150 });
    assert.equal(queued.details.files[0].status, 'timed_out', 'Different Pi-loaded extensions must use the same request queue');
    assert.equal((await navigation).details.status, 'ok');
    assert.equal((await run('nvim_hover', { file, line: 1, column: 8, timeoutMs: 3000 })).details.status, 'ok');
    assert.equal((await run('nvim_symbols', { file, timeoutMs: 3000 })).details.status, 'ok');
    assert.equal((await run('nvim_diagnostics', { files: [file], timeoutMs: 1500 })).details.files[0].refreshed, false);
    await emit('session_shutdown'); assert.equal(existsSync(first.socket), false);
    await emit('session_start'); assert.notEqual(serviceInfo().socket, first.socket);
    bus.emit('nvim-service:stopped', first);
    assert.equal((await run('nvim_hover', { file, line: 1, column: 8, timeoutMs: 3000 })).details.status, 'ok');
  } finally {
    await emit('session_shutdown');
    if (oldInit === undefined) delete process.env.PI_NVIM_INIT; else process.env.PI_NVIM_INIT = oldInit;
    await rm(directory, { recursive: true, force: true });
  }
});
