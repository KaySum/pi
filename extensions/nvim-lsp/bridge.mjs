import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const luaFile = fileURLToPath(new URL("./request.lua", import.meta.url));
const quote = (s) => `'${s.replaceAll("'", "''")}'`;
export function expressionFor(params) {
  // Arguments are JSON data, never executable Lua or Ex commands.
  return `luaeval(${quote("dofile(_A[1])(vim.json.decode(_A[2]))")}, [${quote(luaFile)}, ${quote(JSON.stringify(params))}])`;
}

export class HeadlessLsp {
  constructor({ binary = process.env.PI_NVIM_LSP_BIN || "nvim", init = process.env.PI_NVIM_LSP_INIT } = {}) {
    this.binary = binary;
    this.init = init;
    this.queue = Promise.resolve();
  }

  async remote(expression, signal, timeout = 20000) {
    return new Promise((accept, reject) => {
      execFile(this.binary, ["--server", this.socket, "--remote-expr", expression], {
        encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024, signal,
      }, (error, stdout, stderr) => {
        if (error) reject(new Error(`Neovim LSP RPC failed: ${stderr.trim() || error.message}`));
        else accept(stdout.trim());
      });
    });
  }

  async start(cwd, signal) {
    if (this.child && this.child.exitCode === null && this.cwd === cwd) return;
    await this.stop();
    signal?.throwIfAborted();
    this.cwd = cwd;
    this.directory = await mkdtemp(join(tmpdir(), "pi-lsp-"));
    this.socket = join(this.directory, "nvim.sock");
    this.log = "";
    const env = { ...process.env, PI_NVIM_LSP: "1" };
    delete env.NVIM;
    delete env.NVIM_LISTEN_ADDRESS;
    this.child = spawn(this.binary, ["--headless", "--listen", this.socket, "-n", "-i", "NONE",
      ...(this.init ? ["-u", this.init] : []),
      "--cmd", "set noswapfile noundofile noexrc", "-c", "set autoread"], {
      cwd, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let spawnError;
    this.child.on("error", (error) => { spawnError = error; });
    for (const stream of [this.child.stdout, this.child.stderr]) {
      stream.on("data", (data) => { this.log = (this.log + data.toString()).slice(-6000); });
    }
    try {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        if (spawnError) throw spawnError;
        if (this.child.exitCode !== null) throw new Error(`Neovim exited: ${this.log}`);
        try {
          await stat(this.socket);
          if (await this.remote("1", signal, 1000) === "1") return;
        } catch (error) {
          signal?.throwIfAborted();
        }
        await delay(100, undefined, { signal });
      }
      throw new Error(`Neovim startup timed out. Check your headless configuration. ${this.log}`);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  request(params, cwd, signal) {
    const run = this.queue.then(async () => {
      signal?.throwIfAborted();
      const file = resolve(cwd, params.file);
      if (!(await stat(file)).isFile()) throw new Error(`Not a file: ${file}`);
      await this.start(resolve(cwd), signal);
      try {
        const result = JSON.parse(await this.remote(expressionFor({ ...params, file }), signal, 2 * (params.timeout_ms ?? 8000) + (params.wait_ms ?? 1000) + 5000));
        if (result.error) throw new Error(result.error);
        return result;
      } catch (error) {
        // Also cancels outstanding server work and prevents stale RPCs after abort.
        await this.stop();
        throw error;
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async stop() {
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((done) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
        child.once("close", () => { clearTimeout(timer); done(); });
        child.kill("SIGTERM");
      });
    }
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.directory = undefined;
  }

  async close() {
    await this.queue;
    await this.stop();
  }
}

export function formatResult(result, maxChars = 30000) {
  const text = JSON.stringify(result, null, 2);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[Output truncated; narrow the query or reduce limit. This is not complete JSON.]`;
}
