import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Tab ids, window ids and buffer ids are Neovim's handles. Lines are 1-based. */
export type Layout = { win: number } | { split: 'row' | 'col'; children: Layout[] };

export type Tab = {
  id: number;
  /** As `:tabnext` counts them, from 1. */
  number: number;
  focused?: true;
  windows: number[];
  /** Its splits: a `row` side by side, a `col` stacked. */
  layout: Layout;
};

export type Window = {
  id: number;
  /** As `<C-w>` counts them in its tab, from 1. */
  number: number;
  tab: number;
  buf: number;
  /** `normal` shows a file; else `float`, `terminal`, `help`, `quickfix`, `loclist`, `nofile`, `prompt`… */
  kind: string;
  focused?: true;
  /** The window the user came from to the focused one (`#`). */
  previous?: true;
  /** Shows Pi's own terminal. */
  pi?: true;
  /** Where its top left is on the screen, 1-based; and its size in cells. */
  row: number; col: number; width: number; height: number;
  /** The width left for text, and what the number, sign and fold columns take before it. */
  textWidth: number; textOff: number;
  /** The first and last buffer lines it shows, and how far it is scrolled sideways. */
  topline: number; botline: number; leftcol: number; skipcol: number;
  /** 1-based line, 0-based byte column. */
  cursor: [line: number, col: number];
  cwd: string;
  float?: { relative: string; zindex?: number; focusable?: boolean; border?: unknown };
  options: {
    wrap: boolean; number: boolean; relativenumber: boolean; signcolumn: string; foldcolumn: string;
    cursorline: boolean; scrolloff: number; sidescrolloff: number; list: boolean; diff: boolean;
    spell: boolean; conceallevel: number; colorcolumn: string;
  };
};

export type Buffer = {
  id: number;
  /** Its file, for one that has one: an absolute path. */
  name: string;
  filetype: string;
  /** Empty for a file; else `terminal`, `help`, `nofile`, `quickfix`… */
  buftype: string;
  listed: boolean; loaded: boolean; modified: boolean; readonly: boolean; modifiable: boolean;
  /** How many lines and bytes it holds; only for a loaded buffer. */
  lines?: number; bytes?: number;
  /** Goes up with every change to its text. */
  changedtick: number;
  /** The windows showing it, in any tab. */
  windows: number[];
  /** Names of the language servers attached. */
  lsp: string[];
  pi?: true;
};

export type View = {
  editor: {
    /** Its size in cells. */
    columns: number; lines: number; cmdheight: number;
    /** As `mode()` gives it (`n`, `i`, `v`, `t`…); `blocking` while it waits at a prompt. */
    mode: string; blocking: boolean;
    cwd: string;
    /** Whether the terminal it runs in has focus, once it has said (terminals that report it). */
    focused?: boolean;
  };
  focus: { tab: number; win: number; buf: number; previous?: number };
  /**
   * The user's window: the focused one unless it is Pi's terminal or another like it, else
   * the one they came from, else any showing a file.
   */
  you?: number;
  /** Pi's terminal buffer, and the windows showing it, if Pi runs in one of the editor's. */
  pi?: { buf: number; windows: number[] };
  tabs: Tab[];
  windows: Window[];
  /** Listed ones, ones shown, and Pi's terminal. */
  buffers: Buffer[];
  /** How many buffers that are none of those (plugins' scratch buffers, say) were left out. */
  omitted: number;
};

// Lookups in a view, or in none: `windowOf(view(), id)` while not attached is undefined.
export const windowOf = (view: View | undefined, id: number | undefined) => view?.windows.find(win => win.id === id);
export const bufferOf = (view: View | undefined, id: number | undefined) => view?.buffers.find(buf => buf.id === id);
/** The buffer of a file, by its absolute path. */
export const bufferFor = (view: View | undefined, path: string) => view?.buffers.find(buf => buf.name === path);

export type ViewHandle = {
  /** The latest view, at once; undefined while Pi is not attached to Neovim. */
  (): View | undefined;
  /** A view made now, rather than the latest sent: the latest from then, for every extension. */
  refresh(): Promise<View | undefined>;
};

/**
 * For other extensions: `const view = useView(pi, onChange?)` at load, then `view()` wherever
 * the editor's state is needed. `onChange` hears every new view: a burst of changes makes one,
 * and one the same as the last is not sent.
 */
export function useView(pi: ExtensionAPI, onChange?: (view: View) => void): ViewHandle {
  let latest: View | undefined;
  // How many times the editor has gone: a refresh answered across a stop is no view.
  let stops = 0;
  pi.events.on('nvim-view:changed', view => {
    latest = view as View;
    onChange?.(latest);
  });
  pi.events.on('nvim-view:stopped', () => {
    latest = undefined;
    stops++;
  });
  const ask = () => pi.events.emit('nvim-view:get', { reply: (view?: View) => { latest = view; } });
  pi.on('session_start', ask);
  return Object.assign(() => {
    if (!latest) ask();
    return latest;
  }, {
    refresh: () => new Promise<View | undefined>(resolve => {
      let answered = false;
      const asked = stops;
      // A view that is new reaches every extension's `latest` and `onChange`, as
      // `nvim-view:changed`; this one's `latest` is the view in any case.
      pi.events.emit('nvim-view:refresh', {
        reply: (view: Promise<View | undefined>) => {
          answered = true;
          resolve(view.then(fresh => {
            if (stops !== asked) return undefined;
            if (fresh) latest = fresh;
            return fresh;
          }));
        },
      });
      if (!answered) resolve(undefined); // nvim-view is not loaded.
    }),
  });
}
