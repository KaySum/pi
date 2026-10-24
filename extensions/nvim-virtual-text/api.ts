import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { useRemote, type CallOptions, type Remote } from '../nvim-remote/api.ts';

/** virtual-text.lua, sent once to each attachment, the first time it is needed there. */
const MODULE = readFileSync(new URL('./virtual-text.lua', import.meta.url), 'utf8');
const CALL = `local vt = remote.nvim_virtual_text
if not vt then return 'not installed' end
local fn = ...
return vt[fn](select(2, ...))`;

/** What nvim_set_hl takes; colors as `#rrggbb` or names. */
export type Style = {
  fg?: string; bg?: string; sp?: string;
  bold?: boolean; italic?: boolean; underline?: boolean; undercurl?: boolean; strikethrough?: boolean; reverse?: boolean;
};
/** A highlight group's name (`PiVirtualTextInfo`, `DiffAdd`, `@comment`…), or a style of its own. */
export type Highlight = string | Style;
export type Chunk = [text: string, hl?: Highlight];
/**
 * `eol` after the line's text, `right` at the window's right edge, `overlay` over the text at
 * `col`, `inline` between characters at `col`, `after` between characters at `endCol` (else the
 * end of the last line), a number at that screen column; `above` and `below` as lines of
 * their own.
 */
export type Position = 'eol' | 'right' | 'overlay' | 'inline' | 'after' | 'above' | 'below' | number;

export type Mark = {
  /** The file, absolute: loaded in the editor (not listed) if the user has not opened it. */
  path?: string;
  /** Or a buffer, by number. */
  buf?: number;
  /** 1-based lines; `endLine` (default `line`) ends what `highlight` covers, and is where `below` goes. */
  line?: number; endLine?: number;
  /**
   * Code to find instead, and mark the lines it is on: each of its lines within one of the
   * buffer's, in order, the space around them aside. The occurrence nearest `line` wins.
   */
  match?: string;
  /**
   * With `match`: mark just the text it finds, not its lines, its columns where it is in them;
   * `inline` goes before it, `after` after it, and `highlight` covers it alone.
   */
  columns?: boolean;
  /** 0-based byte columns. Without them `highlight` covers whole lines, to the window's edge. */
  col?: number; endCol?: number;
  /** A string, or chunks in different highlights; a newline starts another line for `above` and `below`, and is a space elsewhere. */
  text?: string | Chunk[];
  /** Default `eol`. */
  position?: Position;
  /** For text (and the sign) not given its own. Default `PiVirtualText`. */
  hl?: Highlight;
  /** Highlight the lines (or columns) marked. */
  highlight?: Highlight;
  /** Up to two cells in the sign column at `line`, in `hl` unless given its own. */
  sign?: string | Chunk;
  /** `above` and `below`: start at the indentation of the line they go by (`true`) or this many columns. */
  indent?: boolean | number;
  /** `above` and `below`: break lines at spaces to fit the window showing the buffer (`true`) or this many columns. */
  wrap?: boolean | number;
  /** `above` and `below`: give each line's background the whole window's width. */
  fill?: boolean;
  /**
   * Hide it while all its lines are deleted, back on undo; and remove it if a reload from
   * disk leaves its text nowhere.
   */
  invalidate?: boolean;
  /** Remove it after this many milliseconds. */
  ttl?: number;
  priority?: number;
};

/**
 * A mark as `list` gives it: as placed and updated, where edits have moved it, its file found;
 * `invalid` while `invalidate` hides it.
 */
export type Placed = Mark & { id: number; group: string; buf: number; path: string; line: number; invalid?: true };
/** What `update` changes: `null` takes an option away. */
export type Patch = { [K in keyof Mark]?: Mark[K] | null };
type Where = { path?: string; buf?: number };

export type VirtualText = {
  /** Resolves to an id for each mark, in order. */
  place(marks: Mark | Mark[], options?: CallOptions): Promise<number[]>;
  /**
   * Change a mark, keeping its id: lines and columns not given stay where edits have moved
   * them, and a `ttl` starts again. Resolves to whether there was such a mark.
   */
  update(id: number, patch: Patch, options?: CallOptions): Promise<boolean>;
  remove(ids: number | number[], options?: CallOptions): Promise<void>;
  /** This group's marks, only in one file or buffer if given, in the order placed. */
  list(where?: Where, options?: CallOptions): Promise<Placed[]>;
  /** Remove this group's marks, only in one file or buffer if given. Resolves to how many went. */
  clear(where?: Where, options?: CallOptions): Promise<number>;
};

type Lua = Pick<Remote, 'lua'>;

/** Call `fn` of virtual-text.lua, installing it in this attachment first if it is not yet. */
export async function call(remote: Lua, fn: string, args: unknown[], options?: CallOptions): Promise<any> {
  const result = await remote.lua(CALL, [fn, ...args], options);
  if (result !== 'not installed') return result;
  await remote.lua(MODULE, [], options);
  return remote.lua(CALL, [fn, ...args], options);
}

/** Without what is undefined, which would reach Lua as `vim.NIL`. */
const defined = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
const list = <T>(value: unknown): T[] => Array.isArray(value) ? value : [];

function check(mark: Patch) {
  if (mark.path != null && !isAbsolute(mark.path)) throw new Error(`A mark's path must be absolute: ${mark.path}`);
  for (const key of ['line', 'endLine'] as const) {
    const line = mark[key];
    if (line != null && (!Number.isInteger(line) || line < 1)) throw new Error(`A mark's ${key} must be a whole number from 1: ${line}`);
  }
  return defined(mark);
}

function checkMark(mark: Mark) {
  if ((mark.path === undefined) === (mark.buf === undefined)) throw new Error('A mark needs a path or a buf, not both');
  if (mark.line === undefined && !mark.match) throw new Error('A mark needs a line or a match');
  if (mark.columns && !mark.match) throw new Error('columns needs a match: the text whose columns to mark');
  return check(mark);
}

/** Virtual text in the editor of `remote`, kept apart from other groups'. */
export function virtualText(remote: Lua, group: string): VirtualText {
  if (!/^[\w.-]+$/.test(group)) throw new Error(`A group name is letters, digits, "_", "." and "-": ${group}`);
  return {
    place: async (marks, options) => list(await call(remote, 'place', [group, [marks].flat().map(checkMark)], options)),
    update: (id, patch, options) => call(remote, 'update', [group, id, check(patch)], options),
    async remove(ids, options) {
      await call(remote, 'remove', [group, [ids].flat()], options);
    },
    list: async (where = {}, options) => list(await call(remote, 'list', [group, defined(where)], options)),
    clear: (where = {}, options) => call(remote, 'clear', [group, defined(where)], options),
  };
}

/**
 * For other extensions: `const text = useVirtualText(pi, 'my-extension')` at load, then
 * `text()` wherever it is needed; undefined while Pi is not attached to Neovim.
 */
export function useVirtualText(pi: ExtensionAPI, group: string, onAttach?: (text: VirtualText, nvim: Remote) => void) {
  const handles = new WeakMap<Remote, VirtualText>();
  const of = (nvim: Remote) => {
    if (!handles.has(nvim)) handles.set(nvim, virtualText(nvim, group));
    return handles.get(nvim)!;
  };
  const nvim = useRemote(pi, onAttach && (remote => onAttach(of(remote), remote)));
  return (): VirtualText | undefined => {
    const remote = nvim();
    return remote && of(remote);
  };
}
