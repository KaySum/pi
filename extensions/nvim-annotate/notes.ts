import { resolve } from 'node:path';
import type { Remote } from '../nvim-remote/api.ts';
import { point, type Pointed } from '../nvim-point/api.ts';
import { virtualText, type Mark } from '../nvim-virtual-text/api.ts';

export const KINDS = ['info', 'hint', 'warn', 'error'] as const;
export type Kind = typeof KINDS[number];

/**
 * A note as asked for: on code by `match`, or on a line, in a file from Pi's working directory.
 * Always above its code, wrapped to the window and indented to it.
 */
export type NoteSpec = { file: string; match?: string; line?: number; text: string; kind?: Kind };
/** A note as placed, numbered in the order notes were added. */
export type Note = { number: number; path: string; text: string; kind: Kind; mark: Mark };
/** Where a note is now, its code moved by edits; `hidden` while its lines are deleted. */
export type Placed = Note & { line: number; endLine: number; hidden?: true };

const GROUP = 'nvim-annotate';
const HL: Record<Kind, string> = {
  info: 'PiVirtualTextInfo', hint: 'PiVirtualTextHint', warn: 'PiVirtualTextWarn', error: 'PiVirtualTextError',
};

/** Pi's notes in the editor of one attachment: added in order, stepped through, cleared. */
export class Notes {
  private notes: Note[] = [];
  /** The note last shown; 0 before any. */
  private at = 0;
  private remote: Remote;

  constructor(remote: Remote) {
    this.remote = remote;
  }

  private get text() { return virtualText(this.remote, GROUP); }

  /** Add notes after those there: all placed, or none if one cannot be (its file or code missing). */
  async add(specs: NoteSpec[], cwd: string): Promise<Note[]> {
    const added = specs.map((spec, i): Note => {
      const number = this.notes.length + i + 1, kind = spec.kind ?? 'info';
      const mark: Mark = {
        key: `note-${number}`, path: resolve(cwd, spec.file), text: `${number}. ${spec.text}`, position: 'above', hl: HL[kind],
        indent: true, wrap: true, invalidate: true,
        ...(spec.match === undefined ? { line: spec.line } : { match: spec.match, line: spec.line }),
      };
      return { number, path: mark.path!, text: spec.text, kind, mark };
    });
    // All of them, those there as they were: the call is checked whole before anything changes.
    await this.text.set([...this.notes, ...added].map(note => note.mark));
    this.notes.push(...added);
    return added;
  }

  /** The notes, where their code is now. */
  async list(): Promise<Placed[]> {
    const placed = new Map((await this.text.list()).map(mark => [mark.key, mark]));
    return this.notes.flatMap(note => {
      const mark = placed.get(note.mark.key);
      return mark ? [{ ...note, line: mark.line, endLine: mark.endLine ?? mark.line, ...(mark.invalid ? { hidden: true as const } : {}) }] : [];
    });
  }

  /**
   * Show the user note `which` (a number, or the next or previous of the one last shown, passing
   * over hidden ones): its code on screen, the cursor on it. Undefined if there is no such note.
   */
  async show(which: number | 'next' | 'prev', cwd: string, options: { focus?: boolean } = {}): Promise<{ note: Placed; total: number; pointed: Pointed } | undefined> {
    const notes = (await this.list()).filter(note => !note.hidden);
    const note = typeof which === 'number' ? notes.find(note => note.number === which)
      : which === 'next' ? notes.find(note => note.number > this.at)
      : notes.findLast(note => note.number < this.at);
    if (!note) return undefined;
    const pointed = await point(this.remote, cwd).show({ path: note.path, line: note.line, endLine: note.endLine }, options);
    if (pointed.shown) this.at = note.number;
    return { note, total: notes.length, pointed };
  }

  /** Remove every note. Resolves to how many there were. */
  async clear(): Promise<number> {
    const count = this.notes.length;
    await this.text.clear();
    this.notes = [];
    this.at = 0;
    return count;
  }
}
