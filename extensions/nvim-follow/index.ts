import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import { useRemote } from '../nvim-remote/api.ts';
import { FOLLOW, editChanges, editsOf, pathOf, readRanges, writeChanges, type Changes } from './core.ts';

const HIGHLIGHT_MS = 1500;
// Pi loads extensions afresh on /reload and for every session, in the same process; the
// setting outlives this module there, and ends with Pi.
const STATE = Symbol.for('pi.nvim-follow');
type Mode = 'on' | 'all' | 'off';
/** `last` is the mode `/follow` alone turns back on. */
type State = { mode: Mode; last: Exclude<Mode, 'off'> };

const MODES: { value: Mode; description: string; now: string; status?: string }[] = [
  { value: 'on', description: 'Follow what Pi edits and writes', now: 'Following edits', status: 'following edits' },
  { value: 'all', description: 'Follow what Pi edits, writes and reads', now: 'Following edits and reads', status: 'following all' },
  { value: 'off', description: 'Stop following', now: 'Following off' },
];
const USAGE = 'Usage: /follow [on|all|off]';
const modeOf = (mode: Mode) => MODES.find(m => m.value === mode)!;

export default function (pi: ExtensionAPI) {
  const state = ((globalThis as { [STATE]?: State })[STATE] ??= { mode: 'off', last: 'on' });
  let context: ExtensionContext | undefined;
  // Each file just before a change, by tool call: where the change landed is found from it.
  const before = new Map<string, string | undefined>();

  // Shown only while attached: without an editor nothing is being followed.
  const show = () => context?.ui.setStatus('nvim-follow', nvim() ? modeOf(state.mode).status : undefined);
  const nvim = useRemote(pi, show);
  pi.events.on('nvim-remote:stopped', show);

  const changes = (name: string) => name === 'edit' || name === 'write';

  pi.on('session_start', (_event, ctx) => {
    context = ctx;
    show();
  });

  pi.on('session_shutdown', () => { before.clear(); });

  pi.on('tool_call', async (event, ctx) => {
    const path = pathOf(event.input, ctx.cwd);
    if (state.mode === 'off' || !changes(event.toolName) || !path || !nvim()) return;
    before.set(event.toolCallId, await readFile(path, 'utf8').catch(() => undefined));
  });

  pi.on('tool_result', async (event, ctx) => {
    const old = before.get(event.toolCallId), had = before.has(event.toolCallId);
    before.delete(event.toolCallId);
    const path = pathOf(event.input, ctx.cwd);
    const remote = nvim();
    if (state.mode === 'off' || event.isError || !path || !remote) return;
    // Not awaited: Pi does not wait on the editor, and a busy one just misses a step.
    const follow = ({ ranges, cursor }: Changes, group: string) =>
      void remote.lua(FOLLOW, [path, ranges, HIGHLIGHT_MS, group, cursor ?? null], { timeout: 2000 }).catch(() => {});
    if (event.toolName === 'read') {
      // An image read is not for an editor.
      if (state.mode === 'all' && !event.content.some(block => block.type === 'image')) follow({ ranges: readRanges(event.input) }, 'PiFollowRead');
      return;
    }
    if (!changes(event.toolName)) return;
    const after = await readFile(path, 'utf8').catch(() => undefined);
    if (after === undefined) return;
    const changed = event.toolName === 'write'
      ? writeChanges(had ? old : undefined, after)
      : old === undefined ? { ranges: [] } : editChanges(old, after, editsOf(event.input));
    follow(changed, 'PiFollow');
  });

  pi.registerCommand('follow', {
    description: 'Show what Pi changes in the Neovim it runs inside: on (edits), all (edits and reads) or off; alone, toggles',
    getArgumentCompletions: prefix => {
      const items = MODES.filter(m => m.value.startsWith(prefix.trim())).map(({ value, description }) => ({ value, label: value, description }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      context = ctx;
      const arg = args.trim();
      const mode = arg ? MODES.find(m => m.value === arg)?.value : state.mode === 'off' ? state.last : 'off';
      if (!mode) return ctx.ui.notify(USAGE, 'warning');
      state.mode = mode;
      if (mode !== 'off') state.last = mode;
      show();
      const { now } = modeOf(mode);
      ctx.ui.notify(nvim() ? now : `${now}; Pi is not attached to Neovim, so there is nothing to follow yet`, nvim() ? 'info' : 'warning');
    },
  });
}
