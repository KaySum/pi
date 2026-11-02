import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { useRemote, type CallOptions, type Remote } from '../nvim-remote/api.ts';

/** point.lua, sent once to each attachment, the first time it is needed there. */
const MODULE = readFileSync(new URL('./point.lua', import.meta.url), 'utf8');
const SHOW = `if not remote.nvim_point then return 'not installed' end
return remote.nvim_point.show(...)`;

export type Place = {
  /** The file: absolute, or from Pi's working directory, as Pi's tools give them. */
  path: string;
  /** 1-based; `endLine` (default `line`) ends the lines to bring on screen together. */
  line: number; endLine?: number;
  /** Where the cursor goes on `line`, in 0-based bytes, within the line, on a character's first byte; else its first non-blank. */
  col?: number;
  /** Lines kept around them when it has to scroll. Default 3. */
  context?: number;
};

/**
 * `shown` in `win`: `opened` if a window was opened for it (none showed a file, or the user's
 * has unsaved changes it could not hide), `scrolled` if the window scrolled. Or not shown: the
 * user is `busy` in that mode (`i`, `v`, `c`…, `r` at a prompt), or `cmdwin` in the command-line
 * window.
 */
export type Pointed = Shown | { shown: false; busy: string };
export type Shown = { shown: true; win: number; buf: number; opened: boolean; scrolled: boolean };

export type Point = {
  /**
   * Show the user `place`: in a window of the current tab showing its file, else theirs (never
   * Pi's terminal), opening the file there; its cursor on it, folds over it open, scrolled to it
   * if it is not on screen. Focus stays where it is, and <C-o> there goes back.
   */
  show(place: Place, options?: CallOptions): Promise<Pointed>;
};

type Lua = Pick<Remote, 'lua'>;

function check(place: Place, cwd: string) {
  const { line, endLine = line, col = 0, context = 0 } = place;
  if (!Number.isInteger(line) || line < 1) throw new Error(`line must be a whole number from 1: ${line}`);
  if (!Number.isInteger(endLine) || endLine < line) throw new Error(`endLine must be a whole number from line: ${endLine}`);
  if (!Number.isInteger(col) || col < 0) throw new Error(`col must be a whole number from 0: ${col}`);
  if (!Number.isInteger(context) || context < 0) throw new Error(`context must be a whole number from 0: ${context}`);
  // Without what is undefined, which would reach Lua as `vim.NIL`.
  return Object.fromEntries(Object.entries({ ...place, path: resolve(cwd, place.path) }).filter(([, v]) => v !== undefined));
}

/** Pointing in the editor of `remote`, relative paths from `cwd`. */
export function point(remote: Lua, cwd = process.cwd()): Point {
  return {
    async show(place, options) {
      const spec = check(place, cwd);
      try {
        const result = await remote.lua(SHOW, [spec], options);
        if (result !== 'not installed') return result;
        await remote.lua(MODULE, [], options);
        return await remote.lua(SHOW, [spec], options);
      } catch (error) {
        // At a prompt, nvim-remote fails every call at once: the user is busy.
        if ((error as { blocking?: boolean }).blocking) return { shown: false, busy: (error as { mode: string }).mode };
        throw error;
      }
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
  // Pi's working directory, which its tools' paths are relative to.
  let cwd = process.cwd();
  pi.on('session_start', (_event, ctx) => { cwd = ctx.cwd; });
  return (): Point | undefined => {
    const remote = nvim();
    if (!remote) return undefined;
    if (!handles.has(remote)) handles.set(remote, point(remote, cwd));
    return handles.get(remote);
  };
}
