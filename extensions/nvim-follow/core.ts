import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FOLLOW = readFileSync(new URL('./follow.lua', import.meta.url), 'utf8');

export type Edit = { oldText: string; newText: string };
/** 1-based, inclusive lines of the file after the change. */
export type Range = [first: number, last: number];

const UNICODE_SPACES = /[  -   　]/g;

/**
 * The file a tool's `path` names, resolved as Pi's edit and write tools resolve it (they do
 * not export how): odd spaces made plain, a leading `@` dropped, `~` and file: URLs expanded.
 */
export function pathOf(input: Record<string, unknown>, cwd: string): string | undefined {
  if (typeof input.path !== 'string' || !input.path) return undefined;
  let path = input.path.replace(UNICODE_SPACES, ' ');
  if (path.startsWith('@')) path = path.slice(1);
  if (path === '~') path = homedir();
  else if (path.startsWith('~/')) path = join(homedir(), path.slice(2));
  else if (path.startsWith('file://')) path = fileURLToPath(path);
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/** The edit tool's replacements, in its current form or the legacy single one. */
export function editsOf(input: Record<string, unknown>): Edit[] {
  if (Array.isArray(input.edits)) return input.edits.filter(isEdit);
  return isEdit(input) ? [{ oldText: input.oldText, newText: input.newText }] : [];
}
const isEdit = (value: unknown): value is Edit =>
  typeof (value as Edit)?.oldText === 'string' && typeof (value as Edit)?.newText === 'string';

const newlines = (text: string) => text.split('\n').length - 1;
const linesOf = (text: string) => {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

/** 1-based line and 0-based byte column, as Neovim's cursor takes them. */
export type Cursor = [line: number, column: number];
/** The lines to mark, and where the cursor goes: the start of the first change. */
export type Changes = { ranges: Range[]; cursor?: Cursor };

/** How much `a` and `b` share at the start and at the end, never splitting a surrogate pair. */
function shared(a: string, b: string): [prefix: number, suffix: number] {
  const most = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < most && a[prefix] === b[prefix]) prefix++;
  if (prefix && prefix < most && /[\uD800-\uDBFF]/.test(a[prefix - 1])) prefix--;
  let suffix = 0;
  while (suffix < most - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  if (suffix && suffix < most - prefix && /[\uDC00-\uDFFF]/.test(b[b.length - suffix])) suffix--;
  return [prefix, suffix];
}

/**
 * How far left to move the window `text[start, end)` that a pure insertion or deletion leaves:
 * "ab" inserted after "ab" could equally be the first or the second. Prefer the nearest place
 * that starts a line, as diff tools do; otherwise leave it.
 */
function slide(text: string, start: number, end: number): number {
  const lineStart = (at: number) => at === 0 || text[at - 1] === '\n';
  if (lineStart(start)) return 0;
  for (let k = 0; start - k > 0 && text[start - k - 1] === text[end - k - 1];) {
    k++;
    if (lineStart(start - k)) return k;
  }
  return 0;
}

/** What changed in `after` given the old and new windows, a pure insertion or deletion slid to a line start. */
function narrow(before: string, after: string, oldStart: number, oldEnd: number, newStart: number, newEnd: number) {
  const k = oldStart === oldEnd ? slide(after, newStart, newEnd) : newStart === newEnd ? slide(before, oldStart, oldEnd) : 0;
  return { start: newStart - k, end: newEnd - k };
}

/** The lines `text[start, end)` spans, and the cursor at `start`. Empty marks the line it is on. */
function span(text: string, start: number, end: number): { range: Range; cursor: Cursor } {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const first = newlines(text.slice(0, start)) + 1;
  // A change ending in a newline ends on that line, not the next.
  const last = Math.max(first, newlines(text.slice(0, end > start && text[end - 1] === '\n' ? end - 1 : end)) + 1);
  return { range: [first, last], cursor: [first, Buffer.byteLength(text.slice(lineStart, start))] };
}

function changes(spans: { start: number; end: number }[], after: string): Changes {
  const shown = spans.sort((a, b) => a.start - b.start).map(({ start, end }) => span(after, start, end));
  return { ranges: shown.map(s => s.range), cursor: shown[0]?.cursor };
}

/**
 * Where each edit landed, narrowed to what it changed: the context an old text carries to be
 * unique, which its new text repeats, is left out. An old text is unique in the file before,
 * while a new text may also occur elsewhere, so edits are placed by where their old text was,
 * shifted by the edits above them, and that is checked against the file after. An edit the
 * tool matched loosely (other whitespace or line endings) is placed by its new text instead,
 * if that occurs exactly once after.
 */
export function editChanges(before: string, after: string, edits: Edit[]): Changes {
  const located = edits
    .map(edit => ({ ...edit, at: edit.oldText ? before.indexOf(edit.oldText) : -1 }))
    .sort((a, b) => a.at - b.at);
  const spans: { start: number; end: number }[] = [];
  let shift = 0;
  for (const { oldText, newText, at } of located) {
    const placed = at >= 0 ? at + shift : -1;
    if (at >= 0) shift += newText.length - oldText.length;
    if (placed >= 0 && after.startsWith(newText, placed)) {
      const [prefix, suffix] = shared(oldText, newText);
      spans.push(narrow(before, after, at + prefix, at + oldText.length - suffix, placed + prefix, placed + newText.length - suffix));
      continue;
    }
    const found = newText ? after.indexOf(newText) : -1;
    if (found < 0 || after.indexOf(newText, found + 1) >= 0) continue;
    spans.push({ start: found, end: found + newText.length });
  }
  return changes(spans, after);
}

/**
 * What a write changed: everything between what the file kept at its start and at its end.
 * A new file is all change; a deletion marks where text went. Nothing when the lines are the
 * same, a final newline aside.
 */
export function writeChanges(before: string | undefined, after: string): Changes {
  const old = before ?? '';
  if (!after || linesOf(old).join('\n') === linesOf(after).join('\n')) return { ranges: [] };
  const [prefix, suffix] = shared(old, after);
  return changes([narrow(old, after, prefix, old.length - suffix, prefix, after.length - suffix)], after);
}

/**
 * What a read looked at: `offset` is its first line (1-based) and `limit` how many. A read
 * from the top without a limit takes in the whole file, so it marks nothing.
 */
export function readRanges(input: Record<string, unknown>): Range[] {
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined;
  const first = Math.max(1, number(input.offset) ?? 1), limit = number(input.limit);
  if (limit !== undefined && limit > 0) return [[first, first + limit - 1]];
  return first > 1 ? [[first, first]] : [];
}
