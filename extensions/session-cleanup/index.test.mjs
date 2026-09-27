import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

// Exercise the actual TS entry point without loading the user's Pi extensions.
const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
const javascript = stripTypeScriptTypes(source).replace('"./core.mjs"', JSON.stringify(new URL('./core.mjs', import.meta.url).href));
const { registerSessionCleanup } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

function setup(t, fail = false) {
  // Scheduling any idle scan or retry is a regression, including the error path.
  t.mock.method(globalThis, 'setTimeout', () => { throw Error('Cleanup must not schedule timers'); });
  t.mock.method(globalThis, 'setInterval', () => { throw Error('Cleanup must not poll'); });
  const hooks = new Map(), commands = new Map(), calls = [], notices = [];
  const cleaner = {
    configPath: '/config/session-cleanup.json',
    lease: async p => { calls.push(['lease', p]); },
    close: async () => { calls.push(['close']); },
    config: async () => ({ retentionDays: 30 }),
    run: async options => {
      calls.push(['run', options]);
      if (fail) throw Error('test failure');
      return { errors: [], expired: [], cleaned: [] };
    },
  };
  registerSessionCleanup({ on: (name, handler) => hooks.set(name, handler), registerCommand: (name, command) => commands.set(name, command) }, cleaner);
  const ctx = { hasUI: true, ui: { notify: (...args) => notices.push(args) }, sessionManager: { getSessionFile: () => '/sessions/current.jsonl' } };
  return { hooks, commands, calls, notices, ctx };
}

test('cleanup runs once per session start, never schedules work, and shutdown only releases its lease', async t => {
  const { hooks, calls, ctx } = setup(t);
  assert.deepEqual(calls, []);
  assert.deepEqual([...hooks.keys()], ['session_start', 'session_shutdown']);
  await hooks.get('session_start')({}, ctx);
  assert.deepEqual(calls, [['lease', '/sessions/current.jsonl'], ['run', { dryRun: false }]]);
  await hooks.get('session_shutdown')({}, ctx);
  assert.deepEqual(calls.at(-1), ['close']);
  assert.equal(calls.filter(c => c[0] === 'run').length, 1);
});

test('failed startup scans do not schedule retries', async t => {
  const { hooks, calls, notices, ctx } = setup(t, true);
  await hooks.get('session_start')({}, ctx);
  assert.equal(calls.filter(c => c[0] === 'run').length, 1);
  assert.match(notices[0][0], /test failure/);
  await hooks.get('session_shutdown')({}, ctx);
});

test('only explicit preview/run commands scan; config does not', async t => {
  const { commands, calls, ctx } = setup(t);
  const command = commands.get('session-cleanup');
  await command.handler('config', ctx);
  assert.deepEqual(calls, []);
  await command.handler('preview', ctx);
  await command.handler('run', ctx);
  assert.deepEqual(calls, [['run', { dryRun: true }], ['run', { dryRun: false }]]);
});
