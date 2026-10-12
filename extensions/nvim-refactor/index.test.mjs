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

// A server that renames the first word of the file, whatever it is asked about.
const SERVER = `vim.api.nvim_create_autocmd('BufReadPost', { callback = function(ev)
  vim.lsp.start({ name = 'first', cmd = function()
    local closing = false
    return {
      request = function(method, params, callback)
        if method == 'initialize' then callback(nil, { capabilities = { renameProvider = true } })
        elseif method == 'textDocument/rename' then
          local word = vim.api.nvim_buf_get_lines(ev.buf, 0, 1, false)[1]:match('^%w+')
          callback(nil, { changes = { [params.textDocument.uri] = { { range = { start = { line = 0, character = 0 }, ['end'] = { line = 0, character = #word } }, newText = params.newName } } } })
        else callback(nil, vim.NIL) end
        return true, 1
      end,
      notify = function() return true end,
      is_closing = function() return closing end,
      terminate = function() closing = true end,
    }
  end }, { bufnr = ev.buf })
end })`;

test('one tool, connected to the service only through the event bus', async t => {
  const bus = new EventEmitter(), tools = [], commands = {}, notes = [];
  register({ events: { on: (channel, handler) => bus.on(channel, handler), emit: (channel, data) => bus.emit(channel, data) },
    on: () => {}, registerTool: tool => tools.push(tool), registerCommand: (name, command) => { commands[name] = command; } });
  const [tool] = tools;
  assert.equal(tools.length, 1);
  assert.equal(tool.name, 'nvim_refactor');
  // Without a snippet a custom tool is left out of the system prompt's list of available tools.
  assert.match(tool.promptSnippet, /Rename symbols/);
  assert.deepEqual(tool.parameters.properties.action.anyOf.map(option => option.const), ['rename', 'actions', 'apply']);

  const directory = await realpath(await mkdtemp('/tmp/pi-refactor-test-'));
  const call = params => tool.execute('id', params, undefined, undefined, { cwd: directory });
  const rename = { action: 'rename', file: 'a.txt', line: 1, symbol: 'one', newName: 'uno' };
  await assert.rejects(call(rename), /Neovim service unavailable/);
  const command = async (args = '') => { await commands['nvim-refactor'].handler(args, { cwd: directory, ui: { notify: (text, type) => notes.push(`${type}: ${text}`) } }); return notes.at(-1); };
  assert.match(await command('actions a.txt'), /^warning: nvim-refactor: Neovim service unavailable[^]*\nUsage: \/nvim-refactor rename/);
  assert.equal(await command(), 'info: Nothing has been refactored in this session.');

  await writeFile(join(directory, 'init.lua'), SERVER);
  const service = launch({ cwd: directory, init: join(directory, 'init.lua'), graceMs: 100, killMs: 300 });
  const nvim = await openNvim(await service.ready);
  t.after(async () => { nvim.close(); await service.stop(); await rm(directory, { recursive: true, force: true }); });
  bus.emit('nvim-service:ready', nvim);
  await writeFile(join(directory, 'a.txt'), 'one two\n');
  assert.deepEqual((await call(rename)).content, [{ type: 'text', text: 'Renamed one to uno in 1 file — first\na.txt: lines 1 changed' }]);
  assert.equal(await readFile(join(directory, 'a.txt'), 'utf8'), 'uno two\n');
  await assert.rejects(call({ ...rename, newName: undefined }), /rename needs newName/);
  assert.deepEqual((await call({ action: 'actions', file: 'a.txt' })).content, [{ type: 'text', text: 'No language server for a.txt offers code actions.' }]);

  // The command shows what the last request returned; with arguments it makes one.
  assert.match(await command(), /^info: Last request \d+ s ago, took \d+ ms: \{"action":"actions","file":"a\.txt"\}\nNo language server for a\.txt offers code actions\.$/);
  assert.equal(await command('rename a.txt 1 uno eins'), 'info: Renamed uno to eins in 1 file — first\na.txt: lines 1 changed');

  await nvim.keys(':echo "one\\ntwo"<CR>');
  await assert.rejects(call(rename), /waiting at a prompt[^]*one\ntwo\nPress ENTER/);
  await nvim.keys('<CR>');
  bus.emit('nvim-service:stopped', {});
  await assert.rejects(call(rename), /Neovim service unavailable/);
});
