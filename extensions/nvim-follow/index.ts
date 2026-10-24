import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import { useRemote } from '../nvim-remote/api.ts';
import { FOLLOW, editRanges, editsOf, pathOf, writeRanges } from './core.ts';

const HIGHLIGHT_MS = 1500;
// Pi loads extensions afresh on /reload and for every session, in the same process; the
// setting outlives this module there, and ends with Pi.
const STATE = Symbol.for('pi.nvim-follow');
type State = { following: boolean };

export default function (pi: ExtensionAPI) {
  const state = ((globalThis as { [STATE]?: State })[STATE] ??= { following: false });
  let context: ExtensionContext | undefined;
  // Each file just before a change, by tool call: where the change landed is found from it.
  const before = new Map<string, string | undefined>();

  // Shown only while attached: without an editor nothing is being followed.
  const show = () => context?.ui.setStatus('nvim-follow', state.following && nvim() ? 'following' : undefined);
  const nvim = useRemote(pi, show);
  pi.events.on('nvim-remote:stopped', show);

  function set(on: boolean) {
    state.following = on;
    show();
    return on;
  }

  const changes = (name: string) => name === 'edit' || name === 'write';

  pi.on('session_start', (_event, ctx) => {
    context = ctx;
    show();
  });

  pi.on('session_shutdown', () => { before.clear(); });

  pi.on('tool_call', async (event, ctx) => {
    const path = pathOf(event.input, ctx.cwd);
    if (!state.following || !changes(event.toolName) || !path || !nvim()) return;
    before.set(event.toolCallId, await readFile(path, 'utf8').catch(() => undefined));
  });

  pi.on('tool_result', async (event, ctx) => {
    const old = before.get(event.toolCallId), had = before.has(event.toolCallId);
    before.delete(event.toolCallId);
    const path = pathOf(event.input, ctx.cwd);
    const remote = nvim();
    if (!state.following || event.isError || !changes(event.toolName) || !path || !remote) return;
    const after = await readFile(path, 'utf8').catch(() => undefined);
    if (after === undefined) return;
    const ranges = event.toolName === 'write'
      ? writeRanges(had ? old : undefined, after)
      : old === undefined ? [] : editRanges(old, after, editsOf(event.input));
    // Not awaited: Pi does not wait on the editor, and a busy one just misses a step.
    void remote.lua(FOLLOW, [path, ranges, HIGHLIGHT_MS], { timeout: 2000 }).catch(() => {});
  });

  pi.registerCommand('follow', {
    description: 'Toggle showing each file Pi changes in the Neovim it runs inside; "on" or "off" to choose',
    handler: async (args, ctx) => {
      context = ctx;
      const arg = args.trim();
      const on = set(arg === 'on' ? true : arg === 'off' ? false : !state.following);
      ctx.ui.notify(nvim()
        ? `Following ${on ? 'on' : 'off'}`
        : `Following ${on ? 'on' : 'off'}; Pi is not attached to Neovim, so there is nothing to follow yet`,
      nvim() ? 'info' : 'warning');
    },
  });
}
