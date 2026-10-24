import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** @typedef {{ socket: string, pid: number, supervisorPid: number, cwd: string }} NvimInfo */

/**
 * Start one private Neovim behind a supervisor that stops it when this process goes away,
 * however that happens.
 *
 * @param {{ cwd: string, executable?: string, init?: string, settings?: string, startupTimeoutMs?: number, graceMs?: number, killMs?: number }} options
 */
export function launch({ cwd, executable = process.env.PI_NVIM_BIN || 'nvim', init = process.env.PI_NVIM_INIT || undefined, settings,
  startupTimeoutMs = 15000, graceMs = 500, killMs = 1500 }) {
  if (typeof cwd !== 'string' || !cwd) throw new Error('cwd is required');
  const config = { cwd, executable, init, settings, startupTimeoutMs, graceMs, killMs };
  const supervisor = spawn(process.execPath, [fileURLToPath(new URL('./supervisor.mjs', import.meta.url)), JSON.stringify(config)], {
    // Its own session: closing Pi's terminal must not kill it before it has stopped Neovim.
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const spawned = Promise.withResolvers();
  const ready = Promise.withResolvers();
  const exited = Promise.withResolvers();
  spawned.promise.catch(() => {});
  ready.promise.catch(() => {});
  let failure;
  let ended = false;
  let stopPromise;
  let output = '';
  let stderr = '';

  // An idle service must not keep Pi's event loop alive.
  const unref = () => { supervisor.unref(); for (const stream of supervisor.stdio) stream?.unref?.(); };

  function stop() {
    return stopPromise ??= new Promise((resolve, reject) => {
      if (!ended) { supervisor.ref(); supervisor.stdin.end(); }
      const timer = setTimeout(() => {
        unref();
        reject(new Error('Neovim supervisor did not exit within 5 seconds'));
      }, 5000);
      exited.promise.then(result => { clearTimeout(timer); resolve(result); });
    });
  }

  // Backstop for a supervisor that itself hangs; it enforces the real startup deadline.
  const startupTimer = setTimeout(() => {
    failure ??= new Error('Neovim supervisor startup timed out');
    stop().catch(() => {});
  }, startupTimeoutMs + 3000);

  function finish(code, signal) {
    if (ended) return;
    ended = true;
    clearTimeout(startupTimer);
    const detail = stderr.trim() ? `: ${stderr.trim()}` : '';
    const error = failure ?? (stopPromise ? undefined : new Error(`Neovim supervisor exited (${signal ?? code})${detail}`));
    const notReady = error ?? new Error('Neovim stopped before becoming ready');
    spawned.reject(notReady);
    ready.reject(notReady);
    for (const stream of supervisor.stdio) stream?.destroy();
    exited.resolve({ error });
  }
  supervisor.on('error', error => { failure ??= error; finish(null, null); });
  // 'close', not 'exit': drain the status pipe so a final error line is not lost.
  supervisor.once('close', finish);
  supervisor.stdin.on('error', () => {});
  supervisor.stderr.setEncoding('utf8').on('data', data => { stderr = (stderr + data).slice(-8192); });
  supervisor.stdout.setEncoding('utf8').on('data', data => {
    output += data;
    let newline;
    while ((newline = output.indexOf('\n')) >= 0) {
      const message = JSON.parse(output.slice(0, newline));
      output = output.slice(newline + 1);
      if (message.type === 'error') failure ??= new Error(message.message);
      if (message.type === 'spawned') spawned.resolve(message.info);
      if (message.type === 'ready' && !stopPromise) {
        clearTimeout(startupTimer);
        unref();
        ready.resolve(message.info);
      }
    }
  });

  return {
    /** @type {Promise<NvimInfo>} Resolves once the process exists, before its configuration has loaded. */
    spawned: spawned.promise,
    /** @type {Promise<NvimInfo>} */
    ready: ready.promise,
    /** @type {Promise<{ error?: Error }>} `error` is set unless the exit followed stop(). */
    exited: exited.promise,
    stop,
  };
}
