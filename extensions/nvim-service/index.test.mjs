import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once, EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { useNvim } from './api.mjs';
import { gone } from './test/helpers.mjs';

process.env.PI_NVIM_INIT = 'NONE';
// Load the real extension entry point, wired to the real service modules.
const source = stripTypeScriptTypes(await readFile(new URL('./index.ts', import.meta.url), 'utf8'))
  .replace(/'(\.\/[a-z]+\.mjs|@earendil-works\/pi-ai)'/g, (_, specifier) => JSON.stringify(import.meta.resolve(specifier)));
const { default: register } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function fakePi(t) {
  const bus = new EventEmitter(), hooks = new EventEmitter(), tools = {}, commands = {}, notes = [];
  const pi = {
    events: { on: (channel, handler) => bus.on(channel, handler), emit: (channel, data) => bus.emit(channel, data) },
    on: (event, handler) => hooks.on(event, handler),
    registerTool: tool => { tools[tool.name] = tool; },
    registerCommand: (name, command) => { commands[name] = command; },
  };
  const ctx = { cwd: '/tmp', hasUI: true, ui: { notify: (message, type) => notes.push(`${type}: ${message}`) } };
  const fire = event => Promise.all(hooks.listeners(event).map(handler => handler({ type: event }, ctx)));
  const early = useNvim(pi);
  register(pi);
  t.after(() => fire('session_shutdown'));
  return { pi, bus, tools, notes, fire, early, late: useNvim(pi),
    call: async (name, params = {}, signal) => (await tools[name].execute('id', params, signal, undefined, ctx)).content[0].text,
    command: async (args = '') => { await commands['nvim-service'].handler(args, ctx); return notes.at(-1); },
  };
}

test('loading registers tools and a command but starts nothing', async t => {
  const f = fakePi(t);
  assert.deepEqual(Object.keys(f.tools), ['nvim_lua', 'nvim_keys', 'nvim_restart']);
  for (const tool of Object.values(f.tools)) assert.equal(tool.executionMode, 'sequential');
  assert.throws(f.early, /Neovim service unavailable/);
  await assert.rejects(f.call('nvim_lua', { code: 'return 1' }), /Neovim is not running\. Use nvim_restart/);
  assert.equal(await f.command(), 'warning: Neovim service is not running. Run /nvim-service restart.');
  assert.equal(process.env.PI_NVIM_SOCKET, undefined);
});

test('a session gets one editor that Pi and other extensions can drive', async t => {
  const f = fakePi(t);
  const ready = once(f.bus, 'nvim-service:ready');
  await f.fire('session_start');
  // The first tool call waits for startup instead of failing.
  assert.equal(await f.call('nvim_keys', { keys: 'ihi<Esc>' }), 'mode n | buffer 1 [No Name] [+] | 1:2');
  const [handle] = await ready;
  assert.equal(handle.apiVersion, 1);
  assert.equal(handle.info.cwd, '/tmp');
  assert.equal(f.early(), handle);
  assert.equal(f.late(), handle);
  assert.equal(process.env.PI_NVIM_SOCKET, handle.info.socket);
  const { info } = handle;
  assert.equal(await f.command(), `info: Neovim PID ${info.pid}\nSupervisor PID ${info.supervisorPid}\nSocket: ${info.socket}\nWorking directory: /tmp`);

  assert.equal(await f.call('nvim_lua', { code: 'return vim.api.nvim_get_current_line()' }), 'hi');
  assert.equal(await f.call('nvim_lua', { code: 'local a, b = ...; return { sum = a + b }', args: [1, 2] }), '{"sum":3}');
  assert.equal(await f.call('nvim_lua', { code: 'vim.cmd.normal("x")' }), 'null');
  assert.equal(await handle.lua('return vim.api.nvim_get_current_line()'), 'h');
  assert.match(await f.call('nvim_lua', { code: 'return string.rep("x", 20000)' }), /x\n\[Truncated: 16384 of 20000 characters shown/);
  assert.match(await f.call('nvim_keys', { keys: '', screen: true }), /^mode n .*\nh\n~\n/);
  await assert.rejects(f.call('nvim_lua', { code: 'error("bad lua")' }), /bad lua/);
  await assert.rejects(f.call('nvim_lua', { code: 'vim.wait(5000)' }, AbortSignal.abort(new Error('user cancelled'))), /user cancelled/);

  // A prompt shows its screen unasked, and Lua refuses with the same screen.
  assert.match(await f.call('nvim_keys', { keys: ':echo "a\\nb"<CR>' }), /^mode r \(blocked at a prompt\).*\n[^]*a\nb\nPress ENTER/);
  await assert.rejects(f.call('nvim_lua', { code: 'return 1' }), /waiting at a prompt[^]*a\nb\nPress ENTER/);
  assert.match(await f.call('nvim_keys', { keys: '<CR>' }), /^mode n /);

  // A repeated session_start (/new) keeps the instance.
  await f.fire('session_start');
  assert.equal(f.late(), handle);

  // A hung editor times out and can be replaced; consumers are told.
  const stopped = once(f.bus, 'nvim-service:stopped'), again = once(f.bus, 'nvim-service:ready');
  await assert.rejects(f.call('nvim_lua', { code: 'while true do end', timeoutMs: 200 }), /did not answer within 200 ms.*nvim_restart/);
  assert.match(await f.call('nvim_restart'), /^Neovim restarted: PID \d+, socket /);
  assert.deepEqual((await stopped)[0], info);
  const [fresh] = await again;
  assert.notEqual(fresh.info.pid, info.pid);
  assert.equal(handle.closed, true);
  assert.equal(f.early(), fresh);
  assert.ok(await gone(info, 0));
  assert.equal(await f.call('nvim_lua', { code: 'return vim.api.nvim_get_current_line()' }), '');

  await f.fire('session_shutdown');
  assert.ok(await gone(fresh.info, 0));
  assert.throws(f.late, /unavailable/);
  assert.equal(process.env.PI_NVIM_SOCKET, undefined);
  assert.deepEqual(f.notes.filter(note => note.startsWith('warning')), []);
});

test('startup failure and an unexpected exit are reported, and recoverable', async t => {
  const f = fakePi(t);
  process.env.PI_NVIM_BIN = '/nonexistent/nvim';
  t.after(() => { delete process.env.PI_NVIM_BIN; });
  await f.fire('session_start');
  await assert.rejects(f.call('nvim_keys', { keys: '' }), /Neovim is not running: .*ENOENT.*Use nvim_restart/);
  assert.match(f.notes.at(-1), /^warning: nvim-service: .*ENOENT/);
  assert.match(await f.command(), /^warning: Neovim service is not running: .*ENOENT/);
  await assert.rejects(f.call('nvim_restart'), /Neovim failed to start: .*ENOENT/);

  delete process.env.PI_NVIM_BIN;
  assert.match(await f.command('restart'), /^info: Neovim PID \d+\n/);
  const { info } = f.late();
  const stopped = once(f.bus, 'nvim-service:stopped');
  process.kill(info.pid, 'SIGKILL');
  await stopped;
  assert.ok(await gone(info));
  assert.match(f.notes.at(-1), /^warning: nvim-service: Neovim exited unexpectedly \(SIGKILL\)\. Run \/nvim-service restart\.$/);
  assert.throws(f.late, /unavailable/);
  assert.match(await f.call('nvim_restart'), /^Neovim restarted/);
  assert.equal(await f.call('nvim_lua', { code: 'return 2' }), '2');
});
