import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { launch } from '../nvim-service/service.mjs';
import { connect } from '../nvim-remote/remote.ts';
import registerRemote from '../nvim-remote/index.ts';
import type { Remote } from '../nvim-remote/api.ts';
import registerVirtualText from './index.ts';
import { virtualText } from './api.ts';

const service = launch({ cwd: '/tmp', init: 'NONE', graceMs: 100, killMs: 300 });
const { socket } = await service.ready;
after(() => service.stop());
const editor = await connect(socket);
after(() => editor.close());
const dir = await realpath(await mkdtemp(join(tmpdir(), 'nvim-virtual-text-')));
after(() => rm(dir, { recursive: true, force: true }));

type Command = { handler(args: string, ctx: object): Promise<void> };

/** Pi with this extension loaded, and nvim-remote too if `remote`, its session started. */
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
  const ready = new Promise<Remote>(resolve => bus.once('nvim-remote:ready', resolve));
  if (remote) registerRemote(api);
  registerVirtualText(api);
  await fire('session_start');
  const nvim = remote ? await ready : undefined;
  const run = async (name: string, args = '') => { await commands[name].handler(args, ctx); return notes.at(-1)!; };
  return { nvim, run, commands, shutdown: () => fire('session_shutdown') };
}

test('the commands are named without spaces, and say when Pi is not attached', async () => {
  const { commands, run } = await pi({ remote: false });
  assert.deepEqual(Object.keys(commands).sort(), ['nvim-virtual-text', 'nvim-virtual-text-add', 'nvim-virtual-text-clear', 'nvim-virtual-text-remove']);
  assert.deepEqual(await run('nvim-virtual-text'), ['Pi is not attached to Neovim', 'warning']);
  assert.deepEqual(await run('nvim-virtual-text-clear'), ['Pi is not attached to Neovim', 'warning']);
});

test('/nvim-virtual-text shows every mark by group, and what is special about each', async () => {
  const { nvim, run, shutdown } = await pi();
  try {
    assert.deepEqual(await run('nvim-virtual-text'), ['No virtual text placed', 'info']);
    const path = join(dir, 'code.ts');
    await writeFile(path, 'head\ntarget\nmiddle\ntail\n');
    await nvim!.lua('vim.cmd.edit(...)', [path]);
    const notes = virtualText(nvim!, 'annotate'), flash = virtualText(nvim!, 'follow');
    await notes.place([
      { path, match: 'target', text: 'explains\nthe target', position: 'below', invalidate: true },
      { path, line: 3, endLine: 4, text: [['a long note ', 'Title'], ['that goes on and on past forty characters']], hl: { fg: '#ff0000' } },
    ]);
    const [hidden] = await flash.place({ path, line: 1, text: 'gone', invalidate: true, ttl: 60000 });
    await nvim!.lua('vim.cmd("normal! ggdd")');
    await flash.update(hidden, { text: 'changed' });

    const [text, type] = await run('nvim-virtual-text');
    assert.equal(type, 'info');
    assert.deepEqual(text.split('\n'), [
      '3 marks in 2 groups, 1 file; 1 hidden by a deletion; 1 changed while hidden',
      'annotate (2)',
      '  #1 code.ts:1 below "explains⏎the target"  [match, invalidate]',
      '  #2 code.ts:2-3 eol "a long note that goes on and on past fo…"',
      'follow (1)',
      '  #3 code.ts:1 eol "changed"  [ttl 60000, invalidate, hidden, changed while hidden]',
      'Watching 1 buffer; 1 style made',
    ]);

    // Cut where a character ends: an emoji, or a letter and its accent, stays whole.
    await notes.place([
      { path, line: 1, text: 'x'.repeat(38) + '🙂' + 'tail' },
      { path, line: 1, text: 'x'.repeat(38) + 'e\u0301' + 'tail' },
    ]);
    const previews = (await run('nvim-virtual-text'))[0].split('\n').filter(line => /#[45] /.test(line));
    assert.deepEqual(previews.map(line => line.match(/"(.*)"/)![1]), ['x'.repeat(38) + '🙂…', 'x'.repeat(38) + 'e\u0301…']);
    assert.ok(previews.every(line => line.isWellFormed()));

    assert.deepEqual(await run('nvim-virtual-text-clear'), ['Removed 5 marks', 'info']);
    assert.match((await run('nvim-virtual-text'))[0], /^0 marks in 0 groups, 0 files\n/);
  } finally { await shutdown(); }
});

test('/nvim-virtual-text-add places at your cursor, or where it says; /nvim-virtual-text-remove takes them away by id', async () => {
  const { nvim, run, shutdown } = await pi();
  try {
    const path = join(dir, 'placed.ts');
    await writeFile(path, 'one\ntwo\nthree\nfour\n');
    // Like sidekick: your window with the cursor on line 3, then Pi's terminal, focused.
    await editor.request('nvim_exec_lua', [`vim.cmd('silent! only | edit ' .. vim.fn.fnameescape(...))
      vim.api.nvim_win_set_cursor(0, { 3, 0 })
      vim.cmd('vsplit | terminal')`, [path]]);
    assert.deepEqual(await run('nvim-virtual-text-add', 'position=below fg=#ff9e64 a note\\nover two lines'), ['Placed #1 at placed.ts:3', 'info']);
    assert.deepEqual(await run('nvim-virtual-text-add', `path=placed.ts match="four" sign=! here`), ['Placed #2 at placed.ts:4', 'info']);
    assert.deepEqual(await run('nvim-virtual-text-add', 'position=sideways x'), ['position=sideways is not a value position takes: eol, right, overlay, inline, above, below or a column', 'warning']);
    assert.deepEqual(await run('nvim-virtual-text-add', 'path=placed.ts match=nowhere x'), [`not found in ${path}: nowhere`, 'warning']);

    const [mine] = await virtualText(nvim!, 'user').list();
    assert.deepEqual([mine.text, mine.position, mine.hl], ['a note\nover two lines', 'below', { fg: '#ff9e64' }]);
    const report = (await run('nvim-virtual-text'))[0];
    assert.match(report, /^user \(2\)$/m);
    assert.match(report, /#1 placed.ts:3 below "a note⏎over two lines"/);

    assert.deepEqual(await run('nvim-virtual-text-remove', '#1 7'), ['Removed #1; no mark #7', 'warning']);
    assert.deepEqual(await run('nvim-virtual-text-remove', '2'), ['Removed #2', 'info']);
    assert.deepEqual(await run('nvim-virtual-text-remove', 'nothing'), ['Usage: /nvim-virtual-text-remove <id …>', 'warning']);
  } finally {
    await editor.request('nvim_exec_lua', ['vim.cmd("silent! only | enew! | silent! %bwipeout!")', []]);
    await shutdown();
  }
});
