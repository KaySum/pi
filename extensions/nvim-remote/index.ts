import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Remote } from './api.ts';
import { attach } from './remote.ts';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function (pi: ExtensionAPI) {
  // Neovim sets $NVIM to its socket in every terminal it starts; outside one, do nothing.
  const socket = process.env.NVIM;
  if (!socket) return;
  // Processes this Pi starts inherit $NVIM too; a Pi among them is not in the editor's terminal.
  // The marker names the process, so /reload still attaches, and the socket, so a Pi in a
  // Neovim started from here still does.
  const self = `${process.pid}:${socket}`, owner = process.env.PI_NVIM_REMOTE;
  if (owner && owner !== self && owner.endsWith(`:${socket}`)) return;
  process.env.PI_NVIM_REMOTE = self;

  let handle: Remote | undefined;
  let context: ExtensionContext | undefined;
  let lastError: string | undefined;
  let ended = false;
  // Connecting and disconnecting run one at a time, in the order asked: overlapping, two
  // reconnects would leave an attachment nobody tracks, and a reconnect could outlive shutdown.
  let lifecycle: Promise<void> = Promise.resolve();
  function queue(work: () => Promise<void>) {
    const run = lifecycle.then(work);
    lifecycle = run.catch(() => {});
    return run;
  }

  const showStatus = () => context?.ui.setStatus('nvim-remote', handle ? 'nvim' : undefined);

  function unpublish() {
    const previous = handle;
    handle = undefined;
    if (!previous) return;
    showStatus();
    pi.events.emit('nvim-remote:stopped', previous.info);
    return previous;
  }

  // An extension's handler failing is its bug: say so, where it can be seen, and carry on.
  function reportHandlerError(error: unknown, source: string) {
    pi.events.emit('nvim-remote:error', { error, source });
    if (context?.hasUI) context.ui.notify(`nvim-remote: a handler for ${source} failed: ${errorText(error)}`, 'warning');
  }

  async function connect(cwd: string) {
    if (ended) return; // Asked for before shutdown, reached after it.
    try {
      const remote: Remote = Object.assign(await attach(socket!, { cwd, onError: reportHandlerError }), { apiVersion: 1 as const });
      handle = remote;
      lastError = undefined;
      remote.onClose(() => {
        if (handle !== remote) return; // Closed on purpose.
        lastError = 'Neovim closed the connection';
        unpublish();
      });
      showStatus();
      pi.events.emit('nvim-remote:ready', remote);
    } catch (error) {
      lastError = errorText(error);
      if (context?.hasUI) context.ui.notify(`nvim-remote: ${lastError}`, 'warning');
    }
  }

  async function disconnect() {
    const errors = await unpublish()?.close() ?? [];
    if (errors.length && context?.hasUI) context.ui.notify(`nvim-remote: cleanup failed in Neovim:\n${errors.join('\n')}`, 'warning');
  }

  pi.events.on('nvim-remote:get', request => {
    (request as { reply?: (handle?: Remote) => void })?.reply?.(handle);
  });

  // Pi loads extensions afresh for every session (/new, /resume and /fork as well as
  // /reload), so this instance sees one start and one shutdown.
  pi.on('session_start', (_event, ctx) => {
    context = ctx;
    // Not awaited: Pi's startup should not wait for the editor.
    void queue(() => connect(ctx.cwd));
  });

  pi.on('session_shutdown', async () => {
    ended = true;
    await queue(disconnect);
    context = undefined;
  });

  pi.registerCommand('nvim-remote', {
    description: 'Show the Neovim this Pi controls; "reconnect" attaches again',
    handler: async (args, ctx) => {
      context = ctx;
      if (args.trim() === 'reconnect') await queue(async () => { await disconnect(); await connect(ctx.cwd); });
      else await lifecycle;
      ctx.ui.notify(handle
        ? `Neovim PID ${handle.info.pid}\nSocket: ${handle.info.socket}\nChannel: ${handle.channel}\nTerminal buffer: ${handle.info.terminal ?? 'not found'}`
        : `Not attached to Neovim${lastError ? `: ${lastError}` : ''}. Run /nvim-remote reconnect.`,
      handle ? 'info' : 'warning');
    },
  });
}
