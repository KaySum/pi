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
/** Where a note is now, its code moved by edits, and the first line of that code; `hidden` while it is deleted. */
export type Placed = Note & { line: number; endLine: number; code: string; hidden?: true };

const GROUP = 'nvim-annotate';
// The line of each [buffer, line], '' where there is none.
const LINES = `return vim.tbl_map(function(at)
  local ok, lines = pcall(vim.api.nvim_buf_get_lines, at[1], at[2] - 1, at[2], false)
  return ok and lines[1] or ''
end, ...)`;
// Each mark tried alone, in a group of its own, all in one call so none is ever drawn: why it
// cannot be placed, '' if it can.
const CHECK = `local vt, group, marks = remote.nvim_virtual_text, ...
if not vt then return nil end
local why = {}
for i, mark in ipairs(marks) do
  local ok, err = pcall(vt.set, group, { mark })
  why[i] = ok and '' or tostring(err)
end
vt.set(group, {})
return why`;
const HL: Record<Kind, string> = {
  info: 'PiVirtualTextInfo', hint: 'PiVirtualTextHint', warn: 'PiVirtualTextWarn', error: 'PiVirtualTextError',
};

/** Pi's notes in the editor of one attachment: added in order, stepped through, cleared. */
export class Notes {
  private notes: Note[] = [];
  /** The note last shown; 0 before any. */
  private at = 0;
  /** The last number given: one removed is not given again, until all are cleared or replaced. */
  private last = 0;
  /** What the notes are doing, each after the one before: see `queued`. */
  private queue: Promise<unknown> = Promise.resolve();
  private remote: Remote;

  constructor(remote: Remote) {
    this.remote = remote;
  }

  private get text() { return virtualText(this.remote, GROUP); }

  get size() { return this.notes.length; }

  /**
   * Run `fn` once all before it are done. A step from :PiNotes comes from Neovim, not as a tool
   * call, so it would otherwise run alongside one: reading the notes as they were, or undoing
   * where a replace or clear left the walkthrough.
   */
  private queued<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * The marks of the notes, by key. A note whose mark is gone, its code gone when its file was
   * read again, is forgotten: it would otherwise be given again, and fail, with every add.
   */
  private async marks() {
    const marks = new Map((await this.text.list()).map(mark => [mark.key, mark]));
    this.notes = this.notes.filter(note => marks.has(note.mark.key));
    return marks;
  }

  /**
   * Add notes after those there, or with `replace` instead of them, numbered from 1 again: all
   * placed, or none if one cannot be (its file or code missing), those there left as they were.
   */
  add(specs: NoteSpec[], cwd: string, { replace = false } = {}): Promise<Note[]> {
    return this.queued(() => this.adding(specs, cwd, replace));
  }

  private async adding(specs: NoteSpec[], cwd: string, replace: boolean) {
    if (!replace) await this.marks();
    const kept = replace ? [] : this.notes;
    const after = replace ? 0 : this.last;
    const added = specs.map((spec, i): Note => {
      const number = after + i + 1, kind = spec.kind ?? 'info';
      const mark: Mark = {
        key: `note-${number}`, path: resolve(cwd, spec.file), text: `${number}. ${spec.text}`, position: 'above', hl: HL[kind],
        indent: true, wrap: true, invalidate: true,
        ...(spec.match === undefined ? { line: spec.line } : { match: spec.match, line: spec.line }),
      };
      return { number, path: mark.path!, text: spec.text, kind, mark };
    });
    // All of them, those kept as they were: the call is checked whole before anything changes.
    try {
      await this.text.set([...kept, ...added].map(note => note.mark));
    } catch (error) {
      throw await this.why(added.map(note => note.mark)) ?? error;
    }
    this.notes = [...kept, ...added];
    this.last = after + added.length;
    if (replace) this.at = 0;
    return added;
  }

  /** The id nvim-virtual-text gave note `number`, and the note; undefined if there is none. */
  private async find(number: number) {
    const marks = await this.marks();
    const note = this.notes.find(note => note.number === number);
    return note && { note, id: marks.get(note.mark.key)!.id };
  }

