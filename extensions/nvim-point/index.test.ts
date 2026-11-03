import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { launch } from '../nvim-service/service.mjs';
import { connect } from '../nvim-remote/remote.ts';
import registerRemote from '../nvim-remote/index.ts';
import registerPoint, { completePath, completePoint, parsePoint } from './index.ts';

const service = launch({ cwd: '/tmp', init: 'NONE', graceMs: 100, killMs: 300 });
const { socket } = await service.ready;
after(() => service.stop());
const editor = await connect(socket); // The user.
after(() => editor.close());
const lua = (code: string, ...args: unknown[]): Promise<any> => editor.request('nvim_exec_lua', [code, args]);
const dir = await realpath(await mkdtemp(join(tmpdir(), 'nvim-point-')));
after(() => rm(dir, { recursive: true, force: true }));

type Command = {
  description: string;
  handler(args: string, ctx: object): Promise<void>;
  getArgumentCompletions(prefix: string): Promise<{ value: string; label: string }[] | null>;
};

/** Pi with nvim-remote (unless `!remote`) and nvim-point loaded, its session started. */
async function pi({ remote = true } = {}) {
  process.env.NVIM = socket;
  delete process.env.PI_NVIM_REMOTE;
  const bus = new EventEmitter(), hooks = new EventEmitter();
  const commands: Record<string, Command> = {};
  const notes: [string, string | undefined][] = [];
  const api = {
    events: { on: (channel: string, handler: (data: unknown) => void) => bus.on(channel, handler), emit: (channel: string, data: unknown) => bus.emit(channel, data) },
    on: (event: string, handler: () => void) => hooks.on(event, handler),
    registerCommand: (name: string, command: Command) => { commands[name] = command; },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: dir, hasUI: true, ui: { setStatus() {}, notify: (text: string, type?: string) => notes.push([text, type]) } };
  const fire = (event: string) => Promise.all(hooks.listeners(event).map(handler => handler({}, ctx)));
  const ready = new Promise(resolve => bus.once('nvim-remote:ready', resolve));
  if (remote) registerRemote(api);
  registerPoint(api);
  await fire('session_start');
  if (remote) await ready;
  const run = async (args: string) => { await commands['nvim-point'].handler(args, ctx); return notes.at(-1)!; };
  return { run, commands, shutdown: () => fire('session_shutdown') };
}

const running = new Set<{ shutdown(): Promise<unknown> }>();
afterEach(async () => {
  for (const p of running) await p.shutdown();
  running.clear();
  await editor.request('nvim_input', ['<Esc>']);
  await lua('vim.cmd("silent! tabonly | silent! only | enew! | silent! %bwipeout!")');
});
/** Pi attached to the test's Neovim, shut down after the test. */
async function attached() {
  const p = await pi();
  running.add(p);
  return p;
}

/** A file of 300 numbered lines, each indented by two spaces. */
async function file(name: string) {
  const path = join(dir, name);
  await writeFile(path, Array.from({ length: 300 }, (_, i) => `  line ${i + 1}`).join('\n') + '\n');
  return path;
}

/** Your file on the left, a terminal beside it focused: your window. */
const layout = (path: string): Promise<number> => lua(`vim.cmd.edit(vim.fn.fnameescape(...))
  local yours = vim.api.nvim_get_current_win()
  vim.cmd('rightbelow vsplit | terminal')
  return yours`, path);
const cursor = (win: number): Promise<[number, number]> => lua('return vim.api.nvim_win_get_cursor(...)', win);
const nameIn = (win: number): Promise<string> => lua('return vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(...))', win);
const USAGE = ['Usage: /nvim-point <path>:<line>[-<end line>][:<column>] [option=value …]', 'warning'];

test('there is one command; without Neovim it says so, and what is wrong with the usage first', async () => {
  const p = await pi({ remote: false });
  assert.deepEqual(Object.keys(p.commands), ['nvim-point']);
  assert.match(p.commands['nvim-point'].description, /<path>:<line>/);
  assert.deepEqual(await p.run('a.ts:1'), ['Pi is not attached to Neovim', 'warning']);
  assert.deepEqual(await p.run(''), USAGE);
});

test('path:line shows the line, the cursor on its first non-blank', async () => {
  const { run } = await attached();
  const yours = await layout(await file('mine.ts'));
  const path = await file('there.ts');
  assert.deepEqual(await run('there.ts:150'), [`Showed there.ts:150 in window ${yours} (scrolled)`, 'info']);
  assert.deepEqual([await nameIn(yours), await cursor(yours)], [path, [150, 2]]);
});

