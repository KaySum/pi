import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { withServers } from '../nvim-service/api.mjs';

const LUA = withServers(readFileSync(new URL('./format.lua', import.meta.url), 'utf8'));
const RANGES = 12;

export function validate(params) {
  const { files, timeoutMs = 10000 } = params ?? {};
  if (!Array.isArray(files) || !files.length || files.length > 32 ||
      files.some(file => typeof file !== 'string' || !file || file.length > 4096 || file.includes('\0'))) {
    throw new Error('files must be 1-32 paths');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('timeoutMs must be an integer from 100 to 60000');
  return { files, timeoutMs };
}

function describe(file, cwd) {
  const inside = relative(cwd, file.path);
  const name = inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : file.path;
  const by = file.formatters?.join(', ');
  if (file.error) return `${name}: ${file.error}${by ? ` — ${by}` : ''}`;
  if (!by) return `${name}: no formatter for this file`;
  if (!file.changed.length) return `${name}: already formatted — ${by}`;
  const ranges = file.changed.slice(0, RANGES).map(([first, last]) => first === last ? first : `${first}-${last}`).join(', ');
  const more = file.changed.length > RANGES ? `, +${file.changed.length - RANGES} more` : '';
  return `${name}: formatted, lines ${ranges}${more} changed — ${by}`;
}

/** Format files with the formatters of the Pi-owned Neovim and write them; returns text for the model. */
export async function format(nvim, input, cwd, signal) {
  const params = validate(input);
  const files = [...new Set(params.files.map(file => resolve(cwd, file)))];
  // Neovim enforces the deadline itself; the margin only covers an editor that stopped answering.
  const limit = AbortSignal.timeout(params.timeoutMs + 3000);
  const report = await nvim.lua(LUA, [{ files, timeoutMs: params.timeoutMs }], { signal: signal ? AbortSignal.any([signal, limit]) : limit });
  return report.files.map(file => describe(file, cwd)).join('\n');
}
