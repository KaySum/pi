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
// Pi's own tools, from the package nvim-service installs.
type Tool = { execute(id: string, input: Record<string, unknown>): Promise<{ content: unknown[]; details?: unknown }> };
const piTools = await import(new URL('../nvim-service/node_modules/@earendil-works/pi-coding-agent/dist/index.js', import.meta.url).href);
const TOOLS: Record<string, (cwd: string) => Tool> = { edit: piTools.createEditTool, write: piTools.createWriteTool, read: piTools.createReadTool };
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

type Command = { handler(args: string, ctx: object): Promise<void>; getArgumentCompletions?(prefix: string): unknown };

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
  /**
   * A tool call as Pi makes one: announced, run by Pi's own tool (so an edit's result carries
   * its real patch), then its result. `result` stands in for what a tool would return instead.
   */
  async function tool(toolName: string, input: Record<string, unknown>, result?: { isError?: boolean; content?: { type: string }[]; details?: unknown }) {
    const toolCallId = `call-${++calls}`;
    await fire('tool_call', { toolName, toolCallId, input });
    let outcome: { isError: boolean; content: unknown[]; details?: unknown } = { isError: result?.isError ?? false, content: result?.content ?? [], details: result?.details };
    const make = TOOLS[toolName];
    if (!result && make) {
      try {
        const { content, details } = await make(dir).execute(toolCallId, input);
        outcome = { isError: false, content, details };
      } catch (error) { outcome = { isError: true, content: [{ type: 'text', text: String(error) }] }; }
    }
    await fire('tool_result', { toolName, toolCallId, input, ...outcome });
  }
  const shutdown = () => fire('session_shutdown', { reason: 'quit' });
  return { bus, commands, status, notes, ctx, fire, follow, tool, shutdown };
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

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
  await tool('edit', { path: 'a.txt', edits: [{ oldText: 'line 5\n', newText: 'five\n' }] });
  await delay(100);
  assert.deepEqual(await shown(code), ['', 1]);
  assert.equal(status['nvim-follow'], undefined);

  await follow();
  assert.equal(status['nvim-follow'], 'following edits');
  assert.deepEqual(notes.at(-1), ['Following edits', 'info']);
  await follow('on');
  assert.equal(status['nvim-follow'], 'following edits');
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
  await tool('edit', { path: 'b.txt', edits: [{ oldText: 'line 45\n', newText: 'line 3\n' }] });
  await showing(code, path, 45);
  await shutdown();
});

test('the cursor lands on the character that changed, not on the context around it', async () => {
  const { follow, tool, shutdown } = await pi();
  const code = await layout();
  const path = join(dir, 'ctx.ts');
  await writeFile(path, 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return "→ 1";\n}\n');
  await follow('on');
  // As Pi writes edits: the lines around the change come along, so the old text is unique.
  const oldText = 'function b() {\n  return "→ 1";\n}', newText = 'function b() {\n  return "→ 2";\n}';
  await tool('edit', { path: 'ctx.ts', edits: [{ oldText, newText }] });
  await showing(code, path, 6);
  // Byte 14 on line 6: the "2", past the 3-byte arrow.
  assert.deepEqual(await lua('return vim.api.nvim_win_get_cursor(...)', code), [6, 14]);
  assert.equal(await lua('local w = ...; local c = vim.api.nvim_win_get_cursor(w); return vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(w), c[1] - 1, c[1], true)[1]:sub(c[2] + 1, c[2] + 1)', code), '2');
  await shutdown();
});

test('several edits in one call: the first is where the cursor goes', async () => {
  const { follow, tool, shutdown } = await pi();
  const code = await layout();
  const path = join(dir, 'c.txt');
  await writeFile(path, lines(40));
  await follow('on');
  const edits = [{ oldText: 'line 30\n', newText: 'thirty\n' }, { oldText: 'line 12\n', newText: 'twelve\n' }];
  await tool('edit', { path: 'c.txt', edits });
  await showing(code, path, 12);
  await shutdown();
});

test('several edits in one call are all brought into view when they fit', async () => {
  const { follow, tool, shutdown } = await pi();
  const code = await layout();
  const path = join(dir, 'many.txt');
  await writeFile(path, lines(300));
  await follow('on');
  const edits = [{ oldText: 'line 150\n', newText: 'one-fifty\n' }, { oldText: 'line 165\n', newText: 'one-sixty-five\n' }];
  await tool('edit', { path: 'many.txt', edits });
  await showing(code, path, 150);
  const [first, last] = await lua(`local w = ...
    return vim.api.nvim_win_call(w, function() return { vim.fn.line('w0'), vim.fn.line('w$') } end)`, code);
  assert.ok(first <= 150 && last >= 165, `${first}-${last} shows both edits`);
  await shutdown();
});

