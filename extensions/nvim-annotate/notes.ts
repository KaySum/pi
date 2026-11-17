import { resolve } from 'node:path';
import type { Remote } from '../nvim-remote/api.ts';
import { blocked } from '../nvim-remote-kit/api.ts';
import { installPoint, type Pointed } from '../nvim-point/api.ts';
import { virtualText, type Mark, type Placed as VirtualPlaced } from '../nvim-virtual-text/api.ts';

export const KINDS = ['info', 'hint', 'warn', 'error'] as const;
export type Kind = typeof KINDS[number];

/**
 * A note as asked for: on code by `match`, or on a line, in a file from Pi's working directory.
 * Always above its code, indented to it, and wrapped as the user's window wraps code.
 */
export type NoteSpec = { file: string; match?: string; line?: number; text: string; kind?: Kind };
/** A note as placed, numbered in the order notes were added; `id` is never given again, unlike numbers. */
export type Note = { id: number; number: number; path: string; text: string; kind: Kind; mark: Mark };
/** Who removed a note: the user, or Pi with its tool. */
export type By = 'user' | 'pi';
export type Removed = { id: number; number: number; path: string; by: By };
/** What happened to the notes since last observed: those added, and those removed and by whom. */
export type Changes = { added: Note[]; removed: Removed[] };
/** Where a note is now, its code moved by edits, and the first line of that code; `hidden` while it is deleted. */
export type Placed = Note & { line: number; endLine: number; code: string; hidden?: true };

