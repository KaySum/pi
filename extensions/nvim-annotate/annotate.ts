import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { relative } from 'node:path';
import { useRemote, type Remote } from '../nvim-remote/api.ts';
import { Notes, type NoteSpec, type Placed } from './notes.ts';

// :PiNotes in Neovim, its argument sent to Pi; gone with the attachment.
const COMMAND = `vim.api.nvim_create_user_command('PiNotes', function(o) remote.notify('nvim-annotate:step', o.args) end, {
  nargs = '?', desc = "Go to Pi's notes: next, prev, or a number",
  complete = function() return { 'next', 'prev' } end,
})
remote.on_detach(function() pcall(vim.api.nvim_del_user_command, 'PiNotes') end)`;
// One line, kept short where messages go: a longer one would stop the editor at "Press ENTER".
const SAY = `vim.api.nvim_echo({ { vim.fn.strcharpart(..., 0, math.max(vim.v.echospace, 1)) } }, false, {})`;
const USAGE = 'Usage: /nvim-annotate [next | prev | <number> | clear]';

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0].replace(/^Lua: /, '');
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
  const all = new WeakMap<Remote, Notes>();
  const notesOf = (remote: Remote) => {
    if (!all.has(remote)) all.set(remote, new Notes(remote));
    return all.get(remote)!;
  };
  // Pi's working directory, which notes' files are from.
  let cwd = process.cwd();
  pi.on('session_start', (_event, ctx) => { cwd = ctx.cwd; });

  // Step to `which`, saying how it went.
  async function step(remote: Remote, which: number | 'next' | 'prev', options: { focus?: boolean } = {}) {
    const result = await notesOf(remote).show(which, cwd, options);
    if (!result) return typeof which === 'number' ? `No note ${which}` : `No ${which === 'next' ? 'next' : 'previous'} note`;
    if (!result.pointed.shown) return 'busy' in result.pointed ? `Not now: you are busy in Neovim (mode ${result.pointed.busy})` : 'Not shown';
    return `Note ${result.note.number} of ${result.total}: ${where(result.note, cwd)}`;
  }
  const parse = (arg: string) => arg === 'next' || arg === 'prev' ? arg : /^[1-9]\d*$/.test(arg) ? Number(arg) : undefined;

  const nvim = useRemote(pi, remote => {
    void remote.lua(COMMAND).catch(() => {});
    remote.on('nvim-annotate:step', async (arg: string) => {
      const which = parse(arg.trim() || 'next');
      const said = which === undefined ? "Usage: :PiNotes [next | prev | <number>]" : await step(remote, which).catch(errorText);
      await remote.lua(SAY, [said]).catch(() => {});
    });
  });

  pi.registerTool({
    name: 'nvim_annotate',
    label: 'Neovim notes',
    promptSnippet: 'Explain code with notes in the user\'s Neovim, and walk them through it',
    description: 'Put notes on code in the Neovim Pi runs inside, where the user reads it: above the lines, numbered in the order added, anchored to the code so they move with edits. add places notes on code by match (the code itself, which is better than a line number) or a line; list says where they are now and the code they are on, to check the right code was found; show takes the user to note N; clear removes them all. The user steps through them with :PiNotes next and :PiNotes prev.',
    promptGuidelines: [
      'Use nvim_annotate to explain code where the user reads it, rather than quoting it in chat: for a walkthrough, add the notes in the order to read them, then show note 1. Keep each note to a sentence or two about that code. Anchor notes by match, a distinctive line of the code. Clear notes once they no longer apply.',
    ],
    executionMode: 'sequential',
    parameters,
    async execute(_id, raw, _signal, _onUpdate, ctx) {
      const params = raw as { action: 'add' | 'list' | 'show' | 'clear'; notes?: NoteSpec[]; note?: number };
      const remote = nvim();
      if (!remote) throw new Error('Pi is not attached to Neovim');
      const notes = notesOf(remote);
      const text = await (async () => {
        switch (params.action) {
          case 'add': {
            if (!params.notes?.length) throw new Error('add needs notes');
            const bad = params.notes.find(note => note.match === undefined && note.line === undefined);
            if (bad) throw new Error(`A note needs a match or a line: ${bad.text}`);
            const added = await notes.add(params.notes, ctx.cwd);
            const placed = (await notes.list()).filter(note => added.some(a => a.number === note.number));
            return `Added ${placed.length === 1 ? 'note' : 'notes'} ${added[0].number}${added.length > 1 ? `-${added.at(-1)!.number}` : ''}:\n${placed.map(note => describe(note, ctx.cwd)).join('\n')}`;
          }
          case 'list': {
            const placed = await notes.list();
            return placed.length ? placed.map(note => describe(note, ctx.cwd)).join('\n') : 'No notes';
          }
          case 'show':
            if (params.note === undefined) throw new Error('show needs a note number');
            return step(remote, params.note);
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
          const count = await notesOf(remote).clear();
          return ctx.ui.notify(`Removed ${count} ${count === 1 ? 'note' : 'notes'}`, 'info');
        }
        const which = parse(arg);
        if (which === undefined) return ctx.ui.notify(USAGE, 'warning');
        // Asked for by you: there, your focus too.
        ctx.ui.notify(await step(remote, which, { focus: true }), 'info');
      } catch (error) { ctx.ui.notify(errorText(error), 'warning'); }
    },
  });
}
