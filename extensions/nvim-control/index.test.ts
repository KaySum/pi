import assert from 'node:assert/strict';
import { after, afterEach, test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { launch } from '../nvim-service/service.mjs';
import { attach, connect } from '../nvim-remote/remote.ts';
import type { Remote } from '../nvim-remote/api.ts';

// Pi's packages are installed with nvim-service, and found from there, as Pi finds them.
const from = new URL('../nvim-service/index.ts', import.meta.url).href;
registerHooks({
  resolve: (specifier, context, next) =>
    next(specifier, specifier.startsWith('@earendil-works/') ? { ...context, parentURL: from } : context),
});
const { default: register, parts } = await import('./index.ts');

const service = launch({ cwd: '/tmp', init: 'NONE', graceMs: 100, killMs: 300 });
const { socket } = await service.ready;
after(() => service.stop());
const editor = await connect(socket); // The user.
after(() => editor.close());
const lua = (code: string, ...args: unknown[]): Promise<any> => editor.request('nvim_exec_lua', [code, args]);

// The Neovim these tests may run under stays out of them; control starts off each time.
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
  const commands: Record<string, Command> = {}, notes: [string, string | undefined][] = [], status: Record<string, string | undefined> = {};
  let active = ['read', 'bash']; // Pi's own, which control must leave alone.
  register({
    events: { on: (channel: string, handler: (data: unknown) => void) => bus.on(channel, handler), emit: (channel: string, data: unknown) => bus.emit(channel, data) },
    on: (event: string, handler: () => void) => hooks.on(event, handler),
    registerTool: (tool: Tool) => { tools[tool.name] = tool; active.push(tool.name); }, // Active once registered, as in Pi.
    registerCommand: (name: string, command: Command) => { commands[name] = command; },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
  } as unknown as ExtensionAPI);
  let current = remote;
  bus.on('nvim-remote:get', (request: { reply(handle?: Remote): void }) => request.reply(current));
  const ctx = { hasUI: true, ui: { notify: (text: string, type?: string) => notes.push([text, type]), setStatus: (key: string, text?: string) => { status[key] = text; } } };
  hooks.listeners('session_start').forEach(handler => handler({ reason: 'startup' }, ctx));
  const run = async (name: string, params: Record<string, unknown>) => (await tools[name].execute('id', params)).content[0].text;
  const command = (args = '') => commands['nvim-control'].handler(args, ctx);
  // As nvim-remote announces them: the editor going away, and being attached again.
  const stop = () => { current = undefined; bus.emit('nvim-remote:stopped', remote?.info); };
  const ready = () => { current = remote; bus.emit('nvim-remote:ready', remote); };
  return { tools, run, commands, command, notes, status, stop, ready, active: () => active };
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
  assert.deepEqual(Object.keys(tools).sort(), ['nvim_control_keys', 'nvim_control_lua']);
  for (const tool of Object.values(tools)) assert.match(tool.promptSnippet!, /user's/);
  // Without a snippet a tool is left out of the system prompt's list.
  assert.match(tools.nvim_control_lua.promptGuidelines!.join(' '), /real editor.*nvim_lua and nvim_keys are your private Neovim/);
  assert.match(tools.nvim_control_lua.promptGuidelines!.join(' '), /never quit Neovim/);
});

test('without an attachment, the tools say so and how to fix it', async () => {
  const { run } = load(undefined);
  await assert.rejects(run('nvim_control_lua', { code: 'return 1' }), /Not attached.*\/nvim-remote reconnect/);
  await assert.rejects(run('nvim_control_keys', { keys: '' }), /Not attached/);
});

// nvim_control_lua

test('nvim_control_lua returns text, or JSON for anything else, and receives args', async t => {
  const { run } = load(await attached(t));
  assert.equal(await run('nvim_control_lua', { code: 'return "plain text"' }), 'plain text');
  assert.deepEqual(JSON.parse(await run('nvim_control_lua', { code: 'return { a = 1, b = { true } }' })), { a: 1, b: [true] }); // Keys in any order.
  assert.equal(await run('nvim_control_lua', { code: 'local x = 1' }), 'null');
  assert.equal(await run('nvim_control_lua', { code: 'return select("#", ...) .. ":" .. (...)', args: ['first', 2] }), '2:first');
});

