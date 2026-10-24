import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { launch } from '../nvim-service/service.mjs';
import { assertCurrent, attach, connect, type AutocmdEvent, type Remote } from './remote.ts';

// Stands in for the user's editor; `editor` is the user, acting on it directly.
const service = launch({ cwd: '/tmp', init: 'NONE', graceMs: 100, killMs: 300 });
const { socket, pid: editorPid } = await service.ready;
after(() => service.stop());
const editor = await connect(socket);
after(() => editor.close());
const lua = (code: string, ...args: unknown[]): Promise<any> => editor.request('nvim_exec_lua', [code, args]);

async function attached(t: TestContext, options?: Parameters<typeof attach>[1]): Promise<Remote> {
  const remote = await attach(socket, options);
  t.after(() => remote.close());
  return remote;
}

/** Resolves to what `check` returns once that is truthy. */
async function eventually<T>(check: () => Promise<T> | T, ms = 3000): Promise<T> {
  for (const end = Date.now() + ms; ; await delay(20)) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) assert.fail(`not within ${ms} ms`);
  }
}

const contextOf = (channel: number) => lua('local c = require("nvim_remote").contexts[...]; return c and { group = c.group, ns = c.ns } or vim.NIL', channel);

// Attaching

test('attaching reports the editor and registers a context for this Pi', async t => {
  const remote = await attached(t, { cwd: '/work' });
  assert.equal(remote.info.pid, editorPid);
  assert.equal(remote.info.socket, socket);
  assert.equal(remote.info.channel, remote.channel);
  assert.equal(remote.info.terminal, undefined); // Not running in one of the editor's terminals.
  assert.equal(remote.closed, false);
  assert.deepEqual(await lua('local c = require("nvim_remote").contexts[...]; return { c.pid, c.cwd }', remote.channel), [process.pid, '/work']);
});

test('the user hears about Pis attaching and detaching', async () => {
  await lua(`_G.announced = {}
    vim.api.nvim_create_autocmd('User', { pattern = 'NvimRemote*', callback = function(ev)
      table.insert(_G.announced, { ev.match, ev.data.channel, ev.data.cwd })
    end })`);
  const remote = await attach(socket, { cwd: '/work' });
  await remote.close();
  assert.deepEqual(await lua('return _G.announced'), [
    ['NvimRemoteAttach', remote.channel, '/work'], ['NvimRemoteDetach', remote.channel, '/work'],
  ]);
  await lua('vim.api.nvim_clear_autocmds({ event = "User", pattern = "NvimRemote*" })');
});

test("Pi's terminal is found through its ancestors", async t => {
  const [buf, shell] = await lua(`vim.cmd.enew()
    local job = vim.fn.jobstart({ 'sh', '-c', 'sleep 30 & wait' }, { term = true })
    vim.wait(1000, function() return #vim.api.nvim_get_proc_children(vim.fn.jobpid(job)) > 0 end)
    return { vim.api.nvim_get_current_buf(), vim.fn.jobpid(job) }`);
  t.after(() => lua('vim.api.nvim_buf_delete(..., { force = true })', buf));
  const [child] = await lua('return vim.api.nvim_get_proc_children(...)', shell);
  const inside = await attached(t, { pid: child });
  assert.equal(inside.info.terminal, buf);
  assert.equal(await inside.lua('return remote.terminal'), buf);
});

test('several Pis share an editor, and a new one leaves the others attached', async t => {
  const first = await attached(t), second = await attached(t);
  assert.notEqual(first.channel, second.channel);
  assert.equal(await first.lua('return remote.channel'), first.channel);
  assert.equal(await second.lua('return remote.channel'), second.channel);
  const [a, b] = [await contextOf(first.channel), await contextOf(second.channel)];
  assert.notEqual(a.group, b.group);
  assert.notEqual(a.ns, b.ns);
});

test('attaching to a socket nothing listens on fails', async () => {
  await assert.rejects(attach('/tmp/nvim-remote-nothing-here.sock'), /ENOENT|ECONNREFUSED/);
});