test('@ paths are followed too', async () => {
  const { follow, tool, shutdown } = await pi();
  const code = await layout();
  const path = join(dir, 'd.txt');
  await writeFile(path, lines(20));
  await follow('on');
  await tool('edit', { path: '@d.txt', edits: [{ oldText: 'line 17\n', newText: 'seventeen\n' }] });
  await showing(code, path, 17);
  await shutdown();
});

test('a write is shown at the first line it changed, a new file at its top', async () => {
  const { follow, tool, shutdown } = await pi();
  const code = await layout();
  await follow('on');
  const created = join(dir, 'new.txt');
  await rm(created, { force: true });
  await tool('write', { path: 'new.txt', content: 'a\nb\n' });
  await showing(code, created, 1);
  const path = join(dir, 'e.txt');
  await writeFile(path, lines(30));
  await tool('write', { path: 'e.txt', content: lines(30).replace('line 22\n', 'changed\n') });
  await showing(code, path, 22);
  await shutdown();
});

test('failed calls and other tools are not followed', async () => {
  const { follow, tool, shutdown } = await pi();
  const code = await layout();
  const path = join(dir, 'f.txt');
  await writeFile(path, lines(10));
  await follow('on');
  await tool('edit', { path: 'f.txt', edits: [{ oldText: 'not in the file', newText: 'y' }] }); // Pi's tool refuses it.
  await tool('read', { path: 'f.txt' });
  await tool('bash', { command: 'true' });
  await delay(100);
  assert.deepEqual(await shown(code), ['', 1]);
  await shutdown();
});

test('following survives /reload and session switches, and its status comes back with the editor', async () => {
  const first = await pi();
  await first.follow('on');
  await first.fire('session_shutdown', { reason: 'reload' });
  const second = await pi(); // Everything loaded afresh.
  await eventually(() => second.status['nvim-follow'] === 'following edits');
  const code = await layout();
  const path = join(dir, 'g.txt');
  await writeFile(path, lines(10));
  await second.tool('edit', { path: 'g.txt', edits: [{ oldText: 'line 8\n', newText: 'eight\n' }] });
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
  assert.deepEqual(notes.at(-1), ['Following edits; Pi is not attached to Neovim, so there is nothing to follow yet', 'warning']);
  await commands['nvim-remote'].handler('reconnect', ctx);
  await eventually(() => status['nvim-follow'] === 'following edits');
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
  await tool('edit', { path: 'h.txt', edits: [{ oldText: 'line 6\n', newText: 'six\n' }] });
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
    await tool('edit', { path: name, edits: [{ oldText: `line ${n + 2}\n`, newText: 'x\n' }] });
  }
  await showing(code, join(dir, 'k.txt'), 4);
  // Each file visited stays loaded, reread, with what Pi wrote.
  for (const [n, name] of ['i.txt', 'j.txt'].entries()) {
    assert.equal(await lua('return vim.api.nvim_buf_get_lines(vim.fn.bufnr(...), select(2, ...), select(2, ...) + 1, true)[1]', join(dir, name), n + 1), 'x');
  }
  await shutdown();
});

// Reads

const highlight = (win: number) => lua(`local w = ...
  for _, c in pairs(require('nvim_remote.v1').contexts) do
    if c.nvim_follow then
      local m = vim.api.nvim_buf_get_extmarks(vim.api.nvim_win_get_buf(w), c.nvim_follow.ns, 0, -1, { details = true })[1]
      if m then return { m[2] + 1, m[4].end_row, m[4].hl_group } end -- First and last line, 1-based.
    end
  end
  return false`, win);

