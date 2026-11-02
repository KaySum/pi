import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { useRemote, type CallOptions, type Remote } from '../nvim-remote/api.ts';

/** point.lua, sent once to each attachment, the first time it is needed there. */
const MODULE = readFileSync(new URL('./point.lua', import.meta.url), 'utf8');
const SHOW = `if not remote.nvim_point then return 'not installed' end
return remote.nvim_point.show(...)`;

export type Place = {
  /** The file, absolute. */
  path: string;
  /** 1-based; `endLine` (default `line`) ends the lines to bring on screen together. */
  line: number; endLine?: number;
  /** Where the cursor goes on `line`, in 0-based bytes; else its first non-blank. */
  col?: number;
  /** Lines kept around them when it has to scroll. Default 3. */
  context?: number;
};

/**
 * Shown in `win`: `opened` if a window was opened for it (none showed a file, or the user's
 * has unsaved changes it could not hide), `scrolled` if the window scrolled. Or not shown: the
 * user is `busy` in that mode (`i`, `v`, `c`…), or at a prompt.
 */
export type Pointed = Shown | { busy: string };
export type Shown = { win: number; buf: number; opened: boolean; scrolled: boolean };

export type Point = {
  /**
   * Show the user `place`: in a window of the current tab showing its file, else theirs (never
   * Pi's terminal), opening the file there; its cursor on it, folds over it open, scrolled to it
   * if it is not on screen. Focus stays where it is, and <C-o> there goes back.
   */
  show(place: Place, options?: CallOptions): Promise<Pointed>;
};

type Lua = Pick<Remote, 'lua'>;

function check(place: Place) {
  if (!isAbsolute(place.path)) throw new Error(`The path must be absolute: ${place.path}`);
  const { line, endLine = line, col = 0, context = 0 } = place;
  if (!Number.isInteger(line) || line < 1) throw new Error(`line must be a whole number from 1: ${line}`);
  if (!Number.isInteger(endLine) || endLine < line) throw new Error(`endLine must be a whole number from line: ${endLine}`);
  if (!Number.isInteger(col) || col < 0) throw new Error(`col must be a whole number from 0: ${col}`);
  if (!Number.isInteger(context) || context < 0) throw new Error(`context must be a whole number from 0: ${context}`);
  // Without what is undefined, which would reach Lua as `vim.NIL`.
  return Object.fromEntries(Object.entries(place).filter(([, v]) => v !== undefined));
}

/** Pointing in the editor of `remote`. */
export function point(remote: Lua): Point {
  return {
    async show(place, options) {
      const spec = check(place);
      const result = await remote.lua(SHOW, [spec], options);
      if (result !== 'not installed') return result;
      await remote.lua(MODULE, [], options);
      return remote.lua(SHOW, [spec], options);
    },
  };
}

/**
 * For other extensions: `const point = usePoint(pi)` at load, then `point()` wherever it is
 * needed; undefined while Pi is not attached to Neovim.
 */
export function usePoint(pi: ExtensionAPI) {
  const handles = new WeakMap<Remote, Point>();
  const nvim = useRemote(pi);
  return (): Point | undefined => {
    const remote = nvim();
    if (!remote) return undefined;
    if (!handles.has(remote)) handles.set(remote, point(remote));
    return handles.get(remote);
  };
}