test('an RPC client from before Pi was restarted is named as the problem', () => {
  // As after /reload once nvim-service's rpc.mjs gained onClose: Node still has the old one.
  const stale = { request: () => Promise.resolve(), notify: () => {}, on: () => () => {}, close: () => {} };
  assert.throws(() => assertCurrent(stale), /nvim-service changed since Pi started.*restart Pi/);
  assert.doesNotThrow(() => assertCurrent({ ...stale, onClose: () => () => {} }));
});

// Running Lua

test('lua returns values and receives arguments', async t => {
  const remote = await attached(t);
  assert.equal(await remote.lua('return 1 + 1'), 2);
  assert.equal(await remote.lua('return "text"'), 'text');
  assert.equal(await remote.lua('return true'), true);
  assert.equal(await remote.lua('return nil'), null);
  assert.equal(await remote.lua('local x = 1'), null); // No return at all.
  assert.deepEqual(await remote.lua('return { 1, 2, { a = "b" } }'), [1, 2, { a: 'b' }]);
  assert.deepEqual(await remote.lua('return { ... }', ['a', 2, { k: [true] }]), ['a', 2, { k: [true] }]);
  assert.deepEqual(await remote.lua('local a, b, c = ...; return { a, b == vim.NIL, c }', [1, null, 3]), [1, true, 3]);
  assert.equal(await remote.lua('return select("#", ...)', [1, 2, 3]), 3);
  assert.equal(await remote.lua('-- a comment on the first line\nreturn 7'), 7);
});

test('lua errors keep their message and the line it came from', async t => {
  const remote = await attached(t);
  await assert.rejects(remote.lua('local x = 1\nlocal y = 2\nerror("boom")'), /nvim-remote:3: boom/);
  await assert.rejects(remote.lua('error("plain", 0)'), /plain/);
  await assert.rejects(remote.lua('return +'), /nvim-remote:1:/); // A syntax error.
  await assert.rejects(remote.lua('return vim.api.nvim_buf_get_lines(99999, 0, -1, true)'), /Invalid buffer id/);
  await assert.rejects(remote.lua('return function() end'), /Cannot convert given Lua type/); // Cannot be sent back.
  assert.equal(await remote.lua('return 1'), 1); // Errors leave the connection usable.
});

test('lua can do anything the user can: buffers, windows, options, commands, plugins', async t => {
  const remote = await attached(t);
  const buf = await remote.lua(`local buf = vim.api.nvim_create_buf(true, false)
    vim.api.nvim_buf_set_lines(buf, 0, -1, true, { 'one', 'two' })
    vim.bo[buf].filetype = 'markdown'
    return buf`);
  t.after(() => lua('vim.api.nvim_buf_delete(..., { force = true })', buf));
  assert.deepEqual(await lua('return { vim.api.nvim_buf_get_lines(..., 0, -1, true), vim.bo[...].filetype }', buf), [['one', 'two'], 'markdown']);
  await remote.lua('vim.cmd("let g:from_pi = 42")');
  assert.equal(await lua('return vim.g.from_pi'), 42);
  await remote.lua('package.loaded.some_plugin = { hello = function(name) return "hi " .. name end }');
  assert.equal(await remote.lua('return require("some_plugin").hello(...)', ['pi']), 'hi pi');
});

// Requests and notifications

test('request reaches any API method', async t => {
  const remote = await attached(t);
  const buf = await remote.request('nvim_create_buf', [false, true]);
  assert.equal(typeof buf, 'number'); // A plain handle, usable in later calls.
  await remote.request('nvim_buf_set_lines', [buf, 0, -1, true, ['x']]);
  assert.deepEqual(await remote.request('nvim_buf_get_lines', [buf, 0, -1, true]), ['x']);
  assert.equal(await remote.request('nvim_eval', ['1 + 2']), 3);
  await assert.rejects(remote.request('nvim_no_such_method'), /nvim_no_such_method/);
  await remote.request('nvim_buf_delete', [buf, { force: true }]);
});

test('notify does not wait, and is applied before what follows it', async t => {
  const remote = await attached(t);
  remote.notify('nvim_set_var', ['notified', 'yes']);
  assert.equal(await remote.request('nvim_get_var', ['notified']), 'yes');
});

// Prompts

