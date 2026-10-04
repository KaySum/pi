// Deterministic, isolated LSP fixture: no installed language servers or network.
import { appendFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'normal', log = process.argv[3];
const encoding = mode === 'utf8' ? 'utf-8' : mode === 'utf32' ? 'utf-32' : 'utf-16';
const documents = new Map();
let buffer = Buffer.alloc(0), root;
function send(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  process.stdout.write(`Content-Length: ${bytes.length}\r\n\r\n`); process.stdout.write(bytes);
}
function message(m) {
  if (log) appendFileSync(log, JSON.stringify({ method: m.method, params: m.params }) + '\n');
  const reply = result => send({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') {
    root = m.params.rootUri;
    reply({ capabilities: { positionEncoding: encoding, textDocumentSync: { openClose: true, change: 1 },
      ...(mode === 'unsupported' ? {} : { definitionProvider: true, declarationProvider: true, typeDefinitionProvider: true,
        implementationProvider: true, referencesProvider: true, hoverProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true }) } });
  } else if (m.method === 'textDocument/didOpen' || m.method === 'textDocument/didChange') {
    documents.set(m.params.textDocument.uri, m.params.textDocument.text ?? m.params.contentChanges[0].text);
  } else if (m.method === 'shutdown') reply(null);
  else if (m.method === 'exit') process.exit(0);
  else if (m.id != null) {
    if (mode === 'hang') return;
    if (mode === 'error') { send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'fixture failure' } }); return; }
    const uri = m.params.textDocument?.uri ?? documents.keys().next().value;
    const text = documents.get(uri) ?? '';
    const firstLine = text.split('\n')[0];
    const prefix = firstLine.slice(0, Math.max(0, firstLine.indexOf('target')));
    const start = encoding === 'utf-8' ? Buffer.byteLength(prefix) : encoding === 'utf-32' ? [...prefix].length : prefix.length;
    const range = { start: { line: 0, character: start }, end: { line: 0, character: start + 6 } };
    const location = { uri, range };
    let result;
    if (text.includes('EMPTY')) result = m.method === 'textDocument/hover' ? null : [];
    else if (m.method === 'textDocument/hover') result = { range, contents: { kind: 'plaintext', value: JSON.stringify({ text, position: m.params.position }) } };
    else if (m.method === 'textDocument/documentSymbol') result = [{ name: 'target', kind: 5, range, selectionRange: range,
      children: [{ name: 'child', kind: 6, range, selectionRange: range }] }];
    else if (m.method === 'workspace/symbol') result = [
      { name: m.params.query, kind: 12, location },
      { name: 'unresolved', kind: 12, location: { uri } },
    ];
    else if (m.method === 'textDocument/references') result = Array(m.params.context.includeDeclaration ? 2 : 1).fill(location);
    else result = [{ targetUri: uri, targetRange: range, targetSelectionRange: range }];
    if (mode === 'single') result = location;
    if (mode === 'virtual') result = [{ uri: 'untitled:virtual', range }];
    if (mode === 'cross') result = [{ uri: `${root}/target.lsp`, range }];
    if (mode === 'malformed') result = [{ uri, range: { start: { line: -1, character: 0 }, end: { line: 0, character: 1 } } }];
    if (mode === 'large') result = Array.from({ length: 1500 }, (_, i) => ({ name: 'name-' + i + 'x'.repeat(300), kind: 12, location }));
    if (mode === 'delay') setTimeout(() => reply(result), 900); else reply(result);
  }
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n'); if (end < 0) break;
    const size = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + size) break;
    const body = buffer.subarray(end + 4, end + 4 + size); buffer = buffer.subarray(end + 4 + size);
    message(JSON.parse(body));
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));
