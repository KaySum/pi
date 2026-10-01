import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { HeadlessDiagnostics, formatResult, LIMITS, validate } from "./bridge.mjs";
import { liveGroup, terminateGroup } from "./processes.mjs";

const lua = (value) => JSON.stringify(value); // Test paths have no JSON-only Unicode escapes.
const server = fileURLToPath(new URL("./fixtures/server.mjs", import.meta.url));
const owner = fileURLToPath(new URL("./fixtures/owner.mjs", import.meta.url));
const lintFixture = fileURLToPath(new URL("./fixtures/", import.meta.url));
const linter = fileURLToPath(new URL("./fixtures/linter.mjs", import.meta.url));
const exists = async (path) => { try { await stat(path); return true; } catch { return false; } };
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    const state = execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return Boolean(state) && !state.startsWith("Z");
  } catch { return false; }
};
async function until(predicate, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(30); }
  throw new Error("Test wait timed out");
}
async function workspace(t, initText = "") {
  const cwd = await mkdtemp(join(tmpdir(), "pi-nd-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const init = join(cwd, "init.lua");
  await writeFile(init, initText);
  await writeFile(join(cwd, "sample.txt"), "😀 BAD WARN INFO HINT\n");
  return { cwd, init };
}
function makeBridge(t, options) {
  const bridge = new HeadlessDiagnostics(options);
  t.after(() => bridge.close());
  return bridge;
}
async function assertClean(bridge) {
  assert.equal(bridge.lastRun.cleanup.ok, true);
  assert.equal(alive(bridge.lastRun.pid), false);
  assert.equal(alive(bridge.lastRun.supervisorPid), false);
  assert.deepEqual(await liveGroup(bridge.lastRun.pid), []);
  assert.equal(await exists(bridge.lastRun.directory), false);
}
function lspInit(cwd, mode = "push", wait = 0, extra = "") {
  return `vim.api.nvim_create_autocmd('BufReadPost', { callback = function(ev)
    vim.lsp.start({ name = 'fixture', cmd = { ${lua(process.execPath)}, ${lua(server)}, ${lua(mode)}, ${lua(String(wait))}, ${lua(join(cwd, "pids"))} },
      root_dir = ${lua(cwd)}, detached = true }, { bufnr = ev.buf })
  end })\n${extra}`;
}
function lintInit(cwd, mode = "normal", runtime = lintFixture) {
  return `vim.opt.rtp:append(${lua(runtime)})
    vim.filetype.add({extension={txt='testlint'}})
    local lint = require('lint')
    lint.linters_by_ft = { testlint = {'selected', 'conditional'}, ['*']={'global'}, ['_']={'fallback'} }
    for i, name in ipairs({'selected', 'conditional', 'global', 'fallback'}) do
      lint.linters[name] = { cmd = ${lua(process.execPath)}, args = {${lua(linter)}, ${lua(join(cwd, "lint-pids"))}, ${lua(mode)}},
        parser = function(output)
          local at = output:find('BAD',1,true)
          return at and {{lnum=0,col=at-1,message=name .. ' finding',severity=i,source='lint-fixture'}} or {}
        end }
    end
    lint.linters.conditional.condition = function(ctx)
      assert(ctx.dirname == vim.uv.fs_realpath(${lua(cwd)}) and ctx.filename:find('sample',1,true))
      return false
    end
  `;
}
const namespaceInit = `local ns = vim.api.nvim_create_namespace('generic-fixture')
vim.api.nvim_create_autocmd('BufReadPost', { callback = function(ev)
  local s = table.concat(vim.api.nvim_buf_get_lines(ev.buf, 0, -1, false), '\\n')
  local diagnostics = {}
  for severity, marker in ipairs({'BAD', 'WARN', 'INFO', 'HINT'}) do
    local at = s:find(marker, 1, true)
    if at then diagnostics[#diagnostics + 1] = { lnum=0, col=at-1, message=marker .. ' generic', severity=severity, source='generic', code=marker } end
  end
  vim.diagnostic.set(ns, ev.buf, diagnostics)
end })`;

test("generic namespaces without LSP, byte positions, filters, quoted paths, fresh calls", { timeout: 20000 }, async (t) => {
  const { cwd, init } = await workspace(t, namespaceInit);
  const file = "a 'quoted' 😀 file.txt";
  await writeFile(join(cwd, file), "😀 BAD WARN INFO HINT\n");
  const bridge = makeBridge(t, { init });
  const first = await bridge.request({ files: [file], timeout_ms: 120 }, cwd);
  assert.equal(first.files[0].diagnostics[0].column, 6);
  assert.deepEqual(first.files[0].diagnostics.map((d) => d.severity), ["error", "warning", "information", "hint"]);
  assert.match(first.files[0].diagnostics[0].namespace, /generic-fixture/);
  assert.equal(first.complete, false);
  await assertClean(bridge);
  const firstPid = bridge.lastRun.pid;
  const filtered = await bridge.request({ files: [file], severity: ["warning", "hint"], limit: 1, timeout_ms: 100 }, cwd);
  assert.equal(filtered.files[0].diagnostics.length, 1);
  assert.equal(filtered.files[0].diagnostics[0].severity, "warning");
  assert.equal(filtered.omitted, 1);
  assert.notEqual(firstPid, bridge.lastRun.pid);
  await assertClean(bridge);
  await writeFile(join(cwd, file), "fixed\n");
  const fixed = await bridge.request({ files: [file], timeout_ms: 100 }, cwd);
  assert.deepEqual(fixed.files[0].diagnostics, []);
  assert.equal(fixed.files[0].providers.find((p) => p.name === "generic-fixture").status, "update_observed");
  await assertClean(bridge);
});

test("push and pull diagnostics, same-client deduplication, LSP child cleanup", { timeout: 20000 }, async (t) => {
  const { cwd, init } = await workspace(t);
  await writeFile(init, lspInit(cwd, "both"));
  const bridge = makeBridge(t, { init });
  const result = await bridge.request({ files: ["sample.txt"], timeout_ms: 700 }, cwd);
  assert.equal(result.files[0].diagnostics.length, 4, JSON.stringify(result));
  assert.equal(result.files[0].diagnostics[0].column, 6);
  assert.equal(result.files[0].providers.find((p) => p.kind === "lsp").status, "pull_responded");
  await assertClean(bridge);
  for (const pid of (await readFile(join(cwd, "pids"), "utf8")).trim().split("\n")) assert.equal(alive(Number(pid)), false);
});

test("delayed providers remain incomplete, never a clean verdict", { timeout: 15000 }, async (t) => {
  const { cwd, init } = await workspace(t);
  await writeFile(init, lspInit(cwd, "pull", 2000));
  const bridge = makeBridge(t, { init });
  const result = await bridge.request({ files: ["sample.txt"], timeout_ms: 300 }, cwd);
  assert.equal(result.complete, false);
  assert.equal(result.files[0].status, "timed_out");
  assert.deepEqual(result.files[0].diagnostics, []);
  assert.match(formatResult(result), /not proof of clean/);
  await assertClean(bridge);
});

test("batches share one process, isolate invalid files, enforce request-wide limit", { timeout: 15000 }, async (t) => {
  const { cwd, init } = await workspace(t, namespaceInit);
  await writeFile(join(cwd, "second.txt"), "BAD WARN\n");
  const events = [];
  const bridge = makeBridge(t, { init, onEvent: (event) => events.push(event) });
  const result = await bridge.request({ files: ["sample.txt", "missing.txt", ".", "second.txt"], timeout_ms: 100, limit: 2 }, cwd);
  assert.equal(result.files[0].diagnostics.length, 2);
  assert.equal(result.files[1].status, "error");
  assert.equal(result.files[2].status, "error");
  assert.equal(result.files[3].diagnostics.length, 0);
  assert.equal(result.omitted, 4);
  assert.equal(events.filter((e) => e.type === "spawned").length, 1);
  await assertClean(bridge);
});

test("concurrent calls serialize; queued cancellation never starts a process", { timeout: 15000 }, async (t) => {
  const { cwd, init } = await workspace(t, namespaceInit);
  const events = [];
  const bridge = makeBridge(t, { init, onEvent: (e) => events.push(e) });
  const one = bridge.request({ files: ["sample.txt"], timeout_ms: 100 }, cwd);
  const aborted = new AbortController();
  aborted.abort();
  const two = assert.rejects(bridge.request({ files: ["sample.txt"] }, cwd, aborted.signal), /abort/i);
  const three = bridge.request({ files: ["sample.txt"], timeout_ms: 100 }, cwd);
  await Promise.all([one, two, three]);
  assert.deepEqual(events.filter((e) => ["spawned", "stopped"].includes(e.type)).map((e) => e.type), ["spawned", "stopped", "spawned", "stopped"]);
  await assertClean(bridge);
});

test("active cancellation and session close await teardown", { timeout: 20000 }, async (t) => {
  const { cwd, init } = await workspace(t);
  const bridge = makeBridge(t, { init });
  const controller = new AbortController();
  const pending = assert.rejects(bridge.request({ files: ["sample.txt"], timeout_ms: 30000 }, cwd, controller.signal), /abort/i);
  await until(() => bridge.lastRun?.pid);
  await delay(150); // Let the request reach Neovim, not just the startup boundary.
  controller.abort();
  await pending;
  await assertClean(bridge);
  const oldPid = bridge.lastRun.pid;
  const next = assert.rejects(bridge.request({ files: ["sample.txt"], timeout_ms: 30000 }, cwd), /shutdown/);
  await until(() => bridge.lastRun?.pid && bridge.lastRun.pid !== oldPid);
  await delay(150);
  await bridge.close();
  await next;
  await assertClean(bridge);
});

test("startup failures and no providers are explicit and leave no processes", { timeout: 15000 }, async (t) => {
  const { cwd } = await workspace(t);
  const missing = makeBridge(t, { binary: "/nonexistent/pi-nvim-diagnostics", init: "NONE" });
  await assert.rejects(missing.request({ files: ["sample.txt"], timeout_ms: 100 }, cwd), /ENOENT/);
  assert.equal(missing.lastRun.cleanup.ok, true);
  assert.equal(await exists(missing.lastRun.directory), false);
  const empty = makeBridge(t, { init: "NONE" });
  const result = await empty.request({ files: ["sample.txt"], timeout_ms: 100 }, cwd);
  assert.equal(result.complete, false);
  assert.equal(result.files[0].providers[0].status, "unavailable");
  await assertClean(empty);
});

test("file changes and plugin modifications are not presented as fresh disk results", { timeout: 15000 }, async (t) => {
  const { cwd, init } = await workspace(t, namespaceInit);
  const bridge = makeBridge(t, { init });
  const pending = bridge.request({ files: ["sample.txt"], timeout_ms: 600 }, cwd);
  await until(() => bridge.lastRun?.pid);
  await delay(200);
  await writeFile(join(cwd, "sample.txt"), "changed while checking\n");
  const result = await pending;
  assert.equal(result.files[0].status, "changed_during_check", JSON.stringify(result));
  await assertClean(bridge);
  await writeFile(init, "vim.api.nvim_create_autocmd('BufReadPost', { callback=function(ev) vim.api.nvim_buf_set_lines(ev.buf,0,-1,false,{'plugin change'}) end })");
  const modified = await bridge.request({ files: ["sample.txt"], timeout_ms: 100 }, cwd);
  assert.equal(modified.files[0].status, "error");
  assert.match(modified.files[0].error, /plugin modified/);
  await assertClean(bridge);
});

test("stubborn LSP receives forced group teardown despite configured detach=true", { timeout: 15000 }, async (t) => {
  const { cwd, init } = await workspace(t);
  await writeFile(init, lspInit(cwd, "stubborn"));
  const bridge = makeBridge(t, { init });
  await bridge.request({ files: ["sample.txt"], timeout_ms: 400 }, cwd);
  assert.equal(bridge.lastRun.cleanup.escalated, "SIGKILL");
  await assertClean(bridge);
  for (const pid of (await readFile(join(cwd, "pids"), "utf8")).trim().split("\n")) assert.equal(alive(Number(pid)), false);
});

for (const phase of ["startup", "active"]) {
  test(`parent SIGKILL during ${phase} triggers independent cleanup`, { timeout: 20000 }, async (t) => {
    const { cwd, init } = await workspace(t, "while true do end");
    if (phase === "active") await writeFile(init, lspInit(cwd, "stubborn"));
    const child = spawn(process.execPath, [owner, cwd, init], { stdio: ["ignore", "pipe", "pipe"] });
    const events = [];
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n"); buffer = lines.pop();
      for (const line of lines) events.push(JSON.parse(line));
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.once("close", resolve));
    t.after(async () => {
      child.kill("SIGKILL");
      const event = events.find((e) => e.pid);
      if (event) await terminateGroup(event.pid, { graceMs: 0 });
    });
    await until(() => events.some((e) => e.type === (phase === "startup" ? "spawned" : "ready")));
    const event = events.find((e) => e.pid);
    if (phase === "active") await until(() => exists(join(cwd, "pids")));
    child.kill("SIGKILL");
    await exited;
    await until(async () => !(await exists(event.directory)) && !alive(event.supervisorPid), 10000);
    assert.deepEqual(await liveGroup(event.pid), [], stderr);
    assert.equal(alive(event.pid), false);
    if (phase === "active") {
      for (const pid of (await readFile(join(cwd, "pids"), "utf8")).trim().split("\n")) assert.equal(alive(Number(pid)), false);
    }
  });
}

test("nvim-lint adapter without LSP respects conditions, globals, fallback and cleared findings", { timeout: 20000 }, async (t) => {
  const { cwd, init } = await workspace(t);
  await writeFile(init, lintInit(cwd));
  const bridge = makeBridge(t, { init });
  const result = await bridge.request({ files: ["sample.txt"], timeout_ms: 400 }, cwd);
  assert.equal(result.files[0].diagnostics.length, 2, JSON.stringify(result));
  assert.equal(result.files[0].providers.find((p) => p.name === "conditional").status, "skipped_condition");
  assert.equal(result.files[0].providers.find((p) => p.name === "selected").status, "update_observed");
  assert.equal(result.files[0].providers.some((p) => p.kind === "lsp"), false);
  await assertClean(bridge);
  for (const pid of (await readFile(join(cwd, "lint-pids"), "utf8")).trim().split("\n")) assert.equal(alive(Number(pid)), false);
  await writeFile(join(cwd, "sample.txt"), "fixed\n");
  const fixed = await bridge.request({ files: ["sample.txt"], timeout_ms: 300 }, cwd);
  assert.deepEqual(fixed.files[0].diagnostics, []);
  await writeFile(join(cwd, "fallback.unknown"), "BAD\n");
  const fallback = await bridge.request({ files: ["fallback.unknown"], timeout_ms: 300 }, cwd);
  assert.equal(fallback.files[0].providers.find((p) => p.name === "fallback").status, "update_observed");
  await assertClean(bridge);
});

test("stubborn linter is contained and killed after its snapshot times out", { timeout: 15000 }, async (t) => {
  const { cwd, init } = await workspace(t);
  await writeFile(init, lintInit(cwd, "hang"));
  const bridge = makeBridge(t, { init });
  const result = await bridge.request({ files: ["sample.txt"], timeout_ms: 300 }, cwd);
  assert.equal(result.files[0].status, "timed_out");
  assert.equal(bridge.lastRun.cleanup.escalated, "SIGKILL");
  await assertClean(bridge);
  for (const pid of (await readFile(join(cwd, "lint-pids"), "utf8")).trim().split("\n")) assert.equal(alive(Number(pid)), false);
});

test("optional installed nvim-lint integration uses isolated config and deterministic executable", {
  timeout: 15000, skip: !process.env.PI_NVIM_DIAGNOSTICS_TEST_LINT_RUNTIME,
}, async (t) => {
  const { cwd, init } = await workspace(t);
  await writeFile(init, lintInit(cwd, "normal", process.env.PI_NVIM_DIAGNOSTICS_TEST_LINT_RUNTIME));
  const bridge = makeBridge(t, { init });
  const result = await bridge.request({ files: ["sample.txt"], timeout_ms: 500 }, cwd);
  assert.equal(result.files[0].diagnostics.length, 2, JSON.stringify(result));
  assert.equal(result.files[0].providers.find((p) => p.name === "conditional").status, "skipped_condition");
  await assertClean(bridge);
  await writeFile(init, lintInit(cwd, "hang", process.env.PI_NVIM_DIAGNOSTICS_TEST_LINT_RUNTIME));
  const pending = await bridge.request({ files: ["sample.txt"], timeout_ms: 300 }, cwd);
  assert.equal(pending.files[0].status, "timed_out");
  assert.equal(bridge.lastRun.cleanup.escalated, "SIGKILL");
  await assertClean(bridge);
  for (const pid of (await readFile(join(cwd, "lint-pids"), "utf8")).trim().split("\n")) assert.equal(alive(Number(pid)), false);
});

test("mixed namespaces preserve independent sources", { timeout: 15000 }, async (t) => {
  const { cwd, init } = await workspace(t);
  await writeFile(init, lspInit(cwd, "both", 0, namespaceInit));
  const bridge = makeBridge(t, { init });
  const result = await bridge.request({ files: ["sample.txt"], timeout_ms: 500 }, cwd);
  assert.equal(result.files[0].diagnostics.length, 8, JSON.stringify(result));
  assert.equal(result.counts.error, 2);
  await assertClean(bridge);
});

test("startup and whole-call deadlines are enforced outside a hung Neovim", { timeout: 20000 }, async (t) => {
  const { cwd, init } = await workspace(t, "while true do end");
  const startup = makeBridge(t, { init, startupMs: 150 });
  await assert.rejects(startup.request({ files: ["sample.txt"] }, cwd), /startup timed out/);
  await assertClean(startup);
  await writeFile(init, "vim.api.nvim_create_autocmd('BufReadPost',{ callback=function() while true do end end })");
  const deadline = makeBridge(t, { init, totalMs: LIMITS.cleanupMs + 1400 });
  await assert.rejects(deadline.request({ files: ["sample.txt"], timeout_ms: 30000 }, cwd), /deadline/i);
  await assertClean(deadline);
});

test("unexpected supervisor death fails closed and triggers parent-side cleanup", { timeout: 20000 }, async (t) => {
  const { cwd, init } = await workspace(t);
  const bridge = makeBridge(t, { init });
  const pending = assert.rejects(bridge.request({ files: ["sample.txt"], timeout_ms: 30000 }, cwd), /Cleanup could not be confirmed/);
  await until(() => bridge.lastRun?.pid);
  process.kill(bridge.lastRun.supervisorPid, "SIGKILL");
  await pending;
  assert.equal(bridge.poisoned, true);
  assert.equal(alive(bridge.lastRun.pid), false);
  assert.deepEqual(await liveGroup(bridge.lastRun.pid), []);
  assert.equal(await exists(bridge.lastRun.directory), false);
  await assert.rejects(bridge.request({ files: ["sample.txt"] }, cwd), /closed or cleanup failed/);
});

test("BOM, CRLF, empty files and no-final-newline snapshots are verified without save events", { timeout: 15000 }, async (t) => {
  const { cwd, init } = await workspace(t, `vim.api.nvim_create_autocmd({'BufWritePre','BufWritePost'}, {callback=function() error('UNEXPECTED SAVE') end})`);
  const bridge = makeBridge(t, { init });
  const contents = ["\ufeffBAD\r\nWARN\r\n", "", "no final newline"];
  const files = contents.map((_, i) => `${i}.txt`);
  await Promise.all(files.map((file, i) => writeFile(join(cwd, file), contents[i])));
  const result = await bridge.request({ files, timeout_ms: 100 }, cwd);
  for (const file of result.files) assert.notEqual(file.status, "error", JSON.stringify(result));
  for (const [i, file] of files.entries()) assert.equal(await readFile(join(cwd, file), "utf8"), contents[i]);
  await assertClean(bridge);
});

test("headless config guards intercept known setup paths before user config calls them", { timeout: 15000 }, async (t) => {
  const { cwd, init } = await workspace(t, `
    package.preload['lazy'] = function() return {setup=function(opts)
      assert(opts.checker.enabled == false and opts.install.missing == false and opts.change_detection.enabled == false)
    end} end
    require('lazy').setup({spec={}, checker={enabled=true}, install={missing=true}})
    package.preload['mason-lspconfig'] = function() return {setup=function(opts) assert(#opts.ensure_installed == 0) end} end
    require('mason-lspconfig').setup({ensure_installed={'missing-server'}})
    package.preload['mason-registry'] = function() return {refresh=function() error('NETWORK') end} end
    require('mason-registry').refresh(function(success) assert(success == false) end)
    package.preload['mason-core.package'] = function() return {install=function() error('INSTALL') end} end
    local installed = require('mason-core.package').install(nil, nil, function(success, message)
      assert(success == false and message:find('disabled',1,true))
    end)
    assert(installed == nil)
    assert(vim.env.PI_NVIM_DIAGNOSTICS == '1')
    assert(vim.env.NVIM == nil and vim.env.NVIM_LISTEN_ADDRESS == nil)
    local connected = pcall(vim.lsp.rpc.connect, '127.0.0.1', 1234)
    assert(not connected)
    vim.api.nvim_create_autocmd('BufReadPost',{callback=function(ev)
      vim.diagnostic.set(vim.api.nvim_create_namespace('guards-passed'),ev.buf,{{lnum=0,col=0,message='guards passed'}})
    end})
  `);
  const bridge = makeBridge(t, { init });
  const result = await bridge.request({ files: ["sample.txt"], timeout_ms: 100 }, cwd);
  assert.equal(result.files[0].diagnostics[0]?.message, "guards passed", JSON.stringify(result));
  assert.equal(result.runtimeLog, undefined);
  await assertClean(bridge);
});

test("provider errors are explicit and do not discard the rest of a batch", { timeout: 15000 }, async (t) => {
  const { cwd, init } = await workspace(t);
  await writeFile(init, lspInit(cwd, "pull-error"));
  await writeFile(join(cwd, "second.txt"), "BAD\n");
  const bridge = makeBridge(t, { init });
  const result = await bridge.request({ files: ["sample.txt", "second.txt"], timeout_ms: 400 }, cwd);
  assert.equal(result.files.length, 2);
  for (const file of result.files) {
    const provider = file.providers.find((p) => p.kind === "lsp");
    assert.equal(provider.status, "error", JSON.stringify(result));
    assert.match(provider.error, /Fixture provider failure/);
  }
  await assertClean(bridge);
  await writeFile(init, lintInit(cwd) + "\nrequire('lint').linters.selected.cmd = '/nonexistent/fixture-linter'\n");
  const missing = await bridge.request({ files: ["sample.txt"], timeout_ms: 300 }, cwd);
  assert.equal(missing.files[0].providers.find((p) => p.name === "selected").status, "error");
  assert.equal(missing.files[0].diagnostics.length, 1); // The global linter still ran.
  await assertClean(bridge);
});

test("long Unicode diagnostics are clipped safely and terminal controls are escaped", { timeout: 10000 }, async (t) => {
  const { cwd, init } = await workspace(t, `vim.api.nvim_create_autocmd('BufReadPost', {callback=function(ev)
    vim.diagnostic.set(vim.api.nvim_create_namespace('long'), ev.buf, {
      {lnum=0,col=0,message='diagnostic' .. string.char(27) .. ('😀'):rep(2000)}
    })
  end})`);
  const bridge = makeBridge(t, { init });
  const result = await bridge.request({ files: ["sample.txt"], timeout_ms: 100 }, cwd);
  assert.equal(result.files[0].textTruncated, true);
  assert.ok(Buffer.byteLength(result.files[0].diagnostics[0].message) < 1024);
  assert.equal(formatResult(result).includes(String.fromCharCode(27)), false);
  assert.ok(formatResult(result).includes("\\x1b"));
  await assertClean(bridge);
});

test("argument, file-size and output bounds", { timeout: 15000 }, async (t) => {
  assert.throws(() => validate({ files: [] }), /files/);
  assert.throws(() => validate({ files: Array(21).fill("x") }), /files/);
  assert.throws(() => validate({ files: ["x"], timeout_ms: 99 }), /timeout/);
  assert.throws(() => validate({ files: ["x"], severity: ["fatal"] }), /severity/);
  const { cwd } = await workspace(t);
  await writeFile(join(cwd, "large.txt"), Buffer.alloc(LIMITS.fileBytes + 1, 97));
  await writeFile(join(cwd, "binary.txt"), Buffer.from([0, 1]));
  execFileSync("mkfifo", [join(cwd, "fifo")]);
  const bridge = makeBridge(t, { init: "NONE" });
  const result = await bridge.request({ files: ["large.txt", "binary.txt", "fifo"] }, cwd);
  assert.equal(bridge.lastRun, undefined);
  assert.match(result.files[0].error, /1 MiB/);
  assert.match(result.files[1].error, /Binary/);
  assert.match(result.files[2].error, /regular file/);
  const formatted = formatResult({ ...result, files: [{ file: "x", diagnostics: [{ line: 1, column: 1, severity: "error", message: "😀".repeat(30000) }] }] });
  assert.ok(Buffer.byteLength(formatted) <= LIMITS.textBytes);
  assert.match(formatted, /Output truncated/);
});