test('at a prompt calls fail at once, and input answers it', async t => {
  const remote = await attached(t);
  await editor.request('nvim_ui_attach', [80, 24, { ext_linegrid: true }]); // Prompts need a screen.
  await editor.request('nvim_input', [':echo "first\\nsecond"<CR>']);
  try {
    await eventually(async () => (await editor.request('nvim_get_mode', [])).blocking);
    await assert.rejects(remote.lua('return 1'), (error: { blocking?: boolean; mode?: string }) => error.blocking === true && error.mode === 'r');
    await assert.rejects(remote.request('nvim_get_current_buf'), /waiting at a prompt/);
    assert.equal((await remote.request('nvim_get_mode')).blocking, true); // Looking is fine.
    await remote.request('nvim_input', ['<CR>']); // So is answering.
    assert.equal(await eventually(() => remote.lua('return 1')), 1);
  } finally {
    await editor.request('nvim_input', ['<Esc>']);
    await editor.request('nvim_ui_detach');
  }
});

// Timeouts and aborting

test('a call gives up after its timeout, and the editor stays usable', async t => {
  const remote = await attached(t);
  const start = Date.now();
  await assert.rejects(remote.lua('vim.wait(1000)', [], { timeout: 150 }), /did not answer within 150 ms/);
  assert.ok(Date.now() - start < 900);
  assert.equal(await remote.lua('return 1', [], { timeout: 5000 }), 1); // Queued behind the wait, then answered.
  assert.equal(await remote.lua('vim.wait(200) return 2', [], { timeout: Infinity }), 2);
});

test('a call can be aborted, with the reason it was', async t => {
  const remote = await attached(t);
  const controller = new AbortController();
  const call = remote.lua('vim.wait(500)', [], { signal: controller.signal });
  controller.abort(new Error('user gave up'));
  await assert.rejects(call, /user gave up/);
  await assert.rejects(remote.lua('return 1', [], { signal: AbortSignal.abort(new Error('already')) }), /already/);
});

// Hearing from the editor

test('Lua can notify Pi, and a subscription can be removed', async t => {
  const remote = await attached(t);
  const seen: unknown[][] = [];
  const off = remote.on('changed', (...args) => seen.push(args));
  await remote.lua('remote.notify("changed", 1, "two", { three = 3 })');
  await remote.lua('return 1');
  assert.deepEqual(seen, [[1, 'two', { three: 3 }]]);
  off();
  await remote.lua('remote.notify("changed")');
  await remote.lua('return 1');
  assert.equal(seen.length, 1);
});

test('autocommands run handlers in Pi, until unsubscribed', async t => {
  const remote = await attached(t);
  const events: unknown[] = [];
  const off = await remote.autocmd('User', event => events.push(event), { pattern: 'PiTest' });
  await lua('vim.api.nvim_exec_autocmds("User", { pattern = "PiTest", data = { n = 1 } })');
  await eventually(() => events.length === 1);
  const [event] = events as AutocmdEvent[];
  assert.deepEqual({ ...event, buf: typeof event.buf, id: typeof event.id },
    { event: 'User', buf: 'number', file: 'PiTest', match: 'PiTest', id: 'number', data: { n: 1 } });
  await off();
  await lua('vim.api.nvim_exec_autocmds("User", { pattern = "PiTest" })');
  await remote.lua('return 1');
  assert.equal(events.length, 1);
  assert.deepEqual(await lua('return vim.api.nvim_get_autocmds({ event = "User", pattern = "PiTest" })'), []);
});

test('a handler that throws or rejects is reported, and nothing else is disturbed', async t => {
  const reported: [string, string][] = [];
  const remote = await attached(t, { onError: (error, source) => reported.push([source, (error as Error).message]) });
  const heard: string[] = [];
  remote.on('ping', () => { throw new Error('sync failure'); });
  remote.on('ping', async () => { throw new Error('async failure'); });
  remote.on('ping', () => heard.push('ping'));
  await remote.autocmd('User', async () => { await delay(5); throw new Error('autocmd failure'); }, { pattern: 'PiBroken' });
  await remote.lua('remote.notify("ping")');
  await lua('vim.api.nvim_exec_autocmds("User", { pattern = "PiBroken" })');
  await eventually(() => reported.length === 3);
  assert.deepEqual(reported.sort(), [
    ['autocmd("User")', 'autocmd failure'], ['on("ping")', 'async failure'], ['on("ping")', 'sync failure'],
  ]);
  assert.deepEqual(heard, ['ping']); // The others still ran.
  assert.equal(await remote.lua('return 1'), 1);
});

