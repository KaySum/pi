import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HeadlessLsp, expressionFor, formatResult } from "./bridge.mjs";

const luaString = (s) => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
test("headless LSP lifecycle, disk reload, navigation, encoding and isolation", { timeout: 45000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-lsp-test-"));
  const init = join(cwd, "init.lua");
  const server = fileURLToPath(new URL("./fixtures/server.mjs", import.meta.url));
  await writeFile(init, `vim.api.nvim_create_autocmd('BufEnter', { callback = function(ev)
    if vim.bo[ev.buf].buftype == '' and vim.api.nvim_buf_get_name(ev.buf) ~= '' then
      vim.lsp.start({name='fixture',cmd={${luaString(process.execPath)},${luaString(server)}},root_dir=${luaString(cwd)}})
    end
  end })\n`);
  const bridge = new HeadlessLsp({ init });
  const file = "a 'quoted' file.txt";
  const request = (args, signal) => bridge.request({ file, timeout_ms: 3000, ...args }, cwd, signal);
  try {
    await writeFile(join(cwd, file), "BAD 😀 target\n");
    const diagnostics = await request({ action: "diagnostics", wait_ms: 150 });
    assert.equal(diagnostics.diagnostics[0].message, "Bad marker");
    assert.equal(diagnostics.diagnostics[0].column, 1);
    const child = bridge.child;
    const socket = bridge.socket;
    const hover = await request({ action: "hover", line: 1, column: 10, expected_text: "target" });
    assert.deepEqual(hover.position, { line: 1, column: 10, sourceLine: "BAD 😀 target", expected_text: "target" });
    assert.deepEqual(JSON.parse(hover.results[0].result.contents.value), { line: 0, character: 7 });
    const [definition, references] = await Promise.all([
      request({ action: "definition", target: "BAD" }),
      request({ action: "references", line: 1, column: 1, expected_text: "BAD" }),
    ]);
    assert.equal(definition.results[0].result.length, 1);
    assert.equal(definition.position.column, 1);
    const anchored = await request({ action: "hover", target: "target", anchor: "😀 target" });
    assert.equal(anchored.position.column, 10);
    assert.equal(anchored.position.target, "target");
    assert.deepEqual(JSON.parse(anchored.results[0].result.contents.value), { line: 0, character: 7 });
    assert.equal(references.results[0].result.length, 1);
    assert.equal(bridge.child, child);
    const symbols = await request({ action: "symbols", limit: 1 });
    assert.equal(symbols.results[0].result.length, 1);
    assert.equal(symbols.results[0].omitted, 2);
    const workspace = await request({ action: "workspace_symbols", query: "needle" });
    assert.equal(workspace.results[0].result[0].name, "needle");
    await writeFile(join(cwd, file), "good now\n");
    const clean = await request({ action: "diagnostics", wait_ms: 200 });
    assert.deepEqual(clean.diagnostics, []);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(request({ action: "symbols" }, abort.signal), /abort/i);
    await assert.rejects(request({ action: "hover", line: 99, column: 1, expected_text: "target" }), /outside/);
    assert.equal(bridge.child, undefined);
    await request({ action: "symbols" }); // Recovers after errors.
    const activeAbort = new AbortController();
    const activeRequest = request({ action: "diagnostics", wait_ms: 5000 }, activeAbort.signal);
    const timer = setTimeout(() => activeAbort.abort(), 100);
    try { await assert.rejects(activeRequest, /abort/i); } finally { clearTimeout(timer); }
    assert.equal(bridge.child, undefined);
    await request({ action: "symbols" });
    await bridge.close();
    await bridge.close();
    await assert.rejects(stat(socket), /ENOENT/);
    assert.notEqual(child.exitCode === null && child.signalCode === null, true);
  } finally {
    await bridge.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("missing server/configuration returns actionable error", { timeout: 10000 }, async () => {
  const bridge = new HeadlessLsp({ init: "NONE" });
  try {
    await assert.rejects(bridge.request({ file: "extensions/nvim-lsp/request.lua", action: "symbols", timeout_ms: 100 }, process.cwd()), /No initialized LSP attached/);
  } finally { await bridge.close(); }
});

test("missing executable rejects without hanging", { timeout: 10000 }, async () => {
  const bridge = new HeadlessLsp({ binary: "/nonexistent/pi-nvim-test" });
  try {
    await assert.rejects(bridge.request({ file: "extensions/nvim-lsp/request.lua", action: "symbols" }, process.cwd()), /ENOENT/);
  } finally { await bridge.close(); }
});

test("waits for a capable server after a diagnostics-only server attaches", { timeout: 10000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-lsp-race-"));
  const init = join(cwd, "init.lua");
  const server = fileURLToPath(new URL("./fixtures/server.mjs", import.meta.url));
  await writeFile(init, `vim.api.nvim_create_autocmd('BufEnter', { callback = function(ev)
    for _, mode in ipairs({'diagnostics-only', 'delayed'}) do
      vim.lsp.start({name=mode,cmd={${luaString(process.execPath)},${luaString(server)},mode},root_dir=${luaString(cwd)}})
    end
  end })`);
  await writeFile(join(cwd, "test.txt"), "target\n");
  const bridge = new HeadlessLsp({ init });
  try {
    const result = await bridge.request({ file: "test.txt", action: "definition", target: "target", timeout_ms: 3000 }, cwd);
    assert.equal(result.results[0].client, "delayed");
    assert.equal(result.results[0].result.length, 1);
    assert.equal(result.clients.length, 2);
  } finally {
    await bridge.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("expected_text rejects wrong positions before waiting for an LSP", { timeout: 15000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-lsp-position-"));
  const bridge = new HeadlessLsp({ init: "NONE" });
  await writeFile(join(cwd, "sample.py"), 'def main() -> None:\n    greeting = format_greeting("Neovim")\n    😀 a.b aXb\n');
  const request = (line, column, expected_text) => bridge.request({
    action: "definition", file: "sample.py", line, column, expected_text, timeout_ms: 100,
  }, cwd);
  try {
    await assert.rejects(request(1, 16, "format_greeting"), /Position mismatch.*def main\(\) -> None:.*2:16/);
    await assert.rejects(request(2, 1, "format_greeting"), /Position mismatch/);
    await assert.rejects(request(2, 31, "format_greeting"), /Position mismatch/);
    // Exact literal matching, byte columns after an emoji, no Lua-pattern interpretation.
    await assert.rejects(request(3, 14, "a.b"), /Position mismatch.*3:10/);
    for (const [line, column, expected] of [[2, 16, "format_greeting"], [2, 30, "format_greeting"], [3, 11, "a.b"]]) {
      await assert.rejects(request(line, column, expected), /No initialized LSP attached/);
    }
    await assert.rejects(request(1, 1, ""), /nonempty, single-line/);
    await assert.rejects(request(1, 1, "a\nb"), /nonempty, single-line/);
  } finally {
    await bridge.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("text targeting rejects ambiguity, missing text and conflicting arguments", { timeout: 15000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-lsp-target-"));
  const bridge = new HeadlessLsp({ init: "NONE" });
  await writeFile(join(cwd, "sample.txt"), 'def target():\n    😀 target(a.b)\n    target(target)\n    target(target)\n');
  const request = (args) => bridge.request({ action: "definition", file: "sample.txt", timeout_ms: 100, ...args }, cwd);
  try {
    await assert.rejects(request({ target: "target" }), /matched 6 locations.*1:5.*2:10/);
    await assert.rejects(request({ target: "target", anchor: "target(target)" }), /matched 4 locations/);
    await assert.rejects(request({ target: "target", anchor: "    target(" }), /matched 2 locations/);
    await assert.rejects(request({ target: "missing" }), /matched 0 locations/);
    await assert.rejects(request({ target: "target", anchor: "wrong anchor" }), /matched 0 locations/);
    // Unambiguous selectors pass position resolution and reach LSP attachment.
    await assert.rejects(request({ target: "target", anchor: "😀 target(a.b)" }), /No initialized LSP attached/);
    await assert.rejects(request({ target: "a.b" }), /No initialized LSP attached/);
    await assert.rejects(request({ target: "target", line: 1, column: 5 }), /not both/);
    await assert.rejects(request({ target: "target", expected_text: "target" }), /not both/);
    await assert.rejects(request({ line: 1, column: 5 }), /expected_text must/);
    await assert.rejects(request({ anchor: "target" }), /anchor requires target/);
    await assert.rejects(request({ target: "" }), /target must/);
    await assert.rejects(request({ target: "target", anchor: "a\nb" }), /anchor must/);
    await assert.rejects(request({ action: "symbols", target: "target" }), /only supported/);
  } finally {
    await bridge.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("serialization and output bounding", () => {
  assert.match(expressionFor({ file: "foo'); error('oops", query: "\n💡" }), /foo''\); error\(''oops/);
  assert.equal(formatResult({ a: 1 }), '{\n  "a": 1\n}');
  assert.match(formatResult({ text: "x".repeat(1000) }, 100), /Output truncated/);
});
