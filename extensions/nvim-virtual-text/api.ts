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
 * `col`, `inline` between characters at `col`; `above` and `below` as lines of their own.
 */
export type Position = 'eol' | 'right' | 'overlay' | 'inline' | 'above' | 'below';

export type Mark = {
  /** The file, absolute: loaded in the editor (not listed) if the user has not opened it. */
  path?: string;
  /** Or a buffer, by number. */
  buf?: number;
  /** 1-based lines; `endLine` (default `line`) ends what `highlight` covers, and is where `below` goes. */
  line: number; endLine?: number;
  /** 0-based byte columns. Without them `highlight` covers whole lines, to the window's edge. */
  col?: number; endCol?: number;
  /** A string, or chunks in different highlights; a newline starts another line for `above` and `below`, and is a space elsewhere. */
  text?: string | Chunk[];
  /** Default `eol`. */
  position?: Position;
  /** For text not given its own. Default `PiVirtualText`. */
  hl?: Highlight;
  /** Highlight the lines (or columns) marked. */
  highlight?: Highlight;
  /** `above` and `below`: pad each line to the widest window showing the buffer, so its background fills it. */
  fill?: boolean;
  /** Remove it after this many milliseconds. */
  ttl?: number;
  priority?: number;
};

export type VirtualText = {
  /** Resolves to an id for each mark, in order. */
  place(marks: Mark | Mark[], options?: CallOptions): Promise<number[]>;
  remove(ids: number | number[], options?: CallOptions): Promise<void>;
  /** Remove this group's marks, only in one file or buffer if given. Resolves to how many went. */
  clear(where?: { path?: string; buf?: number }, options?: CallOptions): Promise<number>;
};

type Lua = Pick<Remote, 'lua'>;

/** Call `fn` of virtual-text.lua, installing it in this attachment first if it is not yet. */
export async function call(remote: Lua, fn: string, args: unknown[], options?: CallOptions): Promise<any> {
  const result = await remote.lua(CALL, [fn, ...args], options);
  if (result !== 'not installed') return result;
  await remote.lua(MODULE, [], options);
  return remote.lua(CALL, [fn, ...args], options);
}

const defined = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

const chunk = (text: string, hl?: Highlight): Chunk => hl === undefined ? [text] : [text, hl];

/** Text as lines of chunks: one line except above and below. */
function linesOf(text: string | Chunk[], block: boolean): Chunk[][] {
  const lines: Chunk[][] = [[]];
  for (const [part, hl] of typeof text === 'string' ? [[text] as Chunk] : text) {
    part.split('\n').forEach((piece, i) => {
      if (i) block ? lines.push([]) : lines.at(-1)!.push(chunk(' ', hl));
      if (piece) lines.at(-1)!.push(chunk(piece, hl));
    });
  }
  return lines;
}

function normalize(mark: Mark) {
  if ((mark.path === undefined) === (mark.buf === undefined)) throw new Error('A mark needs a path or a buf, not both');
  if (mark.path !== undefined && !isAbsolute(mark.path)) throw new Error(`A mark's path must be absolute: ${mark.path}`);
  if (!Number.isInteger(mark.line) || mark.line < 1) throw new Error(`A mark's line must be a whole number from 1: ${mark.line}`);
  const { text, ...rest } = mark;
  const block = mark.position === 'above' || mark.position === 'below';
  return defined({ ...rest, lines: text === undefined ? undefined : linesOf(text, block) });
}

/** Virtual text in the editor of `remote`, kept apart from other groups'. */
export function virtualText(remote: Lua, group: string): VirtualText {
  if (!/^[\w.-]+$/.test(group)) throw new Error(`A group name is letters, digits, "_", "." and "-": ${group}`);
  return {
    async place(marks, options) {
      const ids = await call(remote, 'place', [group, [marks].flat().map(normalize)], options);
      return Array.isArray(ids) ? ids : [];
    },
    async remove(ids, options) {
      await call(remote, 'remove', [[ids].flat()], options);
    },
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
