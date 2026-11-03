import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { usePoint, type Place, type ShowOptions } from './api.ts';

const USAGE = 'Usage: /nvim-point <path>:<line>[-<end line>][:<column>] [option=value …]';
// What went wrong, without the "Lua:" and stack trace an error from the editor carries.
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0].replace(/^Lua: /, '');

// The options, as show takes them; a value with spaces is "quoted", as JSON.
const OPTIONS: Record<string, string> = {
  match: 'Code to find instead of a line; the line given, the nearest',
  buf: 'A buffer by number, instead of a path',
  context: 'Lines kept around them when it scrolls (default 3)',
  scroll: 'center, top or minimal',
  jump: 'false: your jumplist and alternate file as they were',
  open: 'false: only where a window shows the file',
  focus: 'true: focus the window',
  wait: 'Milliseconds to wait while you are busy, or Infinity',
};
const CHOICES: Record<string, string[]> = {
  scroll: ['center', 'top', 'minimal'], jump: ['true', 'false'], open: ['true', 'false'], focus: ['true', 'false'],
};
const NUMBERS = ['buf', 'context', 'wait'];
const OPTION = /\s+(\w+)=("(?:[^"\\]|\\.)*"|\S*)/y;
// Where the options begin: after a space, or first only with an option's name, so a path may hold "=".
const OPTIONS_START = new RegExp(`^(?:${Object.keys(OPTIONS).join('|')})=|\\s\\w+=`);

function value(key: string, raw: string): unknown {
  let text: string | undefined = raw;
  if (raw.startsWith('"')) try { text = JSON.parse(raw) as string; } catch { text = undefined; }
  const result = text === undefined ? undefined
    : key === 'match' ? text
    : CHOICES[key]?.includes(text) ? (key === 'scroll' ? text : text === 'true')
    : NUMBERS.includes(key) && (/^\d+$/.test(text) || (key === 'wait' && text === 'Infinity')) ? Number(text)
    : undefined;
  if (result === undefined || result === '') throw new Error(`${key}=${raw} is not a value ${key} takes: ${OPTIONS[key]}`);
  return result;
}

/**
 * The place and options of `args`: the place `<path>:<line>[-<end line>][:<column>]` (columns from
 * 1, as compilers and grep give them), a path alone with `match=`, lines alone with `buf=`, or
 * nothing with both; then `option=value`s.
 */
export function parsePoint(args: string): { place: Place; options: ShowOptions } {
  const text = args.trim(), at = text.search(OPTIONS_START);
  const where = (at < 0 ? text : text.slice(0, at)).trim();
  const given: Record<string, unknown> = {};
  const rest = at < 0 ? '' : ` ${text.slice(at).trimStart()}`;
  OPTION.lastIndex = 0;
  let end = 0;
  for (let found; (found = OPTION.exec(rest));) {
    if (!(found[1] in OPTIONS)) throw new Error(`No option ${found[1]}: ${Object.keys(OPTIONS).join(', ')}`);
    given[found[1]] = value(found[1], found[2]);
    end = OPTION.lastIndex;
  }
  if (rest.slice(end).trim()) throw new Error(USAGE);
  const [, path, line, endLine, col] = where.match(/^(?:(.+?):)?(\d+)(?:-(\d+))?(?::(\d+))?$/) ?? [undefined, where || undefined];
  if (!line && given.match === undefined) throw new Error(USAGE);
  if (col === '0') throw new Error('Columns count from 1: 0');
  const { match, buf, context, ...options } = given;
  const place = Object.fromEntries(Object.entries({
    path, buf, match, context,
    line: line ? Number(line) : undefined,
    endLine: endLine ? Number(endLine) : undefined,
    col: col ? Number(col) - 1 : undefined,
  }).filter(([, v]) => v !== undefined)) as Place;
  return { place, options: options as ShowOptions };
}

const SHOWN = 50;

