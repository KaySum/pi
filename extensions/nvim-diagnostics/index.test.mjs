import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launch } from '../nvim-service/service.mjs';
import { openNvim } from '../nvim-service/nvim.mjs';

// The extension has no dependencies of its own; Pi's schema library comes from the service's.
const manifest = new URL('../nvim-service/node_modules/@earendil-works/pi-ai/package.json', import.meta.url);
const schema = new URL(JSON.parse(await readFile(manifest, 'utf8')).exports['.'].import, manifest).href;
const source = stripTypeScriptTypes(await readFile(new URL('./index.ts', import.meta.url), 'utf8'))
  .replace(/'(\.\.?\/[a-z/-]+\.mjs)'/g, (_, specifier) => JSON.stringify(import.meta.resolve(specifier)))
  .replace("'@earendil-works/pi-ai'", JSON.stringify(schema));
const { default: register } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('one tool, connected to the service only through the event bus', async t => {
  const bus = new EventEmitter(), hooks = new EventEmitter(), tools = [], commands = {}, notes = [];
  register({ events: { on: (channel, handler) => bus.on(channel, handler), emit: (channel, data) => bus.emit(channel, data) },
    on: (event, handler) => hooks.on(event, handler), registerTool: tool => tools.push(tool), registerCommand: (name, command) => { commands[name] = command; } });
  const [tool] = tools;
  assert.equal(tools.length, 1);
  assert.equal(tool.name, 'nvim_diagnostics');
  assert.equal(tool.parameters.properties.files.maxItems, 32);
  assert.deepEqual(tool.parameters.properties.severity.anyOf.map(option => option.const), ['error', 'warning', 'info', 'hint']);

  const directory = await realpath(await mkdtemp('/tmp/pi-diagnostics-test-'));
  const call = params => tool.execute('id', params, undefined, undefined, { cwd: directory });
  await assert.rejects(call({ files: ['a.txt'] }), /Neovim service unavailable/);
  const command = async (args = '') => { await commands['nvim-diagnostics'].handler(args, { cwd: directory, ui: { notify: (text, type) => notes.push(`${type}: ${text}`) } }); return notes.at(-1); };
  assert.match(await command(), /^warning: nvim-diagnostics: Neovim service unavailable/);

  const service = launch({ cwd: directory, init: 'NONE', graceMs: 100, killMs: 300 });
  const nvim = await openNvim(await service.ready);
  t.after(async () => { nvim.close(); await service.stop(); await rm(directory, { recursive: true, force: true }); });
  bus.emit('nvim-service:ready', nvim);
  await writeFile(join(directory, 'a.txt'), 'text');
  assert.deepEqual((await call({ files: ['a.txt', 'nope.txt'] })).content, [{ type: 'text', text: 'a.txt: no language server or linter for this file\nnope.txt: no such file' }]);
  await assert.rejects(call({ files: [] }), /files must be 1-32 paths/);

  // The command shows the servers and what the last check returned; with paths it runs a traced check.
  assert.match(await command(), /^info: No language servers are running.*\n\nLast check \d+ s ago, took \d+ ms:\na\.txt: no language server or linter for this file\nnope\.txt: no such file$/);
  assert.match(await command('a.txt  nope.txt'), /^info: a\.txt: no language server or linter for this file\nnope\.txt: no such file\n\nTimeline \(\d+ ms\):\n +\d+ ms  a\.txt: unchanged since the last check$/);

  // Pi's own edits and writes start a background check; other tools and failed edits do not.
  const edited = input => hooks.emit('tool_result', input, { cwd: directory });
  await writeFile(join(directory, 'new.txt'), 'text');
  await writeFile(join(directory, 'other.txt'), 'text');
  edited({ toolName: 'write', input: { path: 'new.txt' }, isError: false });
  edited({ toolName: 'edit', input: { path: 'other.txt' }, isError: true });
  edited({ toolName: 'read', input: { path: 'other.txt' }, isError: false });
  edited({ toolName: 'bash', input: { command: 'ls' }, isError: false });
  const loaded = () => nvim.lua('local dir = ...; return { vim.fn.bufloaded(dir .. "/new.txt"), vim.fn.bufloaded(dir .. "/other.txt") }', [directory]);
  for (let i = 0; i < 50 && (await loaded())[0] === 0; i++) await delay(50);
  await delay(500);
  assert.deepEqual(await loaded(), [1, 0]);

  await nvim.keys(':echo "one\\ntwo"<CR>');
  await assert.rejects(call({ files: ['a.txt'] }), /waiting at a prompt[^]*one\ntwo\nPress ENTER/);
  await nvim.keys('<CR>');
  bus.emit('nvim-service:stopped', {});
  await assert.rejects(call({ files: ['a.txt'] }), /Neovim service unavailable/);
});
