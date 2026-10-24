import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './service.mjs';
import { connectRpc } from './rpc.mjs';
import { alive, gone } from './test/helpers.mjs';

const fast = { cwd: '/tmp', init: 'NONE', graceMs: 100, killMs: 300 };

async function slowInit(t) {
  const directory = await mkdtemp('/tmp/pi-nvim-test-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const init = join(directory, 'init.lua');
  await writeFile(init, 'vim.uv.sleep(60000)');
  return init;
}

async function owner(t, mode, init = 'NONE') {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./test/owner.mjs', import.meta.url)), mode, init], { cwd: '/tmp', stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => child.kill('SIGKILL'));
  const [line] = await once(child.stdout.setEncoding('utf8'), 'data');
  return { child, info: JSON.parse(line) };
}

test('starts a private instance and stops it cleanly', async () => {
  const service = launch(fast);
  const info = await service.ready;
  assert.deepEqual(await service.spawned, info);
  assert.equal(info.cwd, '/tmp');
  assert.ok(alive(info.pid) && alive(info.supervisorPid) && existsSync(info.socket));
  assert.deepEqual(await service.stop(), { error: undefined });
  assert.equal(service.stop(), service.stop());
  assert.ok(await gone(info, 0));
});

for (const [mode, signal] of [['exit'], ['crash'], ['wait', 'SIGTERM'], ['wait', 'SIGKILL']]) {
  test(`Neovim goes away when its owner ends: ${signal ?? mode}`, async t => {
    const { child, info } = await owner(t, mode);
    if (signal) child.kill(signal);
    assert.ok(await gone(info));
  });
}

test('a stopped (frozen) Neovim is still removed after the owner is killed', async t => {
  const { child, info } = await owner(t, 'wait');
  process.kill(info.pid, 'SIGSTOP');
  child.kill('SIGKILL');
  assert.ok(await gone(info));
});

test('a Neovim stuck in Lua is killed within the bound', async () => {
  const service = launch(fast);
  const info = await service.ready;
  const rpc = await connectRpc(info.socket);
  rpc.notify('nvim_exec_lua', ['while true do end', []]);
  await service.stop();
  rpc.close();
  assert.ok(await gone(info, 0));
});

test('the owner dying during startup leaves nothing behind', async t => {
  const { child, info } = await owner(t, 'startup', await slowInit(t));
  assert.ok(alive(info.pid));
  child.kill('SIGKILL');
  assert.ok(await gone(info));
});

test('startup timeout and a missing executable fail without leftovers', async t => {
  const slow = launch({ ...fast, init: await slowInit(t), startupTimeoutMs: 300 });
  const info = await slow.spawned;
  await assert.rejects(slow.ready, /startup timed out/);
  assert.match((await slow.exited).error.message, /startup timed out/);
  assert.ok(await gone(info));

  const missing = launch({ ...fast, executable: '/nonexistent/nvim' });
  await assert.rejects(missing.ready, /ENOENT/);
  await assert.rejects(missing.spawned);
  await missing.stop();
});

test('an unexpected Neovim exit is reported and cleaned up', async () => {
  const service = launch(fast);
  const info = await service.ready;
  process.kill(info.pid, 'SIGKILL');
  assert.match((await service.exited).error.message, /exited unexpectedly \(SIGKILL\)/);
  assert.ok(await gone(info));
});

test('instances are independent', async () => {
  const a = launch(fast), b = launch(fast);
  const [first, second] = await Promise.all([a.ready, b.ready]);
  assert.notEqual(first.socket, second.socket);
  await a.stop();
  assert.ok(await gone(first, 0));
  assert.ok(alive(second.pid));
  await b.stop();
  assert.ok(await gone(second, 0));
});

test('plugins named in the settings are disabled through lazy.nvim', async t => {
  const directory = await mkdtemp('/tmp/pi-nvim-test-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A stand-in for lazy.nvim's configuration module, added to the runtimepath as its bootstrap does.
  await mkdir(join(directory, 'lazy/lua/lazy/core'), { recursive: true });
  await writeFile(join(directory, 'lazy/lua/lazy/core/config.lua'),
    "local M = { defaults = { defaults = {} } }\nfunction M.setup(opts) M.options = vim.tbl_deep_extend('force', M.defaults, opts) end\nreturn M");
  const init = join(directory, 'init.lua');
  await writeFile(init, `vim.opt.rtp:prepend(${JSON.stringify(join(directory, 'lazy'))})
local Config = require('lazy.core.config')
Config.setup({ defaults = { cond = function(plugin) return plugin.name ~= 'user-off' end } })
-- What lazy.nvim would make of it: a spec's own \`cond\` keeps a plugin enabled.
Config.plugins, Config.spec = { ['own-cond'] = {} }, { disabled = { ['pi-off'] = {} } }`);
  const settings = join(directory, 'nvim-service.json');
  await writeFile(settings, JSON.stringify({ disabledPlugins: ['pi-off', 'own-cond', 'missing'] }));

  const service = launch({ ...fast, init, settings });
  const rpc = await connectRpc((await service.ready).socket);
  t.after(() => { rpc.close(); return service.stop(); });
  const conds = await rpc.request('nvim_exec_lua', [
    "local cond = require('lazy.core.config').options.defaults.cond\nreturn vim.tbl_map(function(name) return cond({ name = name }) end, { 'pi-off', 'user-off', 'on' })", []]);
  assert.deepEqual(conds, [false, false, true]);
  assert.equal(await rpc.request('nvim_exec_lua', ['return __pi_nvim_disable_problems()', []]),
    'own-cond is still enabled: its spec sets its own `cond`\nmissing is not a lazy.nvim plugin');

  await writeFile(settings, '{ "disabledPlugins": "pi-off" }');
  await assert.rejects(launch({ ...fast, init, settings }).ready, /must be JSON like/);
});
