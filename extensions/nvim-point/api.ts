import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { useRemote, type CallOptions, type Remote } from '../nvim-remote/api.ts';
import { blocked, install, perAttachment, useCwd } from '../nvim-remote-kit/api.ts';

/** point.lua, sent once to each attachment (the kit with it), the first time it is needed there. */
const MODULE = readFileSync(new URL('./point.lua', import.meta.url), 'utf8');
const SHOW = `if not remote.nvim_point then return 'not installed' end
return remote.nvim_point.show(...)`;

type Where = ({
  /** The file: absolute, or from Pi's working directory, as Pi's tools give them. */
  path: string; buf?: never;
} | {
  /** Or a buffer, by number: one without a file too, any but a terminal. */
  buf: number; path?: never;
}) & {
  /** Lines kept around them when it has to scroll. Default 3. */
  context?: number;
};
/** A place by its lines. */
type At = Where & {
  /** 1-based; `endLine` (default `line`) ends the lines to bring on screen together. */
  line: number; endLine?: number;
  /** Where the cursor goes on `line`, in 0-based bytes, within the line, on a character's first byte; else its first non-blank. */
  col?: number;
  match?: never;
};
/** A place by its code, which moves as the file changes, where line numbers do not. */
type Of = Where & {
  /**
   * The code: each of its lines within one of the file's, in order, the space around them
   * aside. Its lines are brought on screen, the cursor where it starts.
   */
  match: string;
  /** The occurrence nearest this line wins, the earlier on a tie; else the first. */
  line?: number;
  endLine?: never; col?: never;
};
export type Place = At | Of;

/**
 * `shown` in `win`: `opened` if a window was opened for it (none showed a file, or the user's
 * has unsaved changes it could not hide), `scrolled` if the window scrolled, sideways too. Or
 * not shown: the user is `busy` in that mode (`i`, `v`, `c`…, `r` at a prompt), or `cmdwin` in
 * the command-line window; or, with `open: false`, the file is `closed`: no window of the tab
 * shows it.
 */
export type Pointed = Shown | { shown: false; busy: string; superseded?: true } | { shown: false; closed: true };
export type Shown = { shown: true; win: number; buf: number; opened: boolean; scrolled: boolean };

export type ShowOptions = CallOptions & {
  /**
   * While the user is busy, try again until they are not, for up to this many milliseconds
   * (`Infinity`: as long as it takes); a later `show` of the same pointer ends the wait, which
   * resolves `superseded`. Default 0: at once, busy or not.
   */
  wait?: number;
  /**
   * `false`: leave the window's jumplist and alternate file (`<C-^>`) as they were, as one
   * following Pi around should, not filling them with Pi's places: nothing is added. (Entering a
   * buffer it reloads, Neovim may drop a stale jump to it, as its own `keepjumps` does.)
   * Default true: <C-o> goes back.
   */
  jump?: boolean;
  /**
   * When the lines are not on screen, where to bring them: `center` (the default), at the `top`,
   * or `minimal`ly, just past the edge they were off, moving the screen least. Too tall for the
   * window, from their start whatever this is.
   */
  scroll?: 'center' | 'top' | 'minimal';
  /**
   * `false`: only where a window of the tab shows the file already, as one following Pi only
   * through files the user has open should; else nothing is loaded or changed, and it is
   * `closed`. Default true: the file is opened in the user's window.
   */
  open?: boolean;
  /**
   * `true`: focus the window once the place is shown, as when the user asked to go there.
   * Default false: focus stays where it is, in Pi's terminal as a rule.
   */
  focus?: boolean;
};

export type Point = {
  /**
   * Show the user `place`: in a window of the current tab showing its file, else theirs (never
   * Pi's terminal), opening the file there; its cursor on it, folds over it open, scrolled to it
   * if it is not on screen. Focus stays where it is (unless `focus`), and <C-o> there goes back.
   */
  show(place: Place, options?: ShowOptions): Promise<Pointed>;
};

