// A separate process, because nothing in Pi can run after Pi is SIGKILLed.
// stdin is the lifetime pipe: only Pi holds its writing end, so EOF means Pi is gone.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const config = JSON.parse(process.argv[2]);
const timers = [];
let child;
let directory;
let startupTimer;
let stopping = false;
let finished = false;
let ready = false;
let stderr = '';

function send(message) {
  if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(message) + '\n');
}

function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(startupTimer);
  timers.forEach(clearTimeout);
  // Do not wait for the pipes to close: a plugin subprocess may have inherited them.
  for (const stream of child?.stdio ?? []) stream?.destroy();
  process.stdin.destroy();
  if (!directory) return;
  try { rmSync(directory, { recursive: true, force: true }); }
  catch (error) { send({ type: 'error', message: `Cannot remove ${directory}: ${error.message}` }); }
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return finish();
  // --embed exits cleanly on EOF. The signals cover a Neovim that is busy, frozen or stopped.
  child.stdin.end();
  timers.push(setTimeout(() => child.kill('SIGTERM'), config.graceMs),
    setTimeout(() => child.kill('SIGKILL'), config.killMs));
}

function fail(error) {
  send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  stop();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
process.stdin.on('end', stop).on('close', stop).on('error', stop).resume();
process.stdout.on('error', stop); // Pi died while a status line was being written.
process.stderr.on('error', stop);
// Last resort for an orderly supervisor exit that skipped stop().
process.on('exit', () => {
  if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});

// The plugins that Pi's nvim-service.json keeps out of this instance.
function disabledPlugins() {
  if (!config.settings) return [];
  let text;
  try { text = readFileSync(config.settings, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  try {
    const { disabledPlugins = [] } = JSON.parse(text);
    if (Array.isArray(disabledPlugins) && disabledPlugins.every(name => typeof name === 'string')) return disabledPlugins;
  } catch {}
  throw new Error(`${config.settings} must be JSON like { "disabledPlugins": ["persistence.nvim"] }`);
}

function launch() {
  const disabled = disabledPlugins();
  // A short path: Unix socket paths are limited and macOS's $TMPDIR is long. mkdtemp is 0700.
  directory = mkdtempSync('/tmp/pi-nvim-');
  const socket = join(directory, 'nvim.sock');
  const env = { ...process.env, PI_NVIM_SERVICE: '1', PI_NVIM_SOCKET: socket };
  // Pi may itself run inside a Neovim terminal; this instance must not address its parent.
  delete env.NVIM;
  delete env.NVIM_LISTEN_ADDRESS;
  const args = ['--headless', '--embed', '--listen', socket, '-n', '-i', 'NONE'];
  if (config.init !== undefined) args.push('-u', config.init);
  // Ready means the user's configuration has loaded, not merely that the socket exists.
  args.push('--cmd', 'lua vim.api.nvim_create_autocmd("VimEnter", {once=true, callback=function() vim.schedule(function() local uv=vim.uv or vim.loop; uv.fs_write(3, "ready\\n", -1); uv.fs_close(3) end) end})');
  if (disabled.length) {
    env.PI_NVIM_DISABLED_PLUGINS = JSON.stringify(disabled);
    args.push('--cmd', `lua dofile(${JSON.stringify(fileURLToPath(new URL('./disable.lua', import.meta.url)))})`);
  }
  child = spawn(config.executable, args, { cwd: config.cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {}); // Neovim may close its end first.
  child.stdout.resume();
  child.stderr.setEncoding('utf8').on('data', data => { stderr = (stderr + data).slice(-8192); });
  const detail = () => stderr.trim() ? `: ${stderr.trim()}` : '';
  child.on('error', fail);
  child.once('exit', (code, signal) => {
    if (!stopping) send({ type: 'error', message: `Neovim exited ${ready ? 'unexpectedly' : 'during startup'} (${signal ?? code})${detail()}` });
    stopping = true;
    finish();
  });
  if (!child.pid) return; // The 'error' handler reports the failed spawn.
  const info = { socket, pid: child.pid, supervisorPid: process.pid, cwd: config.cwd };
  send({ type: 'spawned', info });
  child.stdio[3].on('error', () => {}).once('data', () => {
    if (stopping) return;
    ready = true;
    clearTimeout(startupTimer);
    send({ type: 'ready', info });
  });
  startupTimer = setTimeout(() => fail(new Error(`Neovim startup timed out after ${config.startupTimeoutMs} ms${detail()}`)), config.startupTimeoutMs);
}

try { launch(); } catch (error) { fail(error); }
