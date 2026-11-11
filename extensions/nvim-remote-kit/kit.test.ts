import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { launch } from '../nvim-service/service.mjs';
import { attach, connect } from '../nvim-remote/remote.ts';
import type { Remote } from '../nvim-remote/api.ts';
import { blocked, errorText, install, module, perAttachment, useCwd, withKit } from './api.ts';

const service = launch({ cwd: '/tmp', init: 'NONE', graceMs: 100, killMs: 300 });
const { socket } = await service.ready;
after(() => service.stop());
const editor = await connect(socket); // The user.
after(() => editor.close());
const lua = (code: string, ...args: unknown[]): Promise<any> => editor.request('nvim_exec_lua', [code, args]);
const remote = await attach(socket, { onError: () => {} });
after(() => remote.close());
const kit = (code: string, ...args: unknown[]) => withKit(remote, code, args);

const dir = await realpath(await mkdtemp(join(tmpdir(), 'nvim-remote-kit-')));
after(() => rm(dir, { recursive: true, force: true }));
let files = 0;
async function file(text = 'one\ntwo\n', name = `file-${++files}.txt`) {
  const path = join(dir, name);
  await writeFile(path, text);
  return path;
}
afterEach(() => lua('vim.cmd("silent! tabonly | silent! only | enew! | silent! %bwipeout!")'));

test('the kit is installed once, with a module in the same call, and withKit installs it when needed', async () => {
  const fresh = await attach(socket, { onError: () => {} });
  try {
    const calls: string[] = [];
    const lua = fresh.lua;
    fresh.lua = (code, args, options) => { calls.push(code); return lua(code, args, options); };
    assert.equal(await withKit(fresh, 'return kit.busy() == nil'), true);
    assert.equal(calls.length, 3, 'tried, installed, ran');
    await install(fresh, 'remote.counted = (remote.counted or 0) + 1');
    assert.equal(await fresh.lua('return remote.counted'), 1);
    const call = module('kit_test', 'remote.kit_test = { twice = function(n) return { n * 2, remote.kit ~= nil } end }');
    calls.length = 0;
    assert.deepEqual(await call(fresh, 'twice', [4]), [8, true]);
    assert.deepEqual(await call(fresh, 'twice', [5]), [10, true]);
    assert.equal(calls.length, 4, 'tried, installed, ran; then ran');
    assert.match(calls[0], /^if not remote\.kit_test then return 'not installed' end/);
  } finally { fresh.close(); }
});

test('busy: free in normal and terminal mode; busy in any other', async () => {
  assert.equal(await kit('return kit.busy()'), null);
  await editor.request('nvim_input', ['i']);
  assert.equal(await kit('return kit.busy()'), 'i');
  await editor.request('nvim_input', ['<Esc>']);
  assert.equal(await kit('return kit.busy()'), null);
});

test('say: the first text that fits where messages go, else the last cut to fit', async () => {
  const said = (texts: unknown, columns: number): Promise<string | null> => lua(`local texts, columns = ...
    vim.o.columns = columns
    local said
    local notify = vim.notify
    vim.notify = function(text) said = text end
    local ok, err = pcall(function() remote_say(texts) end)
    vim.notify = notify
    if not ok then error(err) end
    return said`, texts, columns);
  await kit('remote_say = kit.say');
  try {
    assert.equal(await said('short', 80), 'short');
    assert.equal(await said(['a long one that does not fit here', 'shorter'], 20), 'shorter');
    const cut = await said(['x'.repeat(100)], 20);
    assert.ok(cut!.endsWith('…') && cut!.length < 20, cut!);
  } finally { await lua('vim.o.columns = 80; remote_say = nil'); }
});

test('yours: the window you are in, unless it is Pi\'s terminal or a float; then the one you came from, else any file window', async () => {
  const path = await file();
  const [yours, other] = await lua(`vim.cmd.edit(vim.fn.fnameescape(...))
    local yours = vim.api.nvim_get_current_win()
    vim.cmd('vsplit | enew')
    local other = vim.api.nvim_get_current_win()
    return { yours, other }`, path);
  assert.equal(await kit('return kit.yours()'), other, 'an unnamed file buffer is yours too');
  await lua('vim.api.nvim_set_current_win(...); vim.cmd("rightbelow vsplit | terminal")', yours);
  assert.equal(await kit('return kit.yours()'), yours, 'from Pi\'s terminal, the one you came from');
  await lua(`vim.api.nvim_open_win(vim.api.nvim_create_buf(false, true), true, { relative = 'editor', row = 1, col = 1, width = 10, height = 2 })`);
  assert.notEqual(await kit('return kit.yours()'), null);
  assert.equal(await kit('return vim.api.nvim_win_get_config(kit.yours()).relative'), '');
  await lua('vim.api.nvim_win_close(0, true); vim.cmd("only | terminal")');
  assert.equal(await kit('return kit.yours()'), null, 'none when only Pi\'s terminal is there');
});

test('file: one file by any name of it, as Neovim tells them apart, adding no buffer', async () => {
  const path = await file();
  const linked = join(dir, `link-${files}.txt`), hard = join(dir, `hard-${files}.txt`);
  await symlink(path, linked);
  await link(path, hard);
  const buf = await lua('vim.cmd.edit(vim.fn.fnameescape(...)) return vim.api.nvim_get_current_buf()', path);
  const is = (name: string) => kit('return kit.file(...)(select(2, ...))', name, buf);
  assert.deepEqual([await is(path), await is(linked), await is(hard)], [true, true, true]);
  assert.equal(await is(await file()), false);
  // A file system that ignores case (macOS's, as a rule) has one file by both.
  const upper = path.replace(/file-/, 'FILE-');
  assert.equal(await is(upper), existsSync(upper));
  // One not on disk: by its name alone.
  const unsaved = join(dir, 'unsaved.txt');
  const count = await lua('return #vim.api.nvim_list_bufs()');
  assert.equal(await is(unsaved), false);
  assert.equal(await lua('return #vim.api.nvim_list_bufs()'), count, 'none added');
  const named = await lua('vim.cmd.edit(vim.fn.fnameescape(...)) return vim.api.nvim_get_current_buf()', unsaved);
  assert.equal(await kit('return kit.file(...)(select(2, ...))', unsaved, named), true);
});

