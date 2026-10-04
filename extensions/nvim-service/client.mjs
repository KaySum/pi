// Shared, lazy consumer infrastructure. This never owns/spawns a Neovim process.
import { constants } from 'node:fs';
import { open, readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectRpc } from './rpc.mjs';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const OUTPUT_BYTES = 16384;
// Serialize consumers of the same service, not unrelated service instances.
const queueKey = Symbol.for('pi.nvim-service.request-queues.v1');
const queues = globalThis[queueKey] ??= new Map();
export const errorText = error => error instanceof Error ? error.message : String(error);
export function validateTimeout(value = 10000) {
  if (!Number.isInteger(value) || value < 100 || value > 30000) throw new Error('timeoutMs must be an integer between 100 and 30000');
  return value;
}
export function validatePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}

// Fixed-size reads and O_NONBLOCK prevent an unbounded read or FIFO race.
export async function readDisk(path, signal, maximum = MAX_FILE_BYTES) {
  signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error('Not a regular file');
    if (before.size > Math.min(maximum, MAX_FILE_BYTES)) throw new Error('File exceeds the bounded Neovim read budget (at most 2 MiB per file)');
    const buffer = Buffer.alloc(Math.min(before.size + 1, maximum + 1, MAX_FILE_BYTES + 1));
    let length = 0;
    while (length < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat();
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('File changed while being read; retry');
    }
    const bytes = buffer.subarray(0, length);
    if (bytes.includes(0)) throw new Error('Binary file (NUL bytes)');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('File is not valid UTF-8 text'); }
    signal.throwIfAborted();
    return { hash: createHash('sha256').update(bytes).digest('hex'), text, bytes: length };
  } finally { await file.close(); }
}
export async function fingerprint(path, signal) { return (await readDisk(path, signal)).hash; }

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class ServiceClient {
  constructor(helper) {
    this.helper = helper;
    this.service = undefined;
    this.rpc = undefined;
    this.generation = new AbortController();
  }
  setService(info) {
    if (this.service?.socket === info?.socket && this.service?.pid === info?.pid) return;
    this.generation.abort(new Error('Neovim service stopped or changed; retry after it is ready'));
    this.rpc?.close(); this.rpc = undefined;
    this.service = info;
    this.generation = new AbortController();
  }
  close() {
    this.generation.abort(new Error('Neovim consumer session shut down'));
    this.rpc?.close(); this.rpc = undefined; this.service = undefined;
    this.generation = new AbortController();
  }
  async connect(signal) {
    if (this.rpc && !this.rpc.closed) return this.rpc;
    if (!this.service) throw new Error('Pi-owned Neovim is unavailable. Enable nvim-service and run /reload.');
    const info = this.service;
    const rpc = await connectRpc(info.socket, signal);
    try {
      const identity = await rpc.request('nvim_exec_lua', [
        'return {pid=vim.fn.getpid(), owned=vim.env.PI_NVIM_SERVICE, socket=vim.env.PI_NVIM_SOCKET}', [],
      ], signal);
      if (identity.pid !== info.pid || identity.owned !== '1' || identity.socket !== info.socket) {
        throw new Error('Refusing to use a Neovim that does not match the Pi-owned service');
      }
      for (const path of [new URL('./buffers.lua', import.meta.url), this.helper].filter(Boolean)) {
        const lua = await readFile(path, { encoding: 'utf8', signal });
        await rpc.request('nvim_exec_lua', [lua, []], signal);
      }
      signal.throwIfAborted();
      this.rpc = rpc;
      return rpc;
    } catch (error) { rpc.close(); throw error; }
  }
  async enqueue(timeoutMs, callerSignal, run) {
    const timeoutController = new AbortController();
    const deadline = Date.now() + timeoutMs;
    const timeout = new DOMException('Neovim request deadline exceeded', 'TimeoutError');
    const timer = setTimeout(() => timeoutController.abort(timeout), timeoutMs);
    const signal = AbortSignal.any([timeoutController.signal, this.generation.signal, callerSignal].filter(Boolean));
    const scope = { signal, deadline, timeoutController, callerSignal };
    const key = this.service ? `${this.service.socket}:${this.service.pid}` : this;
    let began = false;
    const work = (queues.get(key) ?? Promise.resolve()).then(() => { began = true; return run(scope); });
    const tail = work.catch(() => {});
    queues.set(key, tail);
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    try { return await abortable(work, signal); }
    catch (error) {
      // Active calls return partial results on their own deadline. Queued calls
      // return immediately through the same runner with an already-aborted signal.
      if (signal.reason === timeout && !callerSignal?.aborted) return began ? await work : await run(scope);
      if (began) await work.catch(() => {});
      throw error;
    } finally { clearTimeout(timer); }
  }
}

export async function boundedReport(report, lines, summarize, label) {
  const text = lines.join('\n');
  if (Buffer.byteLength(text) <= OUTPUT_BYTES && lines.length <= 1000) return { text, details: report };
  const directory = await mkdtemp(join(tmpdir(), `pi-nvim-${label}-report-`));
  const fullOutputPath = join(directory, 'report.json');
  await writeFile(fullOutputPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const kept = [];
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > OUTPUT_BYTES - 1024 || kept.length >= 980) break;
    kept.push(line); bytes += size;
  }
  return { text: kept.join('\n') + `\n\n[Output truncated. Full retrieved report: ${fullOutputPath}]`,
    details: { ...summarize(), truncated: true, fullOutputPath } };
}
