import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const binary = realpathSync(process.env.PI_TEST_BINARY || execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const libexec = resolve(dirname(binary), '../libexec/bin/pi');
const requirePi = createRequire(existsSync(libexec) ? realpathSync(libexec) : binary);
const manifest = requirePi.resolve.paths('@earendil-works/pi-ai').map(p => join(p, '@earendil-works/pi-ai/package.json')).find(existsSync);
assert.ok(manifest, 'Cannot locate Pi schema library; set PI_TEST_BINARY');
const pkg = JSON.parse(await readFile(manifest, 'utf8'));
const typeURL = pathToFileURL(resolve(dirname(manifest), pkg.exports['.'].import)).href;
const dataURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const mockURL = dataURL(`
export const clients=[];
export class SemanticClient {
 constructor(){this.calls=[];clients.push(this);}
 setService(info){this.service=info;}
 close(){this.service=undefined;}
 async query(params,cwd,signal){signal?.throwIfAborted(); if(!this.service)throw new Error('unavailable');this.calls.push({params,cwd,signal});return {params,cwd};}
}
export async function formatReport(report){return {text:'semantic result',details:report};}
`);
const { clients } = await import(mockURL);
const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
const { default: register } = await import(dataURL(stripTypeScriptTypes(source)
  .replace("'./core.mjs'", JSON.stringify(mockURL)).replace("'@earendil-works/pi-ai'", JSON.stringify(typeURL))
  .replace("'../nvim-service/discovery.mjs'", JSON.stringify(new URL('../nvim-service/discovery.mjs', import.meta.url).href))));
function setup(t) {
  const handlers = new Map(), tools = new Map(), events = new EventEmitter();
  register({ on: (name, fn) => handlers.set(name, fn), events, registerTool: tool => tools.set(tool.name, tool) });
  const client = clients.at(-1);
  assert.equal(client.service, undefined); assert.equal(client.calls.length, 0);
  t.after(() => handlers.get('session_shutdown')());
  let info;
  events.on('nvim-service:get', request => request.reply(info));
  return { client, handlers, tools, events, setInfo: value => { info = value; },
    execute: (name, args, signal) => tools.get(name).execute('id', args, signal, undefined, { cwd: '/project' }) };
}
const info = { socket: '/tmp/pi-semantic-test.sock', pid: 101 };

test('registers exactly three read-only bounded tools with inert initialization', t => {
  const h = setup(t);
  assert.deepEqual([...h.tools.keys()], ['nvim_navigate', 'nvim_hover', 'nvim_symbols']);
  for (const tool of h.tools.values()) {
    assert.equal(tool.executionMode, 'sequential');
    assert.equal(tool.parameters.properties.file.maxLength, 4096);
    assert.equal(tool.parameters.properties.timeoutMs.maximum, 30000);
    assert.match(tool.description, /never saves or applies edits/);
  }
  assert.deepEqual(h.tools.get('nvim_navigate').parameters.properties.kind.anyOf.map(s => s.const), ['definition', 'declaration', 'type_definition', 'implementation', 'references']);
});

test('maps tool parameters to allowed operations and preserves scope, cwd and abort signals', async t => {
  const h = setup(t); h.setInfo(info);
  const controller = new AbortController();
  const args = { file: 'a.ts', line: 2, column: 3, kind: 'references', includeDeclaration: false };
  const result = await h.execute('nvim_navigate', args, controller.signal);
  assert.equal(result.details.params.operation, 'references');
  assert.equal(h.client.calls[0].signal, controller.signal);
  assert.equal(result.details.cwd, '/project');
  assert.equal((await h.execute('nvim_hover', args)).details.params.operation, 'hover');
  assert.equal((await h.execute('nvim_symbols', { file: 'a' })).details.params.operation, 'document_symbols');
  assert.equal((await h.execute('nvim_symbols', { file: 'a', scope: 'workspace', query: 'name' })).details.params.operation, 'workspace_symbols');
  assert.throws(() => h.execute('nvim_symbols', { file: 'a', scope: 'bad' }), /scope/);
});

test('discovery supports load ordering, stale stopped events, replacement and shutdown', async t => {
  const h = setup(t);
  h.handlers.get('session_start')();
  await assert.rejects(h.execute('nvim_hover', { file: 'a', line: 1, column: 1 }), /unavailable/);
  h.setInfo(info); h.events.emit('nvim-service:ready', info);
  h.events.emit('nvim-service:stopped', { socket: '/tmp/old.sock', pid: 100 });
  assert.deepEqual(h.client.service, info);
  h.setInfo(undefined); h.events.emit('nvim-service:stopped', info);
  assert.equal(h.client.service, undefined);
  h.setInfo(info); h.handlers.get('session_start')();
  assert.deepEqual(h.client.service, info);
  h.handlers.get('session_shutdown')(); h.handlers.get('session_shutdown')();
  assert.equal(h.client.service, undefined);
});

test('rejects malformed discovery and propagates caller cancellation', async t => {
  const h = setup(t);
  h.setInfo({ socket: 'relative', pid: 1 }); h.handlers.get('session_start')();
  assert.equal(h.client.service, undefined);
  h.setInfo(info); const controller = new AbortController(); controller.abort();
  await assert.rejects(h.execute('nvim_hover', { file: 'a', line: 1, column: 1 }, controller.signal), { name: 'AbortError' });
});
