import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { launchNvimService } from './service.mjs';

type Service = ReturnType<typeof launchNvimService>;
type ServiceInfo = Awaited<Service['ready']>;

export default function (pi: ExtensionAPI) {
  let service: Service | undefined;
  let info: ServiceInfo | undefined;
  let context: ExtensionContext | undefined;
  let lastError: string | undefined;

  function warn(message: string) {
    if (context?.hasUI) context.ui.notify(message, 'warning');
    else console.error(message);
  }

  function unpublish() {
    if (!info) return;
    const previous = info;
    info = undefined;
    if (process.env.PI_NVIM_SOCKET === previous.socket) delete process.env.PI_NVIM_SOCKET;
    pi.events.emit('nvim-service:stopped', previous);
  }

  // Query current readiness without depending on extension load order. Clients
  // should also subscribe to :ready/:stopped; this callback never starts a process.
  pi.events.on('nvim-service:get', request => {
    if (request && typeof request === 'object' && 'reply' in request && typeof request.reply === 'function') {
      request.reply(info);
    }
  });

  pi.on('session_start', async (_event, ctx) => {
    context = ctx;
    if (service) return; // /new and session switches may emit session_start again.
    lastError = undefined;
    // Nested Pi must not advertise its parent's socket as its own service.
    delete process.env.PI_NVIM_SOCKET;
    let current: Service | undefined;
    try {
      current = launchNvimService({ cwd: ctx.cwd });
      service = current;
      void current.exited.then(result => {
        if (service !== current || !info) return;
        service = undefined;
        unpublish();
        lastError = result.error?.message ?? 'Neovim service exited unexpectedly';
        warn(`nvim-service: ${lastError}. Run /reload to start a new instance.`);
      });
      const ready = await current.ready;
      if (service !== current) return; // Shutdown can race startup.
      info = ready;
      process.env.PI_NVIM_SOCKET = ready.socket;
      pi.events.emit('nvim-service:ready', ready);
    } catch (error) {
      if (current && service !== current) return; // An intentional shutdown/reload won the race.
      service = undefined;
      unpublish();
      lastError = error instanceof Error ? error.message : String(error);
      warn(`nvim-service: ${lastError}`);
      await current?.stop().catch((error: unknown) => {
        warn(`nvim-service cleanup: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  });

  pi.on('session_shutdown', async () => {
    const current = service;
    service = undefined;
    unpublish();
    try { await current?.stop(); }
    finally { context = undefined; }
  });

  pi.registerCommand('nvim-service', {
    description: 'Show Pi-owned Neovim status and RPC socket',
    handler: async (_args, ctx) => {
      ctx.ui.notify(info
        ? `Neovim PID ${info.pid}\nSupervisor PID ${info.supervisorPid}\nSocket: ${info.socket}\nWorking directory: ${info.cwd}`
        : `Neovim service is not running${lastError ? `: ${lastError}` : ''}. Run /reload to retry.`,
      info ? 'info' : 'warning');
    },
  });
}