test('path:line-end shows the lines; path:line:column puts the cursor at the column, from 1', async () => {
  const { run } = await attached();
  const yours = await layout(await file('mine.ts'));
  await file('there.ts');
  assert.deepEqual(await run('there.ts:120-125'), [`Showed there.ts:120-125 in window ${yours} (scrolled)`, 'info']);
  assert.deepEqual(await cursor(yours), [120, 2]);
  assert.deepEqual(await run('there.ts:122:5'), [`Showed there.ts:122 in window ${yours}`, 'info']);
  assert.deepEqual(await cursor(yours), [122, 4]);
  assert.deepEqual(await run('there.ts:121-124:1'), [`Showed there.ts:121-124 in window ${yours}`, 'info']);
  assert.deepEqual(await cursor(yours), [121, 0]);
});

test('paths are from Pi\'s working directory, or absolute; spaces around them are ignored', async () => {
  const { run } = await attached();
  const yours = await layout(await file('mine.ts'));
  const path = await file('there.ts');
  assert.deepEqual(await run(`  ${path}:10  `), [`Showed there.ts:10 in window ${yours}`, 'info']);
  assert.equal(await nameIn(yours), path);
  // Outside the working directory, it is named as it is.
  const outside = join(await realpath(await mkdtemp(join(tmpdir(), 'nvim-point-outside-'))), 'far.ts');
  await writeFile(outside, 'far\n');
  try {
    assert.deepEqual(await run(`${outside}:1`), [`Showed ${outside}:1 in window ${yours}`, 'info']);
  } finally { await rm(outside, { force: true }); }
});

test('a path with a colon or spaces in it is found: the line is what follows its last colon', async () => {
  const { run } = await attached();
  const yours = await layout(await file('mine.ts'));
  const path = await file('a:b c.ts');
  assert.deepEqual(await run('a:b c.ts:7'), [`Showed a:b c.ts:7 in window ${yours}`, 'info']);
  assert.equal(await nameIn(yours), path);
});

test('opening a window for it, it says so', async () => {
  const { run } = await attached();
  await lua('vim.cmd("terminal")');
  await file('there.ts');
  const [text, type] = await run('there.ts:200');
  assert.match(text, /^Showed there\.ts:200 in window \d+ \(opened a window, scrolled\)$/);
  assert.equal(type, 'info');
});

test('while you are typing in Neovim, it says not now', async () => {
  const { run } = await attached();
  await lua('vim.cmd.edit(vim.fn.fnameescape(...))', await file('mine.ts'));
  await file('there.ts');
  await editor.request('nvim_input', ['i']);
  assert.deepEqual(await run('there.ts:10'), ['Not now: you are busy in Neovim (mode i)', 'warning']);
});

test('what is not a line of a file says why', async () => {
  const { run } = await attached();
  await layout(await file('mine.ts'));
  await file('there.ts');
  for (const args of ['', 'there.ts', 'there.ts:', 'there.ts:x', 'there.ts:-3', 'there.ts:3-', 'there.ts:3:', ':3']) {
    assert.deepEqual(await run(args), USAGE, JSON.stringify(args));
  }
  assert.deepEqual(await run('there.ts:0'), ['line must be a whole number from 1: 0', 'warning']);
  assert.deepEqual(await run('there.ts:5-4'), ['endLine must be a whole number from line: 4', 'warning']);
  assert.deepEqual(await run('there.ts:5:0'), ['Columns count from 1: 0', 'warning']);
  assert.deepEqual(await run('there.ts:301'), [`line 301 is past the end of ${join(dir, 'there.ts')}, at 300`, 'warning']);
  assert.deepEqual(await run('missing.ts:1'), [`no such file: ${join(dir, 'missing.ts')}`, 'warning']);
  assert.deepEqual(await run('12'), ['A place needs a path or a buf', 'warning']);
});

