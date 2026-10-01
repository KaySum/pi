// One short-lived supervisor per tool call. Pi's IPC disconnect is a liveness
// signal that still works when Pi is SIGKILLed. No liveness fd is inherited by nvim.
import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { liveGroup, terminateGroup } from "./processes.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const quote = (s) => `'${s.replaceAll("'", "''")}'`;
const send = (message) => new Promise((done) => {
  if (!process.connected) return done();
  try { process.send(message, () => done()); } catch { done(); }
});
let config, directory, socket, nvim, nvimExited, startTask, stopping, deadlineTimer;
let log = "", busy = false;
const work = new AbortController();
const helpers = new Set();

function remote(expression, timeout, signal = work.signal) {
  return new Promise((accept, reject) => {
    const child = execFile(config.binary, ["--server", socket, "--remote-expr", expression], {
      encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
      signal, env: config.env,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`Neovim RPC: ${stderr.trim().slice(-2000) || error.message}`));
      else accept(stdout.trim());
    });
    helpers.add(child);
    child.once("close", () => helpers.delete(child));
  });
}

async function start() {
  directory = await mkdtemp(join(tmpdir(), "pi-nd-"));
  socket = join(directory, "n.sock");
  await send({ type: "resources", directory });
  // Verify the ownership-inspection prerequisite before launching Neovim.
  if (!(await liveGroup(process.pid)).includes(process.pid)) throw new Error("A compatible POSIX ps is required for process-group verification");
  await mkdir(join(directory, "state", "nvim"), { recursive: true });
  await mkdir(join(directory, "cache", "nvim"), { recursive: true });
  work.signal.throwIfAborted();
  const env = {
    ...process.env, PI_NVIM_DIAGNOSTICS: "1",
    PI_NVIM_DIAGNOSTICS_BOOTSTRAP: join(root, "bootstrap.lua"),
    NVIM_LOG_FILE: join(directory, "nvim.log"),
    XDG_STATE_HOME: join(directory, "state"), XDG_CACHE_HOME: join(directory, "cache"),
  };
  delete env.NVIM;
  delete env.NVIM_LISTEN_ADDRESS;
  config.env = env;
  // detached creates an OWNED group, not a persistent/unreferenced daemon.
  nvim = spawn(config.binary, ["--headless", "--listen", socket, "-n", "-i", "NONE",
    ...(config.init ? ["-u", config.init] : []),
    "--cmd", "set noexrc noswapfile noundofile",
    "--cmd", "lua dofile(vim.env.PI_NVIM_DIAGNOSTICS_BOOTSTRAP)",
  ], { cwd: config.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let spawnError;
  nvim.on("error", (error) => { spawnError = error; });
  nvimExited = new Promise((done) => nvim.once("close", done));
  for (const stream of [nvim.stdout, nvim.stderr]) {
    stream.on("data", (data) => { log = (log + data.toString()).slice(-8000); });
  }
  await send({ type: "spawned", pid: nvim.pid, directory });
  const deadline = Date.now() + config.startupMs;
  while (Date.now() < deadline) {
    work.signal.throwIfAborted();
    if (spawnError) throw spawnError;
    if (nvim.exitCode !== null || nvim.signalCode !== null) throw new Error(`Neovim exited during startup: ${log}`);
    try {
      const ready = await remote("luaeval('pi_nvim_diagnostics ~= nil')", 500);
      if (ready === "v:true" || ready === "true" || ready === "1") {
        await send({ type: "ready", pid: nvim.pid, directory });
        return;
      }
    } catch { work.signal.throwIfAborted(); }
    await delay(50, undefined, { signal: work.signal });
  }
  throw new Error(`Neovim startup timed out. Check headless configuration. ${log}`);
}

async function shutdown(reason) {
  if (stopping) return stopping;
  stopping = (async () => {
    clearTimeout(deadlineTimer);
    work.abort();
    await startTask?.catch(() => {});
    let cleanup = { ok: true, escalated: null, remaining: [] };
    const errors = [];
    try {
      if (nvim?.pid) {
        // Separate signal: the tool's cancellation must not cancel its cleanup.
        if (nvim.exitCode === null && nvim.signalCode === null) {
          await remote("luaeval('pi_nvim_diagnostics.shutdown()')", 500, new AbortController().signal).catch(() => {});
        }
        cleanup = await terminateGroup(nvim.pid);
        if (cleanup.ok) await nvimExited;
      }
    } catch (error) {
      cleanup.ok = false;
      errors.push(error.message);
      // A failed verification is not success; nevertheless make a final attempt.
      if (nvim?.pid) {
        try { process.kill(-nvim.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") errors.push(e.message); }
      }
    }
    for (const helper of helpers) helper.kill("SIGKILL");
    // remote helpers are direct children; execFile callbacks run after close.
    const helperDeadline = Date.now() + 1000;
    while (helpers.size && Date.now() < helperDeadline) await delay(20);
    if (helpers.size) { cleanup.ok = false; errors.push("RPC helpers failed to exit"); }
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    catch (error) { cleanup.ok = false; errors.push(error.message); }
    await send({ type: "stopped", reason, cleanup: { ...cleanup, errors }, log });
    process.exit(cleanup.ok ? 0 : 1);
  })();
  return stopping;
}

process.on("message", (message) => {
  if (message.type === "start" && !config) {
    config = message.config;
    deadlineTimer = setTimeout(() => {
      void send({ type: "failure", error: "Whole-call work deadline exceeded" });
      void shutdown("deadline");
    }, config.workMs);
    startTask = start();
    void startTask.catch((error) => {
      void send({ type: "failure", error: error.message });
      void shutdown("startup failure");
    });
  } else if (message.type === "stop") {
    void shutdown(message.reason || "requested");
  } else if (message.type === "request" && config && !stopping) {
    if (busy) return void send({ type: "response", id: message.id, error: "Concurrent supervisor request" });
    busy = true;
    const expression = `luaeval(${quote("dofile(_A[1])(_A[2])")}, [${quote(join(root, "diagnostics.lua"))}, ${quote(JSON.stringify(message.args))}])`;
    void (async () => {
      try {
        await startTask;
        const raw = await remote(expression, message.args.timeout_ms + 2000);
        await send({ type: "response", id: message.id, result: JSON.parse(raw) });
      } catch (error) {
        await send({ type: "response", id: message.id, error: error.message });
        void shutdown("RPC failure");
      } finally { busy = false; }
    })();
  }
});
process.on("disconnect", () => { void shutdown("parent disconnected"); });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void shutdown(signal); });
process.on("uncaughtException", (error) => {
  void send({ type: "failure", error: error.message });
  void shutdown("supervisor exception");
});
process.on("unhandledRejection", (error) => {
  void send({ type: "failure", error: String(error) });
  void shutdown("supervisor rejection");
});
// A caller that dies before sending start still closes IPC. A caller that stalls
// before start must not leave an immortal supervisor either.
setTimeout(() => { if (!config) void shutdown("no start request"); }, 5000).unref();
