import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** follow.lua, which `show` sends once to each attachment. */
export const FOLLOW = readFileSync(
  new URL("./follow.lua", import.meta.url),
  "utf8",
);
const SHOW = `local follow = remote.nvim_follow
if not (follow and follow.show) then return 'not installed' end
return follow.show(...)`;

type Lua = {
  lua(
    code: string,
    args: unknown[],
    options?: { timeout?: number },
  ): Promise<unknown>;
};

/**
 * Show a change in the editor (follow.lua's `show`, given `args`), installing follow.lua in
 * this attachment first if it is not yet: afterwards only this one-line call is sent.
 */
export async function show(
  remote: Lua,
  args: unknown[],
  options?: { timeout?: number },
) {
  const shown = await remote.lua(SHOW, args, options);
  if (shown !== "not installed") return shown;
  await remote.lua(FOLLOW, [], options);
  return remote.lua(SHOW, args, options);
}

/** 1-based, inclusive lines of the file after the change. */
export type Range = [first: number, last: number];

const UNICODE_SPACES = /[  -   　]/g;

/**
 * The file a tool's `path` names, resolved as Pi's edit and write tools resolve it (they do
 * not export how): odd spaces made plain, a leading `@` dropped, `~` and file: URLs expanded.
 */
export function pathOf(
  input: Record<string, unknown>,
  cwd: string,
): string | undefined {
  if (typeof input.path !== "string" || !input.path) return undefined;
  let path = input.path.replace(UNICODE_SPACES, " ");
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  else if (path.startsWith("file://")) path = fileURLToPath(path);
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

const newlines = (text: string) => text.split("\n").length - 1;
const linesOf = (text: string) => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/** 1-based line and 0-based byte column, as Neovim's cursor takes them. */
export type Cursor = [line: number, column: number];
/** The lines to mark, and where the cursor goes: the start of the first change. */
export type Deletion = { line: number; lines: string[] };
export type Changes = {
  ranges: Range[];
  cursor?: Cursor;
  deletions?: Deletion[];
};

/** How much `a` and `b` share at the start and at the end, never splitting a surrogate pair. */
function shared(a: string, b: string): [prefix: number, suffix: number] {
  const most = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < most && a[prefix] === b[prefix]) prefix++;
  if (prefix && prefix < most && /[\uD800-\uDBFF]/.test(a[prefix - 1]))
    prefix--;
  let suffix = 0;
  while (
    suffix < most - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  if (
    suffix &&
    suffix < most - prefix &&
    /[\uDC00-\uDFFF]/.test(b[b.length - suffix])
  )
    suffix--;
  return [prefix, suffix];
}

/**
 * How far left to move the window `text[start, end)` that a pure insertion or deletion leaves:
 * "ab" inserted after "ab" could equally be the first or the second. Prefer the nearest place
 * that starts a line, as diff tools do; otherwise leave it.
 */
function slide(text: string, start: number, end: number): number {
  const lineStart = (at: number) => at === 0 || text[at - 1] === "\n";
  if (lineStart(start)) return 0;
  for (let k = 0; start - k > 0 && text[start - k - 1] === text[end - k - 1];) {
    k++;
    if (lineStart(start - k)) return k;
  }
  return 0;
}

/** What changed in `after` given the old and new windows, a pure insertion or deletion slid to a line start. */
function narrow(
  before: string,
  after: string,
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
) {
  const k =
    oldStart === oldEnd
      ? slide(after, newStart, newEnd)
      : newStart === newEnd
        ? slide(before, oldStart, oldEnd)
        : 0;
  return { start: newStart - k, end: newEnd - k };
}

/** The lines `text[start, end)` spans, and the cursor at `start`. Empty marks the line it is on. */
function span(
  text: string,
  start: number,
  end: number,
): { range: Range; cursor: Cursor } {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const first = newlines(text.slice(0, start)) + 1;
  // A change ending in a newline ends on that line, not the next.
  const last = Math.max(
    first,
    newlines(
      text.slice(0, end > start && text[end - 1] === "\n" ? end - 1 : end),
    ) + 1,
  );
  return {
    range: [first, last],
    cursor: [first, Buffer.byteLength(text.slice(lineStart, start))],
  };
}

function changes(
  spans: { start: number; end: number }[],
  after: string,
): Changes {
  const shown = spans
    .sort((a, b) => a.start - b.start)
    .map(({ start, end }) => span(after, start, end));
  return { ranges: shown.map((s) => s.range), cursor: shown[0]?.cursor };
}

/**
 * Where an edit landed, from the unified patch Pi's edit tool returns with it (its details'
 * `patch`): Pi's own diff of the file it wrote, loose matches, line endings and all. Each run
 * of removed and added lines between unchanged ones is one change: lines added, lines removed
 * (shown virtually at their old boundary), or lines changed, the cursor on the first character that differs.
 */
export function patchChanges(patch: string): Changes {
  const ranges: Range[] = [];
  const deletions: Deletion[] = [];
  let cursor: Cursor | undefined;
  let line = 0,
    removed: string[] = [],
    added: string[] = [];
  const close = () => {
    if (!removed.length && !added.length) return;
    const at = line - added.length; // Where this run starts in the file after.
    if (added.length) ranges.push([at, at + added.length - 1]);
    else deletions.push({ line: at, lines: removed });
    cursor ??= [
      at,
      removed.length && added.length
        ? Buffer.byteLength(added[0].slice(0, shared(removed[0], added[0])[0]))
        : 0,
    ];
    removed = [];
    added = [];
  };
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      close();
      // An empty range names the line before it.
      line = Number(hunk[1]) + (hunk[2] === "0" ? 1 : 0);
      continue;
    }
    if (!line) continue; // The file headers, before the first hunk.
    if (text.startsWith("+")) {
      added.push(text.slice(1));
      line++;
    } else if (text.startsWith("-")) removed.push(text.slice(1));
    else if (text.startsWith(" ")) {
      close();
      line++;
    }
    // "\ No newline at end of file" says nothing about where.
  }
  close();
  return { ranges, cursor, ...(deletions.length ? { deletions } : {}) };
}

/**
 * What a write changed: everything between what the file kept at its start and at its end.
 * A new file is all change; a pure deletion shows the removed text virtually. Nothing when
 * the lines are the same, a final newline aside.
 */
export function writeChanges(
  before: string | undefined,
  after: string,
): Changes {
  const old = before ?? "";
  if (linesOf(old).join("\n") === linesOf(after).join("\n"))
    return { ranges: [] };
  const [prefix, suffix] = shared(old, after);
  const window = narrow(
    old,
    after,
    prefix,
    old.length - suffix,
    prefix,
    after.length - suffix,
  );
  if (window.start === window.end) {
    const cursor = span(after, window.start, window.end).cursor;
    const removed = old.slice(
      window.start,
      old.length - suffix - (prefix - window.start),
    );
    return {
      ranges: [],
      cursor,
      deletions: [{ line: cursor[0], lines: linesOf(removed) }],
    };
  }
  return changes([window], after);
}

/**
 * What a read looked at: `offset` is its first line (1-based) and `limit` how many. A read
 * from the top without a limit takes in the whole file, so it marks nothing.
 */
export function readRanges(input: Record<string, unknown>): Range[] {
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : undefined;
  const first = Math.max(1, number(input.offset) ?? 1),
    limit = number(input.limit);
  if (limit !== undefined && limit > 0) return [[first, first + limit - 1]];
  return first > 1 ? [[first, first]] : [];
}
