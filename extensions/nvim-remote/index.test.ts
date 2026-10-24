import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { launch } from '../nvim-service/service.mjs';
import { connect } from './remote.ts';
import { useRemote, type Remote } from './api.ts';
import register from './index.ts';

const service = launch({ cwd: '/tmp', init: 'NONE', graceMs: 100, killMs: 300 });
const { socket } = await service.ready;
after(() => service.stop());
const editor = await connect(socket);
after(() => editor.close());
const lua = (code: string, ...args: unknown[]): Promise<any> => editor.request('nvim_exec_lua', [code, args]);

// Whatever Neovim these tests run under (they may be started from one's terminal) stays out.
const clean = () => { delete process.env.NVIM; delete process.env.PI_NVIM_REMOTE; };
clean();
afterEach(clean);

async function eventually<T>(check: () => Promise<T> | T, ms = 3000): Promise<T> {
  for (const end = Date.now() + ms; ; await delay(20)) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) assert.fail(`not within ${ms} ms`);
  }
}

type Command = { handler(args: string, ctx: object): Promise<void> };

/** Pi as an extension sees it: event bus, hooks, commands, and a context with a UI that records. */
function fakePi() {
  const bus = new EventEmitter(), hooks = new EventEmitter();
  const commands: Record<string, Command> = {}, status: Record<string, string | undefined> = {};
  const notes: [string, string | undefined][] = [];
  const pi = {
    events: { on: (channel: string, handler: (data: unknown) => void) => bus.on(channel, handler), emit: (channel: string, data: unknown) => bus.emit(channel, data) },
    on: (event: string, handler: () => void) => hooks.on(event, handler),
    registerCommand: (name: string, command: Command) => { commands[name] = command; },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: '/work', hasUI: true,
    ui: { setStatus: (key: string, text?: string) => { status[key] = text; }, notify: (text: string, type?: string) => notes.push([text, type]) },
  };
  const fire = (event: string, data: object = {}) => Promise.all(hooks.listeners(event).map(handler => handler(data, ctx)));
  const ready = () => new Promise<Remote>(resolve => bus.once('nvim-remote:ready', value => resolve(value as Remote)));
  const stopped = () => new Promise<unknown>(resolve => bus.once('nvim-remote:stopped', resolve));
  return { pi, commands, status, notes, ctx, fire, ready, stopped };
}

/** Loads the extension, as Pi does at startup or on /reload, and starts a session. */
async function start(fake = fakePi()) {
  register(fake.pi);
  const ready = fake.ready();
  await fake.fire('session_start', { reason: 'startup' });
  return { ...fake, remote: await ready };
}

test('outside Neovim the extension does nothing', () => {
  const fake = fakePi();
  register(fake.pi);
  assert.deepEqual(fake.commands, {});
});

test('a Pi started by an attached Pi stays out of its editor; others do not', () => {
  process.env.NVIM = socket;
  process.env.PI_NVIM_REMOTE = `1:${socket}`; // Left by the parent Pi, process 1.
  const nested = fakePi();
  register(nested.pi);
  assert.deepEqual(nested.commands, {});

  process.env.PI_NVIM_REMOTE = `${process.pid}:${socket}`; // Its own, from before a /reload.
  const reloaded = fakePi();
  register(reloaded.pi);
  assert.ok(reloaded.commands['nvim-remote']);

  process.env.NVIM = '/tmp/another-editor.sock'; // In a Neovim the parent started.
  const inner = fakePi();
  register(inner.pi);
  assert.ok(inner.commands['nvim-remote']);
  assert.equal(process.env.PI_NVIM_REMOTE, `${process.pid}:/tmp/another-editor.sock`);
});

test('a session attaches, announces the handle, and shows the chip; shutdown undoes it all', async () => {
  process.env.NVIM = socket;
  const fake = fakePi();
  const seen: Remote[] = [];
  const nvim = useRemote(fake.pi, handle => seen.push(handle)); // An extension loaded before this one.
  const { remote, status, fire, stopped } = await start(fake);
  assert.equal(remote.apiVersion, 1);
  assert.equal(remote.info.socket, socket);
  assert.deepEqual(seen, [remote]);
  assert.equal(nvim(), remote);
  assert.equal(status['nvim-remote'], 'nvim');

  const later = useRemote(fake.pi); // An extension loaded after, asking.
  assert.equal(later(), remote);

  // Something an extension set up in the editor.
  await remote.lua(`vim.api.nvim_create_autocmd('User', { group = remote.group, pattern = 'PiSession', callback = function() end })`);
  const gone = stopped();
  await fire('session_shutdown', { reason: 'quit' });
  assert.deepEqual(await gone, remote.info);
  assert.equal(nvim(), undefined);
  assert.equal(status['nvim-remote'], undefined);
  assert.equal(remote.closed, true);
  assert.equal(await lua('return #vim.api.nvim_get_autocmds({ event = "User", pattern = "PiSession" })'), 0);
  assert.equal(await lua('return require("nvim_remote").contexts[...] == nil', remote.channel), true);
});

