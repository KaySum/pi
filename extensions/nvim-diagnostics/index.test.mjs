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
export class DiagnosticsClient {
 constructor() { this.calls=[]; this.closed=0; clients.push(this); }
 setService(info) { this.service=info; }
 close() { this.service=undefined; this.closed++; }
 async diagnose(params,cwd,signal) {
  signal?.throwIfAborted();
  if(!this.service) throw new Error('service unavailable');
  const report={params,cwd}; this.calls.push({params,cwd,signal}); return report;
 }
}
export async function formatReport(report) { return {text:'diagnostics report',details:report}; }
`);
const { clients } = await import(mockURL);
const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
const { default: register } = await import(dataURL(stripTypeScriptTypes(source)
  .replace("'./core.mjs'", JSON.stringify(mockURL)).replace("'@earendil-works/pi-ai'", JSON.stringify(typeURL))
  .replace("'../nvim-service/discovery.mjs'", JSON.stringify(new URL('../nvim-service/discovery.mjs', import.meta.url).href))));

function setup(t) {
  const handlers = new Map(), tools = [], events = new EventEmitter();
  register({ on: (event, handler) => handlers.set(event, handler), events, registerTool: tool => tools.push(tool) });
  const client = clients.at(-1);
  assert.equal(client.calls.length, 0);
  assert.equal(client.service, undefined);
  assert.equal(tools.length, 1);
  const emit = name => handlers.get(name)?.({ type: name }, { cwd: '/project' });
  t.after(() => emit('session_shutdown'));
  let info;
  events.on('nvim-service:get', request => request.reply(info));
  return { client, tool: tools[0], emit, events, setInfo: value => { info = value; },
    execute: (params, signal) => tools[0].execute('id', params, signal, undefined, { cwd: '/project' }) };
}
const first = { socket: '/tmp/service/one.sock', pid: 100 };
const second = { socket: '/tmp/service/two.sock', pid: 200 };

test('registers a bounded real tool without starting resources or injecting messages', t => {
  const h = setup(t);
  assert.equal(h.tool.name, 'nvim_diagnostics');
  assert.equal(h.tool.executionMode, 'sequential');
  assert.equal(h.tool.parameters.properties.files.maxItems, 32);
  assert.equal(h.tool.parameters.properties.timeoutMs.maximum, 30000);
  assert.match(h.tool.promptGuidelines.join(' '), /empty or cached results do not prove/);
  assert.match(h.tool.description, /never saves/);
});

test('does not wait for a later service handler; ready/get discover it on demand', async t => {
  const h = setup(t);
  h.emit('session_start');
  assert.equal(h.client.service, undefined);
  await assert.rejects(h.execute({ files: ['a'] }), /unavailable/);
  h.setInfo(first);
  h.events.emit('nvim-service:ready', first);
  const params = { files: ['a'], severities: ['warning'] };
  const controller = new AbortController();
  const result = await h.execute(params, controller.signal);
  assert.deepEqual(result.content, [{ type: 'text', text: 'diagnostics report' }]);
  assert.deepEqual(result.details, { params, cwd: '/project' });
  assert.equal(h.client.calls[0].signal, controller.signal);
});

test('late loading queries current service; stale stopped events cannot remove the new one', async t => {
  const h = setup(t);
  h.setInfo(second); h.emit('session_start');
  assert.deepEqual(h.client.service, second);
  h.events.emit('nvim-service:stopped', first);
  assert.deepEqual(h.client.service, second);
  await h.execute({ files: ['a'] });
  h.setInfo(undefined); h.events.emit('nvim-service:stopped', second);
  assert.equal(h.client.service, undefined);
  await assert.rejects(h.execute({ files: ['a'] }), /unavailable/);
  h.setInfo(first); h.events.emit('nvim-service:ready', first);
  await h.execute({ files: ['a'] });
  h.emit('session_shutdown'); h.emit('session_shutdown');
  assert.equal(h.client.service, undefined);
});

test('rejects malformed discovery; passes cancellation without publishing a report', async t => {
  const h = setup(t);
  for (const info of [{ socket: 'relative', pid: 1 }, { socket: '/tmp/x', pid: -1 }, null, 'bad']) {
    h.setInfo(info); h.emit('session_start');
    assert.equal(h.client.service, undefined);
  }
  h.setInfo(first);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.execute({ files: ['a'] }, controller.signal), { name: 'AbortError' });
  assert.equal(h.client.calls.length, 0);
});
