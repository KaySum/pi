import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { launch } from '../nvim-service/service.mjs';
import { connect } from '../nvim-remote/remote.ts';
import registerRemote from '../nvim-remote/index.ts';
import registerFollow from './index.ts';

const service = launch({ cwd: '/tmp', init: 'NONE', graceMs: 100, killMs: 300 });
const { socket } = await service.ready;
after(() => service.stop());
const editor = await connect(socket);
after(() => editor.close());
const lua = (code: string, ...args: unknown[]): Promise<any> => editor.request('nvim_exec_lua', [code, args]);
const dir = await realpath(await mkdtemp(join(tmpdir(), 'nvim-follow-')));
after(() => rm(dir, { recursive: true, force: true }));

// These tests stand in for the Neovim they may be run from; following starts off each time.
const clean = () => {
  process.env.NVIM = socket;
  delete process.env.PI_NVIM_REMOTE;
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('pi.nvim-follow')];
};
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

/** Pi with nvim-remote and nvim-follow loaded, as at startup or after /reload, its session started. */
async function pi() {
  const bus = new EventEmitter(), hooks = new EventEmitter();
  const commands: Record<string, Command> = {}, status: Record<string, string | undefined> = {};
  const notes: [string, string | undefined][] = [];
  const api = {
    events: { on: (channel: string, handler: (data: unknown) => void) => bus.on(channel, handler), emit: (channel: string, data: unknown) => bus.emit(channel, data) },
    on: (event: string, handler: () => void) => hooks.on(event, handler),
    registerCommand: (name: string, command: Command) => { commands[name] = command; },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: dir, hasUI: true,
    ui: { setStatus: (key: string, text?: string) => { status[key] = text; }, notify: (text: string, type?: string) => notes.push([text, type]) },
  };
  const fire = (event: string, data: object = {}) => Promise.all(hooks.listeners(event).map(handler => handler(data, ctx)));
  const ready = new Promise(resolve => bus.once('nvim-remote:ready', resolve));
  registerRemote(api);
  registerFollow(api);
  await fire('session_start', { reason: 'startup' });
  await ready;
  const follow = (args = '') => commands.follow.handler(args, ctx);
  let calls = 0;
  /** A tool call as Pi makes one: announced, carried out on disk, then its result. */
  async function tool(toolName: string, input: Record<string, unknown>, change: (text: string | undefined) => string | undefined, isError = false) {
    const toolCallId = `call-${++calls}`;
    await fire('tool_call', { toolName, toolCallId, input });
    const path = join(dir, String(input.path).replace(/^@/, ''));
    const next = change(await readFile(path, 'utf8').catch(() => undefined));
    if (next !== undefined) await writeFile(path, next);
    await fire('tool_result', { toolName, toolCallId, input, isError, content: [] });
  }
  const shutdown = () => fire('session_shutdown', { reason: 'quit' });
  return { bus, commands, status, notes, ctx, fire, follow, tool, shutdown };
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const edit = (oldText: string, newText: string) => (text: string | undefined) => text!.replace(oldText, newText);

/** The user's window beside Pi's terminal, which has focus. */
async function layout() {
  const [code] = await lua(`vim.cmd('silent! only | silent! %bwipeout! | enew')
    local code = vim.api.nvim_get_current_win()
    vim.cmd('vsplit | terminal')
    return { code }`);
  return code as number;
}
const shown = (win: number) => lua('local w = ...; return { vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(w)), vim.api.nvim_win_get_cursor(w)[1] }', win);
const showing = (win: number, path: string, line: number) =>
  eventually(async () => { const [name, at] = await shown(win); return name === path && at === line; });

test('following is off until asked for, and the status says when it is on', async () => {
  const { follow, status, tool, notes, shutdown } = await pi();
  const code = await layout();
  await writeFile(join(dir, 'a.txt'), lines(10));
  await tool('edit', { path: 'a.txt', edits: [{ oldText: 'line 5\n', newText: 'five\n' }] }, edit('line 5\n', 'five\n'));
  await delay(100);
  assert.deepEqual(await shown(code), ['', 1]);
  assert.equal(status['nvim-follow'], undefined);

  await follow();
  assert.equal(status['nvim-follow'], 'following');
  assert.deepEqual(notes.at(-1), ['Following on', 'info']);
  await follow('on');
  assert.equal(status['nvim-follow'], 'following');
  await follow('off');
  assert.equal(status['nvim-follow'], undefined);
  assert.deepEqual(notes.at(-1), ['Following off', 'info']);
  await shutdown();
});

test('an edit is shown where it landed, not where its new text first occurs', async () => {
  const { follow, tool, shutdown } = await pi();
  const code = await layout();
  const path = join(dir, 'b.txt');
  await writeFile(path, lines(60));
  await follow('on');
  await tool('edit', { path: 'b.txt', edits: [{ oldText: 'line 45\n', newText: 'line 3\n' }] }, edit('line 45\n', 'line 3\n'));
  await showing(code, path, 45);
  await shutdown();
});

test('several edits in one call: the first is where the cursor goes', async () => {
  const { follow, tool, shutdown } = await pi();
  const code = await layout();
  const path = join(dir, 'c.txt');
  await writeFile(path, lines(40));
  await follow('on');
  const edits = [{ oldText: 'line 30\n', newText: 'thirty\n' }, { oldText: 'line 12\n', newText: 'twelve\n' }];
  await tool('edit', { path: 'c.txt', edits }, text => edits.reduce((t, e) => t.replace(e.oldText, e.newText), text!));
  await showing(code, path, 12);
  await shutdown();
});

test('the legacy edit form and @ paths are followed too', async () => {
  const { follow, tool, shutdown } = await pi();
  const code = await layout();
  const path = join(dir, 'd.txt');
  await writeFile(path, lines(20));
  await follow('on');
  await tool('edit', { path: '@d.txt', oldText: 'line 17\n', newText: 'seventeen\n' }, edit('line 17\n', 'seventeen\n'));
  await showing(code, path, 17);
  await shutdown();
});

test('a write is shown at the first line it changed, a new file at its top', async () => {
  const { follow, tool, shutdown } = await pi();
  const code = await layout();
  await follow('on');
  const created = join(dir, 'new.txt');
  await rm(created, { force: true });
  await tool('write', { path: 'new.txt', content: 'a\nb\n' }, () => 'a\nb\n');
  await showing(code, created, 1);
  const path = join(dir, 'e.txt');
  await writeFile(path, lines(30));
  await tool('write', { path: 'e.txt' }, text => text!.replace('line 22\n', 'changed\n'));
  await showing(code, path, 22);
  await shutdown();
});

test('failed calls and other tools are not followed', async () => {
  const { follow, tool, shutdown } = await pi();
  const code = await layout();
  const path = join(dir, 'f.txt');
  await writeFile(path, lines(10));
  await follow('on');
  await tool('edit', { path: 'f.txt', edits: [{ oldText: 'x', newText: 'y' }] }, () => undefined, true);
  await tool('read', { path: 'f.txt' }, () => undefined);
  await tool('bash', { command: 'true' } as Record<string, unknown> & { path?: string }, () => undefined);
  await delay(100);
  assert.deepEqual(await shown(code), ['', 1]);
  await shutdown();
});

test('following survives /reload and session switches, and its status comes back with the editor', async () => {
  const first = await pi();
  await first.follow('on');
  await first.fire('session_shutdown', { reason: 'reload' });
  const second = await pi(); // Everything loaded afresh.
  await eventually(() => second.status['nvim-follow'] === 'following');
  const code = await layout();
  const path = join(dir, 'g.txt');
  await writeFile(path, lines(10));
  await second.tool('edit', { path: 'g.txt', edits: [{ oldText: 'line 8\n', newText: 'eight\n' }] }, edit('line 8\n', 'eight\n'));
  await showing(code, path, 8);
  await second.shutdown();
});

test('without the editor the status goes, and comes back when it does; the setting stays', async () => {
  const { follow, status, commands, ctx, notes, shutdown, bus } = await pi();
  await follow('on');
  const remote = await new Promise<{ channel: number }>(resolve => bus.emit('nvim-remote:get', { reply: resolve }));
  await lua('vim.fn.chanclose(...)', remote.channel);
  await eventually(() => status['nvim-follow'] === undefined);
  await follow('on');
  assert.deepEqual(notes.at(-1), ['Following on; Pi is not attached to Neovim, so there is nothing to follow yet', 'warning']);
  await commands['nvim-remote'].handler('reconnect', ctx);
  await eventually(() => status['nvim-follow'] === 'following');
  await shutdown();
});

test('Pi never waits on a busy editor', async () => {
  const { follow, tool, shutdown } = await pi();
  const code = await layout();
  const path = join(dir, 'h.txt');
  await writeFile(path, lines(10));
  await follow('on');
  editor.notify('nvim_exec_lua', ['local s = vim.uv.hrtime(); while vim.uv.hrtime() - s < 1e9 do end', []]);
  await delay(50);
  const start = Date.now();
  await tool('edit', { path: 'h.txt', edits: [{ oldText: 'line 6\n', newText: 'six\n' }] }, edit('line 6\n', 'six\n'));
  assert.ok(Date.now() - start < 500, `waited ${Date.now() - start} ms`);
  await showing(code, path, 6); // Shown once the editor is free.
  await shutdown();
});

test('changes to several files in a row are shown in turn, ending on the last', async () => {
  const { follow, tool, shutdown } = await pi();
  const code = await layout();
  await follow('on');
  for (const name of ['i.txt', 'j.txt', 'k.txt']) await writeFile(join(dir, name), lines(10));
  for (const [n, name] of ['i.txt', 'j.txt', 'k.txt'].entries()) {
    await tool('edit', { path: name, edits: [{ oldText: `line ${n + 2}\n`, newText: 'x\n' }] }, edit(`line ${n + 2}\n`, 'x\n'));
  }
  await showing(code, join(dir, 'k.txt'), 4);
  // Each file visited stays loaded, reread, with what Pi wrote.
  for (const [n, name] of ['i.txt', 'j.txt'].entries()) {
    assert.equal(await lua('return vim.api.nvim_buf_get_lines(vim.fn.bufnr(...), select(2, ...), select(2, ...) + 1, true)[1]', join(dir, name), n + 1), 'x');
  }
  await shutdown();
});
