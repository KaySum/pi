import { test } from "node:test";
import assert from "node:assert/strict";
import { readSnapshot, selectDiagnostics } from "./bridge.mjs";
const d = (file, severity = 1) => ({ file, severity, line: 1, column: 2, message: "diagnostic" });
const snapshot = { server: "test", cwd: "/p", buffers: [], diagnostics: [d("/p/a"), d("/p/b", 2), d("/peer/c")] };
test("project boundaries and all scope", () => {
  assert.equal(selectDiagnostics(snapshot, {}, "/p").total, 2);
  assert.equal(selectDiagnostics(snapshot, { scope: "all" }, "/p").total, 3);
});
test("file, severity and limits", () => {
  assert.equal(selectDiagnostics(snapshot, { file: "a" }, "/p").total, 1);
  assert.equal(selectDiagnostics(snapshot, { severity: "warning" }, "/p").diagnostics[0].severity, "warning");
  assert.equal(selectDiagnostics(snapshot, { limit: 1 }, "/p").omitted, 1);
  assert.equal(selectDiagnostics(snapshot, { file: "/peer/c" }, "/p").total, 1);
});
test("large output is bounded with omissions", () => {
  const r = selectDiagnostics({ ...snapshot, diagnostics: Array.from({length: 100}, () => ({...d("/p/a"), message: "x".repeat(5000)})) }, {}, "/p");
  assert.ok(JSON.stringify(r).length <= 30000);
  assert.equal(r.diagnostics.length + r.omitted, 100);
});
test("missing and unreachable servers fail clearly", async () => {
  assert.throws(() => readSnapshot(""), /No Neovim connection/);
  await assert.rejects(readSnapshot("/tmp/pi-nvim-nonexistent-test.sock"), /Cannot read Neovim/);
});
test("live Neovim snapshot", {skip: !process.env.NVIM}, async () => {
  const s = await readSnapshot(process.env.NVIM);
  assert.ok(Array.isArray(s.diagnostics));
  for (const d of s.diagnostics) {
    assert.ok(d.line >= 1 && d.column >= 1);
    assert.equal(typeof d.message, "string");
  }
  console.log(`Live Neovim: ${s.diagnostics.length} diagnostics, ${s.buffers.length} loaded buffers`);
});