  /** Change note `number`'s text or kind, where it is now. Resolves to whether there was one. */
  update(number: number, change: { text?: string; kind?: Kind }): Promise<boolean> {
    return this.queued(() => this.updating(number, change));
  }

  private async updating(number: number, change: { text?: string; kind?: Kind }) {
    const found = await this.find(number);
    if (!found) return false;
    const { note, id } = found;
    const text = change.text ?? note.text, kind = change.kind ?? note.kind;
    const patch = { text: `${number}. ${text}`, hl: HL[kind] };
    if (!await this.text.update(id, patch)) return false;
    // As nvim-virtual-text now has it given, so that a later add leaves it as it is.
    Object.assign(note, { text, kind, mark: { ...note.mark, ...patch } });
    return true;
  }

  /** Remove the notes `numbers`, the others keeping theirs. Resolves to the numbers there were. */
  remove(numbers: number[]): Promise<number[]> {
    return this.queued(() => this.removing(numbers));
  }

  private async removing(numbers: number[]) {
    const marks = await this.marks();
    const found = this.notes.filter(note => numbers.includes(note.number));
    if (found.length) await this.text.remove(found.map(note => marks.get(note.mark.key)!.id));
    this.notes = this.notes.filter(note => !found.includes(note));
    return found.map(note => note.number);
  }

  /** Why each of `marks` that cannot be placed cannot, or undefined if each can alone. */
  private async why(marks: Mark[]) {
    // Through JSON, as undefined would reach Lua as vim.NIL.
    const why: string[] | null = await this.remote.lua(CHECK, [`${GROUP}.check`, JSON.parse(JSON.stringify(marks))]);
    const failed = (why ?? []).flatMap((reason, i) => reason ? [`notes[${i}]: ${reason.split('\n')[0]}`] : []);
    if (!failed.length) return undefined;
    return new Error(`${failed.length} of ${marks.length} notes cannot be placed, so none were:\n${failed.join('\n')}`);
  }

  /** The notes, where their code is now. */
  list(): Promise<Placed[]> {
    return this.queued(() => this.listing());
  }

  private async listing(): Promise<Placed[]> {
    const marks = await this.marks();
    const found = this.notes.map(note => ({ note, mark: marks.get(note.mark.key)! }));
    if (!found.length) return [];
    const code: string[] = await this.remote.lua(LINES, [found.map(({ mark }) => [mark.buf, mark.line])]);
    return found.map(({ note, mark }, i) => ({
      ...note, line: mark.line, endLine: mark.endLine ?? mark.line, code: code[i] ?? '', ...(mark.invalid ? { hidden: true as const } : {}),
    }));
  }

  /**
   * Show the user note `which` (a number, or the next or previous of the one last shown, passing
   * over hidden ones): its code on screen, the cursor on it. Undefined if there is no such note.
   */
  show(which: number | 'next' | 'prev', cwd: string, options: { focus?: boolean } = {}) {
    return this.queued(() => this.step(which, cwd, options));
  }

  private async step(which: number | 'next' | 'prev', cwd: string, options: { focus?: boolean }): Promise<{ note: Placed; total: number; pointed: Pointed } | undefined> {
    const notes = (await this.listing()).filter(note => !note.hidden);
    const note = typeof which === 'number' ? notes.find(note => note.number === which)
      : which === 'next' ? notes.find(note => note.number > this.at)
      : notes.findLast(note => note.number < this.at);
    if (!note) return undefined;
    const pointed = await point(this.remote, cwd).show({ path: note.path, line: note.line, endLine: note.endLine }, options);
    if (pointed.shown) this.at = note.number;
    return { note, total: notes.length, pointed };
  }

  /** Remove every note. Resolves to how many there were. */
  clear(): Promise<number> {
    return this.queued(() => this.clearing());
  }

  private async clearing() {
    const count = this.notes.length;
    await this.text.clear();
    this.notes = [];
    this.at = this.last = 0;
    return count;
  }
}
