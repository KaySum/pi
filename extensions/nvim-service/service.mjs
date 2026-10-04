import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** @typedef {{ socket: string, pid: number, supervisorPid: number, cwd: string }} NvimServiceInfo */

/**
 * Start one private service. No shell, npm packages, PID files, or global scans.
 * The supervisor creates/cleans its own runtime directory, including if Pi dies
 * during startup. Call only from session_start or an explicit command/tool.
 *
 * @param {{ cwd: string, executable?: string, init?: string, env?: NodeJS.ProcessEnv,
 *   startupTimeoutMs?: number, graceMs?: number, killMs?: number }} options
 */
export function launchNvimService(options) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('nvim-service requires macOS or Linux');
  const env = options.env ?? process.env;
  const config = {
    cwd: options.cwd,
    executable: options.executable ?? env.PI_NVIM_BIN ?? 'nvim',
    init: options.init ?? env.PI_NVIM_INIT,
    startupTimeoutMs: options.startupTimeoutMs ?? 15000,
    graceMs: options.graceMs ?? 500,
    killMs: options.killMs ?? 1500,
  };
  if (typeof config.cwd !== 'string' || typeof config.executable !== 'string' ||
      (config.init !== undefined && typeof config.init !== 'string') ||
      !Number.isSafeInteger(config.startupTimeoutMs) || config.startupTimeoutMs < 1 ||
      !Number.isSafeInteger(config.graceMs) || config.graceMs < 1 ||
      !Number.isSafeInteger(config.killMs) || config.killMs <= config.graceMs) {
    throw new Error('Invalid Neovim supervisor configuration');
  }
  const supervisor = spawn(process.execPath, [fileURLToPath(new URL('./supervisor.mjs', import.meta.url))], {
    // Separate session/process group: closing Pi's terminal must not kill the
    // supervisor before it has enforced Neovim's termination deadline.
    detached: true,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const spawned = Promise.withResolvers();
  const ready = Promise.withResolvers();
  const exited = Promise.withResolvers();
  // A caller may only await ready or stop; unused promises must not be unhandled.
  spawned.promise.catch(() => {});
  ready.promise.catch(() => {});
  let failure;
  let info;
  let stopping = false;
  let ended = false;
  let startupDone = false;
  let output = '';
  let stderr = '';
  let stopPromise;

  function unref() {
    supervisor.unref();
    for (const stream of supervisor.stdio) stream?.unref?.();
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    // During orderly shutdown keep the parent alive until the supervisor reaps
    // Nvim. Otherwise the idle service must NOT keep Pi's event loop alive.
    if (!ended) {
      supervisor.ref();
      supervisor.stdin.end();
    }
    stopPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unref();
        // Do not kill a supervisor that may still be enforcing child cleanup.
        reject(new Error('Neovim supervisor did not exit within 5 seconds'));
      }, 5000);
      exited.promise.then(result => { clearTimeout(timer); resolve(result); });
    });
    return stopPromise;
  }

  const startupTimer = setTimeout(() => {
    failure = new Error('Neovim supervisor startup timed out');
    ready.reject(failure);
    spawned.reject(failure);
    void stop().catch(() => {});
  }, config.startupTimeoutMs + 3000);

  function finish(code, signal) {
    if (ended) return;
    ended = true;
    clearTimeout(startupTimer);
    const error = failure ?? new Error(stopping ? 'Neovim stopped before becoming ready' :
      `Neovim supervisor exited (${signal ?? code})${stderr ? `: ${stderr.trim()}` : ''}`);
    ready.reject(error);
    spawned.reject(error);
    for (const stream of supervisor.stdio) stream?.destroy();
    exited.resolve({ expected: stopping, error: stopping && !failure ? undefined : error, info });
  }
  supervisor.on('error', error => { failure = error; finish(null, null); });
  // Unlike Nvim/plugin output pipes, these status pipes are owned only by the
  // supervisor. Drain them through 'close' so a final error message isn't lost.
  supervisor.once('close', finish);
  supervisor.stdin.on('error', error => { failure ??= error; });
  supervisor.stdout.setEncoding('utf8');
  supervisor.stderr.setEncoding('utf8');
  supervisor.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
  supervisor.stderr.on('error', error => { failure ??= error; });
  supervisor.stdout.on('error', error => { failure ??= error; });
  supervisor.stdout.on('data', data => {
    output += data.toString();
    if (output.length > 65536) {
      failure = new Error('Oversized Neovim supervisor message');
      void stop().catch(() => {});
      return;
    }
    let newline;
    while ((newline = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (message.type === 'error') failure = new Error(message.message);
        if (message.type === 'spawned') {
          info = message.info;
          spawned.resolve(info);
        }
        if (message.type === 'ready' && !stopping && !startupDone) {
          startupDone = true;
          clearTimeout(startupTimer);
          info = message.info;
          unref();
          ready.resolve(info);
        }
      } catch (error) {
        failure = error;
        void stop().catch(() => {});
      }
    }
  });
  supervisor.stdin.write(JSON.stringify(config) + '\n');

  return {
    /** @type {Promise<NvimServiceInfo>} */
    spawned: spawned.promise,
    /** @type {Promise<NvimServiceInfo>} */
    ready: ready.promise,
    /** @type {Promise<{ expected: boolean, error?: Error, info?: NvimServiceInfo }>} */
    exited: exited.promise,
    stop,
  };
}