test('paths complete as you type: directories go on with "/", files take ":" for their line', async () => {
  const p = await attached();
  const complete = (prefix: string) => p.commands['nvim-point'].getArgumentCompletions(prefix);
  await mkdir(join(dir, 'src', 'deep'), { recursive: true });
  for (const name of ['src/app.ts', 'src/api.ts', 'src/.hidden.ts', 'src/deep/x.ts', 'readme.md']) await writeFile(join(dir, name), 'x\n');
  const values = async (prefix: string) => (await complete(prefix))?.map(item => item.value) ?? null;
  assert.deepEqual(await values('sr'), ['src/']);
  assert.deepEqual(await values('src/'), ['src/deep/', 'src/api.ts:', 'src/app.ts:']); // Directories first.
  assert.deepEqual(await values('src/ap'), ['src/api.ts:', 'src/app.ts:']);
  assert.deepEqual((await complete('src/ap'))!.map(item => item.label), ['api.ts', 'app.ts']);
  assert.deepEqual(await values('src/.'), ['src/.hidden.ts:']); // Hidden once a "." is typed.
  assert.deepEqual(await values(`${dir}/rea`), [`${dir}/readme.md:`]);
  assert.deepEqual(await values('  src/deep/'), ['src/deep/x.ts:']);
  for (const prefix of ['src/app.ts:', 'src/app.ts:12', 'src/app.ts:12-', 'src/app.ts:12-14:3', 'nothing/', 'zzz']) {
    assert.equal(await values(prefix), null, prefix);
  }
});

test('options after the place are as show takes them: scroll, jump, open, focus, context, wait', async () => {
  const { run } = await attached();
  const yours = await layout(await file('mine.ts'));
  const path = await file('there.ts');
  assert.deepEqual(await run('there.ts:200 scroll=top context=5'), [`Showed there.ts:200 in window ${yours} (scrolled)`, 'info']);
  assert.equal(await lua('return vim.api.nvim_win_call(..., function() return vim.fn.line("w0") end)', yours), 195);
  // Not open in a window of the tab, with open=false.
  await file('closed.ts');
  assert.deepEqual(await run('closed.ts:3 open=false'), ['Not open in Neovim: closed.ts:3', 'warning']);
  // Focus, and no jump.
  const jumps = () => lua('return #vim.fn.getjumplist(...)[1]', yours);
  const before = await jumps();
  assert.deepEqual(await run('there.ts:20 jump=false focus=true'), [`Showed there.ts:20 in window ${yours} (scrolled)`, 'info']);
  assert.deepEqual([await jumps(), await lua('return vim.api.nvim_get_current_win()'), await nameIn(yours)], [before, yours, path]);
});

test('match="…" finds code, a line given the nearest; a path alone will do with it', async () => {
  const { run } = await attached();
  const yours = await layout(await file('mine.ts'));
  await file('there.ts');
  assert.deepEqual(await run('there.ts match="line 250"'), [`Showed there.ts at "line 250" in window ${yours} (scrolled)`, 'info']);
  assert.deepEqual(await cursor(yours), [250, 2]);
  assert.deepEqual(await run('there.ts:100 match=line'), [`Showed there.ts:100 at "line" in window ${yours} (scrolled)`, 'info']);
  assert.deepEqual(await cursor(yours), [100, 2]);
});

test('buf=N stands for the path: lines alone, or a match alone', async () => {
  const { run } = await attached();
  const yours = await layout(await file('mine.ts'));
  const buf = await lua('return vim.api.nvim_win_get_buf(...)', yours);
  assert.deepEqual(await run(`120-122 buf=${buf}`), [`Showed buffer ${buf}:120-122 in window ${yours} (scrolled)`, 'info']);
  assert.deepEqual(await cursor(yours), [120, 2]);
  assert.deepEqual(await run(`buf=${buf} match="line 30"`), [`Showed buffer ${buf} at "line 30" in window ${yours} (scrolled)`, 'info']);
  assert.deepEqual(await cursor(yours), [30, 2]);
});

test('what is wrong with the options says what', async () => {
  const { run } = await attached();
  await layout(await file('mine.ts'));
  await file('there.ts');
  assert.deepEqual(await run('there.ts:1 scrol=top'), ['No option scrol: match, buf, context, scroll, jump, open, focus, wait', 'warning']);
  assert.deepEqual(await run('there.ts:1 scroll=middle'), ['scroll=middle is not a value scroll takes: center, top or minimal', 'warning']);
  assert.deepEqual(await run('there.ts:1 focus=yes'), ['focus=yes is not a value focus takes: true: focus the window', 'warning']);
  assert.deepEqual(await run('there.ts:1 wait=soon'), ['wait=soon is not a value wait takes: Milliseconds to wait while you are busy, or Infinity', 'warning']);
  assert.deepEqual(await run('there.ts:1 match='), ['match= is not a value match takes: Code to find instead of a line; the line given, the nearest', 'warning']);
  assert.deepEqual(await run('there.ts:1 focus=true stray'), USAGE);
  assert.deepEqual(await run('there.ts match="nowhere"'), [`not found in ${join(dir, 'there.ts')}: nowhere`, 'warning']);
  assert.deepEqual(await run('there.ts:3 buf=1'), ['A place needs a path or a buf, not both', 'warning']);
});

