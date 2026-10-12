import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { withServers } from '../nvim-service/api.mjs';

export const ACTIONS = ['rename', 'actions', 'apply'];
const LUA = withServers(readFileSync(new URL('./refactor.lua', import.meta.url), 'utf8'));
const RANGES = 12;
const SHOWN = 50;

export function validate(params) {
  const { action, file, line, symbol, column, endLine, newName, title, kind, timeoutMs = 10000 } = params ?? {};
  const text = (value, limit) => typeof value === 'string' && value && value.length <= limit && !/[\0\n]/.test(value);
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(', ')}`);
  if (!text(file, 4096)) throw new Error('file must be a path');
  if (line !== undefined && (!Number.isInteger(line) || line < 1)) throw new Error('line must be a 1-based line number');
  if (symbol !== undefined && !text(symbol, 256)) throw new Error('symbol must be text of up to 256 characters');
  if (column !== undefined && (!Number.isInteger(column) || column < 1)) throw new Error('column must be a 1-based byte column');
  if ((symbol ?? column ?? endLine) !== undefined && line === undefined) throw new Error('symbol, column and endLine need line');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('timeoutMs must be an integer from 100 to 60000');
  if (action === 'rename') {
    if (line === undefined || (symbol ?? column) === undefined) throw new Error('rename needs line (1-based) and either symbol, the text on that line, or column');
    if (!text(newName, 256)) throw new Error('rename needs newName');
    return { action, file, line, symbol, column, newName, timeoutMs };
  }
  if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < line || (symbol ?? column) !== undefined)) {
    throw new Error('endLine must be a line from line on, given without symbol or column');
  }
  if (title !== undefined && !text(title, 512)) throw new Error('title must be text of up to 512 characters');
  if (kind !== undefined && !text(kind, 128)) throw new Error('kind must be a code action kind such as quickfix or source.organizeImports');
  if (action === 'apply' && (title ?? kind) === undefined) throw new Error('apply needs title, as actions listed it, or a kind that only one action has');
  return action === 'apply' ? { action, file, line, symbol, column, endLine, title, kind, timeoutMs } : { action, file, line, symbol, column, endLine, kind, timeoutMs };
}

// Those that cannot be applied here are only counted: servers list every refactoring they know.
function listed(actions, all = false) {
  const shown = actions.filter(a => all || a.disabled === undefined);
  const lines = shown.slice(0, SHOWN).map(a => `  ${a.title}${a.kind ? `  [${a.kind}]` : ''}${a.disabled ? ` (${a.disabled})` : ''}`);
  if (shown.length > SHOWN) lines.push(`  +${shown.length - SHOWN} more`);
  if (shown.length < actions.length) lines.push(`  +${actions.length - shown.length} that cannot be applied here`);
  return lines.join('\n');
}

function describe(report, params, cwd) {
  // Servers report resolved paths, so a cwd reached through a symlink is tried both ways.
  const roots = [cwd, realpathSync(cwd)];
  const show = path => roots.map(root => relative(root, path)).find(inside => inside && !inside.startsWith('..') && !isAbsolute(inside)) ?? path;
  const where = `${show(resolve(cwd, params.file))}${params.line ? `:${params.line}` : ''}`;
  if (report.servers === 0) return `No language server for ${show(resolve(cwd, params.file))} ${params.action === 'rename' ? 'can rename' : 'offers code actions'}.`;

  if (report.actions && !report.files) {
    const failed = report.problems.length ? ` (${report.problems.join('; ')})` : '';
    const of = params.kind ? ` of kind ${params.kind}` : '';
    const list = listed(report.actions);
    const usable = report.actions.filter(a => a.disabled === undefined).length;
    if (params.action === 'apply') {
      // Nothing was applied: the model has to choose, so this is an error with the choices in it.
      const asked = params.title ? `"${params.title}" in ${report.matches.length > 1 ? 'their' : 'its'} title` : `kind ${params.kind}`;
      throw new Error(report.matches.length ? `${report.matches.length} code actions for ${where} have ${asked}; give the full title of one, or a kind that only one has:\n${listed(report.matches, true)}`
        : report.actions.length ? `No code action for ${where} has ${asked}. There are:\n${list}` : `No code actions${of} for ${where}${failed}`);
    }
    if (!report.actions.length) return `No code actions${of} for ${where}${failed}`;
    const names = [...new Set(report.actions.map(a => a.server))].join(', ');
    return `${usable} code action${usable === 1 ? '' : 's'}${of} for ${where} — ${names}${failed}\n${list}`;
  }

  const head = params.action === 'rename' ? `Renamed ${report.symbol ?? 'the symbol'} to ${params.newName}` : `Applied "${report.title}"`;
  const lines = report.files.map(file => {
    const ranges = file.changed.slice(0, RANGES).map(([first, last]) => first === last ? first : `${first}-${last}`).join(', ');
    return `${show(file.path)}: lines ${ranges}${file.changed.length > RANGES ? `, +${file.changed.length - RANGES} more` : ''} changed`;
  }).concat(report.moved.map(op => `${op.kind}d ${op.from ? `${show(op.from)} to ` : ''}${show(op.path)}`));
  if (!lines.length) return `${head} — ${report.server}: it changed no files`;
  const count = report.files.length;
  return `${head}${count ? ` in ${count} file${count === 1 ? '' : 's'}` : ''} — ${report.server}\n${lines.join('\n')}`;
}

/** Rename a symbol or list and apply code actions through the language servers of the Pi-owned Neovim; returns text for the model. */
export async function refactor(nvim, input, cwd, signal) {
  const params = validate(input);
  // Neovim enforces the deadline itself; the margin only covers an editor that stopped answering.
  const limit = AbortSignal.timeout(params.timeoutMs + 3000);
  // Absent options must be absent, not null: Lua would see a value.
  const request = Object.fromEntries(Object.entries({ ...params, file: resolve(cwd, params.file), cwd }).filter(([, value]) => value !== undefined));
  let report;
  try { report = await nvim.lua(LUA, [request], { signal: signal ? AbortSignal.any([signal, limit]) : limit }); }
  catch (error) {
    // The helper's own refusals ("no such file", "x is not on line 3") are the message; drop Lua's framing.
    const refusal = /^(?:Lua: )?(?!\[string )([^\n]+)\nstack traceback:/.exec(error?.message ?? '');
    throw refusal ? new Error(refusal[1]) : error;
  }
  return describe(report, params, cwd);
}

/** `rename src/a.ts 3 greet welcome`, `actions src/a.ts [3]`, `apply src/a.ts 3 Add import`. */
export function parse(text) {
  const [action, file, ...rest] = text.split(/\s+/).filter(Boolean);
  if (action === 'rename') return { action, file, line: Number(rest[0]), symbol: rest[1], newName: rest[2] };
  const line = /^\d+$/.test(rest[0] ?? '') ? Number(rest.shift()) : undefined;
  return { action, file, line, title: action === 'apply' ? rest.join(' ') || undefined : undefined };
}
