// A separate process: Pi's shutdown handlers cannot run after SIGKILL.
// stdin is the lifetime pipe. Only Pi owns its writing end; never pass it to Nvim.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

let child;
let directory;
let config;
let stopping = false;
let finished = false;
let ready = false;
let input = '';
let stderr = '';
let startupTimer;
let termTimer;
let killTimer;

function send(message) {
  if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(message) + '\n');
}

function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(startupTimer);
  clearTimeout(termTimer);
  clearTimeout(killTimer);
  // Do not wait for 'close': a plugin subprocess could inherit an output pipe.
  for (const stream of child?.stdio ?? []) stream?.destroy();
  process.stdin.destroy();
  if (directory) {
    try { rmSync(directory, { recursive: true, force: true }); }
    catch (error) { send({ type: 'error', message: `Cannot remove Neovim runtime directory: ${error.message}` }); }
  }
}

function stop() {
  if (stopping || finished) return;
  stopping = true;
  clearTimeout(startupTimer);
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
    finish();
    return;
  }
  // --embed normally exits on EOF. The timers also work if Nvim's event loop
  // is stuck (or SIGSTOPped); SIGKILL does not require its cooperation.
  child.stdin.end();
  termTimer = setTimeout(() => child.kill('SIGTERM'), config.graceMs);
  killTimer = setTimeout(() => child.kill('SIGKILL'), config.killMs);
}

function fail(error) {
  send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  stop();
}

// Signal handling belongs here, not in Pi (where it could change Pi's behavior).
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
process.stdout.on('error', stop); // Parent died while a status message was being sent.
process.stderr.on('error', stop);
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.on('error', stop);
// Synchronous last resort for an unexpected *orderly* supervisor exit.
// SIGKILL of the supervisor itself remains outside this userspace guarantee.
process.on('exit', () => {
  if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});

function launch(options) {
  config = options;
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('nvim-service requires macOS or Linux');
  if (typeof config.cwd !== 'string' || typeof config.executable !== 'string' ||
      (config.init !== undefined && typeof config.init !== 'string') ||
      !Number.isSafeInteger(config.startupTimeoutMs) || config.startupTimeoutMs < 1 ||
      !Number.isSafeInteger(config.graceMs) || config.graceMs < 1 ||
      !Number.isSafeInteger(config.killMs) || config.killMs <= config.graceMs) {
    throw new Error('Invalid Neovim supervisor configuration');
  }

  // Keep Unix socket paths short, including on macOS with its long $TMPDIR.
  // mkdtemp creates a private (0700), unpredictable directory under /tmp.
  directory = mkdtempSync('/tmp/pi-nvim-');
  const socket = join(directory, 'nvim.sock');
  const env = { ...process.env, PI_NVIM_SERVICE: '1', PI_NVIM_SOCKET: socket };
  delete env.NVIM;
  delete env.NVIM_LISTEN_ADDRESS;
  const args = ['--headless', '--embed', '--listen', socket, '-n', '-i', 'NONE'];
  if (config.init !== undefined) args.push('-u', config.init);
  // A dedicated readiness FD avoids dependencies on a Msgpack client or polling.
  // Register before init.lua, but signal only after VimEnter callbacks have run.
  args.push('--cmd', 'lua vim.api.nvim_create_autocmd("VimEnter", {once=true, callback=function() vim.schedule(function() local uv=vim.uv or vim.loop; assert(uv.fs_write(3, "ready\\n", -1)); uv.fs_close(3) end) end})');
  child = spawn(config.executable, args, {
    cwd: config.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {}); // Nvim may close stdin before our EOF.
  child.stdout.resume(); // Never let unread RPC output block the child.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
  child.on('error', fail);
  child.once('exit', (code, signal) => {
    if (!stopping) send({ type: 'error', message: `Neovim exited ${ready ? 'unexpectedly' : 'during startup'} (${signal ?? code})${stderr ? `: ${stderr.trim()}` : ''}` });
    // Node has reaped our own child before emitting 'exit'. Never signal an old PID.
    finish();
  });
  if (!child.pid) return; // spawn's asynchronous error handler will finish cleanup.
  const info = { socket, pid: child.pid, supervisorPid: process.pid, cwd: config.cwd };
  send({ type: 'spawned', info });
  let readiness = '';
  child.stdio[3].on('error', fail);
  child.stdio[3].on('data', data => {
    if (ready || stopping) return;
    readiness += data.toString();
    if (readiness === 'ready\n') {
      ready = true;
      clearTimeout(startupTimer);
      send({ type: 'ready', info });
    } else if (readiness.length > 64) {
      fail(new Error('Invalid Neovim readiness message'));
    }
  });
  startupTimer = setTimeout(() => fail(new Error(`Neovim startup timed out after ${config.startupTimeoutMs}ms${stderr ? `: ${stderr.trim()}` : ''}`)), config.startupTimeoutMs);
}

// Configuration is the first line; after that this is only a lifetime channel.
// EOF before configuration must not spawn anything or create a runtime directory.
process.stdin.setEncoding('utf8'); // Config paths may span UTF-8 chunk boundaries.
process.stdin.on('data', data => {
  if (config || stopping) return;
  input += data.toString();
  if (input.length > 65536) return fail(new Error('Oversized supervisor configuration'));
  const newline = input.indexOf('\n');
  if (newline < 0) return;
  try { launch(JSON.parse(input.slice(0, newline))); }
  catch (error) { fail(error); }
  input = '';
});
