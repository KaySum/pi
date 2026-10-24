import assert from 'node:assert/strict';
import { after, afterEach, test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { register as registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { launch } from '../nvim-service/service.mjs';
import { attach, connect } from '../nvim-remote/remote.ts';
import type { Remote } from '../nvim-remote/api.ts';

// Pi's packages are installed with nvim-service, and found from there, as Pi finds them.
const from = new URL('../nvim-service/index.ts', import.meta.url).href;
registerHooks(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
  return next(specifier, specifier.startsWith('@earendil-works/') ? { ...context, parentURL: ${JSON.stringify(from)} } : context);
}`)}`);
const { default: register } = await import('./index.ts');

const service = launch({ cwd: '/tmp', init: 'NONE', graceMs: 100, killMs: 300 });
const { socket } = await service.ready;
after(() => service.stop());
const editor = await connect(socket); // The user.
after(() => editor.close());
const lua = (code: string, ...args: unknown[]): Promise<any> => editor.request('nvim_exec_lua', [code, args]);

// The Neovim these tests may run under stays out of them; control starts on each time.
const clean = () => {
  process.env.NVIM = socket;
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('pi.nvim-control')];
};
clean();
afterEach(clean);

type Tool = {
  name: string; promptSnippet?: string; promptGuidelines?: string[];
  execute(id: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: { text: string }[] }>;
};

type Command = { handler(args: string, ctx: object): Promise<void>; getArgumentCompletions?(prefix: string): unknown };

/** The extension loaded into a Pi whose nvim-remote hands out `remote` (or nothing), its session started. */
function load(remote?: Remote) {
  const bus = new EventEmitter(), hooks = new EventEmitter(), tools: Record<string, Tool> = {};
  const commands: Record<string, Command> = {}, notes: [string, string | undefined][] = [];
  let active = ['read', 'bash']; // Pi's own, which control must leave alone.
  register({
    events: { on: (channel: string, handler: (data: unknown) => void) => bus.on(channel, handler), emit: (channel: string, data: unknown) => bus.emit(channel, data) },
    on: (event: string, handler: () => void) => hooks.on(event, handler),
    registerTool: (tool: Tool) => { tools[tool.name] = tool; active.push(tool.name); }, // Active once registered, as in Pi.
    registerCommand: (name: string, command: Command) => { commands[name] = command; },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
  } as unknown as ExtensionAPI);
  bus.on('nvim-remote:get', (request: { reply(handle?: Remote): void }) => request.reply(remote));
  const ctx = { hasUI: true, ui: { notify: (text: string, type?: string) => notes.push([text, type]) } };
  hooks.listeners('session_start').forEach(handler => handler({ reason: 'startup' }, ctx));
  const run = async (name: string, params: Record<string, unknown>) => (await tools[name].execute('id', params)).content[0].text;
  const command = (args = '') => commands['nvim-control'].handler(args, ctx);
  return { tools, run, commands, command, notes, active: () => active };
}

async function attached(t: TestContext, options?: Parameters<typeof attach>[1]): Promise<Remote> {
  const remote = Object.assign(await attach(socket, { onError: () => {}, ...options }), { apiVersion: 1 as const });
  t.after(() => remote.close());
  return remote;
}

/** A scratch buffer focused in a normal window, as the user might have. */
const scratch = () => lua(`vim.cmd('silent! only | enew!'); vim.bo.buftype = ''; return vim.api.nvim_get_current_buf()`);

test('outside Neovim there are no tools, so they cost nothing, and no command', () => {
  delete process.env.NVIM;
  const { tools, commands } = load();
  assert.deepEqual(Object.keys(tools), []);
  assert.deepEqual(Object.keys(commands), []);
});

