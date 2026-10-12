import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export const ACTIONS = ['definition', 'type', 'implementation', 'declaration', 'references', 'hover', 'symbols', 'workspace_symbols'];
const LUA = readFileSync(new URL('./navigation.lua', import.meta.url), 'utf8');
const LABEL = { definition: ['definition', 'definitions'], type: ['type definition', 'type definitions'], implementation: ['implementation', 'implementations'],
  declaration: ['declaration', 'declarations'], references: ['reference', 'references'] };
const AT_POSITION = ['definition', 'type', 'implementation', 'declaration', 'references', 'hover'];
const SHOWN = 100;
const OUTPUT_LIMIT = 16384;

export function validate(params) {
  const { action, file, line, symbol, column, query, timeoutMs = 10000 } = params ?? {};
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`);
  if (typeof file !== 'string' || !file || file.length > 4096 || file.includes('\0')) throw new Error('file must be a path');
  if (AT_POSITION.includes(action)) {
    if (!Number.isInteger(line) || line < 1) throw new Error(`${action} needs line (1-based) and either symbol, the text on that line, or column`);
    if (symbol === undefined && column === undefined) throw new Error(`${action} needs symbol (the text on that line) or column`);
  }
  if (symbol !== undefined && (typeof symbol !== 'string' || !symbol || symbol.length > 256)) throw new Error('symbol must be text of up to 256 characters');
  if (column !== undefined && (!Number.isInteger(column) || column < 1)) throw new Error('column must be a 1-based byte column');
  if (query !== undefined && (typeof query !== 'string' || query.length > 256)) throw new Error('query must be text of up to 256 characters');
  if (action === 'workspace_symbols' && !query?.trim()) throw new Error('workspace_symbols needs a query');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('timeoutMs must be an integer from 100 to 60000');
  return { action, file, line, symbol, column, query, timeoutMs };
}

function format(report, action, cwd) {
  // Servers report resolved paths, so a cwd reached through a symlink is tried both ways.
  const roots = [cwd, realpathSync(cwd)];
  const show = path => roots.map(root => relative(root, path)).find(inside => inside && !inside.startsWith('..') && !isAbsolute(inside)) ?? path;
  const answered = report.servers.filter(server => server.status === 'answered').map(server => server.name);
  const others = report.servers.filter(server => !['answered', 'unsupported'].includes(server.status)).map(server => `${server.name} ${server.status}`);
  const of = report.symbol ? ` for ${report.symbol}` : '';
  const what = count => action === 'symbols' ? `symbols in ${show(report.path)}` : action === 'workspace_symbols' ? `symbols matching ${JSON.stringify(report.query ?? '')}`
    : action === 'hover' ? `hover information${of}` : `${LABEL[action][count === 1 ? 0 : 1]}${of}`;
  if (!report.servers.length) return `No language server for ${show(report.path)}.`;
  const note = `${others.length ? ` (${others.join(', ')})` : ''}${report.loading ? ' (servers were still loading; ask again)' : ''}${report.unsaved ? ' (unsaved buffer)' : ''}`;
  if (!answered.length && !others.length) return `No server for ${show(report.path)} supports this: ${report.servers.map(server => server.name).join(', ')}.`;
  if (!report.items.length) return `No ${what(0)} — ${answered.join(', ') || 'no server answered'}${note}`;

  const from = ` — ${answered.join(', ')}${note}`;
  if (action === 'hover') return report.items.map(item => `${report.symbol} — ${item.server}${note}\n${item.text}`).join('\n\n');
  const lines = [], shown = report.items.slice(0, SHOWN);
  if (action === 'symbols' || action === 'workspace_symbols') {
    lines.push(`${report.total} ${what(report.total)}${from}`);
    for (const item of shown) {
      lines.push(action === 'symbols' ? `${'  '.repeat(item.depth + 1)}${item.line}: ${item.kind} ${item.name}`
        : `  ${item.kind} ${item.name}${item.container ? ` in ${item.container}` : ''}  ${show(item.path)}${item.line ? `:${item.line}` : ''}`);
    }
  } else {
    lines.push(`${report.total} ${what(report.total)}${from}`);
    // Files in the order servers gave them, lines in order within each.
    const order = [...new Set(shown.map(item => item.path))];
    shown.sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path) || (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0));
    let file;
    for (const item of shown) {
      if (item.path !== file) lines.push(show(file = item.path));
      lines.push(`  ${item.line ?? '?'}:${item.column ?? '?'}  ${item.text}`);
    }
  }
  if (report.total > shown.length) lines.push(`  +${report.total - shown.length} more`);
  return lines.join('\n');
}

/** Answer one code-navigation question through the language servers of the Pi-owned Neovim. */
export async function navigate(nvim, input, cwd, signal) {
  const params = validate(input);
  // Neovim enforces the deadline itself; the margin only covers an editor that stopped answering.
  const limit = AbortSignal.timeout(params.timeoutMs + 3000);
  // Absent options must be absent, not null: Lua would see a value.
  const request = Object.fromEntries(Object.entries({ ...params, file: resolve(cwd, params.file) }).filter(([, value]) => value !== undefined));
  let report;
  try { report = await nvim.lua(LUA, [request], { signal: signal ? AbortSignal.any([signal, limit]) : limit }); }
  catch (error) {
    // The helper's own refusals ("no such file", "x is not on line 3") are the message; drop Lua's framing.
    const refusal = /^(?:Lua: )?(?!\[string )([^\n]+)\nstack traceback:/.exec(error?.message ?? '');
    throw refusal ? new Error(refusal[1]) : error;
  }
  const text = format(report, params.action, cwd);
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n[Truncated: narrow the query.]` : text;
}
