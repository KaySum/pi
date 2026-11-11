import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { launch } from '../nvim-service/service.mjs';
import { connect } from '../nvim-remote/remote.ts';
import registerRemote from '../nvim-remote/index.ts';
import type { Remote } from '../nvim-remote/api.ts';
import registerAnnotate from './annotate.ts';

const service = launch({ cwd: '/tmp', init: 'NONE', graceMs: 100, killMs: 300 });
const { socket } = await service.ready;
after(() => service.stop());
const editor = await connect(socket); // The user.
after(() => editor.close());
const lua = (code: string, ...args: unknown[]): Promise<any> => editor.request('nvim_exec_lua', [code, args]);
const dir = await realpath(await mkdtemp(join(tmpdir(), 'nvim-annotate-')));
after(() => rm(dir, { recursive: true, force: true }));

type Tool = { execute(id: string, params: object, signal: undefined, onUpdate: undefined, ctx: object): Promise<{ content: { text: string }[] }> };
type Command = { handler(args: string, ctx: object): Promise<void> };

/** Pi with nvim-remote (unless `!remote`) and nvim-annotate loaded, its session started. */
async function pi({ remote = true } = {}) {
  process.env.NVIM = socket;
  delete process.env.PI_NVIM_REMOTE;
  const bus = new EventEmitter(), hooks = new EventEmitter();
  const tools: Record<string, Tool> = {}, commands: Record<string, Command> = {};
  const notes: [string, string | undefined][] = [];
  const api = {
    events: { on: (channel: string, handler: (data: unknown) => void) => bus.on(channel, handler), emit: (channel: string, data: unknown) => bus.emit(channel, data) },
    on: (event: string, handler: () => void) => hooks.on(event, handler),
    registerTool: (tool: Tool & { name: string }) => { tools[tool.name] = tool; },
    registerCommand: (name: string, command: Command) => { commands[name] = command; },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, hasUI: true, ui: { setStatus() {}, notify: (text: string, type?: string) => notes.push([text, type]) } };
  const fire = (event: string) => Promise.all(hooks.listeners(event).map(handler => handler({}, ctx)));
  const ready = new Promise<Remote>(resolve => bus.once('nvim-remote:ready', resolve));
  if (remote) registerRemote(api);
  registerAnnotate(api, {} as never);
  await fire('session_start');
  const nvim = remote ? await ready : undefined;
  const annotate = async (params: object) => (await tools.nvim_annotate.execute('1', params, undefined, undefined, ctx)).content[0].text;
  const run = async (args: string) => { await commands['nvim-annotate'].handler(args, ctx); return notes.at(-1)!; };
  return { nvim, annotate, run, tools, shutdown: () => fire('session_shutdown') };
}

const running = new Set<{ shutdown(): Promise<unknown> }>();
afterEach(async () => {
  for (const p of running) await p.shutdown();
  running.clear();
  await editor.request('nvim_input', ['<Esc>']);
  await lua('vim.cmd("silent! tabonly | silent! only | enew! | silent! %bwipeout!")');
});
async function attached() {
  const p = await pi();
  running.add(p);
  return p;
}

let files = 0;
/** A file of `n` numbered lines, every tenth one a function. */
async function file(n = 200) {
  const path = join(dir, `file-${++files}.ts`);
  await writeFile(path, Array.from({ length: n }, (_, i) => (i + 1) % 10 === 0 ? `function f${i + 1}() {}` : `line ${i + 1}`).join('\n') + '\n');
  return path;
}
const name = (path: string) => path.slice(dir.length + 1);

/** Your file on the left, a terminal beside it focused, as Pi's would be: [your window, the terminal's]. */
const layout = (path: string): Promise<[number, number]> => lua(`vim.cmd.edit(vim.fn.fnameescape(...))
  local yours = vim.api.nvim_get_current_win()
  vim.cmd('rightbelow vsplit | terminal')
  return { yours, vim.api.nvim_get_current_win() }`, path);