test("inside, two tools for the user's editor, each told apart from the private instance's", () => {
  const { tools } = load();
  assert.deepEqual(Object.keys(tools).sort(), ['editor_keys', 'editor_lua']);
  for (const tool of Object.values(tools)) assert.match(tool.promptSnippet!, /user's/);
  // Without a snippet a tool is left out of the system prompt's list.
  assert.match(tools.editor_lua.promptGuidelines!.join(' '), /real editor.*nvim_lua and nvim_keys are your private Neovim/);
  assert.match(tools.editor_lua.promptGuidelines!.join(' '), /never quit Neovim/);
});

test('without an attachment, the tools say so and how to fix it', async () => {
  const { run } = load(undefined);
  await assert.rejects(run('editor_lua', { code: 'return 1' }), /Not attached.*\/nvim-remote reconnect/);
  await assert.rejects(run('editor_keys', { keys: '' }), /Not attached/);
});

// editor_lua

test('editor_lua returns text, or JSON for anything else, and receives args', async t => {
  const { run } = load(await attached(t));
  assert.equal(await run('editor_lua', { code: 'return "plain text"' }), 'plain text');
  assert.deepEqual(JSON.parse(await run('editor_lua', { code: 'return { a = 1, b = { true } }' })), { a: 1, b: [true] }); // Keys in any order.
  assert.equal(await run('editor_lua', { code: 'local x = 1' }), 'null');
  assert.equal(await run('editor_lua', { code: 'return select("#", ...) .. ":" .. (...)', args: ['first', 2] }), '2:first');
});

test("editor_lua reaches the user's buffers, unsaved changes included", async t => {
  const { run } = load(await attached(t));
  const buf = await scratch();
  await lua('vim.api.nvim_buf_set_lines(..., 0, -1, true, { "typed but not saved" })', buf);
  assert.equal(await run('editor_lua', { code: 'return vim.api.nvim_buf_get_lines(..., 0, -1, true)[1]', args: [buf] }), 'typed but not saved');
});

test('editor_lua errors keep their message and line, and output is cut to 16 KB', async t => {
  const { run } = load(await attached(t));
  await assert.rejects(run('editor_lua', { code: 'local a = 1\nerror("boom")' }), /nvim-remote:2: boom/);
  const long = await run('editor_lua', { code: 'return string.rep("x", 20000)' });
  assert.equal(long.length > 16384 && long.length < 16600, true);
  assert.match(long, /\[Truncated: 16384 of 20000 characters shown\. Ask for less\.\]$/);
});

test('editor_lua gives up after timeoutMs', async t => {
  const { run } = load(await attached(t));
  await assert.rejects(run('editor_lua', { code: 'vim.wait(1000)', timeoutMs: 150 }), /did not answer within 150 ms/);
  assert.equal(await run('editor_lua', { code: 'return 1' }), '1'); // Still usable after.
});

test('what editor_lua sets up through remote goes when Pi detaches', async () => {
  const remote = Object.assign(await attach(socket, { onError: () => {} }), { apiVersion: 1 as const });
  const { run } = load(remote);
  await run('editor_lua', { code: `vim.api.nvim_create_autocmd('User', { group = remote.group, pattern = 'ModelMade', callback = function() end })
    vim.keymap.set('n', '<leader>zz', '<Nop>')
    remote.on_detach(function() vim.keymap.del('n', '<leader>zz') end)` });
  await remote.close();
  assert.equal(await lua('return #vim.api.nvim_get_autocmds({ event = "User", pattern = "ModelMade" })'), 0);
  assert.equal(await lua('return vim.fn.maparg("<leader>zz", "n")'), '');
});

// editor_keys

test('editor_keys types into the focused window and says what changed', async t => {
  const { run } = load(await attached(t));
  const buf = await scratch();
  const state = await run('editor_keys', { keys: 'ihello there<Esc>' });
  assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(..., 0, -1, true)', buf), ['hello there']);
  assert.match(state, new RegExp(`^mode n \\| buffer ${buf} \\[No Name\\] \\[\\+\\] \\| 1:11`));
  assert.match(await run('editor_keys', { keys: '' }), /^mode n \| /); // Just looking.
});

test('editor_keys waits for a busy editor to take in the keys before saying what they did', async t => {
  const { run } = load(await attached(t));
  const buf = await scratch();
  // Busy in Lua: calls are still answered, but typed keys wait until it is done.
  editor.notify('nvim_exec_lua', ['vim.wait(400)', []]);
  await delay(50);
  const state = await run('editor_keys', { keys: 'ibusy<Esc>' });
  assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(..., 0, -1, true)', buf), ['busy']);
  assert.match(state, /^mode n \| .*\[\+\] \| 1:4/);
});

test("editor_keys reports the last message, such as an error the keys caused", async t => {
  const { run } = load(await attached(t));
  await scratch();
  assert.match(await run('editor_keys', { keys: ':NoSuchCommand<CR>' }), /last message: .*E492: Not an editor command: NoSuchCommand/);
});

test("editor_keys will not type into Pi's own terminal, but can look at it", async t => {
  // A process in an editor terminal, standing in for Pi: attached as it, so it is remote.terminal.
  const [buf, shell] = await lua(`vim.cmd('silent! only | enew!')
    local job = vim.fn.jobstart({ 'sh', '-c', 'sleep 30 & wait' }, { term = true })
    vim.wait(1000, function() return #vim.api.nvim_get_proc_children(vim.fn.jobpid(job)) > 0 end)
    return { vim.api.nvim_get_current_buf(), vim.fn.jobpid(job) }`);
  t.after(() => lua('pcall(vim.api.nvim_buf_delete, ..., { force = true })', buf));
  const [child] = await lua('return vim.api.nvim_get_proc_children(...)', shell);
  const { run } = load(await attached(t, { pid: child }));
  await assert.rejects(run('editor_keys', { keys: 'echo hi<CR>' }), /Pi's own terminal.*Focus another window with editor_lua first/);
  assert.match(await run('editor_keys', { keys: '' }), /\(your own terminal\)/);
});

test('at a prompt, editor_keys says so and can answer it; editor_lua says to', async t => {
  const { run } = load(await attached(t));
  await scratch();
  await editor.request('nvim_ui_attach', [80, 24, { ext_linegrid: true }]); // Prompts need a screen.
  try {
    assert.match(await run('editor_keys', { keys: ':echo "first\\nsecond"<CR>' }), /^mode r \(waiting at a prompt: answer it with editor_keys/);
    await assert.rejects(run('editor_lua', { code: 'return 1' }), /waiting at a prompt.*Answer it with editor_keys/);
    assert.match(await run('editor_keys', { keys: '<CR>' }), /^mode n \| /);
  } finally {
    await editor.request('nvim_input', ['<Esc>']);
    await delay(50);
    await editor.request('nvim_ui_detach');
  }
});

// /nvim-control

const ours = (active: string[]) => active.filter(name => name.startsWith('editor_'));

test("control starts on: the model has the editor's tools", () => {
  const { active } = load();
  assert.deepEqual(ours(active()).sort(), ['editor_keys', 'editor_lua']);
});

test('/nvim-control off takes the tools away from the model, and on gives them back; others stay', async () => {
  const { command, active, notes } = load();
  await command('off');
  assert.deepEqual(active(), ['read', 'bash']);
  assert.deepEqual(notes.at(-1), ['The model can no longer control your editor', 'info']);
  await command('off'); // Already off: still off.
  assert.deepEqual(active(), ['read', 'bash']);
  await command('on');
  assert.deepEqual(active(), ['read', 'bash', 'editor_lua', 'editor_keys']);
  assert.deepEqual(notes.at(-1), ['The model can control your editor', 'info']);
  await command('on'); // Not added twice.
  assert.equal(ours(active()).length, 2);
});

test('/nvim-control alone toggles', async () => {
  const { command, active } = load();
  await command();
  assert.deepEqual(ours(active()), []);
  await command();
  assert.equal(ours(active()).length, 2);
});

test('control stays off across /reload', async () => {
  const first = load();
  await first.command('off');
  const second = load(); // Everything loaded afresh: the tools are registered, so active again,
  assert.deepEqual(ours(second.active()), []); // until the session starts with control off.
  await second.command('on');
  assert.equal(ours(load().active()).length, 2);
});

test('/nvim-control offers its two options, and explains itself for anything else', async () => {
  const { commands, command, notes, active } = load();
  const complete = (prefix: string) => commands['nvim-control'].getArgumentCompletions!(prefix) as { value: string }[] | null;
  assert.deepEqual(complete('')?.map(item => item.value), ['on', 'off']);
  assert.deepEqual(complete('of')?.map(item => item.value), ['off']);
  assert.equal(complete('x'), null);
  for (const args of ['maybe', 'on off', 'OFF']) {
    await command(args);
    assert.deepEqual(notes.at(-1), ['Usage: /nvim-control [on|off]', 'warning']);
  }
  assert.equal(ours(active()).length, 2); // Nothing changed.
});
