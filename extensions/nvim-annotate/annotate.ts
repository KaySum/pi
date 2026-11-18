import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { relative } from 'node:path';
import { useRemote, type Remote } from '../nvim-remote/api.ts';
import { errorText, perAttachment, useCwd, withKit } from '../nvim-remote-kit/api.ts';
import { Notes, type Kind, type NoteSpec, type Placed } from './notes.ts';

// :PiNotes and :PiNotesRemove in Neovim, their arguments sent to Pi; gone with the attachment.
const COMMAND = `vim.api.nvim_create_user_command('PiNotes', function(o) remote.notify('nvim-annotate:step', o.args) end, {
  nargs = '?', desc = "Go to Pi's notes: next, prev, or a number",
  complete = function() return { 'next', 'prev' } end,
})
vim.api.nvim_create_user_command('PiNotesRemove', function(o) remote.notify('nvim-annotate:remove', o.args) end, {
  nargs = '*', desc = "Remove Pi's notes by numbers and ranges (2 5-7,10); all of them, with none",
})
remote.on_detach(function()
  pcall(vim.api.nvim_del_user_command, 'PiNotes')
  pcall(vim.api.nvim_del_user_command, 'PiNotesRemove')
end)`;
// A note whose code a reload took since it was placed or changed.
const GONE = 'gone from the editor: its code deleted, or its buffer wiped';
const USAGE = 'Usage: /nvim-annotate [next | prev | <number> | clear]';
const NUMBERS = 'numbers and ranges, as 2 5-7,10';

/**
 * Note numbers as written: numbers and ranges (`5-7`, or `7-5`), by spaces or commas, in any
 * order. Each as [first, last]; undefined if there are none, or anything else.
 */
export function ranges(text: string): [number, number][] | undefined {
  const parts = text.replace(/\s*-\s*/g, '-').split(/[\s,]+/).filter(Boolean);
  const found = parts.map(part => /^([1-9]\d*)(?:-([1-9]\d*))?$/.exec(part));
  if (!found.length || found.some(match => !match)) return undefined;
  return found.map(match => {
    const a = Number(match![1]), b = Number(match![2] ?? match![1]);
    return a <= b ? [a, b] : [b, a];
  });
}

// What removing said: those removed, those asked for that were not there, and whether others are left.
function removal(removed: number[], missing: string[], left: boolean) {
  const numbers = (list: (number | string)[]) => `${list.length === 1 && !String(list[0]).includes('-') ? 'note' : 'notes'} ${list.join(', ')}`;
  const none = missing.length ? `no ${numbers(missing)}` : '';
  if (!removed.length) return none.replace(/^n/, 'N');
  return `Removed ${numbers(removed)}${none && `; ${none}`}${left ? '; the others keep their numbers' : ''}`;
}

const file = (path: string, cwd: string) => relative(cwd, path).startsWith('..') ? path : relative(cwd, path);
const where = (note: Placed, cwd: string) =>
  `${file(note.path, cwd)}:${note.line === note.endLine ? note.line : `${note.line}-${note.endLine}`}`;