const cursor = (win: number): Promise<[number, number]> => lua('return vim.api.nvim_win_get_cursor(...)', win);
const current = (): Promise<number> => lua('return vim.api.nvim_get_current_win()');
/** The notes' extmarks in `path`: [line, the text drawn, its highlight, where]. */
const drawn = (remote: Remote, path: string): Promise<[number, string, string, string][]> => lua(`local channel, path = ...
  local ns = vim.api.nvim_get_namespaces()['nvim-virtual-text.' .. channel .. '.nvim-annotate']
  local buf = vim.fn.bufnr(path)
  if not ns or buf == -1 then return {} end
  local found = {}
  for _, m in ipairs(vim.api.nvim_buf_get_extmarks(buf, ns, 0, -1, { details = true })) do
    local d = m[4]
    local chunks = d.virt_lines and d.virt_lines[1] or d.virt_text
    if chunks then
      table.insert(found, { m[2] + 1, chunks[#chunks][1], chunks[#chunks][2], d.virt_lines and (d.virt_lines_above and 'above' or 'below') or 'eol' })
    end
  end
  table.sort(found, function(a, b) return a[1] < b[1] end)
  return found`, remote.channel, path);

async function eventually<T>(check: () => Promise<T> | T, ms = 3000): Promise<NonNullable<T>> {
  for (const end = Date.now() + ms; ; await delay(20)) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > end) assert.fail(`not within ${ms} ms`);
  }
}

test('notes go above code found by match or line, numbered, wrapped and indented to it, in the color asked', async () => {
  const { nvim, annotate } = await attached();
  const path = await file();
  await layout(path);
  const said = await annotate({ action: 'add', notes: [
    { file: name(path), match: 'function f20() {}', text: 'Starts here.' },
    { file: name(path), line: 45, text: 'Then this.', kind: 'warn' },
    { file: name(path), match: 'function f60', text: 'short', kind: 'hint' },
  ] });
  assert.equal(said, `Added notes 1-3:\n1. ${name(path)}:20 \`function f20() {}\`: Starts here.\n2. ${name(path)}:45 warn \`line 45\`: Then this.\n3. ${name(path)}:60 hint \`function f60() {}\`: short`);
  assert.deepEqual(await drawn(nvim!, path), [
    [20, '1. Starts here.', 'PiVirtualTextInfo', 'above'],
    [45, '2. Then this.', 'PiVirtualTextWarn', 'above'],
    [60, '3. short', 'PiVirtualTextHint', 'above'],
  ]);
  // More come after, numbered on.
  assert.match(await annotate({ action: 'add', notes: [{ file: path, line: 100, text: 'Last.' }] }), /^Added note 4:\n4\. .*:100 `function f100\(\) \{\}`: Last\.$/);
});

test('a note that cannot be placed places none: all or nothing', async () => {
  const { annotate } = await attached();
  const path = await file();
  await layout(path);
  await assert.rejects(annotate({ action: 'add', notes: [
    { file: name(path), match: 'function f10', text: 'fine' },
    { file: name(path), match: 'nowhere()', text: 'missing' },
  ] }), /not found/);
  await assert.rejects(annotate({ action: 'add', notes: [{ file: 'missing.ts', line: 1, text: 'x' }] }), /no such file|missing/);
  await assert.rejects(annotate({ action: 'add', notes: [{ file: name(path), text: 'nowhere' }] }), /needs a match or a line/);
  await assert.rejects(annotate({ action: 'add' }), /add needs notes/);
  assert.equal(await annotate({ action: 'list' }), 'No notes');
});

test('each note says the code it is on, its space trimmed and a long line cut', async () => {
  const { annotate } = await attached();
  const path = join(dir, 'code.ts');
  await writeFile(path, `const a = 1;\n    if (ready) {\n${'x'.repeat(100)}\n`);
  await layout(path);
  assert.equal(await annotate({ action: 'add', notes: [
    { file: name(path), match: 'if (ready) {', text: 'indented' },
    { file: name(path), line: 3, text: 'long' },
  ] }), `Added notes 1-2:\n1. code.ts:2 \`if (ready) {\`: indented\n2. code.ts:3 \`${'x'.repeat(79)}…\`: long`);
});

test('notes move with the code as it is edited, and hide while it is deleted', async () => {
  const { annotate } = await attached();
  const path = await file();
  await layout(path);
  await annotate({ action: 'add', notes: [
    { file: name(path), match: 'function f30', text: 'one' },
    { file: name(path), match: 'function f50', text: 'two' },
  ] });
  await lua('vim.api.nvim_buf_set_lines(vim.fn.bufnr(...), 0, 0, true, { "a", "b", "c" })', path);
  assert.equal(await annotate({ action: 'list' }), `1. ${name(path)}:33 \`function f30() {}\`: one\n2. ${name(path)}:53 \`function f50() {}\`: two`);
  await lua('vim.api.nvim_buf_set_lines(vim.fn.bufnr(...), 52, 53, true, {})', path);
  assert.match(await annotate({ action: 'list' }), /^2\. .* \(its lines deleted\): two$/m);
});

