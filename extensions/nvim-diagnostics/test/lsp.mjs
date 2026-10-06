// Deterministic push/pull LSP fixture. No network, plugins, or installed servers.
const mode = process.argv[2];
const documents = new Map();
const held = new Set();
let refreshed = false;
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
    reply({ capabilities: { positionEncoding: 'utf-16', textDocumentSync: { openClose: true, change: 1 },
      ...(mode !== 'push' ? { diagnosticProvider: { identifier: 'fixture', interFileDependencies: false, workspaceDiagnostics: false } } : {}) } });
  } else if (m.method === 'textDocument/didOpen' || m.method === 'textDocument/didChange') {
    const { uri, version } = m.params.textDocument;
    const text = m.params.textDocument.text ?? m.params.contentChanges[0].text;
    documents.set(uri, { text, version });
    if (mode === 'push') setTimeout(() => send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
      params: { uri, version, diagnostics: diagnostics(text) } }), 150);
  } else if (m.method === 'textDocument/diagnostic') {
    if (mode === 'hang') return;
    if (mode === 'cancel') {
      setTimeout(() => send({ jsonrpc: '2.0', id: m.id, error: { code: -32800, message: 'Request cancelled' } }), 30);
      return;
    }
    if (mode === 'refresh' && !refreshed) {
      refreshed = true; held.add(m.id);
      send({ jsonrpc: '2.0', id: 'fixture-refresh', method: 'workspace/diagnostic/refresh', params: null });
      return;
    }
    const doc = documents.get(m.params.textDocument.uri);
    setTimeout(() => reply({ kind: 'full', resultId: String(doc?.version), items: diagnostics(doc?.text ?? '') }), 150);
  } else if (m.method === '$/cancelRequest') {
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