test('after the place, option names complete, and the values some take', async () => {
  const p = await attached();
  const complete = async (prefix: string) => (await p.commands['nvim-point'].getArgumentCompletions(prefix))?.map(item => item.value) ?? null;
  assert.deepEqual(await complete('a.ts:3 sc'), ['a.ts:3 scroll=']);
  assert.deepEqual(await complete('a.ts:3 scroll=m'), ['a.ts:3 scroll=minimal ']);
  assert.deepEqual(await complete('a.ts:3 focus='), ['a.ts:3 focus=true ', 'a.ts:3 focus=false ']);
  // Those given already are not offered again.
  assert.equal((await complete('a.ts:3 scroll=top '))!.includes('a.ts:3 scroll=top scroll='), false);
  assert.equal((await complete('a.ts:3 '))!.length, 8);
  assert.equal(await complete('a.ts:3 wait='), null); // A number: nothing to offer.
  // Within a quoted value, nothing; one closed is passed over, what it says aside.
  assert.equal(await complete('a.ts:3 match="foo sc'), null);
  assert.equal(await complete('a.ts:3 match="a\\" sc'), null);
  assert.deepEqual(await complete('a.ts:3 match="x scroll=" sc'), ['a.ts:3 match="x scroll=" scroll=']);
  // Given first, before any place, an option is given all the same.
  assert.equal((await complete('buf=2 '))!.some(value => value.endsWith('buf=')), false);
  assert.equal((await complete('  match="x" '))!.some(value => value.endsWith('match=')), false);
});

test('a quoted value takes JSON escapes; one never closed says what is wrong with it', async () => {
  const { run } = await attached();
  const yours = await layout(await file('mine.ts'));
  await writeFile(join(dir, 'quotes.ts'), 'a\nsay("hi", \'x\') = 1\n');
  assert.deepEqual(await run('quotes.ts match="say(\\"hi\\", \'x\') = 1"'), [`Showed quotes.ts at "say(\\"hi\\", 'x') = 1" in window ${yours}`, 'info']);
  assert.deepEqual(await cursor(yours), [2, 0]);
  assert.deepEqual(await run('quotes.ts match="say(\\"hi'), ['match="say(\\"hi is not a value match takes: Code to find instead of a line; the line given, the nearest', 'warning']);
});

test('wait= while you are busy: shown once you are free, or not now', async () => {
  const { run } = await attached();
  const mine = await file('mine.ts');
  const yours = await lua('vim.cmd.edit(vim.fn.fnameescape(...)) return vim.api.nvim_get_current_win()', mine);
  await file('there.ts');
  await editor.request('nvim_input', ['i']);
  assert.deepEqual(await run('there.ts:10 wait=200'), ['Not now: you are busy in Neovim (mode i)', 'warning']);
  const pending = run('there.ts:20 wait=5000');
  await new Promise(resolve => setTimeout(resolve, 150));
  await editor.request('nvim_input', ['<Esc>']);
  assert.deepEqual(await pending, [`Showed there.ts:20 in window ${yours}`, 'info']); // On screen as it opens.
});

test('an option given twice: the last says', async () => {
  const { run } = await attached();
  const yours = await layout(await file('mine.ts'));
  await file('there.ts');
  await run('there.ts:200 scroll=center scroll=top');
  assert.equal(await lua('return vim.api.nvim_win_call(..., function() return vim.fn.line("w0") end)', yours), 197);
});