// Of the agent's messages, those that tell it how its notes changed in the editor.
const CHANGED = 'nvim-annotate';
// The code it is on, so that a match that found other code than meant shows.
const code = (note: Placed) => {
  // By characters, not UTF-16 units: one outside the BMP is not cut in half.
  const chars = [...note.code.trim()];
  return chars.length > 80 ? `${chars.slice(0, 79).join('')}…` : chars.join('');
};
const describe = (note: Placed, cwd: string) =>
  `${note.number}. ${where(note, cwd)}${note.kind === 'info' ? '' : ` ${note.kind}`}${note.hidden ? ' (its lines deleted)' : ` \`${code(note)}\``}: ${note.text}`;

/** Everything nvim-annotate registers; `parameters`, the tool's schema, from index.ts. */
export default function register(pi: ExtensionAPI, parameters: Parameters<ExtensionAPI['registerTool']>[0]['parameters']) {
  const notesOf = perAttachment(remote => new Notes(remote));
  // Pi's working directory, which notes' files are from.
  const cwd = useCwd(pi);

  // Step to `which`, saying how it went.
  async function step(remote: Remote, which: number | 'next' | 'prev', options: { focus?: boolean } = {}) {
    const result = await notesOf(remote).show(which, options);
    if (!result) return typeof which === 'number' ? `No note ${which}` : `No ${which === 'next' ? 'next' : 'previous'} note`;
    if (!result.pointed.shown) return 'busy' in result.pointed ? `Not now: you are busy in Neovim (mode ${result.pointed.busy})`
      : 'moved' in result.pointed ? 'Not shown: it kept moving as it was shown' : 'Not shown';
    return `Note ${result.note.number} of ${result.total}: ${where(result.note, cwd())}`;
  }
  const parse = (arg: string) => arg === 'next' || arg === 'prev' ? arg : /^[1-9]\d*$/.test(arg) ? Number(arg) : undefined;
  // The notes of each attachment as the agent last knew them, by id: each one's number, file and
  // whether it was hidden. What it added or removed itself it knows from its tool's replies.
  type Known = { number: number; path: string; hidden: boolean };
  const known = perAttachment(() => new Map<number, Known>());

  // How the notes changed since the agent last knew, said for it once: removed by the user, gone
  // otherwise, hidden with their lines deleted or back; and the notes there now. Undefined
  // if none did.
  async function changes() {
    const remote = nvim();
    if (!remote) return undefined;
    const seen = known(remote), { notes: placed, added, removed } = await notesOf(remote).observe();
    // Pi detached or attached anew meanwhile: these are of notes no longer there.
    if (nvim() !== remote) return undefined;
    // Those the agent added it knew as it added them.
    for (const note of added) seen.set(note.id, { number: note.number, path: note.path, hidden: false });
    const now = new Map(placed.map(note => [note.id, { number: note.number, path: note.path, hidden: !!note.hidden }]));
    const said = (notes: { number: number; path: string }[]) =>
      `${notes.length === 1 ? 'note' : 'notes'} ${notes.map(note => `${note.number} (${file(note.path, cwd())})`).join(', ')}`;
    const be = (notes: Known[]) => notes.length === 1 ? 'is' : 'are', its = (notes: Known[]) => notes.length === 1 ? 'its' : 'their';
    const byUser = removed.filter(note => note.by === 'user');
    const lost = [...seen].filter(([id]) => !now.has(id) && !removed.some(note => note.id === id)).map(([, note]) => note);
    const hidden = [...now].filter(([id, note]) => note.hidden && !seen.get(id)?.hidden).map(([, note]) => note);
    const back = [...now].filter(([id, note]) => !note.hidden && seen.get(id)?.hidden).map(([, note]) => note);
    const facts = [
      byUser.length && `the user removed ${said(byUser)}`,
      // Gone with its code, or its buffer wiped: the editor does not say which.
      lost.length && `${said(lost)} ${be(lost)} gone from the editor, removed by neither the user nor Pi`,
      hidden.length && `${said(hidden)} ${be(hidden)} hidden, ${its(hidden)} lines deleted (back if that is undone)`,
      back.length && `${said(back)} ${be(back)} back, ${its(back)} lines restored`,
    ].filter(fact => typeof fact === 'string');
    seen.clear();
    for (const [id, note] of now) seen.set(id, note);
    if (!facts.length) return undefined;
    const left = [...now.values()].map(note => note.hidden ? `${note.number} (hidden)` : String(note.number)).join(', ');
    return `Pi's notes in the editor changed: ${facts.join('; ')}. Notes now: ${left || 'none'}.`;
  }

  // Remove every note, as the user asked: saying how many.
  async function clearing(remote: Remote) {
    const cleared = await notesOf(remote).clear('user');
    return `Removed ${cleared.length} ${cleared.length === 1 ? 'note' : 'notes'}`;
  }

  // Remove the notes `text` numbers (see `ranges`), or with none, all; saying how it went.
  // Undefined if it is neither.
  async function removing(remote: Remote, text: string) {
    if (!text.trim()) {
      return clearing(remote);
    }
    const spans = ranges(text);
    return spans && remove(remote, spans);
  }
  // Remove the notes `spans` take in (of those there: a range is never counted out), saying how it went.
  async function remove(remote: Remote, spans: [number, number][]) {
    const notes = notesOf(remote);
    const within = (n: number, [first, last]: [number, number]) => n >= first && n <= last;
    // Chosen and removed in one step: a replace between could not have its notes taken for these.
    const removed = await notes.removeWithin(spans, 'user');
    const missing = spans.filter(span => !removed.some(n => within(n, span)))
      .map(([first, last]) => first === last ? String(first) : `${first}-${last}`);
    return removal(removed, missing, notes.size > 0);
  }

  const nvim = useRemote(pi, remote => {
    void remote.lua(COMMAND).catch(() => {});
    // Fitted to where messages go: a longer one would stop the editor at "Press ENTER".
    const say = (said: string) => withKit(remote, 'kit.say(...)', [said]).catch(() => {});
    remote.on('nvim-annotate:step', async (arg: string) => {
      const which = parse(arg.trim() || 'next');
      await say(which === undefined ? 'Usage: :PiNotes [next | prev | <number>]' : await step(remote, which).catch(errorText));
    });
    remote.on('nvim-annotate:remove', async (arg: string) => {
      const said = await removing(remote, arg).catch(errorText);
      await say(said ?? `Usage: :PiNotesRemove [${NUMBERS}; none for all]`);
    });
  });

  pi.registerTool({
    name: 'nvim_annotate',
    label: 'Neovim notes',
    promptSnippet: 'Explain code with notes in the user\'s Neovim, and walk them through it',
    description: 'Put notes on code in the Neovim Pi runs inside, where the user reads it: above the lines, numbered in the order added, anchored to the code so they move with edits. add places notes on code by match (the code itself, which is better than a line number) or a line; list says where they are now and the code they are on, to check the right code was found; show takes the user to note N; update changes the text or kind of one, and remove removes one or several, the others keeping their numbers; clear removes them all. The user steps through them with :PiNotes next and :PiNotes prev.',
    promptGuidelines: [
      'Use nvim_annotate to explain code where the user reads it, rather than quoting it in chat: for a walkthrough, add the notes in the order to read them with show: true, which takes the user to the first. Keep each note to a sentence or two about that code. Give a kind only for what it means: warn for a real risk, error for a bug, never for emphasis. Anchor notes by match, a distinctive line of the code. For a new explanation add with replace: true, which swaps the old notes for the new; clear notes once they no longer apply. A message that the notes changed reports what happened in the editor: the user may remove notes for any reason, so do not guess why, and do not add them back unless asked.',
    ],
    executionMode: 'sequential',
    parameters,
    async execute(_id, raw, _signal, _onUpdate, ctx) {
      const params = raw as {
        action: 'add' | 'list' | 'show' | 'update' | 'remove' | 'clear'; notes?: NoteSpec[]; note?: number | number[];
        show?: boolean; replace?: boolean; text?: string; kind?: Kind;
      };
      const remote = nvim();
      if (!remote) throw new Error('Pi is not attached to Neovim');
      const notes = notesOf(remote);
      if (Array.isArray(params.note) && params.action !== 'remove') throw new Error(`${params.action} takes one note number`);
      const text = await (async () => {
        switch (params.action) {
          case 'add': {
            if (!params.notes?.length) throw new Error('add needs notes');
            const bad = params.notes.flatMap((note, i) => note.match === undefined && note.line === undefined ? [`notes[${i}]`] : []);
            if (bad.length) throw new Error(`A note needs a match or a line: ${bad.join(', ')}`);
            const before = notes.size;
            const { added, placed } = await notes.add(params.notes, ctx.cwd, { replace: params.replace });
            const lines = added.map(a => {
              const note = placed.find(note => note.number === a.number);
              return note ? describe(note, ctx.cwd) : `${a.number}. ${GONE}`;
            });
            const replaced = params.replace ? `, replacing ${before}` : '';
            const said = `Added ${added.length === 1 ? 'note' : 'notes'} ${added[0].number}${added.length > 1 ? `-${added.at(-1)!.number}` : ''}${replaced}:\n${lines.join('\n')}`;
            return params.show ? `${said}\n${await step(remote, added[0].number)}` : said;
          }
          case 'list': {
            const placed = await notes.list();
            return placed.length ? placed.map(note => describe(note, ctx.cwd)).join('\n') : 'No notes';
          }
          case 'show':
            if (params.note === undefined) throw new Error('show needs a note number');
            return step(remote, params.note as number);
          case 'update': {
            if (params.note === undefined) throw new Error('update needs a note number');
            if (params.text === undefined && params.kind === undefined) throw new Error('update needs a text or a kind');
            const number = params.note as number;
            const updated = await notes.update(number, { text: params.text, kind: params.kind });
            if (!updated) return `No note ${number}`;
            return updated.placed ? `Updated:\n${describe(updated.placed, ctx.cwd)}` : `Note ${number} is ${GONE}`;
          }
          case 'remove': {
            if (params.note === undefined) throw new Error('remove needs a note number');
            const asked = [...new Set([params.note].flat())];
            const removed = await notes.remove(asked, 'pi'), missing = asked.filter(number => !removed.includes(number));
            return removal(removed, missing.map(String), notes.size > 0);
          }
          case 'clear': {
            const count = (await notes.clear('pi')).length;
            return `Removed ${count} ${count === 1 ? 'note' : 'notes'}`;
          }
        }
      })();
      return { content: [{ type: 'text', text }], details: {} };
    },
  });

  pi.registerCommand('nvim-annotate', {
    description: "Show Pi's notes in Neovim, go to one (next, prev, a number), or clear them",
    getArgumentCompletions: prefix => ['next', 'prev', 'clear'].filter(word => word.startsWith(prefix.trim())).map(word => ({ value: word, label: word })),
    handler: async (args, ctx) => {
      const remote = nvim();
      if (!remote) return ctx.ui.notify('Pi is not attached to Neovim', 'warning');
      const arg = args.trim();
      try {
        if (!arg) {
          const placed = await notesOf(remote).list();
          return ctx.ui.notify(placed.length ? placed.map(note => describe(note, ctx.cwd)).join('\n') : 'No notes', 'info');
        }
        if (arg === 'clear') {
          return ctx.ui.notify(await clearing(remote), 'info');
        }
        const which = parse(arg);
        if (which === undefined) return ctx.ui.notify(USAGE, 'warning');
        // Asked for by you: there, your focus too.
        ctx.ui.notify(await step(remote, which, { focus: true }), 'info');
      } catch (error) { ctx.ui.notify(errorText(error), 'warning'); }
    },
  });

  pi.registerCommand('nvim-annotate-remove', {
    description: "Remove Pi's notes in Neovim by numbers and ranges, in any order (2 5-7,10); all of them, with none",
    handler: async (args, ctx) => {
      const remote = nvim();
      if (!remote) return ctx.ui.notify('Pi is not attached to Neovim', 'warning');
      try {
        const said = await removing(remote, args);
        ctx.ui.notify(said ?? `Usage: /nvim-annotate-remove [${NUMBERS}; none for all]`, said ? 'info' : 'warning');
      } catch (error) { ctx.ui.notify(errorText(error), 'warning'); }
    },
  });

  // The agent told how its notes changed in the editor before it next thinks: as a run starts,
  // and between the turns of one, once each time.
  pi.on('before_agent_start', async () => {
    const text = await changes().catch(() => undefined);
    return text ? { message: { customType: CHANGED, content: text, display: true } } : undefined;
  });
  pi.on('turn_end', async event => {
    if (!event.toolResults.length) return undefined;
    const text = await changes().catch(() => undefined);
    return text ? { entries: [...event.entries, { type: 'custom_message', customType: CHANGED, content: text, display: true }] } : undefined;
  });
}
