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
import type { Remote } from '../nvim-remote/api.ts';
import registerAnnotate, { ranges } from './annotate.ts';

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
  const fire = (event: string, data: object = {}) => Promise.all(hooks.listeners(event).map(handler => handler(data, ctx)));
  const ready = new Promise<Remote>(resolve => bus.once('nvim-remote:ready', resolve));
  if (remote) registerRemote(api);
  registerAnnotate(api, {} as never);
  await fire('session_start');
  const nvim = remote ? await ready : undefined;
  const annotate = async (params: object) => (await tools.nvim_annotate.execute('1', params, undefined, undefined, ctx)).content[0].text;
  const run = async (args: string) => { await commands['nvim-annotate'].handler(args, ctx); return notes.at(-1)!; };
  return { nvim, annotate, run, tools, commands, ctx, notes, fire, shutdown: () => fire('session_shutdown') };
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

/**
 * Hold the reply to the first call of `remote.lua` that `holds`, once Neovim has run it: `held`
 * resolves then, and `release` lets the reply through.
 */
function hold(remote: Remote, holds: (code: string, args: unknown[]) => boolean) {
  const lua = remote.lua;
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = new Promise<void>(resolve => { reached = resolve; });
  let armed = true;
  remote.lua = async (code, args = [], options) => {
    const result = await lua(code, args, options);
    if (armed && holds(code, args)) {
      armed = false;
      reached();
      await gate;
    }
    return result;
  };
  return { held, release };
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

test('notes wrap as your window wraps code: its breakindent shift, or not at all with nowrap', async () => {
  const { nvim, annotate } = await attached();
  const path = join(dir, 'wrapped.ts');
  await writeFile(path, '  indented();\n');
  const [yours] = await layout(path);
  await lua(`local win = ...
    vim.wo[win].wrap = true; vim.wo[win].linebreak = true; vim.wo[win].breakindent = true
    vim.wo[win].breakindentopt = 'shift:4'; vim.wo[win].showbreak = ''`, yours);
  const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  await annotate({ action: 'add', notes: [{ file: name(path), line: 1, text: long }] });
  const lines = async (): Promise<string[]> => lua(`local channel, path = ...
    local ns = vim.api.nvim_get_namespaces()['nvim-virtual-text.' .. channel .. '.nvim-annotate']
    for _, m in ipairs(vim.api.nvim_buf_get_extmarks(vim.fn.bufnr(path), ns, 0, -1, { details = true })) do
      if m[4].virt_lines then
        return vim.tbl_map(function(l) return table.concat(vim.tbl_map(function(c) return c[1] end, l)) end, m[4].virt_lines)
      end
    end`, nvim!.channel, path);
  let got = await lines();
  assert.ok(got.length > 1, got.join('|'));
  assert.ok(got[0].startsWith('  1. word0'));
  for (const line of got.slice(1)) assert.match(line, /^ {6}\S/, line); // Its indent, 2, and the shift, 4.
  await lua('vim.wo[...].wrap = false', yours);
  await eventually(async () => (await lines()).length === 1);
  assert.deepEqual(await lines(), [`  1. ${long}`]);
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

test('a failed add names every note that cannot be placed, and draws none of them', async () => {
  const { nvim, annotate } = await attached();
  const path = await file();
  await layout(path);
  await annotate({ action: 'add', notes: [{ file: name(path), line: 1, text: 'there before' }] });
  const error = await annotate({ action: 'add', notes: [
    { file: name(path), match: 'function f10', text: 'fine' },
    { file: name(path), match: 'nowhere()', text: 'missing code' },
    { file: name(path), line: 20, text: 'fine too' },
    { file: 'missing.ts', line: 1, text: 'missing file' },
  ] }).catch((error: Error) => error.message);
  assert.equal(error, `2 of 4 notes cannot be placed, so none were:\nnotes[1]: not found in ${path}: nowhere()\nnotes[3]: no such file: ${join(dir, 'missing.ts')}`);
  assert.deepEqual(await drawn(nvim!, path), [[1, '1. there before', 'PiVirtualTextInfo', 'above']]);
  // Nothing is left of the trial.
  assert.equal(await lua(`local channel, path = ...
    local ns = vim.api.nvim_get_namespaces()['nvim-virtual-text.' .. channel .. '.nvim-annotate.check']
    return ns and #vim.api.nvim_buf_get_extmarks(vim.fn.bufnr(path), ns, 0, -1, {}) or 0`, nvim!.channel, path), 0);
  await assert.rejects(annotate({ action: 'add', notes: [{ file: name(path), text: 'a' }, { file: name(path), line: 2, text: 'b' }, { file: name(path), text: 'c' }] }),
    /^Error: A note needs a match or a line: notes\[0\], notes\[2\]$/);
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

test('add with show takes you to the first note added, in the same call', async () => {
  const { annotate } = await attached();
  const path = await file();
  const [yours, term] = await layout(path);
  await annotate({ action: 'add', notes: [{ file: name(path), line: 5, text: 'earlier' }] });
  assert.equal(await annotate({ action: 'add', show: true, notes: [
    { file: name(path), match: 'function f120', text: 'first of these' },
    { file: name(path), match: 'function f150', text: 'then' },
  ] }), `Added notes 2-3:\n2. ${name(path)}:120 \`function f120() {}\`: first of these\n3. ${name(path)}:150 \`function f150() {}\`: then\nNote 2 of 3: ${name(path)}:120`);
  assert.deepEqual([(await cursor(yours))[0], await current()], [120, term]);
  // And :PiNotes goes on from there.
  await editor.request('nvim_command', ['PiNotes next']);
  await eventually(async () => (await cursor(yours))[0] === 150);
});

test('add with replace swaps the notes there for the new, numbered from 1, or leaves them if it fails', async () => {
  const { nvim, annotate } = await attached();
  const path = await file();
  const [yours] = await layout(path);
  await annotate({ action: 'add', show: true, notes: [10, 20, 30].map(line => ({ file: name(path), line, text: `old ${line}` })) });
  await assert.rejects(annotate({ action: 'add', replace: true, notes: [{ file: name(path), match: 'nowhere()', text: 'x' }] }), /cannot be placed/);
  assert.equal((await drawn(nvim!, path)).length, 3);
  assert.equal(await annotate({ action: 'add', replace: true, notes: [{ file: name(path), line: 40, text: 'new' }, { file: name(path), line: 50, text: 'newer' }] }),
    `Added notes 1-2, replacing 3:\n1. ${name(path)}:40 \`function f40() {}\`: new\n2. ${name(path)}:50 \`function f50() {}\`: newer`);
  assert.deepEqual((await drawn(nvim!, path)).map(([line, text]) => [line, text]), [[40, '1. new'], [50, '2. newer']]);
  // The walkthrough starts again.
  await editor.request('nvim_command', ['PiNotes next']);
  await eventually(async () => (await cursor(yours))[0] === 40);
});

test('update changes a note where its code is now; remove takes one out, the numbers keeping their gaps', async () => {
  const { nvim, annotate } = await attached();
  const path = await file();
  const [yours] = await layout(path);
  await annotate({ action: 'add', notes: [10, 20, 30].map(line => ({ file: name(path), line, text: `at ${line}` })) });
  await lua('vim.api.nvim_buf_set_lines(vim.fn.bufnr(...), 0, 0, true, { "a", "b" })', path);
  assert.equal(await annotate({ action: 'update', note: 2, text: 'changed', kind: 'warn' }), `Updated:\n2. ${name(path)}:22 warn \`function f20() {}\`: changed`);
  assert.equal(await annotate({ action: 'update', note: 1, kind: 'error' }), `Updated:\n1. ${name(path)}:12 error \`function f10() {}\`: at 10`);
  // A later add leaves them as changed.
  await annotate({ action: 'add', notes: [{ file: name(path), line: 100, text: 'four' }] });
  assert.deepEqual((await drawn(nvim!, path)).slice(0, 2), [[12, '1. at 10', 'PiVirtualTextError', 'above'], [22, '2. changed', 'PiVirtualTextWarn', 'above']]);
  assert.equal(await annotate({ action: 'remove', note: 4 }), 'Removed note 4; the others keep their numbers');
  assert.equal(await annotate({ action: 'remove', note: 2 }), 'Removed note 2; the others keep their numbers');
  assert.deepEqual((await drawn(nvim!, path)).map(([line, text]) => [line, text]), [[12, '1. at 10'], [32, '3. at 30']]);
  // A removed number is not given again.
  assert.match(await annotate({ action: 'add', notes: [{ file: name(path), line: 60, text: 'five' }] }), /^Added note 5:/);
  await editor.request('nvim_command', ['PiNotes 1']);
  await eventually(async () => (await cursor(yours))[0] === 12);
  await editor.request('nvim_command', ['PiNotes next']);
  await eventually(async () => (await cursor(yours))[0] === 32);
  for (const action of ['update', 'remove']) assert.equal(await annotate({ action, note: 2, text: 'x' }), 'No note 2');
  await assert.rejects(annotate({ action: 'update', note: [1, 3], text: 'x' }), /update takes one note number/);
  await assert.rejects(annotate({ action: 'update', note: 1 }), /update needs a text or a kind/);
  await assert.rejects(annotate({ action: 'remove' }), /remove needs a note number/);
});

test('remove takes several at once, saying which there were not', async () => {
  const { nvim, annotate } = await attached();
  const path = await file();
  await layout(path);
  await annotate({ action: 'add', notes: [10, 20, 30, 40, 50].map(line => ({ file: name(path), line, text: `at ${line}` })) });
  assert.equal(await annotate({ action: 'remove', note: [4, 2, 2, 9] }), 'Removed notes 2, 4; no note 9; the others keep their numbers');
  assert.deepEqual((await drawn(nvim!, path)).map(([, text]) => text), ['1. at 10', '3. at 30', '5. at 50']);
  assert.equal(await annotate({ action: 'remove', note: [2, 4] }), 'No notes 2, 4');
  assert.equal(await annotate({ action: 'remove', note: [1, 3, 5] }), 'Removed notes 1, 3, 5');
  assert.equal(await annotate({ action: 'list' }), 'No notes');
});

test('a note whose code is gone after a reload from disk is forgotten, and does not block adding', async () => {
  const { annotate } = await attached();
  const path = await file();
  await layout(path);
  await annotate({ action: 'add', notes: [{ file: name(path), match: 'function f20() {}', text: 'gone soon' }] });
  await writeFile(path, 'const kept = 1;\n');
  await lua('vim.api.nvim_buf_call(vim.fn.bufnr(...), function() vim.cmd("edit!") end)', path);
  assert.equal(await annotate({ action: 'list' }), 'No notes');
  assert.equal(await annotate({ action: 'remove', note: 1 }), 'No note 1');
  // Its number is not given again.
  assert.equal(await annotate({ action: 'add', notes: [{ file: name(path), match: 'const kept = 1;', text: 'here' }] }),
    `Added note 2:\n2. ${name(path)}:1 \`const kept = 1;\`: here`);
});

test('two :PiNotes next at once go two notes on, not one', async () => {
  const { annotate } = await attached();
  const path = await file();
  const [yours] = await layout(path);
  await annotate({ action: 'add', notes: [20, 40, 60].map(line => ({ file: name(path), line, text: `at ${line}` })) });
  await lua('vim.cmd("PiNotes next"); vim.cmd("PiNotes next")');
  await eventually(async () => (await cursor(yours))[0] === 40);
  await delay(150);
  assert.equal((await cursor(yours))[0], 40);
});

test('edits as the notes are read: each note is told with its own code, and shown where it is', async () => {
  const { nvim, annotate } = await attached();
  const path = await file();
  const [yours] = await layout(path);
  await annotate({ action: 'add', notes: [{ file: name(path), match: 'function f20() {}', text: 'one' }] });
  const insert = () => lua('vim.api.nvim_buf_set_lines(vim.fn.bufnr(...), 0, 0, true, { "a", "b", "c" })', path);
  // Read before the lines went in: where it was, and the code there then.
  let gate = hold(nvim!, code => code.includes('vt.list(group'));
  const listing = annotate({ action: 'list' });
  await gate.held;
  await insert();
  gate.release();
  assert.equal(await listing, `1. ${name(path)}:20 \`function f20() {}\`: one`);
  // Shown after more went in: where it is now.
  gate = hold(nvim!, code => code.includes('vt.list(group'));
  const showing = annotate({ action: 'show', note: 1 });
  await gate.held;
  await insert();
  gate.release();
  assert.match(await showing, new RegExp(`^Note 1 of 1: ${name(path)}:26`));
  assert.equal((await cursor(yours))[0], 26);
  // An edit just before each call that moves the cursor, three of them.
  const lua_ = nvim!.lua;
  let edits = 3;
  nvim!.lua = (async (code: string, args?: unknown[]) => {
    if (edits > 0 && code.includes('remote.nvim_point')) { edits--; await insert(); }
    return lua_(code, args);
  }) as Remote['lua'];
  const shown = await annotate({ action: 'show', note: 1 });
  nvim!.lua = lua_;
  const line = (await cursor(yours))[0];
  assert.equal(await lua('local path, line = ...; return vim.api.nvim_buf_get_lines(vim.fn.bufnr(path), line - 1, line, true)[1]', path, line), 'function f20() {}');
  assert.match(shown, new RegExp(`^Note 1 of 1: ${name(path)}:${line}$`));
});

test('a note moved by showing it, its file reloaded or an autocommand as its buffer is entered, is shown where it went', async () => {
  const { annotate } = await attached();
  const [a, b] = [await file(), await file()];
  const [yours] = await layout(a);
  await annotate({ action: 'add', notes: [{ file: name(a), match: 'function f20() {}', text: 'here' }, { file: name(b), match: 'function f40() {}', text: 'there' }] });
  const at = async () => lua('local win = ...; return { vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win)), vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(win), vim.api.nvim_win_get_cursor(win)[1] - 1, vim.api.nvim_win_get_cursor(win)[1], true)[1] }', yours);
  // Changed on disk while hidden: showing it reloads it, three lines down.
  await writeFile(b, 'a\nb\nc\n' + await readFile(b, 'utf8'));
  await lua('vim.o.autoread = true');
  assert.equal(await annotate({ action: 'show', note: 2 }), `Note 2 of 2: ${name(b)}:43`);
  assert.deepEqual(await at(), [b, 'function f40() {}']);
  // Hidden again, and entering it inserts three more lines, once.
  await annotate({ action: 'show', note: 1 });
  await lua(`vim.api.nvim_create_autocmd('BufEnter', { buffer = vim.fn.bufnr(...), once = true, callback = function(ev)
    vim.api.nvim_buf_set_lines(ev.buf, 0, 0, true, { 'x', 'y', 'z' })
  end })`, b);
  assert.equal(await annotate({ action: 'show', note: 2 }), `Note 2 of 2: ${name(b)}:46`);
  assert.deepEqual(await at(), [b, 'function f40() {}']);
});

test('a note whose file is reloaded shorter as it is shown, its old lines past the end, is shown whole where it went', async () => {
  const { annotate } = await attached();
  const [a, b] = [await file(), await file(100)];
  const [yours] = await layout(a);
  await annotate({ action: 'add', notes: [{ file: name(b), match: 'function f40() {}\nline 41\nline 42', text: 'three lines' }] });
  await writeFile(b, (await readFile(b, 'utf8')).split('\n').slice(30, 50).join('\n') + '\n');
  await lua('vim.o.autoread = true');
  assert.equal(await annotate({ action: 'show', note: 1 }), `Note 1 of 1: ${name(b)}:10-12`);
  assert.equal(await lua('local win = ...; return vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(win), vim.api.nvim_win_get_cursor(win)[1] - 1, vim.api.nvim_win_get_cursor(win)[1], true)[1]', yours), 'function f40() {}');
  // Shown again from the other file, entering it reloads it shorter still, from an autocommand not nested.
  await annotate({ action: 'add', notes: [{ file: name(a), line: 5, text: 'away' }] });
  await annotate({ action: 'show', note: 2 });
  await lua(`local path = ...
    vim.api.nvim_create_autocmd('BufEnter', { buffer = vim.fn.bufnr(path), once = true, callback = function()
      vim.fn.writefile(vim.list_slice(vim.fn.readfile(path), 6, 20), path)
      vim.cmd('edit!')
    end })`, b);
  assert.equal(await annotate({ action: 'show', note: 1 }), `Note 1 of 2: ${name(b)}:5-7`);
  assert.equal(await lua('local win = ...; return vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(win), vim.api.nvim_win_get_cursor(win)[1] - 1, vim.api.nvim_win_get_cursor(win)[1], true)[1]', yours), 'function f40() {}');
});

test('a note whose buffer is renamed is listed and shown in that buffer, by its name now', async () => {
  const { annotate } = await attached();
  const [a, b] = [await file(), await file()];
  const [yours] = await layout(a);
  await annotate({ action: 'add', notes: [{ file: name(a), match: 'function f20() {}', text: 'here' }, { file: name(b), line: 5, text: 'there' }] });
  const renamed = join(dir, 'renamed.ts');
  const buf = await lua('local path, renamed = ...; local buf = vim.fn.bufnr(path); vim.api.nvim_buf_set_lines(buf, 0, 0, true, { "x", "y" }); vim.api.nvim_buf_set_name(buf, renamed); return buf', a, renamed);
  assert.match(await annotate({ action: 'list' }), /^1\. renamed\.ts:22 `function f20\(\) \{\}`: here$/m);
  await annotate({ action: 'show', note: 2 });
  assert.equal(await annotate({ action: 'show', note: 1 }), 'Note 1 of 2: renamed.ts:22');
  const at = await lua('local win = ...; local buf = vim.api.nvim_win_get_buf(win); return { buf, vim.api.nvim_buf_get_lines(buf, vim.api.nvim_win_get_cursor(win)[1] - 1, vim.api.nvim_win_get_cursor(win)[1], true)[1] }', yours);
  assert.deepEqual(at, [buf, 'function f20() {}']);
  // Renamed again as it is entered, shown: said by that name.
  await annotate({ action: 'show', note: 2 });
  await lua(`local buf, name = ...
    vim.api.nvim_create_autocmd('BufEnter', { buffer = buf, once = true, callback = function() vim.api.nvim_buf_set_name(buf, name) end })`, buf, join(dir, 'entered.ts'));
  assert.equal(await annotate({ action: 'show', note: 1 }), 'Note 1 of 2: entered.ts:22');
});

test('a long line of code is cut short by whole characters, not halves of one', async () => {
  const { annotate } = await attached();
  const path = join(dir, 'unicode.ts');
  await writeFile(path, `// ${'a'.repeat(75)}🚀 tail\n`);
  const added = await annotate({ action: 'add', notes: [{ file: name(path), line: 1, text: 'long' }] });
  assert.ok(added.isWellFormed(), added);
  assert.match(added, new RegExp(`aaa🚀…\`: long$`));
});

test('a change Neovim made whose answer is lost, as when a call times out, is known for made', async () => {
  const { nvim, annotate, fire } = await attached();
  const path = await file();
  await layout(path);
  const between = async () => (await fire('turn_end', { toolResults: [{}], entries: [] }))
    .flatMap(result => (result as { entries?: { content: string }[] } | undefined)?.entries ?? []).map(entry => entry.content);
  await annotate({ action: 'add', notes: [10, 20].map(line => ({ file: name(path), line, text: `at ${line}` })) });
  // The next call of nvim-virtual-text's `fn` (see CALL) is made, and its answer lost.
  const lose = (fn: string) => {
    const real = nvim!.lua;
    nvim!.lua = (async (code: string, args?: unknown[]) => {
      const result = await real(code, args);
      if (args?.[0] !== fn) return result;
      nvim!.lua = real;
      throw new Error('Neovim did not answer within 150 ms; whatever was asked may still finish there');
    }) as Remote['lua'];
  };
  lose('update');
  await assert.rejects(annotate({ action: 'update', note: 1, text: 'updated' }), /did not answer/);
  lose('set');
  await assert.rejects(annotate({ action: 'add', notes: [{ file: name(path), line: 30, text: 'added' }] }), /did not answer/);
  assert.match(await annotate({ action: 'list' }), /^1\. .*: updated\n2\. .*: at 20\n3\. .*: added$/);
  lose('remove');
  await assert.rejects(annotate({ action: 'remove', note: 2 }), /did not answer/);
  assert.match(await annotate({ action: 'list' }), /^1\. .*: updated\n3\. .*: added$/);
  // Its own removal, which it knows of: nothing to tell it.
  assert.deepEqual(await between(), []);
  // Made, its answer lost, and the next read of the marks failing too: known for made all the same.
  lose('update');
  await assert.rejects(annotate({ action: 'update', note: 1, text: 'again' }), /did not answer/);
  const real = nvim!.lua;
  nvim!.lua = (async (code: string, args?: unknown[]) => {
    if (!code.includes('vt.list(group')) return real(code, args);
    nvim!.lua = real;
    throw new Error('Neovim did not answer within 150 ms; whatever was asked may still finish there');
  }) as Remote['lua'];
  await assert.rejects(annotate({ action: 'list' }), /did not answer/);
  assert.match(await annotate({ action: 'list' }), /^1\. .*: again\n3\. .*: added$/);
  // A clear made, its answer lost, then a replace: the replace's notes, added to after.
  lose('clear');
  await assert.rejects(annotate({ action: 'clear' }), /did not answer/);
  await annotate({ action: 'add', replace: true, notes: [40, 50].map(line => ({ file: name(path), line, text: `new ${line}` })) });
  assert.match(await annotate({ action: 'add', notes: [{ file: name(path), line: 60, text: 'after' }] }), /^Added note 3:/);
  assert.match(await annotate({ action: 'list' }), /^1\. .*: new 40\n2\. .*: new 50\n3\. .*: after$/);
});

test('a change Neovim makes only after the notes were read again is known for made once it is', async () => {
  const { nvim, annotate, fire } = await attached();
  const path = await file();
  await layout(path);
  const between = async () => (await fire('turn_end', { toolResults: [{}], entries: [] }))
    .flatMap(result => (result as { entries?: { content: string }[] } | undefined)?.entries ?? []).map(entry => entry.content);
  await annotate({ action: 'add', notes: [10, 20].map(line => ({ file: name(path), line, text: `at ${line}` })) });
  // The next call of nvim-virtual-text's `fn` (see CALL) gives up at once; Neovim runs it at `late()`.
  const delay = (fn: string) => {
    const real = nvim!.lua;
    let late!: () => Promise<unknown>;
    nvim!.lua = (async (code: string, args?: unknown[]) => {
      if (args?.[0] !== fn) return real(code, args);
      nvim!.lua = real;
      late = () => real(code, args);
      throw new Error('Neovim did not answer within 150 ms; whatever was asked may still finish there');
    }) as Remote['lua'];
    return () => late();
  };
  let late = delay('update');
  await assert.rejects(annotate({ action: 'update', note: 1, text: 'updated' }), /did not answer/);
  assert.match(await annotate({ action: 'list' }), /^1\. .*: at 10\n/);
  await late();
  assert.match(await annotate({ action: 'list' }), /^1\. .*: updated\n/);
  late = delay('remove');
  await assert.rejects(annotate({ action: 'remove', note: 2 }), /did not answer/);
  assert.deepEqual(await between(), []);
  await late();
  assert.match(await annotate({ action: 'list' }), /^1\. .*: updated$/);
  assert.deepEqual(await between(), []);
  // An older replace Neovim makes after a newer one: its notes are those there, added to after.
  late = delay('set');
  await assert.rejects(annotate({ action: 'add', replace: true, notes: [{ file: name(path), line: 30, text: 'older' }] }), /did not answer/);
  await annotate({ action: 'add', replace: true, notes: [40, 50].map(line => ({ file: name(path), line, text: `newer ${line}` })) });
  await late();
  assert.match(await annotate({ action: 'list' }), /^1\. .*: older$/);
  assert.match(await annotate({ action: 'add', notes: [{ file: name(path), line: 60, text: 'after' }] }), /^Added note 2:/);
  assert.match(await annotate({ action: 'list' }), /^1\. .*: older\n2\. .*: after$/);
  // So too an older clear: none there.
  late = delay('clear');
  await assert.rejects(annotate({ action: 'clear' }), /did not answer/);
  await annotate({ action: 'add', replace: true, notes: [{ file: name(path), line: 70, text: 'newest' }] });
  await late();
  assert.equal(await annotate({ action: 'list' }), 'No notes');
  assert.deepEqual(await between(), []);
  // Two answers lost, Neovim making the later first: made as it made them, the older last.
  await annotate({ action: 'add', notes: [{ file: name(path), line: 10, text: 'kept' }] });
  const older = delay('set');
  await assert.rejects(annotate({ action: 'add', replace: true, notes: [{ file: name(path), line: 80, text: 'older' }] }), /did not answer/);
  const newer = delay('clear');
  await assert.rejects(annotate({ action: 'clear' }), /did not answer/);
  await newer();
  await older();
  assert.match(await annotate({ action: 'list' }), /^1\. .*: older$/);
  assert.match(await annotate({ action: 'add', notes: [{ file: name(path), line: 90, text: 'after' }] }), /^Added note 2:/);
  // A replace Neovim makes as the notes are read: listed as it was, or as it is, not half of each.
  const replacing = delay('set');
  await assert.rejects(annotate({ action: 'add', replace: true, notes: [{ file: name(path), line: 30, text: 'replacing' }] }), /did not answer/);
  const real = nvim!.lua;
  nvim!.lua = (async (code: string, args?: unknown[]) => {
    if (!code.includes('vt.list(group')) return real(code, args);
    nvim!.lua = real;
    await replacing();
    return real(code, args);
  }) as Remote['lua'];
  assert.equal(await annotate({ action: 'list' }), `1. ${name(path)}:30 \`function f30() {}\`: replacing`);
  // An append Neovim makes after an update to a note it kept: that note as the append gave it.
  const appending = delay('set');
  await assert.rejects(annotate({ action: 'add', notes: [{ file: name(path), line: 40, text: 'appended' }] }), /did not answer/);
  await annotate({ action: 'update', note: 1, text: 'changed' });
  assert.match(await annotate({ action: 'list' }), /^1\. .*: changed$/);
  await appending();
  assert.match(await annotate({ action: 'list' }), /^1\. .*: replacing\n2\. .*: appended$/);
  // An update or removal Neovim makes after a replace: of the note now numbered as it was.
  const updating = delay('update');
  await assert.rejects(annotate({ action: 'update', note: 1, text: 'late' }), /did not answer/);
  await annotate({ action: 'add', replace: true, notes: [{ file: name(path), line: 50, text: 'replacement' }] });
  await updating();
  assert.match(await annotate({ action: 'list' }), /^1\. .*:50 .*: late$/);
  const removing = delay('remove');
  await assert.rejects(annotate({ action: 'remove', note: 1 }), /did not answer/);
  await annotate({ action: 'add', replace: true, notes: [{ file: name(path), line: 60, text: 'again' }] });
  await removing();
  assert.equal(await annotate({ action: 'list' }), 'No notes');
  assert.deepEqual(await between(), []);
  // One Neovim makes after a clear: the note numbered as it was since is another, left as it is.
  await annotate({ action: 'add', replace: true, notes: [{ file: name(path), line: 70, text: 'cleared' }] });
  const removingCleared = delay('remove');
  await assert.rejects(annotate({ action: 'remove', note: 1 }), /did not answer/);
  await annotate({ action: 'clear' });
  await annotate({ action: 'add', notes: [{ file: name(path), line: 80, text: 'reborn' }] });
  await removingCleared();
  assert.match(await annotate({ action: 'list' }), /^1\. .*:80 .*: reborn$/);
  // So too that note itself, put back by an add Neovim makes after the clear.
  const removingRestored = delay('remove');
  await assert.rejects(annotate({ action: 'remove', note: 1 }), /did not answer/);
  const restoring = delay('set');
  await assert.rejects(annotate({ action: 'add', notes: [{ file: name(path), line: 90, text: 'restoring' }] }), /did not answer/);
  await annotate({ action: 'clear' });
  await restoring();
  assert.match(await annotate({ action: 'list' }), /^1\. .*: reborn\n2\. .*: restoring$/);
  await removingRestored();
  assert.match(await annotate({ action: 'list' }), /^1\. .*: reborn\n2\. .*: restoring$/);
  // One Neovim makes during another, before its writes, as an autocommand it sets off may: the
  // notes as Neovim then has them, numbered on from them.
  let nested!: [string, unknown[]];
  nvim!.lua = (async (code: string, args?: unknown[]) => {
    if (args?.[0] !== 'update') return real(code, args);
    nested = [code, args];
    throw new Error('Neovim did not answer within 150 ms; whatever was asked may still finish there');
  }) as Remote['lua'];
  await assert.rejects(annotate({ action: 'update', note: 1, text: 'nested' }), /did not answer/);
  nvim!.lua = (async (code: string, args?: unknown[]) => {
    if (args?.[0] !== 'set') return real(code, args);
    nvim!.lua = real;
    return real(`local function during(...) ${nested[0]} end
local function call(...) ${code} end
local nested, args = ...
local vt = remote.nvim_virtual_text
local set = vt.set
vt.set = function(...)
  vt.set = set
  during(unpack(nested))
  return set(...)
end
return call(unpack(args))`, [nested[1], args]);
  }) as Remote['lua'];
  await annotate({ action: 'add', replace: true, notes: [{ file: name(path), match: 'function f30() {}\nline 31', text: 'over' }] });
  assert.match(await annotate({ action: 'list' }), /^1\. .*:30-31 .*: over$/);
  // Its anchor as given too, its lines all kept by the next add.
  assert.match(await annotate({ action: 'add', notes: [{ file: name(path), line: 40, text: 'next' }] }), /^Added note 2:/);
  assert.match(await annotate({ action: 'list' }), /^1\. .*:30-31 .*: over\n2\. /);
});

test('a replace refused leaves the notes as they were, though its notes have their texts', async () => {
  const { annotate } = await attached();
  const path = await file();
  await layout(path);
  await annotate({ action: 'add', notes: [10, 20].map(line => ({ file: name(path), line, text: `at ${line}` })) });
  const listed = await annotate({ action: 'list' });
  await assert.rejects(annotate({ action: 'add', replace: true, notes: [
    { file: name(path), line: 30, text: 'at 10', kind: 'error' },
    { file: 'missing.ts', line: 1, text: 'at 20' },
  ] }), /cannot be placed/);
  assert.equal(await annotate({ action: 'list' }), listed);
  assert.match(await annotate({ action: 'add', notes: [{ file: name(path), line: 40, text: 'more' }] }), /^Added note 3:/);
  // Replaced, numbered from 1 again: the next after it.
  await annotate({ action: 'add', replace: true, notes: [{ file: name(path), line: 50, text: 'anew' }] });
  assert.match(await annotate({ action: 'add', notes: [{ file: name(path), line: 60, text: 'after' }] }), /^Added note 2:/);
});

test('a note added while a step is reading the notes is kept', async () => {
  const { nvim, annotate } = await attached();
  const path = await file();
  await layout(path);
  await annotate({ action: 'add', notes: [{ file: name(path), line: 20, text: 'one' }] });
  const { held, release } = hold(nvim!, code => code.includes('vt.list(group'));
  await editor.request('nvim_command', ['PiNotes next']);
  await held;
  const adding = annotate({ action: 'add', notes: [{ file: name(path), line: 40, text: 'two' }] });
  await delay(50);
  release();
  assert.match(await adding, /^Added note 2:/);
  assert.equal(await annotate({ action: 'list' }), `1. ${name(path)}:20 \`function f20() {}\`: one\n2. ${name(path)}:40 \`function f40() {}\`: two`);
});

for (const reset of ['replace', 'clear'] as const) {
  test(`notes ${reset === 'replace' ? 'replaced' : 'cleared'} while a step is under way start their walkthrough again`, async () => {
    const { nvim, annotate } = await attached();
    const path = await file();
    const [yours] = await layout(path);
    await annotate({ action: 'add', notes: [20, 40, 60].map(line => ({ file: name(path), line, text: `at ${line}` })) });
    const { held, release } = hold(nvim!, code => code.includes('local vt, pt, group, key, spec'));
    await editor.request('nvim_command', ['PiNotes 3']);
    await held;
    const notes = [10, 30].map(line => ({ file: name(path), line, text: `new ${line}` }));
    const resetting = reset === 'replace' ? annotate({ action: 'add', replace: true, notes })
      : annotate({ action: 'clear' }).then(() => annotate({ action: 'add', notes }));
    await delay(50);
    release();
    await resetting;
    await eventually(async () => (await cursor(yours))[0] === 60);
    await editor.request('nvim_command', ['PiNotes next']);
    await eventually(async () => (await cursor(yours))[0] === 10);
  });
}

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

test(':PiNotes says how it went, cut to fit where messages go', async () => {
  const { annotate } = await attached();
  const path = await file();
  await layout(path);
  await annotate({ action: 'add', notes: [{ file: name(path), line: 10, text: 'a' }] });
  const said = () => lua('return vim.api.nvim_exec2("messages", { output = true }).output') as Promise<string>;
  await lua('vim.cmd("messages clear")');
  await editor.request('nvim_command', ['PiNotes 9']);
  await eventually(async () => (await said()).includes('No note 9'));
  await editor.request('nvim_command', ['PiNotes 1']);
  await eventually(async () => (await said()).includes(`Note 1 of 1: ${name(path)}:10`));
  // Too long for a narrow editor: cut, so that it never stops the editor at "Press ENTER".
  await lua('vim.o.columns = 20');
  try {
    await editor.request('nvim_command', ['PiNotes wat']);
    await eventually(async () => (await said()).split('\n').some(line => line.endsWith('…')));
    assert.equal((await editor.request('nvim_get_mode', []) as { blocking: boolean }).blocking, false);
  } finally { await lua('vim.o.columns = 80'); }
});

for (const action of ['add', 'update'] as const) {
  test(`${action} says a note is gone when a reload took its code as it was ${action === 'add' ? 'added' : 'updated'}`, async () => {
    const { nvim, annotate } = await attached();
    const path = await file();
    await layout(path);
    if (action === 'update') await annotate({ action: 'add', notes: [{ file: name(path), match: 'function f30', text: 'one' }] });
    const { held, release } = hold(nvim!, (_code, args) => args[0] === (action === 'add' ? 'set' : 'update'));
    const doing = action === 'add'
      ? annotate({ action: 'add', notes: [{ file: name(path), match: 'function f30', text: 'one' }] })
      : annotate({ action: 'update', note: 1, text: 'changed' });
    await held;
    await writeFile(path, 'nothing of it\n');
    await lua('vim.api.nvim_buf_call(vim.fn.bufnr(...), function() vim.cmd("edit!") end)', path);
    release();
    assert.equal(await doing, action === 'add'
      ? 'Added note 1:\n1. gone from the editor: its code deleted, or its buffer wiped'
      : 'Note 1 is gone from the editor: its code deleted, or its buffer wiped');
  });
}

test('note numbers are numbers and ranges, either way round, by spaces or commas, in any order', () => {
  assert.deepEqual(ranges('2 5-7,10'), [[2, 2], [5, 7], [10, 10]]);
  assert.deepEqual(ranges('9-4, 1'), [[4, 9], [1, 1]]);
  assert.deepEqual(ranges(' 3 - 5 '), [[3, 5]]);
  for (const bad of ['', ' ', 'x', '0', '2-', '-3', '1-2-3', '2 x', '1.5']) assert.equal(ranges(bad), undefined, bad);
});

test('/nvim-annotate-remove and :PiNotesRemove remove notes by numbers and ranges, mixed, in any order', async () => {
  const { nvim, annotate, commands, ctx, notes } = await attached();
  const remove = async (args: string) => { await commands['nvim-annotate-remove'].handler(args, ctx); return notes.at(-1)!; };
  const path = await file();
  await layout(path);
  await annotate({ action: 'add', notes: Array.from({ length: 8 }, (_, i) => ({ file: name(path), line: 10 + i * 10, text: `n${i + 1}` })) });
  assert.deepEqual(await remove('7-5 2,8 12 20-30'), ['Removed notes 2, 5, 6, 7, 8; no notes 12, 20-30; the others keep their numbers', 'info']);
  assert.deepEqual((await drawn(nvim!, path)).map(([, text]) => text), ['1. n1', '3. n3', '4. n4']);
  assert.deepEqual(await remove('2 x'), ['Usage: /nvim-annotate-remove [numbers and ranges, as 2 5-7,10; none for all]', 'warning']);
  assert.deepEqual(await remove('9'), ['No note 9', 'info']);
  const said = () => lua('return vim.api.nvim_exec2("messages", { output = true }).output') as Promise<string>;
  await lua('vim.cmd("messages clear")');
  await editor.request('nvim_command', ['PiNotesRemove 4, 1']);
  await eventually(async () => (await said()).includes('Removed notes 1, 4'));
  assert.deepEqual((await drawn(nvim!, path)).map(([, text]) => text), ['3. n3']);
  await editor.request('nvim_command', ['PiNotesRemove x']);
  await eventually(async () => (await said()).includes('Usage: :PiNotesRemove'));
  assert.deepEqual(await remove('1-1000000'), ['Removed note 3', 'info']);
  // With none: all of them, as clear.
  await annotate({ action: 'add', notes: [{ file: name(path), line: 5, text: 'a' }, { file: name(path), line: 6, text: 'b' }] });
  assert.deepEqual(await remove('  '), ['Removed 2 notes', 'info']);
  assert.deepEqual(await drawn(nvim!, path), []);
  await annotate({ action: 'add', notes: [{ file: name(path), line: 5, text: 'c' }] });
  await lua('vim.cmd("messages clear")');
  await editor.request('nvim_command', ['PiNotesRemove']);
  await eventually(async () => (await said()).includes('Removed 1 note'));
  assert.deepEqual(await drawn(nvim!, path), []);
});

test('changes the agent has not been told outlast its own calls on other notes, unless it replaces them all', async () => {
  const { annotate, commands, ctx, fire } = await attached();
  const path = await file();
  await layout(path);
  const between = async () => (await fire('turn_end', { toolResults: [{}], entries: [] }))
    .flatMap(result => (result as { entries?: { content: string }[] } | undefined)?.entries ?? []).map(entry => entry.content);
  await annotate({ action: 'add', notes: [10, 20, 30].map(line => ({ file: name(path), line, text: `at ${line}` })) });
  await commands['nvim-annotate-remove'].handler('1', ctx);
  await annotate({ action: 'update', note: 2, text: 'changed' });
  await annotate({ action: 'show', note: 3 });
  assert.deepEqual(await between(), [`Pi's notes in the editor changed: the user removed note 1 (${name(path)}). Notes now: 2, 3.`]);
  await commands['nvim-annotate-remove'].handler('2', ctx);
  await annotate({ action: 'add', replace: true, notes: [{ file: name(path), line: 40, text: 'anew' }] });
  assert.deepEqual(await between(), []);
});

test('a removal by the user while an agent call runs is told; the agent\'s own removals never are', async () => {
  const { annotate, commands, ctx, fire } = await attached();
  const path = await file();
  await layout(path);
  const between = async () => (await fire('turn_end', { toolResults: [{}], entries: [] }))
    .flatMap(result => (result as { entries?: { content: string }[] } | undefined)?.entries ?? []).map(entry => entry.content);
  const add = (lines: number[], replace = false) =>
    annotate({ action: 'add', replace, notes: lines.map(line => ({ file: name(path), line, text: `at ${line}` })) });
  await add([10, 20, 30]);
  for (const action of ['update', 'show']) {
    const calling = annotate(action === 'update' ? { action, note: 3, text: 'changed' } : { action, note: 3 });
    const removing = commands['nvim-annotate-remove'].handler(action === 'update' ? '1' : '2', ctx);
    await Promise.all([calling, removing]);
  }
  assert.deepEqual(await between(), [`Pi's notes in the editor changed: the user removed notes 1 (${name(path)}), 2 (${name(path)}). Notes now: 3.`]);
  await add([40, 50]);
  await annotate({ action: 'remove', note: 4 });
  await annotate({ action: 'clear' });
  await add([60, 70]);
  await add([80], true);
  assert.deepEqual(await between(), []);
});

test('the tool says what it did as it did it: a note the user removes after is told as theirs, not as gone', async () => {
  const { annotate, commands, ctx, fire } = await attached();
  const path = await file();
  await layout(path);
  await annotate({ action: 'add', notes: [10, 20, 30].map(line => ({ file: name(path), line, text: `at ${line}` })) });
  const adding = annotate({ action: 'add', notes: [{ file: name(path), line: 40, text: 'new' }] });
  await commands['nvim-annotate-remove'].handler('4', ctx);
  assert.equal(await adding, `Added note 4:\n4. ${name(path)}:40 \`function f40() {}\`: new`);
  const updating = annotate({ action: 'update', note: 2, text: 'changed' });
  await commands['nvim-annotate-remove'].handler('2', ctx);
  assert.equal(await updating, `Updated:\n2. ${name(path)}:20 \`function f20() {}\`: changed`);
  const told = (await fire('turn_end', { toolResults: [{}], entries: [] }))
    .flatMap(result => (result as { entries?: { content: string }[] } | undefined)?.entries ?? []).map(entry => entry.content);
  assert.deepEqual(told, [`Pi's notes in the editor changed: the user removed notes 4 (${name(path)}), 2 (${name(path)}). Notes now: 1, 3.`]);
});

test('removing by numbers is one step: a replace that comes in meanwhile is removed whole or kept whole', async () => {
  const { nvim, annotate, commands, ctx } = await attached();
  const path = await file();
  await layout(path);
  await annotate({ action: 'add', notes: [10, 20, 30].map(line => ({ file: name(path), line, text: `old ${line}` })) });
  const removing = commands['nvim-annotate-remove'].handler('1-10', ctx);
  const replacing = annotate({ action: 'add', replace: true, notes: [50, 60, 70, 80, 90].map(line => ({ file: name(path), line, text: `new ${line}` })) });
  await Promise.all([removing, replacing]);
  assert.ok([0, 5].includes((await drawn(nvim!, path)).length));
});

test('the agent is told how its notes changed in the editor, once, before it next thinks', async () => {
  const { annotate, commands, ctx, fire } = await attached();
  const path = await file();
  await layout(path);
  // Its message, if any: at a run's start, and after a turn with tool calls.
  const told = async () => (await fire('before_agent_start', { messageType: 'user', prompt: 'go on' }))
    .map(result => (result as { message?: { content: string } } | undefined)?.message?.content).find(Boolean);
  const between = async () => (await fire('turn_end', { toolResults: [{}], entries: [] }))
    .flatMap(result => (result as { entries?: { content: string }[] } | undefined)?.entries ?? []).map(entry => entry.content);
  await annotate({ action: 'add', notes: [10, 20, 30, 40].map(line => ({ file: name(path), match: `function f${line}`, text: `at ${line}` })) });
  assert.equal(await told(), undefined, 'nothing changed since the agent added them');
  await commands['nvim-annotate-remove'].handler('2', ctx);
  await lua('vim.api.nvim_buf_set_lines(vim.fn.bufnr(...), 29, 30, true, {})', path); // Note 3's code.
  assert.equal(await told(), `Pi's notes in the editor changed: the user removed note 2 (${name(path)}); note 3 (${name(path)}) is hidden, its lines deleted (back if that is undone). Notes now: 1, 3 (hidden), 4.`);
  assert.equal(await told(), undefined, 'told once');
  // While it works: reloaded from disk, where note 4's code is gone and note 3's never was.
  await writeFile(path, (await readFile(path)).toString().replace('function f40() {}', 'x'));
  await lua('vim.api.nvim_buf_call(vim.fn.bufnr(...), function() vim.cmd("edit!") end)', path);
  assert.deepEqual(await between(), [`Pi's notes in the editor changed: note 4 (${name(path)}) is gone from the editor, removed by neither the user nor Pi; note 3 (${name(path)}) is back, its lines restored. Notes now: 1, 3.`]);
  // A buffer wiped and opened again, its code all there: its notes are gone, but not their code.
  await annotate({ action: 'add', notes: [{ file: name(path), match: 'function f20', text: 'wiped' }] });
  await between();
  await lua('local path = ...; vim.cmd("enew"); vim.cmd("bwipeout! " .. vim.fn.bufnr(path)); vim.cmd.edit(vim.fn.fnameescape(path))', path);
  assert.deepEqual(await between(), [`Pi's notes in the editor changed: notes 1 (${name(path)}), 3 (${name(path)}), 5 (${name(path)}) are gone from the editor, removed by neither the user nor Pi. Notes now: none.`]);
  await annotate({ action: 'add', notes: [{ file: name(path), match: 'function f20', text: 'again' }] });
  // Its own changes it knows already; the user clearing it is told.
  await annotate({ action: 'remove', note: 1 });
  assert.deepEqual(await between(), []);
  await commands['nvim-annotate-remove'].handler('', ctx);
  assert.equal(await told(), `Pi's notes in the editor changed: the user removed note 6 (${name(path)}). Notes now: none.`);
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

test('a change found as Pi detaches is not told: it is of notes no longer there', async () => {
  const p = await pi();
  const path = await file();
  await layout(path);
  await p.annotate({ action: 'add', notes: [10, 20, 30].map(line => ({ file: name(path), line, text: `at ${line}` })) });
  await p.commands['nvim-annotate-remove'].handler('1', p.ctx);
  // Its last read done, held while Pi detaches.
  const real = p.nvim!.lua.bind(p.nvim!);
  let reached!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { reached = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  p.nvim!.lua = (async (code: string, args?: unknown[]) => {
    const result = await real(code, args);
    if (code.includes('nvim_buf_get_lines')) { reached(); await held; }
    return result;
  }) as Remote["lua"];
  const told = p.fire('before_agent_start', { messageType: 'user', prompt: 'go on' });
  await reading;
  await p.shutdown();
  release();
  assert.deepEqual((await told).filter(Boolean), []);
});

test('a Pi detaching leaves :PiNotes and :PiNotesRemove to another attached since, which has them as its own', async () => {
  const first = await pi();
  running.add(first);
  const path = await file();
  const [yours] = await layout(path);
  await first.annotate({ action: 'add', notes: [{ file: name(path), line: 20, text: 'first' }] });
  const second = await attached();
  await second.annotate({ action: 'add', notes: [{ file: name(path), line: 70, text: 'second' }] });
  await first.shutdown();
  running.delete(first);
  assert.equal(await lua('return vim.fn.exists(":PiNotes") + vim.fn.exists(":PiNotesRemove")'), 4);
  await editor.request('nvim_command', ['PiNotes 1']);
  await eventually(async () => (await cursor(yours))[0] === 70);
  await second.shutdown();
  running.delete(second);
  await eventually(async () => await lua('return vim.fn.exists(":PiNotes") + vim.fn.exists(":PiNotesRemove")') === 0);
});

test('once Pi detaches, its notes and :PiNotes go; without Neovim the tool and command say so', async () => {
  const p = await pi();
  const path = await file();
  await layout(path);
  await p.annotate({ action: 'add', notes: [{ file: name(path), line: 5, text: 'a' }] });
  assert.equal(await lua('return vim.fn.exists(":PiNotes")'), 2);
  assert.equal(await lua('return vim.fn.exists(":PiNotesRemove")'), 2);
  await p.shutdown();
  await eventually(async () => await lua('return vim.fn.exists(":PiNotes")') === 0);
  assert.equal(await lua('return vim.fn.exists(":PiNotesRemove")'), 0);
  assert.deepEqual(await drawn(p.nvim!, path), []);
  const detached = await pi({ remote: false });
  await assert.rejects(detached.annotate({ action: 'list' }), /Pi is not attached to Neovim/);
  assert.deepEqual(await detached.run(''), ['Pi is not attached to Neovim', 'warning']);
});
