import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { relative } from 'node:path';
import { useRemote, type Remote } from '../nvim-remote/api.ts';
import { errorText, perAttachment, useCwd, withKit } from '../nvim-remote-kit/api.ts';
import { Notes, type Kind, type NoteSpec, type Placed } from './notes.ts';

// :PiNotes in Neovim, its arguments sent to Pi; gone with the attachment.
const COMMAND = `vim.api.nvim_create_user_command('PiNotes', function(o) remote.notify('nvim-annotate:step', o.args) end, {
  nargs = '*', desc = "Go to Pi's notes: next, prev, a number; or remove some",
  complete = function() return { 'next', 'prev', 'remove' } end,
})
remote.on_detach(function() pcall(vim.api.nvim_del_user_command, 'PiNotes') end)`;
// A note whose code a reload took since it was placed or changed.
const GONE = 'gone: its code is no longer in the file';
const USAGE = 'Usage: /nvim-annotate [next | prev | <number> | remove <numbers> | clear]';
const PINOTES = 'Usage: :PiNotes [next | prev | <number> | remove <numbers>]';
// remove (or delete) and the note numbers after it.
const REMOVE = /^(?:remove|delete)\b(.*)$/s;

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

const where = (note: Placed, cwd: string) =>
  `${relative(cwd, note.path).startsWith('..') ? note.path : relative(cwd, note.path)}:${note.line === note.endLine ? note.line : `${note.line}-${note.endLine}`}`;
// The code it is on, so that a match that found other code than meant shows.
const code = (note: Placed) => {
  const line = note.code.trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
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
    const result = await notesOf(remote).show(which, cwd(), options);
    if (!result) return typeof which === 'number' ? `No note ${which}` : `No ${which === 'next' ? 'next' : 'previous'} note`;
    if (!result.pointed.shown) return 'busy' in result.pointed ? `Not now: you are busy in Neovim (mode ${result.pointed.busy})` : 'Not shown';
    return `Note ${result.note.number} of ${result.total}: ${where(result.note, cwd())}`;
  }
  const parse = (arg: string) => arg === 'next' || arg === 'prev' ? arg : /^[1-9]\d*$/.test(arg) ? Number(arg) : undefined;
  // Remove the notes `spans` take in (of those there: a range is never counted out), saying how it went.
  async function remove(remote: Remote, spans: [number, number][]) {
    const notes = notesOf(remote);
    const within = (n: number, [first, last]: [number, number]) => n >= first && n <= last;
    const there = (await notes.list()).map(note => note.number).filter(n => spans.some(span => within(n, span)));
    const removed = there.length ? await notes.remove(there) : [];
    const missing = spans.filter(span => !removed.some(n => within(n, span)))
      .map(([first, last]) => first === last ? String(first) : `${first}-${last}`);
    return removal(removed, missing, notes.size > 0);
  }

  const nvim = useRemote(pi, remote => {
    void remote.lua(COMMAND).catch(() => {});
    remote.on('nvim-annotate:step', async (arg: string) => {
      const asked = REMOVE.exec(arg.trim()), spans = asked && ranges(asked[1]);
      const which = parse(arg.trim() || 'next');
      const said = asked ? (spans ? await remove(remote, spans).catch(errorText) : PINOTES)
        : which === undefined ? PINOTES : await step(remote, which).catch(errorText);
      // Fitted to where messages go: a longer one would stop the editor at "Press ENTER".
      await withKit(remote, 'kit.say(...)', [said]).catch(() => {});
    });
  });

  pi.registerTool({
    name: 'nvim_annotate',
    label: 'Neovim notes',
    promptSnippet: 'Explain code with notes in the user\'s Neovim, and walk them through it',
    description: 'Put notes on code in the Neovim Pi runs inside, where the user reads it: above the lines, numbered in the order added, anchored to the code so they move with edits. add places notes on code by match (the code itself, which is better than a line number) or a line; list says where they are now and the code they are on, to check the right code was found; show takes the user to note N; update changes the text or kind of one, and remove removes one or several, the others keeping their numbers; clear removes them all. The user steps through them with :PiNotes next and :PiNotes prev.',
    promptGuidelines: [
      'Use nvim_annotate to explain code where the user reads it, rather than quoting it in chat: for a walkthrough, add the notes in the order to read them with show: true, which takes the user to the first. Keep each note to a sentence or two about that code. Give a kind only for what it means: warn for a real risk, error for a bug, never for emphasis. Anchor notes by match, a distinctive line of the code. For a new explanation add with replace: true, which swaps the old notes for the new; clear notes once they no longer apply.',
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
            const added = await notes.add(params.notes, ctx.cwd, { replace: params.replace });
            // Read again, where they are now: one whose code a reload took meanwhile is gone.
            const placed = await notes.list();
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
            if (!await notes.update(number, { text: params.text, kind: params.kind })) return `No note ${number}`;
            const note = (await notes.list()).find(note => note.number === number);
            return note ? `Updated:\n${describe(note, ctx.cwd)}` : `Note ${number} is ${GONE}`;
          }
          case 'remove': {
            if (params.note === undefined) throw new Error('remove needs a note number');
            const asked = [...new Set([params.note].flat())];
            const removed = await notes.remove(asked), missing = asked.filter(number => !removed.includes(number));
            return removal(removed, missing.map(String), notes.size > 0);
          }
          case 'clear': {
            const count = await notes.clear();
            return `Removed ${count} ${count === 1 ? 'note' : 'notes'}`;
          }
        }
      })();
      return { content: [{ type: 'text', text }], details: {} };
    },
  });

  pi.registerCommand('nvim-annotate', {
    description: "Show Pi's notes in Neovim, go to one (next, prev, a number), remove some (remove 2 5-7), or clear them",
    getArgumentCompletions: prefix => ['next', 'prev', 'remove', 'clear'].filter(word => word.startsWith(prefix.trim())).map(word => ({ value: word, label: word })),
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
          const count = await notesOf(remote).clear();
          return ctx.ui.notify(`Removed ${count} ${count === 1 ? 'note' : 'notes'}`, 'info');
        }
        const asked = REMOVE.exec(arg);
        if (asked) {
          const spans = ranges(asked[1]);
          return ctx.ui.notify(spans ? await remove(remote, spans) : USAGE, spans ? 'info' : 'warning');
        }
        const which = parse(arg);
        if (which === undefined) return ctx.ui.notify(USAGE, 'warning');
        // Asked for by you: there, your focus too.
        ctx.ui.notify(await step(remote, which, { focus: true }), 'info');
      } catch (error) { ctx.ui.notify(errorText(error), 'warning'); }
    },
  });
}
