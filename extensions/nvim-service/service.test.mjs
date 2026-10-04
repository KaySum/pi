import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { launchNvimService } from './service.mjs';

const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const defaults = { cwd: process.cwd(), executable: 'nvim', init: 'NONE', graceMs: 100, killMs: 300 };
const ownerFile = fileURLToPath(new URL('./test/owner.mjs', import.meta.url));
const supervisorFile = fileURLToPath(new URL('./supervisor.mjs', import.meta.url));

function running(pid) {
  try {
    process.kill(pid, 0);
    // Some Linux container PID 1s do not reap adopted children. Zombies aren't
    // running; Nvim itself is reaped by its supervisor, not left to PID 1.
    if (process.platform === 'linux' && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'ENOENT') return false;
    throw error;
  }
}

async function until(predicate, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(15);
  }
}

async function assertClean(info) {
  await until(() => !running(info.pid) && !running(info.supervisorPid) && !existsSync(dirname(info.socket)), 'Nvim, supervisor, and runtime directory cleanup');
}

function fixture(t, options = {}) {
  const child = spawn(process.execPath, [ownerFile, JSON.stringify({ ...defaults, ...options })], {
    detached: true, // A disposable group; tests must never signal the real Pi's group.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  let output = '';
  let stderr = '';
  let exit;
  const exited = new Promise(resolve => { exit = resolve; });
  child.once('exit', (code, signal) => exit({ code, signal }));
  child.stdin.on('error', () => {});
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => {
    output += data;
    let newline;
    while ((newline = output.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(output.slice(0, newline)));
      output = output.slice(newline + 1);
    }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    const info = messages.find(m => m.info)?.info;
    try { if (info) await assertClean(info); }
    finally {
      // Emergency cleanup if the implementation regresses. Never global pkill.
      if (info && running(info.pid)) process.kill(info.pid, 'SIGKILL');
      if (info && running(info.supervisorPid)) process.kill(info.supervisorPid, 'SIGTERM');
      for (const stream of child.stdio) stream?.destroy();
    }
  });
  return {
    child, exited,
    async message(type) {
      await until(() => messages.some(m => m.type === type), `${type} message (${stderr})`);
      return messages.find(m => m.type === type);
    },
  };
}

async function rpc(socket, expression) {
  const { stdout } = await exec('nvim', ['--server', socket, '--remote-expr', expression], { timeout: 2000 });
  return stdout.trim();
}

test('private socket is ready after init, RPC works, and editor NVIM is not inherited', async t => {
  const env = { ...process.env, NVIM: '/do/not/touch/editor.sock', NVIM_LISTEN_ADDRESS: '/do/not/touch/legacy.sock', PI_NVIM_SOCKET: '/inherited/outer-pi.sock' };
  const service = launchNvimService({ ...defaults, env });
  t.after(() => service.stop());
  const info = await service.ready;
  assert.equal((await stat(dirname(info.socket))).mode & 0o777, 0o700);
  const actual = JSON.parse(await rpc(info.socket, 'json_encode({"pid":getpid(), "cwd":getcwd(), "nvim":$NVIM, "legacy":$NVIM_LISTEN_ADDRESS, "service":$PI_NVIM_SERVICE, "socket":$PI_NVIM_SOCKET, "shada":&shadafile, "updatecount":&updatecount})'));
  assert.deepEqual(actual, { pid: info.pid, cwd: process.cwd(), nvim: '', legacy: '', service: '1', socket: info.socket, shada: 'NONE', updatecount: 0 });
  assert.equal(env.NVIM, '/do/not/touch/editor.sock');
  const { stdout } = await exec('ps', ['-o', 'pgid=', '-p', String(info.supervisorPid)]);
  assert.equal(Number(stdout.trim()), info.supervisorPid, 'supervisor owns a separate process group');
  const stop = service.stop();
  assert.equal(service.stop(), stop, 'stop is idempotent, including while pending');
  await stop;
  await assertClean(info);
});

for (const action of ['stop', 'exit', 'crash', 'SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL']) {
  test(`owner ${action} leaves no Neovim or supervisor`, async t => {
    const owner = fixture(t);
    const { info } = await owner.message('ready');
    if (action.startsWith('SIG')) owner.child.kill(action);
    else owner.child.stdin.write(action + '\n');
    await owner.exited;
    await assertClean(info);
  });
}

test('the idle service does not prevent natural owner-process exit', async t => {
  const owner = fixture(t, { mode: 'natural-exit' });
  const { info } = await owner.message('ready');
  assert.equal((await owner.exited).code, 0);
  await assertClean(info);
});

test('SIGKILL of owner also cleans up a SIGSTOPped Neovim', async t => {
  const owner = fixture(t);
  const { info } = await owner.message('ready');
  process.kill(info.pid, 'SIGSTOP');
  owner.child.kill('SIGKILL');
  await owner.exited;
  await assertClean(info);
});

test('terminating the owner process group does not kill the supervisor prematurely', async t => {
  const owner = fixture(t);
  const { info } = await owner.message('ready');
  process.kill(info.pid, 'SIGSTOP');
  process.kill(-owner.child.pid, 'SIGHUP');
  await owner.exited;
  await assertClean(info);
});

test('a stuck Lua callback cannot block cleanup', async t => {
  const owner = fixture(t);
  const { info } = await owner.message('ready');
  // Schedule the loop after the RPC has returned. It deliberately never yields.
  await rpc(info.socket, 'luaeval("(function() vim.defer_fn(function() while true do end end, 50); return true end)()")');
  await delay(100);
  owner.child.kill('SIGKILL');
  await owner.exited;
  await assertClean(info);
});

test('Pi death during initialization still triggers supervisor cleanup', async t => {
  const directory = await mkdtemp('/tmp/pi-nvim-test-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const init = join(directory, 'init.lua');
  await writeFile(init, 'while true do end\n');
  const owner = fixture(t, { init });
  const { info } = await owner.message('spawned');
  owner.child.kill('SIGKILL');
  await owner.exited;
  await assertClean(info);
});

test('a hung init has a startup deadline and is killed before ready rejects', async t => {
  const directory = await mkdtemp('/tmp/pi-nvim-test-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const init = join(directory, 'init.lua');
  await writeFile(init, 'while true do end\n');
  const service = launchNvimService({ ...defaults, init, startupTimeoutMs: 200 });
  t.after(() => service.stop());
  const info = await service.spawned;
  await assert.rejects(service.ready, /startup timed out/);
  await assertClean(info);
});

test('stop during startup is bounded and repeatable', async t => {
  const service = launchNvimService(defaults);
  t.after(() => service.stop());
  const info = await service.spawned;
  await service.stop();
  await assertClean(info);
});

test('missing executable and bad cwd fail without leaking resources', async t => {
  for (const options of [{ executable: '/no/such/nvim' }, { cwd: '/no/such/project' }]) {
    const service = launchNvimService({ ...defaults, ...options });
    t.after(() => service.stop());
    await assert.rejects(service.ready, /ENOENT/);
    assert.equal((await service.exited).expected, false);
  }
  assert.throws(() => launchNvimService({ ...defaults, killMs: 1 }), /Invalid.*configuration/);
});

test('unexpected Neovim exit cleans up its supervisor and reports an error', async t => {
  const service = launchNvimService(defaults);
  t.after(() => service.stop());
  const info = await service.ready;
  process.kill(info.pid, 'SIGKILL');
  const result = await service.exited;
  assert.equal(result.expected, false);
  assert.match(result.error.message, /Neovim exited unexpectedly/);
  await assertClean(info);
});

test('supervisor handles direct SIGTERM without abandoning Neovim', async t => {
  const owner = fixture(t);
  const { info } = await owner.message('ready');
  process.kill(info.pid, 'SIGSTOP');
  process.kill(info.supervisorPid, 'SIGTERM');
  await owner.exited;
  await assertClean(info);
});

test('EOF before configuration does not launch a service', async () => {
  const supervisor = spawn(process.execPath, [supervisorFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  supervisor.stdout.on('data', data => { output += data; });
  supervisor.stderr.resume();
  const exit = new Promise(resolve => supervisor.once('exit', (code, signal) => resolve({ code, signal })));
  supervisor.stdin.end();
  assert.deepEqual(await exit, { code: 0, signal: null });
  assert.equal(output, '');
});

test('concurrent instances have distinct sockets; stopping one cannot affect another', async t => {
  const first = launchNvimService(defaults);
  const second = launchNvimService(defaults);
  t.after(() => Promise.all([first.stop(), second.stop()]));
  const [a, b] = await Promise.all([first.ready, second.ready]);
  assert.notEqual(a.socket, b.socket);
  assert.notEqual(a.pid, b.pid);
  await first.stop();
  await assertClean(a);
  assert.equal(Number(await rpc(b.socket, 'getpid()')), b.pid);
  await second.stop();
  await assertClean(b);
});
