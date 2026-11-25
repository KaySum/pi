import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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
/** The group's marks by key, each with the code on its line (see MARKS). */
type Marks = Map<string | undefined, VirtualPlaced & { code: string; given?: Mark }>;
/** Of the CALLs asked about, those that have run: how, and when among the others (see CALL). */
type Done = Record<string, { ok: boolean; result?: unknown; made: number; during?: string }> | [];
/** What a CALL's change is made with: true if it numbered the notes from 1 again. */
type Made<T> = (result: T, marks?: Marks) => boolean | void;
/** Notes a CALL is to remove, `by` the user or Pi, their files as `marks` had them. */
type Removing = { notes: Note[]; by: By; marks: Marks };
// Of the CALLs whose tokens are given, those that have run, and how, kept until forgotten (see
// CALL) so that a read that fails loses nothing; and the group's marks, each with the code on its
// line and the mark as last given it (see `drawn`). False if nvim-virtual-text is not installed yet. All in one call: neither a change nor an
// edit can come between what is done and where a mark is, and what is there.
const MARKS = `local calls, done = remote.nvim_annotate_calls or {}, vim.empty_dict()
for _, token in ipairs(...) do
  done[token] = calls[token]
end
local vt, group = remote.nvim_virtual_text, select(2, ...)
if not vt then return false end
local marks = vt.list(group, {})
for _, mark in ipairs(marks) do
  local ok, lines = pcall(vim.api.nvim_buf_get_lines, mark.buf, mark.line - 1, mark.line, false)
  mark.code = ok and lines[1] or ''
  mark.given = vt.marks[mark.id] and vt.marks[mark.id].given
end
return { true, marks, done }`;
// Call nvim-virtual-text's `fn` with the arguments after it, as its own calls are made; the last,
// { token, forget, pending }: the token under which to note that it has run, how, and when among
// the others, so that one whose answer was lost (timed out) is known for done or not once Neovim
// says (see MARKS); the tokens of those no longer asked about; and of those still asked about, to
// say which ran before this one (one that ran during another, in an autocommand it set off, is
// noted so: see `drawn`). False if it is not installed yet.
const CALL = `local vt, fn = remote.nvim_virtual_text, ...
if not vt then return false end
local args = { select(2, ...) }
local call = table.remove(args)
local calls, done = remote.nvim_annotate_calls or {}, vim.empty_dict()
remote.nvim_annotate_calls = calls
for _, token in ipairs(call.forget) do
  calls[token] = nil
end
for _, token in ipairs(call.pending) do
  done[token] = calls[token]
end
local during = remote.nvim_annotate_running
remote.nvim_annotate_running = call.token
local ok, result = pcall(vt[fn], unpack(args))
remote.nvim_annotate_running = during
remote.nvim_annotate_made = (remote.nvim_annotate_made or 0) + 1
calls[call.token] = { ok = ok, result = ok and result or nil, made = remote.nvim_annotate_made, during = during }
if not ok then error(result, 0) end
if result == nil then result = vim.NIL end
return { true, result, done }`;
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

/** Note `number`'s mark, its anchor `at`. */
const markOf = (number: number, path: string, text: string, kind: Kind, at: { line?: number; match?: string }): Mark => ({
  key: `note-${number}`, path, text: `${number}. ${text}`, position: 'above', hl: HL[kind], indent: true, wrap: 'window', invalidate: true, ...at,
});

