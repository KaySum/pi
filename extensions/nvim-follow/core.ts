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

/**
 * Where each edit landed. An old text is unique in the file before, while a new text may
 * also occur elsewhere, so edits are placed by where their old text was, shifted by the
 * edits above them. An edit the tool matched loosely (other whitespace or line endings) is
 * placed by its new text instead, if that occurs exactly once after.
 */
export function editRanges(before: string, after: string, edits: Edit[]): Range[] {
  const located = edits
    .map(edit => ({ ...edit, at: edit.oldText ? before.indexOf(edit.oldText) : -1 }))
    .sort((a, b) => a.at - b.at);
  const ranges: Range[] = [];
  let shift = 0;
  for (const { oldText, newText, at } of located) {
    if (at >= 0) {
      const first = newlines(before.slice(0, at)) + 1 + shift;
      shift += newlines(newText) - newlines(oldText);
      ranges.push([first, first + newlines(newText.replace(/\n$/, ''))]);
      continue;
    }
    const found = newText ? after.indexOf(newText) : -1;
    if (found < 0 || after.indexOf(newText, found + 1) >= 0) continue;
    const first = newlines(after.slice(0, found)) + 1;
    ranges.push([first, first + newlines(newText.replace(/\n$/, ''))]);
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/**
 * What a write changed: the lines between those it kept at the start and at the end. A new
 * file is all change; a deletion marks the line where text went. Nothing for no change.
 */
export function writeRanges(before: string | undefined, after: string): Range[] {
  const old = linesOf(before ?? ''), next = linesOf(after);
  if (before === after || !next.length) return [];
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  if (start === old.length && start === next.length) return []; // Only the final newline changed.
  let end = 0;
  while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end++;
  const first = Math.min(start + 1, next.length);
  return [[first, Math.max(first, next.length - end)]];
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
