import type { Mark, Style } from './api.ts';

// What /nvim-virtual-text-add takes: `key=value` options, then the text. A value with spaces
// is "quoted", as JSON; `\n` in the text starts another line.
const NUMBERS = ['line', 'endLine', 'col', 'endCol', 'ttl', 'priority'] as const;
const FLAGS = ['fill', 'invalidate', 'columns', 'bold', 'italic', 'underline'] as const;
const FLAGS_OR_NUMBERS = ['indent', 'wrap'] as const;
const STRINGS = ['path', 'match', 'hl', 'highlight', 'sign', 'fg', 'bg'] as const;
const POSITIONS = ['eol', 'right', 'overlay', 'inline', 'after', 'above', 'below'];
const STYLE = ['fg', 'bg', 'bold', 'italic', 'underline'] as const;
const KEYS: readonly string[] = [...NUMBERS, ...FLAGS, ...FLAGS_OR_NUMBERS, ...STRINGS, 'position'];
const OPTION = /\s*(\w+)=("(?:[^"\\]|\\.)*"|\S*)/y;

const DESCRIPTIONS: Record<string, string> = {
  path: 'File, from the working directory (default: your window\'s)', line: 'Line (default: your cursor\'s)',
  endLine: 'Last line marked', col: 'Byte column', endCol: 'Last byte column', match: 'Code to find instead of a line',
  columns: 'Mark just the matched text', position: 'eol, right, overlay, inline, after, above, below or a column', hl: 'Highlight group of the text',
  highlight: 'Highlight group for the lines marked', sign: 'Sign column text', indent: 'true or columns',
  wrap: 'true or columns', fill: 'Background across the window', ttl: 'Milliseconds before it goes',
  invalidate: 'Hide while its lines are deleted', priority: 'Extmark priority', fg: 'Text color, #rrggbb',
  bg: 'Background color, #rrggbb', bold: 'true', italic: 'true', underline: 'true',
};

function value(key: string, raw: string): unknown {
  const text = raw.startsWith('"') ? JSON.parse(raw) as string : raw;
  const number = text !== '' && Number.isFinite(Number(text)) ? Number(text) : undefined;
  const flag = text === 'true' ? true : text === 'false' ? false : undefined;
  const result = (NUMBERS as readonly string[]).includes(key) ? number
    : (FLAGS as readonly string[]).includes(key) ? flag
    : (FLAGS_OR_NUMBERS as readonly string[]).includes(key) ? flag ?? number
    : key === 'position' ? (POSITIONS.includes(text) ? text : number)
    : text;
  if (result === undefined || result === '') throw new Error(`${key}=${raw} is not a value ${key} takes: ${DESCRIPTIONS[key]}`);
  return result;
}

/** The options and text of `args`; options end at the first word that is not a known `key=value`. */
export function parseAdd(args: string): { options: Record<string, unknown>; text: string } {
  const options: Record<string, unknown> = {};
  let end = 0;
  OPTION.lastIndex = 0;
  for (let found; (found = OPTION.exec(args)) && KEYS.includes(found[1]);) {
    options[found[1]] = value(found[1], found[2]);
    end = OPTION.lastIndex;
  }
  return { options, text: args.slice(end).trim().replaceAll('\\n', '\n') };
}

/**
 * A mark from `args`, at `at` (your window's buffer and cursor line) unless it says where.
 * `resolve` makes a path absolute.
 */
export function markOf(args: string, at: { buf: number; line: number } | undefined, resolve: (path: string) => string): Mark {
  const { options, text } = parseAdd(args);
  const { path, ...rest } = options as Mark & Style & { path?: string };
  const style = Object.fromEntries(STYLE.filter(key => key in rest).map(key => [key, rest[key]]));
  for (const key of STYLE) delete (rest as Record<string, unknown>)[key];
  if (Object.keys(style).length && rest.hl !== undefined) throw new Error('Give hl, or fg, bg, bold, italic and underline, not both');
  if (!text && rest.highlight === undefined && rest.sign === undefined) throw new Error('Usage: /nvim-virtual-text-add [option=value …] <text>');
  const where = path !== undefined ? { path: resolve(path), line: rest.line ?? (rest.match ? undefined : 1) }
    : at ? { buf: at.buf, line: rest.line ?? at.line }
    : undefined;
  if (!where) throw new Error('No window of yours to place it in: give path=');
  return { ...rest, ...where, ...(text ? { text } : {}), ...(Object.keys(style).length ? { hl: style } : {}) };
}

/** Completions: the option keys while options are being given, and the values some take. */
export function completeAdd(prefix: string) {
  const last = /\S*$/.exec(prefix)![0], base = prefix.slice(0, prefix.length - last.length);
  try { if (parseAdd(base).text) return null; } catch { return null; } // The text has begun.
  const [key, typed] = last.split('=', 2);
  const values = typed === undefined ? undefined
    : key === 'position' ? POSITIONS
    : [...FLAGS, ...FLAGS_OR_NUMBERS].includes(key as never) ? ['true', 'false']
    : null;
  const items = values === undefined
    ? KEYS.filter(k => k.startsWith(last)).map(k => ({ value: `${base}${k}=`, label: `${k}=`, description: DESCRIPTIONS[k] }))
    : (values ?? []).filter(v => v.startsWith(typed!)).map(v => ({ value: `${base}${key}=${v} `, label: v }));
  return items.length ? items : null;
}