test("nvim_control_lua reaches the user's buffers, unsaved changes included", async t => {
  const { run } = load(await attached(t));
  const buf = await scratch();
  await lua('vim.api.nvim_buf_set_lines(..., 0, -1, true, { "typed but not saved" })', buf);
  assert.equal(await run('nvim_control_lua', { code: 'return vim.api.nvim_buf_get_lines(..., 0, -1, true)[1]', args: [buf] }), 'typed but not saved');
});

test('nvim_control_lua errors keep their message and line, and output is cut to 16 KB', async t => {
  const { run } = load(await attached(t));
  await assert.rejects(run('nvim_control_lua', { code: 'local a = 1\nerror("boom")' }), /nvim-remote:2: boom/);
  const long = await run('nvim_control_lua', { code: 'return string.rep("x", 20000)' });
  assert.equal(long.length > 16384 && long.length < 16600, true);
  assert.match(long, /\[Truncated: 16384 of 20000 characters shown\. Ask for less\.\]$/);
});

test('nvim_control_lua gives up after timeoutMs', async t => {
  const { run } = load(await attached(t));
  await assert.rejects(run('nvim_control_lua', { code: 'vim.wait(1000)', timeoutMs: 150 }), /did not finish within 150 ms/);
  assert.equal(await run('nvim_control_lua', { code: 'return 1' }), '1'); // Still usable after.
});

test('what nvim_control_lua sets up through remote goes when Pi detaches', async () => {
  const remote = Object.assign(await attach(socket, { onError: () => {} }), { apiVersion: 1 as const });
  const { run } = load(remote);
  await run('nvim_control_lua', { code: `vim.api.nvim_create_autocmd('User', { group = remote.group, pattern = 'ModelMade', callback = function() end })
    vim.keymap.set('n', '<leader>zz', '<Nop>')
    remote.on_detach(function() vim.keymap.del('n', '<leader>zz') end)` });
  await remote.close();
  assert.equal(await lua('return #vim.api.nvim_get_autocmds({ event = "User", pattern = "ModelMade" })'), 0);
  assert.equal(await lua('return vim.fn.maparg("<leader>zz", "n")'), '');
});

// nvim_control_keys

test('nvim_control_keys types into the focused window and says what changed', async t => {
  const { run } = load(await attached(t));
  const buf = await scratch();
  const state = await run('nvim_control_keys', { keys: 'ihello there<Esc>' });
  assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(..., 0, -1, true)', buf), ['hello there']);
  assert.match(state, new RegExp(`^mode n \\| buffer ${buf} \\[No Name\\] \\[\\+\\] \\| 1:11`));
  assert.match(await run('nvim_control_keys', { keys: '' }), /^mode n \| /); // Just looking.
});

test('nvim_control_keys waits for a busy editor to take in the keys before saying what they did', async t => {
  const { run } = load(await attached(t));
  const buf = await scratch();
  // Busy in Lua: calls are still answered, but typed keys wait until it is done.
  editor.notify('nvim_exec_lua', ['vim.wait(400)', []]);
  await delay(50);
  const state = await run('nvim_control_keys', { keys: 'ibusy<Esc>' });
  assert.deepEqual(await lua('return vim.api.nvim_buf_get_lines(..., 0, -1, true)', buf), ['busy']);
  assert.match(state, /^mode n \| .*\[\+\] \| 1:4/);
});

test('nvim_control_keys delivers every key, however many: none are dropped when Neovim takes only part', async t => {
  const { run } = load(await attached(t));
  const text = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
  for (const insert of [text(20000), text(100000), 'λ🦀'.repeat(4000)]) {
    const buf = await scratch();
    const state = await run('nvim_control_keys', { keys: `i${insert}<Esc>`, timeoutMs: 30000 });
    assert.equal((await lua('return vim.api.nvim_buf_get_lines(..., 0, -1, true)[1]', buf)).length, insert.length);
    assert.equal(await lua('return vim.api.nvim_buf_get_lines(..., 0, -1, true)[1]', buf), insert);
    assert.match(state, /^mode n \| /, 'the closing <Esc> arrived too');
  }
});