test('the place and options parse as show takes them, whatever the order and spacing', () => {
  for (const [args, place, options = {}] of [
    ['a.ts:3', { path: 'a.ts', line: 3 }],
    ['a.ts:3-9:4', { path: 'a.ts', line: 3, endLine: 9, col: 3 }],
    ['a.ts:3:1:2', { path: 'a.ts:3', line: 1, col: 1 }], // The line follows the last colon but one.
    ['my dir/x=1.ts:3', { path: 'my dir/x=1.ts', line: 3 }],
    ['a=b.ts:3', { path: 'a=b.ts', line: 3 }],
    ['a=b.ts:3 scroll=top', { path: 'a=b.ts', line: 3 }, { scroll: 'top' }],
    ['/abs/a.ts:3', { path: '/abs/a.ts', line: 3 }],
    ['  a.ts:3\tscroll=top  ', { path: 'a.ts', line: 3 }, { scroll: 'top' }],
    ['a.ts:3 scroll="minimal" focus=true jump=false open=false', { path: 'a.ts', line: 3 }, { scroll: 'minimal', focus: true, jump: false, open: false }],
    ['a.ts:3 wait=Infinity context=0', { path: 'a.ts', line: 3, context: 0 }, { wait: Infinity }],
    ['a.ts match="x y"', { path: 'a.ts', match: 'x y' }],
    ['a.ts:7 match=x', { path: 'a.ts', line: 7, match: 'x' }],
    ['3-4 buf=2', { buf: 2, line: 3, endLine: 4 }],
    ['buf=2 match="a\\nb"', { buf: 2, match: 'a\nb' }],
    ['match=x buf=2', { buf: 2, match: 'x' }],
  ] as const) {
    assert.deepEqual(parsePoint(args), { place, options }, args);
  }
});

test('what does not parse says why, before anything is shown', () => {
  for (const [args, message] of [
    ['a.ts:3 match="a" b', /Usage:/],
    ['a.ts:3 focus=true focus', /Usage:/],
    ['a.ts:3 =top', /Usage:/],
    ['buf=2', /Usage:/],
    ['a.ts:3 wait=', /wait= is not a value wait takes/],
    ['a.ts:3 context=x', /context=x is not a value context takes/],
    ['a.ts:3 buf=0x10', /buf=0x10 is not a value buf takes/],
    ['a.ts:3 context=1e1', /context=1e1 is not a value context takes/],
    ['a.ts:3 context=1.5', /context=1.5 is not a value context takes/],
    ['a.ts:3 context=Infinity', /context=Infinity is not a value context takes/],
    ['a.ts:3 wait=-5', /wait=-5 is not a value wait takes/],
    ['a.ts:3 jump=no', /jump=no is not a value jump takes/],
    ['a.ts:3 scroll="up"', /scroll="up" is not a value scroll takes/],
    ['a.ts:3 match=""', /match="" is not a value match takes/],
    ['a.ts:3 Scroll=top', /No option Scroll:/],
  ] as const) {
    assert.throws(() => parsePoint(args), message, args);
  }
});

test('paths complete no more than 50 at once, and none in a directory that is not there', async () => {
  const many = join(dir, 'many');
  await mkdir(many);
  await Promise.all(Array.from({ length: 60 }, (_, i) => writeFile(join(many, `f${String(i).padStart(2, '0')}.ts`), '')));
  const items = (await completePath('many/', dir))!;
  assert.deepEqual([items.length, items[0].value, items.at(-1)!.value], [50, 'many/f00.ts:', 'many/f49.ts:']);
  assert.equal(await completePath('nowhere/', dir), null);
  assert.equal(await completePath('many/zz', dir), null);
});

test('completion: a first option\'s value; paths with spaces in them, before any option', async () => {
  await writeFile(join(dir, 'with space.txt'), '');
  const values = async (prefix: string) => (await completePoint(prefix, dir))?.map(item => item.value) ?? null;
  assert.deepEqual(await values('focus=t'), ['focus=true ']);
  assert.deepEqual(await values('scroll='), ['scroll=center ', 'scroll=top ', 'scroll=minimal ']);
  assert.deepEqual(await values('with sp'), ['with space.txt:']);
  // No file by that name: the word is an option's.
  assert.deepEqual(await values('there.ts m'), ['there.ts match=']);
});

test('completion: a quote in a path is the path\'s own, until options begin', async () => {
  await writeFile(join(dir, 'say"hello.txt'), '');
  const values = async (prefix: string) => (await completePoint(prefix, dir))?.map(item => item.value) ?? null;
  assert.deepEqual(await values('say"h'), ['say"hello.txt:']);
  assert.deepEqual(await values('say"hello.txt:1 sc'), ['say"hello.txt:1 scroll=']);
  assert.equal(await values('a.ts:1 match="open sc'), null); // A quoted value still being typed.
});
