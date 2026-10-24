import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { once } from 'node:events';
import { launch } from './service.mjs';
import { connectRpc } from './rpc.mjs';

const service = launch({ cwd: '/tmp', init: 'NONE', graceMs: 100, killMs: 300 });
const { socket } = await service.ready;
after(() => service.stop());

async function open(t) {
  const rpc = await connectRpc(socket);
  t.after(() => rpc.close());
  const { id } = await rpc.request('nvim_get_chan_info', [0]);
  return { rpc, lua: (code, ...args) => rpc.request('nvim_exec_lua', [code, args]), channel: id };
}

test('requests return results, errors and plain integer handles', async t => {
  const { rpc, lua } = await open(t);
  assert.equal(await lua('return ... + 1', 41), 42);
  assert.deepEqual(await lua('return { a = { 1, 2 }, b = vim.NIL }'), { a: [1, 2], b: null });
  await assert.rejects(lua('error("boom")'), /boom/);
  await assert.rejects(rpc.request('nvim_no_such_method'), /nvim_no_such_method/);
  const buffer = await rpc.request('nvim_get_current_buf');
  assert.equal(typeof buffer, 'number');
  assert.equal(await rpc.request('nvim_buf_line_count', [buffer]), 1);
  assert.deepEqual(await rpc.request('nvim_list_wins'), [await rpc.request('nvim_get_current_win')]);
});

test('Neovim can notify and call back; subscriptions can be removed', async t => {
  const { rpc, lua, channel } = await open(t);
  const seen = [];
  const off = rpc.on('ping', (...args) => seen.push(args));
  rpc.on('ping', () => { throw new Error('a broken subscriber is isolated'); });
  rpc.on('add', async (a, b) => a + b);
  rpc.on('fail', () => { throw new Error('refused'); });
  assert.equal(await lua('vim.rpcnotify(..., "ping", 1, "two"); return vim.rpcrequest(..., "add", 2, 3)', channel), 5);
  assert.deepEqual(seen, [[1, 'two']]);
  await assert.rejects(lua('return vim.rpcrequest(..., "fail")', channel), /refused/);
  await assert.rejects(lua('return vim.rpcrequest(..., "unhandled")', channel), /No handler for unhandled/);
  off();
  await lua('vim.rpcnotify(..., "ping")', channel);
  assert.equal(seen.length, 1);
  assert.equal(rpc.closed, false);
});

test('abort and close reject pending requests without waiting for Neovim', async t => {
  const { rpc, lua } = await open(t);
  const controller = new AbortController();
  const aborted = rpc.request('nvim_exec_lua', ['vim.wait(5000)', []], controller.signal);
  controller.abort(new Error('caller gave up'));
  await assert.rejects(aborted, /caller gave up/);
  await assert.rejects(rpc.request('nvim_get_mode', [], AbortSignal.abort(new Error('already'))), /already/);

  const other = await open(t);
  const pending = other.lua('vim.wait(5000)');
  other.rpc.close();
  await assert.rejects(pending, /connection closed/);
  await assert.rejects(other.lua('return 1'), /connection closed/);
  assert.equal(other.rpc.closed, true);
  assert.equal(await lua('return 1'), 1); // Other channels are unaffected.
});

test('connecting fails clearly when nothing listens, or when aborted', async () => {
  await assert.rejects(connectRpc('/tmp/pi-nvim-none/nvim.sock'), /ENOENT/);
  await assert.rejects(connectRpc(socket, AbortSignal.abort(new Error('never mind'))), /never mind/);
});

test('close is reported once, whichever end closes', async t => {
  const { rpc, lua, channel } = await open(t);
  const seen = [];
  rpc.onClose(error => seen.push(error.message));
  const off = rpc.onClose(() => seen.push('unsubscribed'));
  off();
  await lua('local chan = ...; vim.defer_fn(function() vim.fn.chanclose(chan) end, 0)', channel);
  for (let i = 0; i < 100 && !seen.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  rpc.close();
  assert.deepEqual(seen, ['Neovim RPC connection closed']);
  rpc.onClose(error => seen.push(`late: ${error.message}`));
  assert.deepEqual(seen, ['Neovim RPC connection closed', 'late: Neovim RPC connection closed']);
});

test('a request aborted while it waits rejects with the reason, however falsy', async t => {
  const { rpc } = await open(t);
  for (const reason of [null, 0, false, '', NaN, undefined]) {
    const controller = new AbortController();
    const pending = rpc.request('nvim_exec_lua', ['vim.wait(200)', []], controller.signal);
    await new Promise(resolve => setTimeout(resolve, 20)); // Started, not answered.
    controller.abort(reason);
    await assert.rejects(pending, error => Object.is(error, reason === undefined ? controller.signal.reason : reason), String(reason));
  }
  assert.equal(await rpc.request('nvim_eval', ['1 + 1']), 2); // Still usable after.
});

test('a request that succeeds with nil resolves, and one that fails always rejects', async t => {
  const { rpc, lua } = await open(t);
  assert.equal(await lua('return nil'), null);
  await assert.rejects(lua('error("")'), /Lua/); // An empty message is still a failure.
});