test('autocommand options pass through: buffer, once', async t => {
  const remote = await attached(t);
  const buf = await lua('return vim.api.nvim_create_buf(true, true)');
  t.after(() => lua('vim.api.nvim_buf_delete(..., { force = true })', buf));
  const entered: number[] = [];
  await remote.autocmd(['BufEnter'], event => entered.push(event.buf), { buffer: buf });
  let once = 0;
  await remote.autocmd('User', () => { once++; }, { pattern: 'PiOnce', once: true });
  await lua('vim.api.nvim_set_current_buf(...); vim.cmd.enew()', buf);
  for (let i = 0; i < 2; i++) await lua('vim.api.nvim_exec_autocmds("User", { pattern = "PiOnce" })');
  await remote.lua('return 1');
  assert.deepEqual(entered, [buf]);
  assert.equal(once, 1);
});

test('event data that cannot be sent is left out, not the event', async t => {
  const remote = await attached(t);
  const events: { data?: unknown }[] = [];
  await remote.autocmd('User', event => events.push(event), { pattern: 'PiOdd' });
  await lua('vim.api.nvim_exec_autocmds("User", { pattern = "PiOdd", data = { f = function() end } })');
  await eventually(() => events.length === 1);
  assert.equal(events[0].data, undefined);
});

test('an autocommand Neovim refuses is reported, and leaves nothing behind', async t => {
  const remote = await attached(t);
  await assert.rejects(remote.autocmd('NoSuchEvent', () => {}), /NoSuchEvent/);
});

// Cleaning up

const residue = (channel: number, group: number, ns: number) => lua(`local chan, group, ns = ...
  local marks = 0
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do marks = marks + #vim.api.nvim_buf_get_extmarks(buf, ns, 0, -1, {}) end
  return { context = require('nvim_remote').contexts[chan] ~= nil, group = pcall(vim.api.nvim_get_autocmds, { group = group }), marks = marks }`,
  channel, group, ns);

/** Sets up in the editor what a Pi might: an autocommand, highlights, a command, through `remote`. */
const SETUP = `_G.cleaned = {}
  vim.api.nvim_create_autocmd('User', { group = remote.group, pattern = 'PiSetUp', callback = function() end })
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, true, { 'a', 'b' })
  vim.api.nvim_buf_set_extmark(buf, remote.ns, 0, 0, { end_row = 1, hl_group = 'Search' })
  vim.api.nvim_create_user_command('PiCommand', function() end, {})
  remote.on_detach(function() table.insert(_G.cleaned, 'first') end)
  remote.on_detach(function() error('a broken cleanup') end)
  remote.on_detach(function() vim.api.nvim_del_user_command('PiCommand'); table.insert(_G.cleaned, 'last') end)
  return { group = remote.group, ns = remote.ns }`;

test('closing undoes what this Pi set up, cleanups last to first, past one that fails', async () => {
  const remote = await attach(socket);
  const { group, ns } = await remote.lua(SETUP);
  assert.deepEqual(await residue(remote.channel, group, ns), { context: true, group: true, marks: 1 });
  const errors = await remote.close();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /a broken cleanup/);
  assert.deepEqual(await lua('return _G.cleaned'), ['last', 'first']);
  assert.deepEqual(await residue(remote.channel, group, ns), { context: false, group: false, marks: 0 });
  assert.equal(await lua('return vim.fn.exists(":PiCommand")'), 0);
  assert.equal(remote.closed, true);
  await assert.rejects(remote.lua('return 1'), /closed/);
});

