import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launch } from './service.mjs';
import { connect, openNvim, describeState } from './nvim.mjs';

async function fixture(t) {
  const service = launch({ cwd: '/tmp', init: 'NONE', graceMs: 100, killMs: 300 });
  const info = await service.ready;
  const nvim = await openNvim(info, { width: 60, height: 12 });
  t.after(async () => { nvim.close(); await service.stop(); });
  return { info, nvim, text: () => nvim.lua('return table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), "\\n")') };
}

test('typing keys edits like a person and reports where that left the editor', async t => {
  const { nvim, text } = await fixture(t);
  let state = await nvim.keys('ihello<CR>wörld<Esc>');
  assert.deepEqual(state, { mode: 'n', blocking: false, prompt: false, buffer: 1, file: '', line: 2, column: 6, modified: true, message: '' });
  assert.equal(await text(), 'hello\nwörld');
  assert.equal(describeState(state), 'mode n | buffer 1 [No Name] [+] | 2:6');
  state = await nvim.keys('ggdd:echo "one left"<CR>');
  assert.equal(state.message, 'one left');
  assert.equal(await text(), 'wörld');
  assert.equal((await nvim.keys('A')).mode, 'i');
  state = await nvim.keys('<Esc>:set nu');
  assert.equal(state.mode, 'c');
  assert.equal(state.message, ':set nu');
  assert.equal(await nvim.lua('return vim.fn.getcmdline()'), 'set nu');
  assert.equal((await nvim.keys('<Esc>')).mode, 'n');
  // Without a command-line row, the last screen row is the statusline, not a message.
  assert.equal((await nvim.keys(':set cmdheight=0 laststatus=2<CR>')).message, '');
  assert.match((await nvim.screen()).split('\n').at(-1), /^\[No Name\]/);
  await nvim.keys(':set cmdheight=1<CR>');
  assert.match(describeState(await nvim.keys(':file /tmp/named.txt<CR>')), /^mode n \| buffer 1 "(\/private)?\/tmp\/named.txt" \[\+\] \| 1:6/);
});

test('a blocking prompt is reported with its screen instead of hanging', async t => {
  const { nvim } = await fixture(t);
  const state = await nvim.keys(':echo "first\\nsecond"<CR>');
  assert.deepEqual(state, { mode: 'r', blocking: true, prompt: true, message: 'Press ENTER or type command to continue' });
  assert.match(describeState(state), /^mode r \(blocked at a prompt\) \| Press ENTER/);
  assert.match(await nvim.screen(), /first\nsecond\nPress ENTER/);
  for (const call of [() => nvim.lua('return 1'), () => nvim.request('nvim_list_bufs')]) {
    await assert.rejects(call, error => error.blocking && /waiting at a prompt \(mode r\)/.test(error.message) && /first\nsecond/.test(error.screen));
  }
  assert.equal((await nvim.keys('<CR>')).blocking, false);
  assert.equal(await nvim.lua('return 1'), 1);

  const confirm = await nvim.keys(':call confirm("Really?", "&Yes\\n&No")<CR>');
  assert.equal(confirm.prompt, true);
  assert.match(await nvim.screen(), /Really\?/);
  assert.equal((await nvim.keys('y')).prompt, false);
});

test('the screen shows what Lua alone would miss, and stays compact', async t => {
  const { nvim } = await fixture(t);
  await nvim.lua(`local b = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_lines(b, 0, -1, false, { 'FLOAT' })
    vim.api.nvim_open_win(b, false, { relative = 'editor', row = 2, col = 10, width = 8, height = 1, border = 'single' })
    vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'body' })`);
  const screen = await nvim.screen();
  assert.match(screen, /^body\n/);
  assert.match(screen, /│FLOAT   │/);
  assert.match(screen, /more identical rows/);
  assert.ok(screen.split('\n').length < 12);
  await nvim.resize(40, 8);
  assert.deepEqual(await nvim.lua('return { vim.o.columns, vim.o.lines }'), [40, 8]);
});

test('events, raw API calls and private channels need nothing else from the service', async t => {
  const { info, nvim } = await fixture(t);
  const lines = [];
  nvim.on('nvim_buf_lines_event', (_buffer, _tick, first, _last, data) => lines.push([first, data]));
  nvim.on('double', n => n * 2);
  assert.equal(await nvim.request('nvim_buf_attach', [0, false, {}]), true);
  await nvim.keys('ichanged<Esc>');
  assert.deepEqual(lines, [[0, ['changed']]]);
  assert.equal(await nvim.lua('return vim.rpcrequest(..., "double", 21)', [nvim.channel]), 42);

  const own = await nvim.connect();
  t.after(() => own.close());
  assert.notEqual(own.channel, nvim.channel);
  assert.deepEqual(await own.request('nvim_buf_get_lines', [0, 0, -1, false]), ['changed']);
  own.close();
  assert.equal(nvim.closed, false);

  await assert.rejects(connect({ ...info, pid: info.pid + 1 }), /does not belong/);
  await assert.rejects(nvim.lua('vim.wait(5000)', [], { signal: AbortSignal.timeout(100) }), { name: 'TimeoutError' });
});