test('/new keeps the connection; /reload replaces it, and extensions set up again', async () => {
  process.env.NVIM = socket;
  const first = fakePi();
  const attachedFirst: Remote[] = [];
  useRemote(first.pi, handle => attachedFirst.push(handle));
  const { remote, fire } = await start(first);
  await fire('session_start', { reason: 'new' });
  assert.deepEqual(attachedFirst, [remote]); // Not attached again.
  assert.equal(remote.closed, false);

  // /reload: the old instance shuts down, then everything loads afresh.
  await fire('session_shutdown', { reason: 'reload' });
  const second = fakePi();
  const attachedSecond: Remote[] = [];
  useRemote(second.pi, handle => attachedSecond.push(handle));
  const { remote: fresh, fire: fireSecond, status } = await start(second);
  assert.notEqual(fresh, remote);
  assert.equal(remote.closed, true);
  assert.deepEqual(attachedSecond, [fresh]);
  assert.equal(status['nvim-remote'], 'nvim');
  await fireSecond('session_shutdown', { reason: 'quit' });
});

test('when the editor drops the connection, Pi lets go, says why, and can reconnect', async () => {
  process.env.NVIM = socket;
  const fake = fakePi();
  const nvim = useRemote(fake.pi);
  const { remote, status, notes, commands, ctx, fire, stopped } = await start(fake);
  const gone = stopped();
  await lua('vim.fn.chanclose(...)', remote.channel);
  assert.deepEqual(await gone, remote.info);
  assert.equal(nvim(), undefined);
  assert.equal(status['nvim-remote'], undefined);

  await commands['nvim-remote'].handler('', ctx);
  assert.deepEqual(notes.at(-1), ['Not attached to Neovim: Neovim closed the connection. Run /nvim-remote reconnect.', 'warning']);

  const back = fake.ready();
  await commands['nvim-remote'].handler('reconnect', ctx);
  const again = await back;
  assert.notEqual(again, remote);
  assert.equal(nvim(), again);
  assert.equal(status['nvim-remote'], 'nvim');
  assert.match(notes.at(-1)![0], new RegExp(`^Neovim PID \\d+\\nSocket: ${socket}\\nChannel: ${again.channel}\\nTerminal buffer: not found$`));
  await fire('session_shutdown', { reason: 'quit' });
});

test('reconnecting on purpose detaches the old connection cleanly first', async () => {
  process.env.NVIM = socket;
  const fake = fakePi();
  const { remote, commands, ctx, fire } = await start(fake);
  await remote.lua('remote.on_detach(function() vim.g.reconnect_cleaned = true end)');
  const back = fake.ready();
  await commands['nvim-remote'].handler('reconnect', ctx);
  await back;
  assert.equal(remote.closed, true);
  assert.equal(await lua('return vim.g.reconnect_cleaned'), true);
  await fire('session_shutdown', { reason: 'quit' });
});

test('an editor that cannot be reached is reported, not thrown', async () => {
  process.env.NVIM = '/tmp/nvim-remote-nothing-here.sock';
  const fake = fakePi();
  const nvim = useRemote(fake.pi);
  register(fake.pi);
  await fake.fire('session_start', { reason: 'startup' });
  await eventually(() => fake.notes.length);
  assert.match(fake.notes[0][0], /^nvim-remote: .*(ENOENT|ECONNREFUSED)/);
  assert.equal(fake.notes[0][1], 'warning');
  assert.equal(nvim(), undefined);
  assert.equal(fake.status['nvim-remote'], undefined);
  await fake.commands['nvim-remote'].handler('', fake.ctx);
  assert.match(fake.notes.at(-1)![0], /^Not attached to Neovim: .*(ENOENT|ECONNREFUSED)/);
  await fake.fire('session_shutdown', { reason: 'quit' });
});

test('cleanups that fail in the editor are reported at shutdown', async () => {
  process.env.NVIM = socket;
  const { remote, notes, fire } = await start();
  await remote.lua('remote.on_detach(function() error("could not undo") end)');
  await fire('session_shutdown', { reason: 'quit' });
  assert.match(notes.at(-1)![0], /^nvim-remote: cleanup failed in Neovim:\n.*could not undo/);
});
