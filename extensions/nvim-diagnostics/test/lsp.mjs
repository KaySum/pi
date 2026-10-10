// Deterministic push/pull LSP fixture. No network, plugins, or installed servers.
const mode = process.argv[2];
const dynamic = mode.startsWith('dynamic');
const documents = new Map();
const held = new Set();
const heldFull = new Map();
let refreshed = false, registered = false, switched = false;
let buffer = Buffer.alloc(0);
function send(value) {
  const body = Buffer.from(JSON.stringify(value));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
function diagnostics(text) {
  const index = text.indexOf('BAD');
  return index < 0 ? [] : [{ range: { start: { line: 0, character: index }, end: { line: 0, character: index + 3 } },
    severity: 1, source: 'fixture-lsp', code: 'E1', message: 'BAD is not allowed' }];
}
function message(m) {
  const reply = result => send({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') {
    if (mode === 'init-hang') return;
    reply({ capabilities: { positionEncoding: 'utf-16', textDocumentSync: { openClose: true, change: 1 },
      ...(mode !== 'push' && (!dynamic || mode === 'dynamic-selectors') ? { diagnosticProvider: { identifier: mode === 'default' ? undefined : 'fixture', interFileDependencies: false, workspaceDiagnostics: false } } : {}) } });
  } else if (m.method === 'textDocument/didOpen' || m.method === 'textDocument/didChange') {
    const { uri, version } = m.params.textDocument;
    const text = m.params.textDocument.text ?? m.params.contentChanges[0].text;
    documents.set(uri, { text, version });
    if (dynamic && !registered) {
      registered = true;
      const providers = mode.startsWith('dynamic-selectors') ? [
        { identifier: 'wrong-buffer', documentSelector: [{ scheme: 'file', pattern: '**/*.excluded' }] },
        { identifier: 'fixture-dynamic', documentSelector: [{ scheme: 'file', pattern: '**/*.lsp' }, { pattern: '**/*.lsp' }] },
      ] : mode === 'dynamic-multi' || mode === 'dynamic-cancel' ? [
        { identifier: 'fixture-dynamic' }, { identifier: 'fixture-other' }, { identifier: 'fixture-dynamic' },
      ] : [{ identifier: 'fixture-dynamic' }];
      const register = () => send({ jsonrpc: '2.0', id: 'fixture-register', method: 'client/registerCapability', params: {
        registrations: providers.map((options, i) => ({ id: `provider-${i}`, method: 'textDocument/diagnostic',
          registerOptions: { interFileDependencies: false, workspaceDiagnostics: false, ...options } })),
      } });
      if (mode === 'dynamic-late') setTimeout(register, 800); else register();
    }
    if (mode === 'push') setTimeout(() => send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
      params: { uri, version, diagnostics: diagnostics(text) } }), 150);
  } else if (m.method === 'fixture/switch') {
    switched = true;
    send({ jsonrpc: '2.0', id: 'fixture-unregister', method: 'client/unregisterCapability', params: {
      unregisterations: [{ id: 'provider-0', method: 'textDocument/diagnostic' }],
    } });
    send({ jsonrpc: '2.0', id: 'fixture-replace', method: 'client/registerCapability', params: {
      registrations: [{ id: 'replacement', method: 'textDocument/diagnostic', registerOptions: {
        identifier: mode === 'dynamic-replace' ? 'fixture-dynamic' : 'fixture-replacement',
        interFileDependencies: mode === 'dynamic-replace', workspaceDiagnostics: false,
      } }],
    } });
    reply(null);
  } else if (m.method === 'fixture/release') {
    for (const [id, items] of heldFull) send({ jsonrpc: '2.0', id, result: { kind: 'full', items } });
    heldFull.clear(); reply(null);
  } else if (m.method === 'textDocument/diagnostic') {
    if (mode === 'hang') return;
    if (['dynamic-switch', 'dynamic-replace'].includes(mode) && !switched) { held.add(m.id); return; }
    if (mode === 'error') {
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'Fixture provider failed' } }); return;
    }
    if (mode === 'unchanged') { reply({ kind: 'unchanged', resultId: 'unverified' }); return; }
    if (mode === 'malformed') { reply(42); return; }
    if (mode === 'dynamic-legacy' && m.params.identifier !== 'fixture-dynamic') {
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Expected dynamically registered identifier' } });
      return;
    }
    if (mode === 'cancel' || (mode === 'dynamic-cancel' && m.params.identifier === 'fixture-other')) {
      setTimeout(() => send({ jsonrpc: '2.0', id: m.id, error: { code: -32800, message: 'Request cancelled' } }), 30);
      return;
    }
    if (mode === 'refresh' && !refreshed) {
      refreshed = true; held.add(m.id);
      send({ jsonrpc: '2.0', id: 'fixture-refresh', method: 'workspace/diagnostic/refresh', params: null });
      return;
    }
    const doc = documents.get(m.params.textDocument.uri);
    let items = mode === 'empty' ? [] : diagnostics(doc?.text ?? '');
    if (mode === 'cancel-full') { heldFull.set(m.id, items); return; }
    if (mode === 'bad-range' && items.length) items[0].range = { start: { line: 99, character: 0 }, end: { line: 99, character: 1 } };
    if (mode === 'many') items = Array.from({ length: 10001 }, () => diagnostics('BAD')[0]);
    setTimeout(() => reply({ kind: 'full', resultId: String(doc?.version), items }), mode === 'delay' ? 700 : 150);
  } else if (m.method === '$/cancelRequest') {
    // Cancellation need not produce RequestCancelled: Pyright can return an
    // ordinary empty full report. The consumer must still reject that response.
    if (heldFull.delete(m.params.id)) send({ jsonrpc: '2.0', id: m.params.id, result: { kind: 'full', items: [] } });
    if (held.delete(m.params.id)) send({ jsonrpc: '2.0', id: m.params.id, error: { code: -32800, message: 'Request cancelled' } });
  } else if (m.method === 'shutdown') reply(null);
  else if (m.method === 'exit') process.exit(0);
  else if (m.method && m.id != null) reply(null);
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const size = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
    if (buffer.length < headerEnd + 4 + size) break;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + size);
    buffer = buffer.subarray(headerEnd + 4 + size);
    message(JSON.parse(body));
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));