test('nvim_control_keys never splits a key name or a character between the parts it sends', async t => {
  const { run } = load(await attached(t));
  // A <lt> and an emoji either side of where 4 KB parts would be cut.
  for (const pad of [4090, 4091, 4092, 4093, 4094, 4095]) {
    const buf = await scratch();
    await run('nvim_control_keys', { keys: `i${'a'.repeat(pad)}<lt>😀b<Esc>` });
    assert.equal(await lua('return vim.api.nvim_buf_get_lines(..., 0, -1, true)[1]', buf), `${'a'.repeat(pad)}<😀b`);
  }
});

test("nvim_control_keys reports the last message, such as an error the keys caused", async t => {
  const { run } = load(await attached(t));
  await scratch();
  assert.match(await run('nvim_control_keys', { keys: ':NoSuchCommand<CR>' }), /last message: .*E492: Not an editor command: NoSuchCommand/);
});

test("nvim_control_keys will not type into Pi's own terminal, but can look at it", async t => {
  // A process in an editor terminal, standing in for Pi: attached as it, so it is remote.terminal.
  const [buf, shell] = await lua(`vim.cmd('silent! only | enew!')
    local job = vim.fn.jobstart({ 'sh', '-c', 'sleep 30 & wait' }, { term = true })
    vim.wait(1000, function() return #vim.api.nvim_get_proc_children(vim.fn.jobpid(job)) > 0 end)
    return { vim.api.nvim_get_current_buf(), vim.fn.jobpid(job) }`);
  t.after(() => lua('pcall(vim.api.nvim_buf_delete, ..., { force = true })', buf));
  const [child] = await lua('return vim.api.nvim_get_proc_children(...)', shell);
  const { run } = load(await attached(t, { pid: child }));
  await assert.rejects(run('nvim_control_keys', { keys: 'echo hi<CR>' }), /Pi's own terminal.*Focus another window with nvim_control_lua first/);
  assert.match(await run('nvim_control_keys', { keys: '' }), /\(your own terminal\)/);
});

test('at a prompt, nvim_control_keys says so and can answer it; nvim_control_lua says to', async t => {
  const { run } = load(await attached(t));
  await scratch();
  await editor.request('nvim_ui_attach', [80, 24, { ext_linegrid: true }]); // Prompts need a screen.
  try {
    assert.match(await run('nvim_control_keys', { keys: ':echo "first\\nsecond"<CR>' }), /^mode r \(waiting at a prompt: answer it with nvim_control_keys/);
    await assert.rejects(run('nvim_control_lua', { code: 'return 1' }), /waiting at a prompt.*Answer it with nvim_control_keys/);
    assert.match(await run('nvim_control_keys', { keys: '<CR>' }), /^mode n \| /);
  } finally {
    await editor.request('nvim_input', ['<Esc>']);
    await delay(50);
    await editor.request('nvim_ui_detach');
  }
});

// /nvim-control

const ours = (active: string[]) => active.filter(name => name.startsWith('nvim_control_'));

test("control starts off: the model does not have the editor's tools until asked", () => {
  const { active } = load();
  assert.deepEqual(active(), ['read', 'bash']);
});

test('/nvim-control on gives the model the tools, and off takes them away; others stay', async () => {
  const { command, active, notes } = load();
  await command('on');
  assert.deepEqual(active(), ['read', 'bash', 'nvim_control_lua', 'nvim_control_keys']);
  assert.deepEqual(notes.at(-1), ['The model can control your editor', 'info']);
  await command('on'); // Already on: not added twice.
  assert.equal(ours(active()).length, 2);
  await command('off');
  assert.deepEqual(active(), ['read', 'bash']);
  assert.deepEqual(notes.at(-1), ['The model can no longer control your editor', 'info']);
  await command('off'); // Already off: still off.
  assert.deepEqual(active(), ['read', 'bash']);
});

test('/nvim-control alone toggles', async () => {
  const { command, active } = load();
  await command();
  assert.equal(ours(active()).length, 2); // Off by default, so on.
  await command();
  assert.deepEqual(ours(active()), []);
});

test('control stays on across /reload once turned on, and off once turned off', async () => {
  const first = load();
  await first.command('on');
  assert.equal(ours(load().active()).length, 2); // Everything loaded afresh, still on.
  const second = load();
  await second.command('off');
  assert.deepEqual(ours(load().active()), []);
});

test('/nvim-control offers its two options, and explains itself for anything else', async () => {
  const { commands, command, notes, active } = load();
  const complete = (prefix: string) => commands['nvim-control'].getArgumentCompletions!(prefix) as { value: string }[] | null;
  assert.deepEqual(complete('')?.map(item => item.value), ['on', 'off']);
  assert.deepEqual(complete('of')?.map(item => item.value), ['off']);
  assert.equal(complete('x'), null);
  for (const args of ['maybe', 'on off', 'ON']) {
    await command(args);
    assert.deepEqual(notes.at(-1), ['Usage: /nvim-control [on|off]', 'warning']);
  }
  assert.deepEqual(ours(active()), []); // Nothing changed.
});

test('the footer says whether control is on or off while Pi is attached', async t => {
  const { status, command, stop, ready } = load(await attached(t));
  assert.equal(status['nvim-control'], 'control off');
  await command('on');
  assert.equal(status['nvim-control'], 'control on');
  await command('off');
  assert.equal(status['nvim-control'], 'control off');
  await command('on');
  stop(); // No editor: nothing to control, so nothing shown.
  assert.equal(status['nvim-control'], undefined);
  ready();
  assert.equal(status['nvim-control'], 'control on');
});

test('without an attachment the footer shows nothing, on or off', async () => {
  const fake = load(undefined);
  assert.equal(fake.status['nvim-control'], undefined);
  await fake.command('on');
  assert.equal(fake.status['nvim-control'], undefined);
});

test('keys are cut into parts of at most 4 KB, between whole key names and characters', () => {
  assert.deepEqual(parts(''), []);
  assert.deepEqual(parts('ihello<Esc>'), ['ihello<Esc>']);
  const cut = parts('a'.repeat(4094) + '<Esc>' + '🦀'.repeat(2000));
  assert.ok(cut.every(part => Buffer.byteLength(part) <= 4096));
  assert.ok(cut[1].startsWith('<Esc>'), 'the key name went whole into the next part');
  assert.equal(cut.join(''), 'a'.repeat(4094) + '<Esc>' + '🦀'.repeat(2000));
  assert.ok(cut.every(part => !/^[\uDC00-\uDFFF]/.test(part)), 'no part starts inside a character');
});

test('key names with punctuation are kept whole too', () => {
  for (const key of ['<C-\\>', '<C-]>', '<C-^>', '<C-@>', '<C-S-x>', '<M-<>', '<C->>', '<C-->', '<k0>', '<ScrollWheelUp>']) {
    for (let pad = 4088; pad <= 4097; pad++) {
      const cut = parts('a'.repeat(pad) + key + 'b');
      assert.ok(cut.some(part => part.includes(key)), `${key} after ${pad} bytes was split: ${JSON.stringify(cut.map(p => p.slice(-8)))}`);
      assert.equal(cut.join(''), 'a'.repeat(pad) + key + 'b');
    }
  }
});

test('a key name with punctuation reaches Neovim whole, wherever it falls', async t => {
  const { run } = load(await attached(t));
  await lua(`vim.keymap.set('i', '<C-]>', 'MARK')`);
  t.after(() => lua(`pcall(vim.keymap.del, 'i', '<C-]>')`));
  for (const pad of [4092, 4093, 4094]) {
    const buf = await scratch();
    await run('nvim_control_keys', { keys: `i${'x'.repeat(pad)}<C-]><Esc>` });
    assert.equal(await lua('return vim.api.nvim_buf_get_lines(..., 0, -1, true)[1]', buf), `${'x'.repeat(pad)}MARK`);
  }
});

test("keys stop the moment Pi's own terminal takes focus, even partway through", async t => {
  // A terminal standing in for Pi's, attached as it, so it is remote.terminal.
  const [term, job] = await lua(`vim.cmd('silent! only | enew!')
    local job = vim.fn.jobstart({ 'cat' }, { term = true })
    return { vim.api.nvim_get_current_buf(), vim.fn.jobpid(job) }`);
  t.after(() => lua('pcall(vim.api.nvim_buf_delete, ..., { force = true })', term));
  const remote = await attached(t, { pid: job }); // The terminal's job itself.
  assert.equal(remote.info.terminal, term);
  const buf = await lua(`vim.cmd('vsplit | enew!'); vim.bo.buftype = ''; return vim.api.nvim_get_current_buf()`);
  // Once the first part has gone in, the user puts focus on Pi's terminal.
  let parts = 0;
  const watched = Object.assign(Object.create(remote), {
    async lua(code: string, args: unknown[], options?: object) {
      const value = await remote.lua(code, args, options);
      if (code.includes('nvim_input') && ++parts === 1) {
        await lua(`vim.cmd.stopinsert(); vim.api.nvim_set_current_buf(...)`, term);
      }
      return value;
    },
  }) as Remote;
  const { run } = load(watched);
  await assert.rejects(run('nvim_control_keys', { keys: `i${'x'.repeat(5000)}UNSAFE_SUFFIX<CR>` }),
    /Stopped after typing 4096 of \d+ bytes of keys: focus moved to Pi's own terminal/);
  assert.equal(parts, 2); // The second part was refused, not typed.
  await delay(100);
  assert.ok(!(await lua('return table.concat(vim.api.nvim_buf_get_lines(..., 0, -1, false), "\\n")', term)).includes('UNSAFE_SUFFIX'));
  assert.equal((await lua('return vim.api.nvim_buf_get_lines(..., 0, -1, true)[1]', buf)).length, 4095); // Only the first part.
});

/** `remote`, with what it does as each part of keys is typed in its hands. */
function typing(remote: Remote, part: (n: number, type: () => Promise<unknown>) => Promise<unknown>) {
  let parts = 0;
  const watched = Object.assign(Object.create(remote), {
    lua: (code: string, args: unknown[], options?: object) =>
      code.includes('nvim_input') ? part(++parts, () => remote.lua(code, args, options)) : remote.lua(code, args, options),
  }) as Remote;
  return { remote: watched, parts: () => parts };
}

test('a part Neovim takes only some of is reported, and nothing after it is typed', async t => {
  const { remote, parts } = typing(await attached(t), async (n, type) => n === 2 ? 512 : type()); // Says it took 512 bytes.
  const { run } = load(remote);
  const buf = await scratch();
  await assert.rejects(run('nvim_control_keys', { keys: `i${'x'.repeat(10000)}<Esc>` }), /took only 512 of 4096 bytes of keys; the rest were not typed/);
  assert.equal(parts(), 2);
  await editor.request('nvim_input', ['<Esc>']);
  assert.equal((await lua('return vim.api.nvim_buf_get_lines(..., 0, -1, true)[1]', buf)).length, 4095); // The first part only.
});

test('stopping the call between parts types nothing more', async t => {
  const controller = new AbortController();
  const { remote, parts } = typing(await attached(t), async (n, type) => {
    const value = await type();
    if (n === 1) controller.abort(new Error('stopped by the user'));
    return value;
  });
  const { tools } = load(remote);
  const buf = await scratch();
  await assert.rejects(tools.nvim_control_keys.execute('id', { keys: `i${'x'.repeat(10000)}<Esc>` }, controller.signal), /stopped by the user/);
  assert.equal(parts(), 1);
  await editor.request('nvim_input', ['<Esc>']);
  assert.equal((await lua('return vim.api.nvim_buf_get_lines(..., 0, -1, true)[1]', buf)).length, 4095);
});

test("answering a prompt does not let the keys after the answer into Pi's terminal", async t => {
  const [term, job] = await lua(`vim.cmd('silent! only | enew!')
    local job = vim.fn.jobstart({ 'cat' }, { term = true })
    return { vim.api.nvim_get_current_buf(), vim.fn.jobpid(job) }`);
  t.after(() => lua('pcall(vim.api.nvim_buf_delete, ..., { force = true })', term));
  const remote = await attached(t, { pid: job }); // Standing in for Pi, in its terminal.
  assert.equal(remote.info.terminal, term);
  const { run } = load(remote);
  await editor.request('nvim_ui_attach', [80, 24, { ext_linegrid: true }]); // Prompts need a screen.
  const prompt = async () => {
    await editor.request('nvim_input', [':echo "first\\nsecond"<CR>']);
    for (let i = 0; i < 100 && !(await editor.request('nvim_get_mode', [])).blocking; i++) await delay(10);
  };
  try {
    // Focus on Pi's terminal, a prompt open over it: the answer goes in, the rest does not.
    await prompt();
    await assert.rejects(run('nvim_control_keys', { keys: '<CR>iPROMPT_SUFFIX<CR>' }), /Stopped after typing 4 of \d+ bytes of keys: focus moved to Pi's own terminal/);
    await delay(100);
    assert.ok(!(await lua('return table.concat(vim.api.nvim_buf_get_lines(..., 0, -1, false), "\\n")', term)).includes('PROMPT_SUFFIX'));
    // Only answering it is fine.
    await prompt();
    assert.match(await run('nvim_control_keys', { keys: '<CR>' }), /^mode nt \| .*\(your own terminal\)/); // Normal mode, in a terminal.
  } finally {
    await editor.request('nvim_input', ['<Esc>']);
    await delay(50);
    await editor.request('nvim_ui_detach');
  }
});

test('output is never cut inside a character', async t => {
  const { run } = load(await attached(t));
  for (const prefix of ['a', '']) { // Odd and even: the cut falls inside an emoji, or between two.
    const shown = await run('nvim_control_lua', { code: `return ... .. string.rep('🦀', 9000)`, args: [prefix] });
    const body = shown.slice(0, shown.indexOf('\n[Truncated'));
    assert.ok(body.isWellFormed(), `with ${JSON.stringify(prefix)} in front, the cut split an emoji`);
    assert.ok(body.length >= 16383 && body.length <= 16384);
    assert.match(shown, new RegExp(`\\[Truncated: ${body.length} of ${prefix.length + 18000} characters shown`));
  }
});

test('timeoutMs is for the whole call: once it runs out, no further part of the keys is typed', async t => {
  const { remote, parts } = typing(await attached(t), async (n, type) => {
    const value = await type();
    if (n === 1) await delay(180); // Slow between parts: longer than the whole budget.
    return value;
  });
  const { run } = load(remote);
  const buf = await scratch();
  const start = Date.now();
  await assert.rejects(run('nvim_control_keys', { keys: `i${'x'.repeat(10000)}<Esc>`, timeoutMs: 100 }),
    /timeoutMs ran out after typing 4096 of \d+ bytes of keys; the rest were not typed/);
  assert.equal(parts(), 1);
  assert.ok(Date.now() - start < 600, `took ${Date.now() - start} ms`);
  await editor.request('nvim_input', ['<Esc>']);
  assert.equal((await lua('return vim.api.nvim_buf_get_lines(..., 0, -1, true)[1]', buf)).length, 4095);
});

test('running out of timeoutMs says the call did not finish, and stops waiting then', async t => {
  const { run } = load(await attached(t));
  await scratch();
  const start = Date.now();
  await assert.rejects(run('nvim_control_lua', { code: 'vim.wait(250) return 1', timeoutMs: 150 }), /did not finish within 150 ms/);
  assert.ok(Date.now() - start < 400, `took ${Date.now() - start} ms`);
});

test('numeric key notation (<Char-65>, <Char-0x41>, <Char-0101>) is kept whole', () => {
  for (const key of ['<Char-65>', '<Char-0x41>', '<Char-0101>', '<char-97>', '<C-Char-65>', '<Char-0X7E>']) {
    for (let pad = 4084; pad <= 4097; pad++) {
      const cut = parts('a'.repeat(pad) + key + 'b');
      assert.ok(cut.some(part => part.includes(key)), `${key} after ${pad} bytes was split`);
    }
  }
});

test('numeric key notation reaches Neovim whole, wherever it falls', async t => {
  const { run } = load(await attached(t));
  for (const [key, typed] of [['<Char-65>', 'A'], ['<Char-0x42>', 'B'], ['<Char-0103>', 'C']]) {
    for (const pad of [0, 4091, 4092, 4093]) {
      const buf = await scratch();
      await run('nvim_control_keys', { keys: `i${'x'.repeat(pad)}${key}<Esc>` });
      assert.equal(await lua('return vim.api.nvim_buf_get_lines(..., 0, -1, true)[1]', buf), `${'x'.repeat(pad)}${typed}`, `${key} after ${pad}`);
    }
  }
});
