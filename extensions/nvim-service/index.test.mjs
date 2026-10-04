import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const dataURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const mockURL = dataURL(`
export const launches = [];
export function launchNvimService(options) {
  const ready = Promise.withResolvers();
  const exited = Promise.withResolvers();
  ready.promise.catch(() => {});
  const service = {
    options, ready: ready.promise, exited: exited.promise, stopCalls: 0,
    becomeReady: ready.resolve,
    fail(error) { ready.reject(error); exited.resolve({ expected: false, error }); },
    stop() {
      this.stopCalls++;
      ready.reject(new Error('stopped before ready'));
      exited.resolve({ expected: true });
      return exited.promise;
    },
  };
  launches.push(service);
  return service;
}
`);
const { launches } = await import(mockURL);
const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
const { default: register } = await import(dataURL(stripTypeScriptTypes(source).replace("'./service.mjs'", JSON.stringify(mockURL))));
const info = { socket: '/tmp/pi-nvim-test/nvim.sock', pid: 123, supervisorPid: 122, cwd: '/project' };

function setup(t) {
  const previousSocket = process.env.PI_NVIM_SOCKET;
  const previousNVIM = process.env.NVIM;
  const initialLaunches = launches.length;
  const handlers = new Map();
  const commands = new Map();
  const events = new EventEmitter();
  const notifications = [];
  const ctx = { cwd: '/project', hasUI: true, ui: { notify: (message, level) => notifications.push({ message, level }) } };
  register({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    events,
  });
  assert.equal(launches.length, initialLaunches, 'factory must not start any resources');
  const emit = name => handlers.get(name)?.({ type: name }, ctx);
  t.after(async () => {
    await emit('session_shutdown');
    if (previousSocket === undefined) delete process.env.PI_NVIM_SOCKET;
    else process.env.PI_NVIM_SOCKET = previousSocket;
    if (previousNVIM === undefined) delete process.env.NVIM;
    else process.env.NVIM = previousNVIM;
  });
  return {
    events, notifications, emit, ctx,
    command: () => commands.get('nvim-service').handler('', ctx),
    current() {
      let result;
      events.emit('nvim-service:get', { reply: value => { result = value; } });
      return result;
    },
  };
}

test('publishes only after ready, preserves NVIM, and reuses the service on session changes', async t => {
  const h = setup(t);
  process.env.NVIM = '/editor/socket';
  process.env.PI_NVIM_SOCKET = '/outer/pi/socket';
  const readyEvents = [];
  const stoppedEvents = [];
  h.events.on('nvim-service:ready', value => readyEvents.push(value));
  h.events.on('nvim-service:stopped', value => stoppedEvents.push(value));
  assert.equal(h.current(), undefined);
  const startup = h.emit('session_start');
  const service = launches.at(-1);
  assert.deepEqual(service.options, { cwd: '/project' });
  assert.equal(process.env.PI_NVIM_SOCKET, undefined);
  assert.equal(h.current(), undefined);
  service.becomeReady(info);
  await startup;
  assert.deepEqual(h.current(), info);
  assert.deepEqual(readyEvents, [info]);
  assert.equal(process.env.PI_NVIM_SOCKET, info.socket);
  assert.equal(process.env.NVIM, '/editor/socket');
  const count = launches.length;
  await h.emit('session_start');
  assert.equal(launches.length, count);
  await h.command();
  assert.match(h.notifications.at(-1).message, /Neovim PID 123/);
  await h.emit('session_shutdown');
  await h.emit('session_shutdown');
  assert.equal(service.stopCalls, 1);
  assert.equal(process.env.PI_NVIM_SOCKET, undefined);
  assert.equal(process.env.NVIM, '/editor/socket');
  assert.equal(h.current(), undefined);
  assert.deepEqual(stoppedEvents, [info]);
});

test('reload shutdown followed by startup creates and publishes a fresh instance', async t => {
  const h = setup(t);
  const first = h.emit('session_start');
  const old = launches.at(-1);
  old.becomeReady(info);
  await first;
  await h.emit('session_shutdown');
  assert.equal(old.stopCalls, 1);
  const second = h.emit('session_start');
  const fresh = launches.at(-1);
  assert.notEqual(fresh, old);
  const nextInfo = { ...info, pid: 124, socket: '/tmp/pi-nvim-next/nvim.sock' };
  fresh.becomeReady(nextInfo);
  await second;
  assert.deepEqual(h.current(), nextInfo);
  assert.equal(process.env.PI_NVIM_SOCKET, nextInfo.socket);
});

test('startup failure is visible, cleans up, and can be retried', async t => {
  const h = setup(t);
  const startup = h.emit('session_start');
  const failed = launches.at(-1);
  failed.fail(new Error('spawn nvim ENOENT'));
  await startup;
  assert.equal(failed.stopCalls, 1);
  assert.equal(h.current(), undefined);
  assert.equal(process.env.PI_NVIM_SOCKET, undefined);
  assert.match(h.notifications.at(-1).message, /ENOENT/);
  await h.command();
  assert.match(h.notifications.at(-1).message, /not running.*ENOENT/);
  const retry = h.emit('session_start');
  launches.at(-1).becomeReady(info);
  await retry;
  assert.deepEqual(h.current(), info);
});

test('unexpected exit clears discovery and emits stopped once', async t => {
  const h = setup(t);
  let stopped = 0;
  h.events.on('nvim-service:stopped', () => { stopped++; });
  const startup = h.emit('session_start');
  const service = launches.at(-1);
  service.becomeReady(info);
  await startup;
  service.fail(new Error('Neovim exited unexpectedly (SIGKILL)'));
  await service.exited;
  assert.equal(h.current(), undefined);
  assert.equal(process.env.PI_NVIM_SOCKET, undefined);
  assert.equal(stopped, 1);
  assert.match(h.notifications.at(-1).message, /SIGKILL/);
  await h.emit('session_shutdown');
  assert.equal(stopped, 1);
});

test('shutdown racing startup does not publish a stale instance or warn about cancellation', async t => {
  const h = setup(t);
  const startup = h.emit('session_start');
  const service = launches.at(-1);
  await h.emit('session_shutdown');
  service.becomeReady(info);
  await startup;
  assert.equal(h.current(), undefined);
  assert.equal(process.env.PI_NVIM_SOCKET, undefined);
  assert.deepEqual(h.notifications, []);
});

test('unpublishing only removes our own socket value', async t => {
  const h = setup(t);
  const startup = h.emit('session_start');
  launches.at(-1).becomeReady(info);
  await startup;
  process.env.PI_NVIM_SOCKET = '/replacement/socket';
  await h.emit('session_shutdown');
  assert.equal(process.env.PI_NVIM_SOCKET, '/replacement/socket');
});
