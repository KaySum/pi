// A scriptable language server for navigation. A line `def NAME` defines NAME; one that
// starts with two spaces (`  def NAME`) is a child of the definition above it. Every
// other mention of NAME is a reference. The mode controls how the server behaves.
import { appendFileSync } from 'node:fs';

const [mode, log] = process.argv.slice(2);
const documents = new Map();
const failed = new Set();
const started = Date.now();
let buffer = Buffer.alloc(0), nextId = 1000;

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
const range = (line, start, length) => ({ start: { line, character: start }, end: { line, character: start + length } });
function mentions(name, definitionsOnly) {
  const found = [];
  for (const [uri, text] of documents) {
    text.split('\n').forEach((line, index) => {
      const pattern = new RegExp(definitionsOnly ? `(?<=^\\s*def )${name}\\b` : `\\b${name}\\b`, 'g');
      for (const match of line.matchAll(pattern)) found.push({ uri, range: range(index, match.index, name.length) });
    });
  }
  return found;
}
function wordAt({ textDocument, position }) {
  const line = (documents.get(textDocument.uri) ?? '').split('\n')[position.line] ?? '';
  for (const match of line.matchAll(/[\p{L}\p{N}_]+/gu)) {
    if (match.index <= position.character && position.character <= match.index + match[0].length) return match[0];
  }
}
function outline(uri) {
  const top = [];
  (documents.get(uri) ?? '').split('\n').forEach((line, index) => {
    const match = /^(\s*)def (\w+)/.exec(line);
    if (!match) return;
    const symbol = { name: match[2], kind: match[1] ? 6 : 12, range: range(index, 0, line.length), selectionRange: range(index, match[1].length + 4, match[2].length), children: [] };
    (match[1] && top.length ? top.at(-1).children : top).push(symbol);
  });
  return top.reverse(); // Servers do not promise source order.
}

function answer(m) {
  const word = m.params.position && wordAt(m.params);
  switch (m.method) {
    case 'textDocument/definition': {
      const found = word ? mentions(word, true) : [];
      return mode === 'links' ? found.map(l => ({ targetUri: l.uri, targetRange: l.range, targetSelectionRange: l.range })) : found.length === 1 ? found[0] : found;
    }
    case 'textDocument/references': return word ? mentions(word, false) : [];
    case 'textDocument/hover': return word ? { contents: { kind: 'markdown', value: `**${word}**: ${mentions(word, true).length ? 'defined here' : 'unknown'}` } } : null;
    case 'textDocument/documentSymbol': return outline(m.params.textDocument.uri);
    case 'workspace/symbol': return [...documents.keys()].flatMap(uri => outline(uri).flatMap(s => [s, ...s.children])
      .filter(s => s.name.toLowerCase().includes(m.params.query.toLowerCase())).map(s => ({ name: s.name, kind: s.kind, location: { uri, range: s.selectionRange } })));
  }
}

function receive(m) {
  if (log) appendFileSync(log, JSON.stringify({ mode, method: m.method, version: m.params?.textDocument?.version }) + '\n');
  if (m.method === 'initialize') {
    const capabilities = { textDocumentSync: { openClose: true, change: 1 }, ...(mode === 'plain' ? {} : { definitionProvider: true, referencesProvider: true,
      hoverProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true }) };
    send({ id: m.id, result: { capabilities } });
    // Like rust-analyzer: answers with nothing while it loads, and only says it is loading a moment in.
    if (mode === 'loading') {
      setTimeout(() => {
        send({ id: nextId++, method: 'window/workDoneProgress/create', params: { token: 'load' } });
        send({ method: '$/progress', params: { token: 'load', value: { kind: 'begin', title: 'loading' } } });
      }, 700);
      setTimeout(() => send({ method: '$/progress', params: { token: 'load', value: { kind: 'end' } } }), 1500);
    }
  } else if (m.method === 'textDocument/didOpen' || m.method === 'textDocument/didChange') {
    documents.set(m.params.textDocument.uri, m.params.textDocument.text ?? m.params.contentChanges[0].text);
  } else if (m.method === 'shutdown') send({ id: m.id, result: null });
  else if (m.method === 'exit') process.exit(0);
  else if (m.id !== undefined && m.method) {
    // The server's state "changed under" the first request of each kind.
    if (mode === 'flaky' && !failed.has(m.method)) { failed.add(m.method); return send({ id: m.id, error: { code: -32801, message: 'content modified' } }); }
    if (mode === 'broken') return send({ id: m.id, error: { code: -32603, message: 'index corrupt' } });
    if (mode === 'loading' && Date.now() - started < 1500) return send({ id: m.id, result: m.method === 'textDocument/hover' ? null : [] });
    send({ id: m.id, result: answer(m) ?? null });
  }
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const size = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + size) return;
    receive(JSON.parse(buffer.subarray(end + 4, end + 4 + size)));
    buffer = buffer.subarray(end + 4 + size);
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));