test('a Pi whose channel dies is cleaned up by the editor itself', async () => {
  const remote = await attach(socket);
  const { group, ns } = await remote.lua(SETUP);
  const closed = new Promise<Error>(resolve => remote.onClose(resolve));
  await lua('vim.fn.chanclose(...)', remote.channel); // The editor ends it: no detach from Pi.
  assert.match((await closed).message, /closed/);
  assert.equal(remote.closed, true);
  await eventually(async () => !(await residue(remote.channel, group, ns)).context);
  assert.deepEqual(await residue(remote.channel, group, ns), { context: false, group: false, marks: 0 });
  assert.deepEqual(await lua('return _G.cleaned'), ['last', 'first']);
});

test('a Pi that is killed is cleaned up by the editor itself', async () => {
  // A real process, attached and then killed without a chance to detach.
  const script = `import { attach } from ${JSON.stringify(new URL('./remote.ts', import.meta.url).href)};
    const remote = await attach(${JSON.stringify(socket)});
    await remote.lua(\`vim.api.nvim_create_autocmd('User', { group = remote.group, pattern = 'PiKilled', callback = function() end })
      remote.on_detach(function() vim.g.killed_cleaned = true end)\`);
    console.log(remote.channel);
    setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const channel = Number(await new Promise<string>(resolve => child.stdout.once('data', data => resolve(String(data)))));
  assert.equal(await lua('return #vim.api.nvim_get_autocmds({ event = "User", pattern = "PiKilled" })'), 1);
  child.kill('SIGKILL');
  await eventually(() => lua('return vim.g.killed_cleaned'));
  assert.equal(await lua('return #vim.api.nvim_get_autocmds({ event = "User", pattern = "PiKilled" })'), 0);
  assert.equal(await lua('return require("nvim_remote").contexts[...] == nil', channel), true);
});

test('one Pi detaching leaves another Pi\'s setup alone', async t => {
  const leaving = await attach(socket), staying = await attached(t);
  await leaving.lua(SETUP);
  const kept = await staying.lua(`vim.api.nvim_create_autocmd('User', { group = remote.group, pattern = 'PiStays', callback = function() end })
    return { group = remote.group, ns = remote.ns }`);
  await leaving.close();
  assert.equal(await lua('return #vim.api.nvim_get_autocmds({ group = ... })', kept.group), 1);
  assert.equal(await staying.lua('return remote.channel'), staying.channel);
});

test('after the editor goes away every call fails instead of hanging', async () => {
  const remote = await attach(socket);
  await lua('vim.fn.chanclose(...)', remote.channel);
  await eventually(() => remote.closed);
  await assert.rejects(remote.lua('return 1'), /closed/);
  await assert.rejects(remote.request('nvim_get_mode'), /closed/);
  await assert.rejects(remote.autocmd('User', () => {}), /closed/);
  assert.deepEqual(await remote.close(), []);
});

// A channel of one's own

test('connect opens a separate raw channel', async t => {
  const remote = await attached(t);
  const raw = await remote.connect();
  assert.notEqual(raw.channel, remote.channel);
  assert.equal(await raw.request('nvim_eval', ['1 + 1']), 2);
  raw.close();
  assert.equal(await remote.lua('return 1'), 1);
});

// For real: Pi as a process in one of the editor's terminals, finding it through $NVIM

test('a process in an editor terminal attaches through $NVIM and is matched to its terminal', async t => {
  const script = `import { attach } from ${JSON.stringify(new URL('./remote.ts', import.meta.url).href)};
    const remote = await attach(process.env.NVIM);
    await remote.lua('vim.g.terminal_pi = { remote.terminal, remote.channel }');
    setInterval(() => {}, 1000);`;
  const buf = await lua(`vim.cmd.enew()
    vim.fn.jobstart({ ..., '--input-type=module', '-e', select(2, ...) }, { term = true })
    return vim.api.nvim_get_current_buf()`, process.execPath, script);
  t.after(() => lua('pcall(vim.api.nvim_buf_delete, ..., { force = true })', buf));
  const [terminal, channel] = await eventually(() => lua('return vim.g.terminal_pi or false'));
  assert.equal(terminal, buf);
  // Deleting the terminal ends the process; the editor then lets go of it.
  await lua('vim.api.nvim_buf_delete(..., { force = true })', buf);
  await eventually(() => lua('return require("nvim_remote").contexts[...] == nil', channel));
});
