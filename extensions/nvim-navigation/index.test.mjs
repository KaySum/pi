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
  const bus = new EventEmitter(), tools = [];
  register({ events: { on: (channel, handler) => bus.on(channel, handler), emit: (channel, data) => bus.emit(channel, data) },
    on: () => {}, registerTool: tool => tools.push(tool) });
  const [tool] = tools;
  assert.equal(tools.length, 1);
  assert.equal(tool.name, 'nvim_navigate');
  assert.equal(tool.executionMode, 'sequential');
  // Without a snippet a custom tool is left out of the system prompt's list of available tools.
  assert.match(tool.promptSnippet, /definitions, references/);
  assert.deepEqual(tool.parameters.properties.action.anyOf.map(option => option.const),
    ['definition', 'type', 'implementation', 'declaration', 'references', 'hover', 'symbols', 'workspace_symbols']);
  assert.deepEqual(tool.parameters.required, ['action', 'file']);

  const directory = await realpath(await mkdtemp('/tmp/pi-navigation-test-'));
  const call = params => tool.execute('id', params, undefined, undefined, { cwd: directory });
  await assert.rejects(call({ action: 'symbols', file: 'a.txt' }), /Neovim service unavailable/);

  const service = launch({ cwd: directory, init: 'NONE', graceMs: 100, killMs: 300 });
  const nvim = await openNvim(await service.ready);
  t.after(async () => { nvim.close(); await service.stop(); await rm(directory, { recursive: true, force: true }); });
  bus.emit('nvim-service:ready', nvim);
  await writeFile(join(directory, 'a.txt'), 'text');
  assert.deepEqual((await call({ action: 'symbols', file: 'a.txt' })).content, [{ type: 'text', text: 'No language server for a.txt.' }]);
  await assert.rejects(call({ action: 'hover', file: 'a.txt' }), /hover needs line/);

  await nvim.keys(':echo "one\\ntwo"<CR>');
  await assert.rejects(call({ action: 'symbols', file: 'a.txt' }), /waiting at a prompt[^]*one\ntwo\nPress ENTER/);
});