test('reads are followed only when asked for, at what was read, in their own highlight', async () => {
  const { follow, tool, status, notes, shutdown } = await pi();
  const code = await layout();
  const path = join(dir, 'r.txt');
  await writeFile(path, lines(100));
  await follow('on');
  await tool('read', { path: 'r.txt', offset: 40, limit: 10 });
  await delay(100);
  assert.deepEqual(await shown(code), ['', 1]); // Edits only, so far.

  await follow('all');
  assert.equal(status['nvim-follow'], 'following all');
  assert.deepEqual(notes.at(-1), ['Following edits and reads', 'info']);
  await tool('read', { path: 'r.txt', offset: 40, limit: 10 });
  await showing(code, path, 40);
  assert.deepEqual(await eventually(() => highlight(code)), [40, 49, 'PiFollowRead']);
  // Edits keep their own highlight.
  await tool('edit', { path: 'r.txt', edits: [{ oldText: 'line 70\n', newText: 'seventy\n' }] });
  await showing(code, path, 70);
  assert.deepEqual(await eventually(async () => { const h = await highlight(code); return h && h[0] === 70 && h; }), [70, 70, 'PiFollow']);
  await shutdown();
});

test('a whole-file read opens the file without moving the cursor', async () => {
  const { follow, tool, shutdown } = await pi();
  const code = await layout();
  const path = join(dir, 's.txt');
  await writeFile(path, lines(50));
  await follow('all');
  await tool('read', { path: 's.txt', offset: 30 });
  await showing(code, path, 30);
  await tool('read', { path: 's.txt' });
  await delay(100);
  assert.deepEqual(await shown(code), [path, 30]);
  await shutdown();
});

test('image reads and failed reads are not followed', async () => {
  const { follow, tool, shutdown } = await pi();
  const code = await layout();
  await writeFile(join(dir, 'picture.png'), 'not really an image');
  await writeFile(join(dir, 't.txt'), lines(5));
  await follow('all');
  await tool('read', { path: 'picture.png' }, { content: [{ type: 'text' }, { type: 'image' }] });
  await tool('read', { path: 't.txt', offset: 3 }, { isError: true });
  await delay(100);
  assert.deepEqual(await shown(code), ['', 1]);
  await shutdown();
});

test('/follow takes one of three options; alone it switches off, or back to the last one on', async () => {
  const { follow, status, notes, shutdown } = await pi();
  const states: (string | undefined)[] = [];
  for (const args of ['all', 'on', 'off', '', 'all', 'off', '', '']) {
    await follow(args);
    states.push(status['nvim-follow']);
  }
  assert.deepEqual(states, ['following all', 'following edits', undefined, 'following edits', 'following all', undefined, 'following all', undefined]);
  assert.deepEqual(notes.slice(0, 3), [['Following edits and reads', 'info'], ['Following edits', 'info'], ['Following off', 'info']]);
  await shutdown();
});

test('anything else /follow does not understand says how to use it, and changes nothing', async () => {
  const { follow, status, notes, shutdown } = await pi();
  await follow('on');
  for (const args of ['sideways', 'reads', 'all off', 'ALL', 'al']) {
    await follow(args);
    assert.deepEqual(notes.at(-1), ['Usage: /follow [on|all|off]', 'warning']);
    assert.equal(status['nvim-follow'], 'following edits');
  }
  await follow('  off  '); // Spaces around are fine.
  assert.equal(status['nvim-follow'], undefined);
  await shutdown();
});

test('the three options are offered as completions, with what each does', async () => {
  const { commands, shutdown } = await pi();
  const complete = (prefix: string) => commands.follow.getArgumentCompletions!(prefix) as { value: string; description: string }[] | null;
  assert.deepEqual(complete('')?.map(item => item.value), ['on', 'all', 'off']);
  assert.deepEqual(complete('o')?.map(item => item.value), ['on', 'off']);
  assert.deepEqual(complete('a'), [{ value: 'all', label: 'all', description: 'Follow what Pi edits, writes and reads' }]);
  assert.equal(complete('x'), null);
  await shutdown();
});

test('following all survives /reload too', async () => {
  const first = await pi();
  await first.follow('all');
  await first.fire('session_shutdown', { reason: 'reload' });
  const second = await pi();
  await eventually(() => second.status['nvim-follow'] === 'following all');
  await second.shutdown();
});

test('an edit result without a patch (from another edit tool) falls back to its first changed line, or just the file', async () => {
  const { follow, tool, shutdown } = await pi();
  const code = await layout();
  const path = join(dir, 'other.txt');
  await writeFile(path, lines(40));
  await follow('on');
  await tool('edit', { path: 'other.txt' }, { details: { firstChangedLine: 33 } });
  await showing(code, path, 33);
  await lua('vim.api.nvim_win_set_cursor(..., { 5, 0 })', code);
  await tool('edit', { path: 'other.txt' }, { details: {} });
  await delay(100);
  assert.deepEqual(await shown(code), [path, 5]); // Opened, the cursor left alone.
  await shutdown();
});
