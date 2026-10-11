import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export const SEVERITIES = ['error', 'warning', 'info', 'hint'];
const LUA = readFileSync(new URL('./diagnostics.lua', import.meta.url), 'utf8');
const PER_FILE = 50;
const OUTPUT_LIMIT = 16384;
const STATUS = { pending: 'no answer', busy: 'still working' };

export function validate(params) {
  const { files, severity = 'warning', timeoutMs = 10000 } = params ?? {};
  if (!Array.isArray(files) || !files.length || files.length > 32 ||
      files.some(file => typeof file !== 'string' || !file || file.length > 4096 || file.includes('\0'))) {
    throw new Error('files must be 1-32 paths');
  }
  if (!SEVERITIES.includes(severity)) throw new Error(`severity must be one of ${SEVERITIES.join(', ')}`);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('timeoutMs must be an integer from 100 to 60000');
  return { files, severity, timeoutMs };
}

function describe(file, shown, cwd, timeoutMs) {
  const inside = relative(cwd, file.path);
  const name = inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : file.path;
  if (file.error) return [`${name}: ${file.error}`];
  if (!file.clients.length) return [`${name}: no language server or linter for this file`];
  const counts = SEVERITIES.filter(level => file.counts[level])
    .map(level => `${file.counts[level]} ${level}${file.counts[level] > 1 ? 's' : ''}`).join(', ') || 'no diagnostics';
  const clients = file.clients.map(client => `${client.name} ${STATUS[client.status] ?? client.status}`).join(', ');
  const listed = file.diagnostics.filter(d => shown.includes(d.severity));
  const total = shown.reduce((sum, level) => sum + file.counts[level], 0);
  const lines = [`${name}: ${file.done ? '' : `incomplete after ${timeoutMs} ms: `}${counts}${file.unsaved ? ' (unsaved buffer)' : ''} — ${clients}`];
  for (const d of listed.slice(0, PER_FILE)) {
    const message = d.message.replace(/\s+/g, ' ').trim().slice(0, 500);
    lines.push(`  ${d.line}:${d.column} ${d.severity}${d.code ? ` [${d.code}]` : ''} ${message}${d.source ? ` (${d.source})` : ''}`);
  }
  if (total > PER_FILE) lines.push(`  +${total - PER_FILE} more`);
  return lines;
}

/**
 * Check files through the language servers of the Pi-owned Neovim; returns text for the model.
 * With `trace`, a timeline of every request, reply and report follows the result.
 */
export async function diagnose(nvim, input, cwd, signal, { trace = false } = {}) {
  const params = validate(input);
  const files = [...new Set(params.files.map(file => resolve(cwd, file)))];
  // Neovim enforces the deadline itself; the margin only covers an editor that stopped answering.
  const limit = AbortSignal.timeout(params.timeoutMs + 3000);
  const report = await nvim.lua(LUA, [{ files, timeoutMs: params.timeoutMs, trace }], { signal: signal ? AbortSignal.any([signal, limit]) : limit });
  const shown = SEVERITIES.slice(0, SEVERITIES.indexOf(params.severity) + 1);
  const text = report.files.flatMap(file => describe(file, shown, cwd, params.timeoutMs)).join('\n');
  if (trace) return `${text}\n\nTimeline (${report.elapsedMs} ms):\n${report.trace.join('\n')}`;
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n[Truncated: check fewer files or raise severity.]` : text;
}

/** What the checks have to work with: every language server in the editor and how it is treated. */
export async function status(nvim, signal) {
  const { clients, pendingPulls, trackedBuffers } = await nvim.lua(LUA, [{ status: true }], { signal });
  if (!clients.length) return 'No language servers are running. They start when a file is first checked or opened.';
  const lines = clients.map(c => `  ${c.name} (${c.id}): ${!c.initialized ? 'starting' : c.pull ? 'pull, answers are definite'
    : `push only, ${c.reports ? '' : 'has never reported, '}given ${c.windowMs} ms after a change`}; ${c.buffers} buffer${c.buffers === 1 ? '' : 's'}; root ${c.root ?? 'none'}`);
  return `Language servers in Pi's Neovim:\n${lines.join('\n')}\n${trackedBuffers} checked file${trackedBuffers === 1 ? '' : 's'} kept open${pendingPulls ? `; ${pendingPulls} diagnostic requests still pending` : ''}`;
}

/**
 * Checks files in the background and discards the result, so that their servers are
 * running and settled before anyone asks. `add(path)` queues an absolute path; paths
 * added while a check is running go into the next one.
 */
export function warmer(nvim) {
  const pending = new Set();
  let running;
  async function run() {
    while (pending.size) {
      const files = [...pending].slice(0, 32);
      for (const file of files) pending.delete(file);
      // Best effort: the service may be down, the file gone, the editor at a prompt.
      try { await diagnose(nvim(), { files }, '/'); } catch { /* the real check will say why */ }
    }
    running = undefined;
  }
  return { add(path) { pending.add(path); return running ??= run(); } };
}
