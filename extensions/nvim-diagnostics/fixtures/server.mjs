// Deterministic stdio LSP used only by isolated integration tests.
import { appendFileSync } from "node:fs";
const mode = process.argv[2] || "push";
const delayMs = Number(process.argv[3] || 0);
if (process.argv[4]) appendFileSync(process.argv[4], `${process.pid}\n`);
if (mode === "stubborn") process.on("SIGTERM", () => {});
const documents = new Map();
let input = Buffer.alloc(0);
function send(message) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
function diagnostics(text) {
  const results = [];
  for (const [line, content] of text.split("\n").entries()) {
    for (const [index, marker] of ["BAD", "WARN", "INFO", "HINT"].entries()) {
      const character = content.indexOf(marker);
      if (character >= 0) results.push({ range: { start: { line, character }, end: { line, character: character + marker.length } },
        severity: index + 1, message: `${marker} marker`, source: "fixture", code: `F${index + 1}` });
    }
  }
  return results;
}
function handle(message) {
  if (message.method === "initialize") {
    send({ id: message.id, result: { capabilities: { positionEncoding: "utf-16", textDocumentSync: 1,
      ...(["pull", "pull-error", "both"].includes(mode) ? { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } : {}),
    } } });
  } else if (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange") {
    const doc = message.params.textDocument;
    documents.set(doc.uri, doc.text ?? message.params.contentChanges[0].text);
    if (!["pull", "pull-error"].includes(mode)) setTimeout(() => send({ method: "textDocument/publishDiagnostics", params: {
      uri: doc.uri, version: doc.version, diagnostics: diagnostics(documents.get(doc.uri)),
    } }), delayMs);
  } else if (message.method === "textDocument/diagnostic") {
    if (mode === "pull-error") return send({ id: message.id, error: { code: -32603, message: "Fixture provider failure" } });
    setTimeout(() => send({ id: message.id, result: { kind: "full", items: diagnostics(documents.get(message.params.textDocument.uri) || "") } }), delayMs);
  } else if (message.method === "shutdown") {
    if (mode !== "stubborn") send({ id: message.id, result: null });
  } else if (message.method === "exit") {
    if (mode !== "stubborn") process.exit(0);
  } else if (message.id !== undefined) send({ id: message.id, result: null });
}
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (true) {
    const separator = input.indexOf("\r\n\r\n");
    if (separator < 0) break;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(input.subarray(0, separator).toString())[1]);
    if (input.length < separator + 4 + length) break;
    const message = JSON.parse(input.subarray(separator + 4, separator + 4 + length));
    input = input.subarray(separator + 4 + length);
    handle(message);
  }
});
process.stdin.on("end", () => { if (mode === "stubborn") setInterval(() => {}, 1000); else process.exit(0); });
process.stdout.on("error", () => { if (mode !== "stubborn") process.exit(0); });
