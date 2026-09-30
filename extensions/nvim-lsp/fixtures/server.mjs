// Minimal deterministic LSP server used only by bridge.test.mjs.
let input = Buffer.alloc(0);
const send = (message) => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
function handle(m) {
  if (m.method === "exit") process.exit(0);
  if (m.method === "textDocument/didOpen" || m.method === "textDocument/didChange") {
    const text = m.params.textDocument.text ?? m.params.contentChanges.at(-1).text;
    send({ method: "textDocument/publishDiagnostics", params: {
      uri: m.params.textDocument.uri,
      diagnostics: text.includes("BAD") ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: "Bad marker", source: "fixture" }] : [],
    } });
  }
  if (m.id === undefined) return;
  let result = null;
  if (m.method === "initialize") result = { capabilities: {
    positionEncoding: "utf-16", textDocumentSync: 1, hoverProvider: true,
    definitionProvider: true, referencesProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true,
  } };
  if (m.method === "textDocument/hover") result = { contents: { kind: "plaintext", value: JSON.stringify(m.params.position) } };
  if (m.method === "textDocument/definition" || m.method === "textDocument/references") result = [{ uri: m.params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }];
  if (m.method === "textDocument/documentSymbol") result = [1, 2, 3].map((i) => ({ name: `symbol${i}`, kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }));
  if (m.method === "workspace/symbol") result = [{ name: m.params.query, kind: 12, location: { uri: "file:///fixture", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } }];
  if (m.method === "initialize" && process.argv[2] === "diagnostics-only") {
    result = { capabilities: { textDocumentSync: 1 } };
  }
  if (m.method === "initialize" && process.argv[2] === "delayed") {
    setTimeout(() => send({ id: m.id, result }), 350);
  } else {
    send({ id: m.id, result });
  }
}
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (true) {
    const end = input.indexOf("\r\n\r\n");
    if (end < 0) break;
    const size = Number(/Content-Length: (\d+)/i.exec(input.subarray(0, end).toString())[1]);
    if (input.length < end + 4 + size) break;
    const message = JSON.parse(input.subarray(end + 4, end + 4 + size));
    input = input.subarray(end + 4 + size);
    handle(message);
  }
});