const GROUP = 'nvim-annotate';
// The group's marks, each with the code on its line, all read in one call: an edit cannot come
// between where a mark is and what is there. False if nvim-virtual-text is not installed yet.
const MARKS = `local vt, group = remote.nvim_virtual_text, ...
if not vt then return false end
local marks = vt.list(group, {})
for _, mark in ipairs(marks) do
  local ok, lines = pcall(vim.api.nvim_buf_get_lines, mark.buf, mark.line - 1, mark.line, false)
  mark.code = ok and lines[1] or ''
end
return marks`;
// Show the note whose mark has key `key` where it is, in its buffer however named now, both in
// this one call: no other call comes between. Showing can move it all the same (a reload of its
// file, the user's autocommands as its buffer is entered), so it is found again after, and shown
// again where it went, a few times at most: also when nvim-point failed, its lines past the end of
// the file as reloaded shorter. nvim-point's result, with the file and lines shown; not shown if
// it kept moving; nil if the note is gone or hidden; false if nvim-point is not installed yet.
const SHOW = `local vt, pt, group, key, spec = remote.nvim_virtual_text, remote.nvim_point, ...
if not pt then return false end
local function find()
  for _, mark in ipairs(vt and vt.list(group, {}) or {}) do
    if mark.key == key then return not mark.invalid and mark or nil end
  end
end
local mark = find()
for _ = 1, 3 do
  if not mark then return nil end
  spec.buf, spec.line, spec.endLine = mark.buf, mark.line, mark.endLine or mark.line
  local ok, pointed = pcall(pt.show, spec)
  if ok and not pointed.shown then return pointed end
  mark = find()
  local moved = not mark or mark.buf ~= spec.buf or mark.line ~= spec.line or (mark.endLine or mark.line) ~= spec.endLine
  if not moved then
    if not ok then error(pointed, 0) end
    pointed.path, pointed.line, pointed.endLine = mark.path, spec.line, spec.endLine
    return pointed
  end
end
return mark and { shown = false, moved = true } or nil`;
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
  /** The last id given. */
  private ids = 0;
  /** What happened to the notes since `observe` last said, in order. */
  private changes: Changes = { added: [], removed: [] };
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
    type Read = (VirtualPlaced & { code: string })[] | false;
    let read: Read = await this.remote.lua(MARKS, [GROUP]);
    if (read === false) {
      await this.text.list();
      read = await this.remote.lua(MARKS, [GROUP]) as Read;
    }
    const marks = new Map((read || []).map(mark => [mark.key, mark]));
    this.notes = this.notes.filter(note => marks.has(note.mark.key));
    return marks;
  }

  /**
   * Add notes after those there, or with `replace` instead of them, numbered from 1 again: all
   * placed, or none if one cannot be (its file or code missing), those there left as they were.
   * Resolves to those added, and the notes where they are then: read in the same step, so one
   * added is missing only if the editor took it (its code deleted, or its buffer wiped).
   */
  add(specs: NoteSpec[], cwd: string, { replace = false } = {}): Promise<{ added: Note[]; placed: Placed[] }> {
    return this.queued(async () => {
      const added = await this.adding(specs, cwd, replace);
      return { added, placed: await this.listing() };
    });
  }

  private async adding(specs: NoteSpec[], cwd: string, replace: boolean) {
    if (!replace) await this.marks();
    const kept = replace ? [] : this.notes;
    const after = replace ? 0 : this.last;
    const added = specs.map((spec, i): Note => {
      const number = after + i + 1, kind = spec.kind ?? 'info';
      const mark: Mark = {
        key: `note-${number}`, path: resolve(cwd, spec.file), text: `${number}. ${spec.text}`, position: 'above', hl: HL[kind],
        indent: true, wrap: 'window', invalidate: true,
        ...(spec.match === undefined ? { line: spec.line } : { match: spec.match, line: spec.line }),
      };
      return { id: this.ids + i + 1, number, path: mark.path!, text: spec.text, kind, mark };
    });
    // All of them, those kept as they were: the call is checked whole before anything changes.
    try {
      await this.text.set([...kept, ...added].map(note => note.mark));
    } catch (error) {
      throw await this.why(added.map(note => note.mark)) ?? error;
    }
    this.ids += added.length;
    if (replace) this.retire(this.notes);
    this.changes.added.push(...added);
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

  /**
   * Change note `number`'s text or kind, where it is now. Resolves to undefined if there was none,
   * else to it as placed then, read in the same step: none if the editor took it meanwhile.
   */
  update(number: number, change: { text?: string; kind?: Kind }): Promise<{ placed?: Placed } | undefined> {
    return this.queued(async () => {
      if (!await this.updating(number, change)) return undefined;
      return { placed: (await this.listing()).find(note => note.number === number) };
    });
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
  remove(numbers: number[], by: By): Promise<number[]> {
    return this.queued(() => this.removing(numbers, by));
  }

  /**
   * Remove the notes numbered within any of `spans` ([first, last]), chosen and removed in one
   * step: of the notes there then, as nothing else runs between. Resolves to the numbers removed.
   */
  removeWithin(spans: [number, number][], by: By): Promise<number[]> {
    return this.queued(async () => {
      await this.marks();
      const within = (n: number) => spans.some(([first, last]) => n >= first && n <= last);
      const numbers = this.notes.map(note => note.number).filter(within);
      return numbers.length ? this.removing(numbers, by) : [];
    });
  }

  private async removing(numbers: number[], by: By) {
    const marks = await this.marks();
    const found = this.notes.filter(note => numbers.includes(note.number));
    if (found.length) await this.text.remove(found.map(note => marks.get(note.mark.key)!.id));
    this.notes = this.notes.filter(note => !found.includes(note));
    this.journal(found.map(note => ({ ...note, path: marks.get(note.mark.key)!.path })), by);
    return found.map(note => note.number);
  }

  private journal(notes: Note[], by: By) {
    this.changes.removed.push(...notes.map(({ id, number, path }) => ({ id, number, path, by })));
  }

  /** Pi has done with `notes`, all it had: those the user removed before are now as if Pi had. */
  private retire(notes: Note[]) {
    for (const removed of this.changes.removed) removed.by = 'pi';
    this.journal(notes, 'pi');
  }

  /**
   * The notes, where their code is now, and what happened to them since last asked: read in one
   * step, so each change is either among those or already in the notes.
   */
  observe(): Promise<Changes & { notes: Placed[] }> {
    return this.queued(async () => {
      const notes = await this.listing(), changes = this.changes;
      this.changes = { added: [], removed: [] };
      return { notes, ...changes };
    });
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
    return this.notes.map(note => {
      const mark = marks.get(note.mark.key)!;
      // Its file as its buffer is named now, renamed or saved as another.
      return { ...note, path: mark.path, line: mark.line, endLine: mark.endLine ?? mark.line, code: mark.code ?? '', ...(mark.invalid ? { hidden: true as const } : {}) };
    });
  }

  /**
   * Show the user note `which` (a number, or the next or previous of the one last shown, passing
   * over hidden ones): its code on screen, the cursor on it. Undefined if there is no such note.
   */
  show(which: number | 'next' | 'prev', options: { focus?: boolean } = {}) {
    return this.queued(() => this.step(which, options));
  }

  private async step(which: number | 'next' | 'prev', options: { focus?: boolean }): Promise<{ note: Placed; total: number; pointed: Pointed } | undefined> {
    const notes = (await this.listing()).filter(note => !note.hidden);
    const note = typeof which === 'number' ? notes.find(note => note.number === which)
      : which === 'next' ? notes.find(note => note.number > this.at)
      : notes.findLast(note => note.number < this.at);
    if (!note) return undefined;
    const result = await this.point(note, options);
    if (!result) return undefined;
    const { path = note.path, line = note.line, endLine = note.endLine, ...pointed } = result;
    if (pointed.shown) this.at = note.number;
    return { note: { ...note, path, line, endLine }, total: notes.length, pointed: pointed as Pointed };
  }

  /** Show `note` where it is (see SHOW). Undefined if it is gone or hidden by then. */
  private async point(note: Note, options: { focus?: boolean }) {
    type Result = (Pointed & { path?: string; line?: number; endLine?: number }) | null | false;
    const args = [GROUP, note.mark.key, options.focus ? { focus: true } : {}];
    try {
      let result: Result = await this.remote.lua(SHOW, args);
      if (result === false) {
        await installPoint(this.remote);
        result = await this.remote.lua(SHOW, args);
      }
      return result || undefined;
    } catch (error) {
      // At a prompt, nvim-remote fails every call at once: the user is busy.
      const busy = blocked(error);
      if (busy !== undefined) return { shown: false as const, busy };
      throw error;
    }
  }

  /** Remove every note. Resolves to the numbers they had. */
  clear(by: By): Promise<number[]> {
    return this.queued(() => this.clearing(by));
  }

  private async clearing(by: By) {
    const marks = await this.marks();
    const numbers = this.notes.map(note => note.number);
    await this.text.clear();
    if (by === 'pi') this.retire(this.notes);
    else this.journal(this.notes.map(note => ({ ...note, path: marks.get(note.mark.key)!.path })), by);
    this.notes = [];
    this.at = this.last = 0;
    return numbers;
  }
}