test('open: a file loaded unlisted, and undone; what is no file to read is refused', async () => {
  const path = await file();
  const [buf, done, listed] = await kit('local buf, done = kit.open(...) return { buf, done, vim.bo[buf].buflisted }', path);
  assert.deepEqual([done, listed, await lua('return vim.api.nvim_buf_is_loaded(...)', buf)], ['added', false, true]);
  assert.deepEqual(await kit('return { kit.open(...) }', path), [buf], 'loaded already: nothing done');
  await kit('kit.undo(...)', buf, 'added');
  assert.equal(await lua('return vim.api.nvim_buf_is_valid(...)', buf), false);
  // One the user listed and unloaded is only unloaded again.
  const listedBuf = await lua('vim.cmd.badd(vim.fn.fnameescape(...)) return vim.fn.bufnr(...)', path);
  assert.equal(await kit('local buf, done = kit.open(...) kit.undo(buf, done) return done', path), 'loaded');
  assert.deepEqual(await lua('return { vim.api.nvim_buf_is_valid(...), vim.api.nvim_buf_is_loaded(...) }', listedBuf), [true, false]);

  const folder = join(dir, `folder-${++files}`);
  await mkdir(folder);
  await assert.rejects(kit('kit.open(...)', join(dir, 'missing.txt')), /no such file/);
  await assert.rejects(kit('kit.open(...)', folder), /not a file/);
  const locked = await file();
  await chmod(locked, 0o000);
  try {
    await assert.rejects(kit('kit.open(...)', locked), /cannot read/);
  } finally { await chmod(locked, 0o644); }
});

test('open: the user\'s autocommands failing do not fail it; one making it no file does, and is undone', async () => {
  await lua(`vim.api.nvim_create_augroup('user', {})
    vim.api.nvim_create_autocmd('BufReadPost', { group = 'user', pattern = '*.txt', callback = function() error('broken plugin') end })
    vim.api.nvim_create_autocmd('BufReadPost', { group = 'user', pattern = '*.scratch', command = 'setlocal buftype=nofile' })`);
  try {
    const path = await file();
    assert.equal(await kit('local buf, done = kit.open(...) return done', path), 'added');
    const scratch = await file('x\n', `file-${++files}.scratch`);
    await assert.rejects(kit('kit.open(...)', scratch), /not a file/);
    assert.equal(await lua('return vim.fn.bufexists(...)', scratch), 0);
  } finally { await lua("vim.api.nvim_del_augroup_by_name('user')"); }
});

test('guarded: a file changed on disk never stops the editor at a prompt; autoread reloads it', async () => {
  const path = await file('before\n');
  const buf = await lua('vim.cmd.edit(vim.fn.fnameescape(...)) return vim.api.nvim_get_current_buf()', path);
  await new Promise(resolve => setTimeout(resolve, 1100)); // A later mtime.
  await writeFile(path, 'after\n');
  await lua('vim.o.autoread = true');
  try {
    await kit('kit.guarded(..., function() vim.cmd("checktime") end)', buf);
    assert.equal(await lua('return vim.api.nvim_buf_get_lines(..., 0, -1, true)[1]', buf), 'after');
    // Changed here as well: left as it is, and said so, rather than asked.
    await lua('vim.api.nvim_buf_set_lines(..., 0, -1, true, { "mine" })', buf);
    await new Promise(resolve => setTimeout(resolve, 1100));
    await writeFile(path, 'theirs\n');
    await kit('kit.guarded(..., function() vim.cmd("checktime") end)', buf);
    assert.equal(await lua('return vim.api.nvim_buf_get_lines(..., 0, -1, true)[1]', buf), 'mine');
    assert.equal((await editor.request('nvim_get_mode', []) as { blocking: boolean }).blocking, false);
    // No autocommand of the kit's is left behind.
    assert.equal(await lua('return #vim.api.nvim_get_autocmds({ event = "FileChangedShell" })'), 0);
  } finally { await lua('vim.o.autoread = false'); }
});

test('the TypeScript helpers: one handle per attachment, a refused call\'s mode, an error\'s text, Pi\'s directory', async () => {
  let made = 0;
  const of = perAttachment(() => ++made);
  const one = {} as Remote, other = {} as Remote;
  assert.deepEqual([of(one), of(one), of(other), made], [1, 1, 2, 2]);
  assert.equal(blocked(Object.assign(new Error('at a prompt'), { blocking: true, mode: 'r' })), 'r');
  assert.equal(blocked(new Error('other')), undefined);
  assert.equal(blocked(undefined), undefined);
  assert.equal(errorText(new Error('Lua: not found: x\nstack traceback:\n\t...')), 'not found: x');
  assert.equal(errorText('plain'), 'plain');
  const hooks = new EventEmitter();
  const cwd = useCwd({ on: (event: string, handler: () => void) => hooks.on(event, handler) } as unknown as ExtensionAPI);
  assert.equal(cwd(), process.cwd());
  hooks.emit('session_start', {}, { cwd: '/somewhere' });
  assert.equal(cwd(), '/somewhere');
});