test('show takes you to a note, focus staying in Pi\'s terminal', async () => {
  const { annotate } = await attached();
  const path = await file();
  const [yours, term] = await layout(path);
  await annotate({ action: 'add', notes: [{ file: name(path), match: 'function f10', text: 'a' }, { file: name(path), match: 'function f150', text: 'b' }] });
  assert.equal(await annotate({ action: 'show', note: 2 }), `Note 2 of 2: ${name(path)}:150`);
  assert.deepEqual([(await cursor(yours))[0], await current()], [150, term]);
  assert.equal(await annotate({ action: 'show', note: 7 }), 'No note 7');
  await assert.rejects(annotate({ action: 'show' }), /show needs a note number/);
});

test(':PiNotes in Neovim steps through the notes in order, passing over deleted ones', async () => {
  const { annotate } = await attached();
  const path = await file();
  const [yours] = await layout(path);
  await annotate({ action: 'add', notes: [
    { file: name(path), match: 'function f30', text: 'one' },
    { file: name(path), match: 'function f70', text: 'two' },
    { file: name(path), match: 'function f120', text: 'three' },
  ] });
  // Two's code deleted: one, then three.
  await lua('vim.api.nvim_buf_set_lines(vim.fn.bufnr(...), 69, 70, true, {})', path);
  await editor.request('nvim_command', ['PiNotes next']);
  await eventually(async () => (await cursor(yours))[0] === 30);
  await editor.request('nvim_command', ['PiNotes']);
  await eventually(async () => (await cursor(yours))[0] === 119);
  await editor.request('nvim_command', ['PiNotes prev']);
  await eventually(async () => (await cursor(yours))[0] === 30);
  await editor.request('nvim_command', ['PiNotes 3']);
  await eventually(async () => (await cursor(yours))[0] === 119);
  // Past the last: where it was.
  await editor.request('nvim_command', ['PiNotes next']);
  await delay(150);
  assert.equal((await cursor(yours))[0], 119);
});

test('/nvim-annotate lists the notes, goes to one with your focus, and clears them', async () => {
  const { nvim, annotate, run } = await attached();
  const path = await file();
  const [yours] = await layout(path);
  assert.deepEqual(await run(''), ['No notes', 'info']);
  await annotate({ action: 'add', notes: [{ file: name(path), match: 'function f40', text: 'here' }] });
  assert.deepEqual(await run(''), [`1. ${name(path)}:40 \`function f40() {}\`: here`, 'info']);
  assert.deepEqual(await run('next'), [`Note 1 of 1: ${name(path)}:40`, 'info']);
  assert.deepEqual([(await cursor(yours))[0], await current()], [40, yours]);
  assert.deepEqual(await run('wat'), ['Usage: /nvim-annotate [next | prev | <number> | clear]', 'warning']);
  assert.deepEqual(await run('clear'), ['Removed 1 note', 'info']);
  assert.deepEqual(await drawn(nvim!, path), []);
});

test('clear removes every note; the tool says how many', async () => {
  const { nvim, annotate } = await attached();
  const path = await file();
  await layout(path);
  await annotate({ action: 'add', notes: [{ file: name(path), line: 1, text: 'a' }, { file: name(path), line: 2, text: 'b' }] });
  assert.equal(await annotate({ action: 'clear' }), 'Removed 2 notes');
  assert.deepEqual(await drawn(nvim!, path), []);
  assert.equal(await annotate({ action: 'list' }), 'No notes');
});

test('once Pi detaches, its notes and :PiNotes go; without Neovim the tool and command say so', async () => {
  const p = await pi();
  const path = await file();
  await layout(path);
  await p.annotate({ action: 'add', notes: [{ file: name(path), line: 5, text: 'a' }] });
  assert.equal(await lua('return vim.fn.exists(":PiNotes")'), 2);
  await p.shutdown();
  await eventually(async () => await lua('return vim.fn.exists(":PiNotes")') === 0);
  assert.deepEqual(await drawn(p.nvim!, path), []);
  const detached = await pi({ remote: false });
  await assert.rejects(detached.annotate({ action: 'list' }), /Pi is not attached to Neovim/);
  assert.deepEqual(await detached.run(''), ['Pi is not attached to Neovim', 'warning']);
});
