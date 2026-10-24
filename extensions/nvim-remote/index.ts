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
  let attaching: Promise<void> | undefined;
  let context: ExtensionContext | undefined;
  let lastError: string | undefined;

  const showStatus = () => context?.ui.setStatus('nvim-remote', handle ? 'nvim' : undefined);

  function unpublish() {
    const previous = handle;
    handle = undefined;
    if (!previous) return;
    showStatus();
    pi.events.emit('nvim-remote:stopped', previous.info);
    return previous;
  }

  async function connect(cwd: string) {
    try {
      const remote: Remote = Object.assign(await attach(socket!, { cwd }), { apiVersion: 1 as const });
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

  pi.on('session_start', (_event, ctx) => {
    context = ctx;
    attaching ??= connect(ctx.cwd);
    showStatus(); // A /new or session switch keeps the connection.
  });

  pi.on('session_shutdown', async () => {
    await attaching;
    await disconnect();
    context = undefined;
  });

  pi.registerCommand('nvim-remote', {
    description: 'Show the Neovim this Pi controls; "reconnect" attaches again',
    handler: async (args, ctx) => {
      context = ctx;
      if (args.trim() === 'reconnect') {
        await attaching;
        await disconnect();
        attaching = connect(ctx.cwd);
      }
      await attaching;
      ctx.ui.notify(handle
        ? `Neovim PID ${handle.info.pid}\nSocket: ${handle.info.socket}\nChannel: ${handle.channel}\nTerminal buffer: ${handle.info.terminal ?? 'not found'}`
        : `Not attached to Neovim${lastError ? `: ${lastError}` : ''}. Run /nvim-remote reconnect.`,
      handle ? 'info' : 'warning');
    },
  });
}
