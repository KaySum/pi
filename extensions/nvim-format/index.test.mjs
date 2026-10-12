import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
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
  const bus = new EventEmitter(), tools = [], commands = {}, notes = [];
  register({ events: { on: (channel, handler) => bus.on(channel, handler), emit: (channel, data) => bus.emit(channel, data) },
    on: () => {}, registerTool: tool => tools.push(tool), registerCommand: (name, command) => { commands[name] = command; } });
  const [tool] = tools;
  assert.equal(tools.length, 1);
  assert.equal(tool.name, 'nvim_format');
  // Without a snippet a custom tool is left out of the system prompt's list of available tools.
  assert.match(tool.promptSnippet, /Format files/);
  assert.equal(tool.parameters.properties.files.maxItems, 32);

  const directory = await realpath(await mkdtemp('/tmp/pi-format-test-'));
  const call = params => tool.execute('id', params, undefined, undefined, { cwd: directory });
  await assert.rejects(call({ files: ['a.txt'] }), /Neovim service unavailable/);
  const command = async (args = '') => { await commands['nvim-format'].handler(args, { cwd: directory, ui: { notify: (text, type) => notes.push(`${type}: ${text}`) } }); return notes.at(-1); };
  assert.match(await command('a.txt'), /^warning: nvim-format: Neovim service unavailable/);
  assert.equal(await command(), 'info: Nothing has been formatted in this session.');

  await writeFile(join(directory, 'init.lua'), `package.preload.conform = function()
  return {
    list_formatters_to_run = function() return { { name = 'upper' } }, false end,
    format = function(opts, callback)
      vim.api.nvim_buf_set_lines(opts.bufnr, 0, -1, false, vim.tbl_map(string.upper, vim.api.nvim_buf_get_lines(opts.bufnr, 0, -1, false)))
      callback()
    end,
  }
end`);
  const service = launch({ cwd: directory, init: join(directory, 'init.lua'), graceMs: 100, killMs: 300 });
  const nvim = await openNvim(await service.ready);
  t.after(async () => { nvim.close(); await service.stop(); await rm(directory, { recursive: true, force: true }); });
  bus.emit('nvim-service:ready', nvim);
  await writeFile(join(directory, 'a.txt'), 'text\n');
  assert.deepEqual((await call({ files: ['a.txt', 'nope.txt'] })).content, [{ type: 'text', text: 'a.txt: formatted, lines 1 changed — upper\nnope.txt: no such file' }]);
  assert.equal(await readFile(join(directory, 'a.txt'), 'utf8'), 'TEXT\n');
  await assert.rejects(call({ files: [] }), /files must be 1-32 paths/);

  // The command shows what the last formatting returned; with paths it formats them.
  assert.match(await command(), /^info: Last formatting \d+ s ago, took \d+ ms:\na\.txt: formatted, lines 1 changed — upper\nnope\.txt: no such file$/);
  await writeFile(join(directory, 'b.txt'), 'more\n');
  assert.equal(await command('a.txt  b.txt'), 'info: a.txt: already formatted — upper\nb.txt: formatted, lines 1 changed — upper');

  await nvim.keys(':echo "one\\ntwo"<CR>');
  await assert.rejects(call({ files: ['a.txt'] }), /waiting at a prompt[^]*one\ntwo\nPress ENTER/);
  await nvim.keys('<CR>');
  bus.emit('nvim-service:stopped', {});
  await assert.rejects(call({ files: ['a.txt'] }), /Neovim service unavailable/);
});
