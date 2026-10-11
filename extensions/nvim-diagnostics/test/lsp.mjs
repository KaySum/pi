// A scriptable language server. Lines containing "ERROR x" / "WARN x" / "HINT x" become
// diagnostics, so tests control results through file contents; the mode controls behavior.
import { appendFileSync } from 'node:fs';

const [mode, log] = process.argv.slice(2);
const pulls = ['pull', 'slow', 'cancel', 'dynamic', 'error'].includes(mode);
const documents = new Map();
const held = new Map();
const published = new Map();
let buffer = Buffer.alloc(0), nextId = 1000, storms = 4;

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
function diagnose(uri) {
  return (documents.get(uri)?.text ?? '').split('\n').flatMap((line, index) => {
    const match = /(ERROR|WARN|HINT) (.*)/.exec(line);
    return match ? [{ range: { start: { line: index, character: match.index }, end: { line: index, character: line.length } },
      severity: { ERROR: 1, WARN: 2, HINT: 4 }[match[1]], message: match[2], code: match[1][0] + index, source: 'fake' }] : [];
  });
}
const publish = uri => send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: diagnose(uri) } });

function changed(uri) {
  if (mode === 'push') publish(uri);
  // Like marksman: say something only when the answer differs from the last one.
  if (mode === 'onchange' && JSON.stringify(diagnose(uri)) !== published.get(uri)) {
    published.set(uri, JSON.stringify(diagnose(uri)));
    publish(uri);
  }
  if (mode === 'phased') {
    // Like vtsls: clear at once, then report for real after a pause, with progress in between.
    send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } });
    send({ id: nextId++, method: 'window/workDoneProgress/create', params: { token: uri } });
    send({ method: '$/progress', params: { token: uri, value: { kind: 'begin', title: 'checking' } } });
    setTimeout(() => { send({ method: '$/progress', params: { token: uri, value: { kind: 'end' } } }); publish(uri); }, 1500);
  }
  if (mode === 'late') {
    send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } });
    setTimeout(() => publish(uri), 600);
  }
}

function receive(m) {
  if (log) appendFileSync(log, JSON.stringify({ mode, method: m.method, version: m.params?.textDocument?.version, identifier: m.params?.identifier }) + '\n');
  const reply = result => send({ id: m.id, result });
  if (m.method === 'initialize') {
    const capabilities = { textDocumentSync: { openClose: true, change: 1 },
      ...(pulls && mode !== 'dynamic' ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } : {}) };
    setTimeout(() => reply({ capabilities }), mode === 'slow' ? 700 : 0);
  } else if (m.method === 'initialized' && mode === 'dynamic') {
    setTimeout(() => send({ id: nextId++, method: 'client/registerCapability', params: { registrations: [
      { id: 'late', method: 'textDocument/diagnostic', registerOptions: { documentSelector: null, identifier: 'late-provider' } }] } }), 400);
  } else if (m.method === 'textDocument/didOpen' || m.method === 'textDocument/didChange') {
    const { uri, version } = m.params.textDocument;
    documents.set(uri, { version, text: m.params.textDocument.text ?? m.params.contentChanges[0].text });
    changed(uri);
  } else if (m.method === 'textDocument/didClose') {
    if (!pulls && mode !== 'onchange' && mode !== 'silent') send({ method: 'textDocument/publishDiagnostics', params: { uri: m.params.textDocument.uri, diagnostics: [] } });
  } else if (m.method === 'textDocument/diagnostic') {
    const full = { kind: 'full', items: diagnose(m.params.textDocument.uri) };
    if (mode === 'error') send({ id: m.id, error: { code: -32603, message: 'checker crashed' } });
    else if (mode === 'cancel' && storms-- > 0) {
      // Like pyright starting up: ask the client to refresh, which makes it cancel its
      // pending pulls, then answer each cancelled pull with an empty report. Several rounds.
      held.set(m.id, () => reply({ kind: 'full', items: [] }));
      send({ id: nextId++, method: 'workspace/diagnostic/refresh' });
    } else reply(full);
  } else if (m.method === '$/cancelRequest') {
    held.get(m.params.id)?.();
    held.delete(m.params.id);
  } else if (m.method === 'shutdown') reply(null);
  else if (m.method === 'exit') process.exit(0);
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