/** Pi's notes in the editor of one attachment: added in order, stepped through, cleared. */
export class Notes {
  private notes: Note[] = [];
  /** The note last shown; 0 before any. */
  private at = 0;
  /** The last number given: one removed is not given again, until all are cleared or replaced. */
  private last = 0;
  /**
   * Whether `last` is to be the last number drawn: an add or clear made during a replace or clear
   * (see `drawn`) may have come before or after its writes, and so been undone by them or not.
   */
  private recount = false;
  /** The CALLs made that numbered the notes from 1 again: replaces and clears. */
  private afresh = new Set<string>();
  /** The last id given. */
  private ids = 0;
  /** What happened to the notes since `observe` last said, in order. */
  private changes: Changes = { added: [], removed: [] };
  /** The CALLs made, by which each is known. */
  private calls = 0;
  /**
   * Changes whose CALL failed, which Neovim may have made all the same (one timed out after it
   * did): `made` once Neovim says it did, with its result. Notes one would remove are taken for
   * removed by whoever asked once they are gone, whenever that is.
   */
  private pending: { token: string; fn: string; made: Made<any>; removing?: Removing }[] = [];
  /** The CALLs no longer asked about, for Neovim to forget with the next (see CALL). */
  private forget: string[] = [];
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
    type Read = [true, (VirtualPlaced & { code: string; given?: Mark })[], Done] | false;
    const read = (): Promise<Read> => this.remote.lua(MARKS, [this.pending.map(call => call.token), GROUP]);
    let result = await read();
    if (result === false) {
      await this.text.list();
      result = await read();
    }
    const [, placed, done] = result || [true, [], {}];
    const marks: Marks = new Map(placed.map(mark => [mark.key, mark]));
    this.settle(done, marks);
    for (const { removing } of this.pending) {
      if (removing) this.drop(removing.notes.filter(note => !marks.has(note.mark.key)), removing.by, removing.marks);
    }
    this.notes = this.notes.filter(note => marks.has(note.mark.key));
    this.drawn(placed);
    return marks;
  }

  /**
   * The notes as Neovim draws them, `placed`: a change made there during another, before its
   * writes, after or between them, can leave them otherwise than either order of the two made here.
   * One drawn that is not among them is taken in again, as if Pi had added it.
   */
  private drawn(placed: { key?: string; given?: Mark }[]) {
    for (const { key, given } of placed) {
      const number = Number(key?.match(/^note-(\d+)$/)?.[1]);
      const kind = KINDS.find(kind => HL[kind] === given?.hl);
      if (!given || !number || !kind || typeof given.text !== 'string' || !given.text.startsWith(`${number}. `)) continue;
      // As given, its anchor too (a match, the lines it takes in): given so again, it stays as it is.
      const as = { text: given.text.slice(`${number}. `.length), kind, mark: given };
      this.last = Math.max(this.last, number);
      const note = this.notes.find(note => note.mark.key === key);
      if (!note) {
        const taken: Note = { id: ++this.ids, number, path: given.path!, ...as };
        this.notes.push(taken);
        this.changes.added.push(taken);
      } else if (!isDeepStrictEqual(note.mark, given)) Object.assign(note, as);
    }
    this.notes.sort((a, b) => a.number - b.number);
    if (this.recount) this.last = Math.max(0, ...this.notes.map(note => note.number));
    this.recount = false;
  }

  /**
   * The pending changes Neovim says it made, made here as it made them: in the order it ran them,
   * not the order asked, as one whose answer was lost may have waited there for a later one.
   */
  private settle(done: Done, marks?: Marks) {
    if (Array.isArray(done)) return;
    const settled = this.pending.filter(call => done[call.token]).sort((a, b) => done[a.token].made - done[b.token].made);
    this.pending = this.pending.filter(call => !done[call.token]);
    for (const call of settled) {
      this.forget.push(call.token);
      if (!done[call.token].ok) continue;
      if (call.made(done[call.token].result, marks)) this.afresh.add(call.token);
      // Its numbers given still, unless made during a replace or clear (see `recount`).
      const during = done[call.token].during;
      if (during && this.afresh.has(during) && (call.fn === 'set' || call.fn === 'clear')) this.recount = true;
    }
  }

  /** Call nvim-virtual-text's `fn` (see CALL), then `made`; or once Neovim says it did, if the call failed. */
  private async call<T>(fn: string, args: unknown[], made: Made<T>, removing?: Removing): Promise<T> {
    const token = String(++this.calls);
    const forget = [...this.forget];
    const pending = this.pending.map(call => call.token);
    // Through JSON, as undefined would reach Lua as vim.NIL.
    const run = (): Promise<[true, T, Done] | false> =>
      this.remote.lua(CALL, [fn, GROUP, ...JSON.parse(JSON.stringify(args)), { token, forget, pending }]);
    let result: [true, T, Done] | false;
    try {
      result = await run();
      if (result === false) {
        await this.text.list();
        result = await run() as [true, T, Done];
      }
    } catch (error) {
      this.pending.push({ token, fn, made, removing });
      throw error;
    }
    this.forget = this.forget.filter(old => !forget.includes(old));
    this.settle(result[2]);
    this.forget.push(token);
    if (made(result[1])) this.afresh.add(token);
    return result[1];
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
    // Those done before, settled first: this comes after them.
    await this.marks();
    // Each kept as given now: one made late leaves them so, though changed since.
    const kept = replace ? [] : this.notes.map(note => [note, { ...note }] as const);
    const after = replace ? 0 : this.last;
    const added = specs.map((spec, i): Note => {
      const number = after + i + 1, kind = spec.kind ?? 'info';
      const at = spec.match === undefined ? { line: spec.line } : { match: spec.match, line: spec.line };
      const mark = markOf(number, resolve(cwd, spec.file), spec.text, kind, at);
      return { id: this.ids + i + 1, number, path: mark.path!, text: spec.text, kind, mark };
    });
    // Its ids taken, made or not: one made late does not share those given meanwhile.
    this.ids += added.length;
    // Made, late too, the notes are those it set: any others there then it removed, as Pi.
    const made = () => {
      for (const [note, was] of kept) Object.assign(note, was);
      const set = [...kept.map(([note]) => note), ...added];
      if (replace) this.retire(this.notes);
      else this.journal(this.notes.filter(note => !set.includes(note)), 'pi');
      this.changes.added.push(...added);
      this.notes = set;
      this.last = after + added.length;
      if (replace) this.at = 0;
      return replace;
    };
    // All of them, those kept as they were: the call is checked whole before anything changes.
    try {
      await this.call('set', [[...kept.map(([, was]) => was), ...added].map(note => note.mark)], made);
    } catch (error) {
      throw await this.why(added.map(note => note.mark)) ?? error;
    }
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
    // As nvim-virtual-text now has it given, so that a later add leaves it as it is. Made late, it
    // is of the note with its key then: a replace since kept the key's mark, and so its id.
    return this.call<boolean>('update', [id, patch], updated => {
      const now = this.notes.find(other => other.mark.key === note.mark.key);
      if (updated && now) Object.assign(now, { text, kind, mark: { ...now.mark, ...patch } });
    });
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
    if (found.length) {
      const ids = found.map(note => marks.get(note.mark.key)!.id);
      // The notes with those keys then whose marks it removed, made late too: a replace since kept
      // the keys' marks, and so their ids; a clear did not, and the notes since, even these restored
      // by an add made late, have others. Not those drawn still, as `now` has them: one made during
      // another, before its writes, had its mark drawn again by them (see `drawn`).
      const made = (removed: number[], now?: Marks) => {
        const gone = found.filter((_, i) => removed.includes(ids[i]) && !now?.has(found[i].mark.key)).map(note => note.mark.key);
        const there = this.notes.filter(note => gone.includes(note.mark.key));
        this.drop(there.filter(note => found.includes(note)), by, marks);
        this.drop(there.filter(note => !found.includes(note)), by, new Map());
      };
      await this.call('remove', [ids], made, { notes: found, by, marks });
    }
    return found.map(note => note.number);
  }

  /** Forget `notes` among those there still, removed `by` the user or Pi, their files as `marks` had them. */
  private drop(notes: Note[], by: By, marks: Marks) {
    const there = notes.filter(note => this.notes.includes(note));
    this.notes = this.notes.filter(note => !there.includes(note));
    this.journal(there.map(note => ({ ...note, path: marks.get(note.mark.key)?.path ?? note.path })), by);
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
    const all = this.notes, numbers = all.map(note => note.number);
    await this.call('clear', [{}], () => {
      // Every note there as it ran, made late too: added since, or not.
      if (by === 'pi') this.retire(this.notes);
      else this.drop(this.notes, by, marks);
      this.notes = [];
      this.at = this.last = 0;
      return true;
    }, { notes: all, by, marks });
    return numbers;
  }
}