/**
 * Files and directories under what is typed, from `cwd`: a directory goes on with "/", a file
 * with ":" for its line. Hidden ones once a "." is typed; none once the line is.
 */
export async function completePath(prefix: string, cwd: string) {
  const typed = prefix.trimStart();
  if (/:\d*(-\d*)?(:\d*)?$/.test(typed)) return null;
  const folder = typed.slice(0, typed.lastIndexOf('/') + 1), start = typed.slice(folder.length);
  const entries = await readdir(resolve(cwd, folder || '.'), { withFileTypes: true }).catch(() => []);
  const items = entries
    .filter(entry => entry.name.startsWith(start) && (start.startsWith('.') || !entry.name.startsWith('.')))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, SHOWN)
    .map(entry => {
      const name = entry.isDirectory() ? `${entry.name}/` : entry.name;
      return { value: `${folder}${name}${entry.isDirectory() ? '' : ':'}`, label: name };
    });
  return items.length ? items : null;
}

/** Completions: paths for the place, then the options not given yet, and the values some take. */
export async function completePoint(prefix: string, cwd: string) {
  if (!/\s/.test(prefix.trimStart())) return completePath(prefix, cwd);
  const last = /\S*$/.exec(prefix)![0], base = prefix.slice(0, prefix.length - last.length);
  // Without the quoted values, whose text is no option; one still open is being typed.
  const bare = prefix.replace(/"(?:[^"\\]|\\.)*"/g, '');
  if (bare.includes('"')) return null;
  const [key, typed] = last.split('=', 2);
  const items = typed === undefined
    ? Object.keys(OPTIONS).filter(k => k.startsWith(key) && !new RegExp(`(?:^|\\s)${k}=`).test(bare.trimStart()))
      .map(k => ({ value: `${base}${k}=`, label: `${k}=`, description: OPTIONS[k] }))
    : (CHOICES[key] ?? []).filter(v => v.startsWith(typed)).map(v => ({ value: `${base}${key}=${v} `, label: v }));
  return items.length ? items : null;
}

// A library for other extensions (see api.ts); Pi loads this for its command.
export default function (pi: ExtensionAPI) {
  const point = usePoint(pi);
  // Pi's working directory, which paths typed are from.
  let cwd = process.cwd();
  pi.on('session_start', (_event, ctx) => { cwd = ctx.cwd; });

  pi.registerCommand('nvim-point', {
    description: 'Show a place in your Neovim window, as other extensions would: <path>:<line>[-<end line>][:<column>] [option=value …]',
    getArgumentCompletions: prefix => completePoint(prefix, cwd),
    handler: async (args, ctx) => {
      let parsed;
      try { parsed = parsePoint(args); } catch (error) { return ctx.ui.notify(errorText(error), 'warning'); }
      const show = point()?.show;
      if (!show) return ctx.ui.notify('Pi is not attached to Neovim', 'warning');
      const { place, options } = parsed;
      const from = place.path === undefined ? undefined : relative(ctx.cwd, resolve(ctx.cwd, place.path));
      const name = from === undefined ? `buffer ${place.buf}` : from.startsWith('..') ? resolve(ctx.cwd, place.path!) : from;
      const lines = place.line === undefined ? '' : `:${place.line}${place.endLine ? `-${place.endLine}` : ''}`;
      const where = `${name}${lines}${place.match === undefined ? '' : ` at ${JSON.stringify(place.match)}`}`;
      try {
        const result = await show(place, options);
        if (!result.shown) {
          return ctx.ui.notify('busy' in result ? `Not now: you are busy in Neovim (mode ${result.busy})` : `Not open in Neovim: ${where}`, 'warning');
        }
        const done = [result.opened && 'opened a window', result.scrolled && 'scrolled'].filter(Boolean);
        ctx.ui.notify(`Showed ${where} in window ${result.win}${done.length ? ` (${done.join(', ')})` : ''}`, 'info');
      } catch (error) { ctx.ui.notify(errorText(error), 'warning'); }
    },
  });
}