/** How often a waiting `show` tries again: unnoticed by the user, a few calls a second. */
const RETRY_MS = 100;

type Lua = Pick<Remote, 'lua'>;

function check(place: Place, cwd: string): Record<string, unknown> {
  const { match, line = 1, endLine = line, col = 0, context = 0 } = place;
  if (place.path === undefined && place.buf === undefined) throw new Error('A place needs a path or a buf');
  if (place.path !== undefined && place.buf !== undefined) throw new Error('A place needs a path or a buf, not both');
  if (place.buf !== undefined && (!Number.isInteger(place.buf) || place.buf < 1)) throw new Error(`buf must be a buffer number: ${place.buf}`);
  if (match !== undefined) {
    if (typeof match !== 'string' || !match.trim()) throw new Error('match must be some code to find');
    if (place.endLine !== undefined || place.col !== undefined) throw new Error('With match, its lines and column are where it is: no endLine or col');
  } else if (place.line === undefined) throw new Error('A place needs a line or a match');
  if (!Number.isInteger(line) || line < 1) throw new Error(`line must be a whole number from 1: ${line}`);
  if (!Number.isInteger(endLine) || endLine < line) throw new Error(`endLine must be a whole number from line: ${endLine}`);
  if (!Number.isInteger(col) || col < 0) throw new Error(`col must be a whole number from 0: ${col}`);
  if (!Number.isInteger(context) || context < 0) throw new Error(`context must be a whole number from 0: ${context}`);
  // Without what is undefined, which would reach Lua as `vim.NIL`.
  const path = place.path === undefined ? undefined : resolve(cwd, place.path);
  return Object.fromEntries(Object.entries({ ...place, path }).filter(([, v]) => v !== undefined));
}

/** Pointing in the editor of `remote`, relative paths from `cwd`. */
export function point(remote: Lua, cwd = process.cwd()): Point {
  async function once(spec: Record<string, unknown>, options?: CallOptions): Promise<Pointed> {
    try {
      const result = await remote.lua(SHOW, [spec], options);
      if (result !== 'not installed') return result;
      await install(remote, MODULE, options);
      return await remote.lua(SHOW, [spec], options);
    } catch (error) {
      // At a prompt, nvim-remote fails every call at once: the user is busy.
      const busy = blocked(error);
      if (busy !== undefined) return { shown: false, busy };
      throw error;
    }
  }
  let latest = 0;
  return {
    async show(place, { wait = 0, jump, scroll, open, focus, ...options } = {}) {
      const spec = check(place, cwd);
      if (focus === true) spec.focus = true;
      if (jump === false) spec.jump = false;
      if (open === false) spec.open = false;
      if (scroll !== undefined) {
        if (!['center', 'top', 'minimal'].includes(scroll)) throw new Error(`scroll is center, top or minimal: ${scroll}`);
        spec.scroll = scroll;
      }
      if (!(wait >= 0)) throw new Error(`wait must be milliseconds from 0: ${wait}`);
      const ticket = ++latest, until = Date.now() + wait;
      for (;;) {
        const result = await once(spec, options);
        // Only being busy passes: a file not open stays so, whatever the wait.
        if (result.shown || !('busy' in result) || Date.now() >= until) return result;
        // No longer than the wait has left: nothing is shown once it is over.
        await delay(Math.min(RETRY_MS, until - Date.now()), undefined, { signal: options.signal });
        if (ticket !== latest) return { ...result, superseded: true };
        if (Date.now() >= until) return result;
      }
    },
  };
}

/**
 * For other extensions: `const point = usePoint(pi)` at load, then `point()` wherever it is
 * needed; undefined while Pi is not attached to Neovim.
 */
export function usePoint(pi: ExtensionAPI) {
  const nvim = useRemote(pi), cwd = useCwd(pi);
  const of = perAttachment(remote => point(remote, cwd()));
  return (): Point | undefined => {
    const remote = nvim();
    return remote && of(remote);
  };
}
