import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { DiagnosticsClient, formatReport } from './core.mjs';

type ServiceInfo = { socket: string; pid: number };
function serviceInfo(value: unknown): ServiceInfo | undefined {
  if (!value || typeof value !== 'object' || !('socket' in value) || !('pid' in value)) return;
  if (typeof value.socket !== 'string' || !value.socket.startsWith('/') ||
      typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid < 1) return;
  return { socket: value.socket, pid: value.pid };
}

export default function (pi: ExtensionAPI) {
  // Registration is inert: no sockets, timers, processes, or filesystem reads.
  const client = new DiagnosticsClient();
  const accept = (value: unknown) => client.setService(serviceInfo(value));
  const discover = () => pi.events.emit('nvim-service:get', { reply: accept });
  pi.events.on('nvim-service:ready', accept);
  pi.events.on('nvim-service:stopped', value => {
    const stopped = serviceInfo(value);
    if (stopped?.socket === client.service?.socket && stopped?.pid === client.service?.pid) client.setService(undefined);
  });
  pi.on('session_start', discover); // Never wait for a later session_start handler.
  pi.on('session_shutdown', () => client.close());

  pi.registerTool({
    name: 'nvim_diagnostics',
    label: 'Neovim diagnostics',
    description: 'Check disk files using Pi-owned Neovim diagnostics. Loads/refreshes unmodified buffers; never saves files. Returns errors, warnings, info, and hints with coverage/freshness status. Lines/UTF-8 byte columns are 1-based; range ends exclusive. Output capped at 16 KiB; larger reports go to a private file.',
    promptGuidelines: [
      'After editing, batch changed files into nvim_diagnostics. Check coverage/status: empty or cached results do not prove correctness and do not replace tests, builds, or linters. Retry timed-out startup checks when useful.',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      files: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
        minItems: 1, maxItems: 32,
        description: 'Explicit file paths relative to cwd or absolute. No glob expansion or reference/range syntax. UTF-8 text, at most 2 MiB each.',
      }),
      severities: Type.Optional(Type.Array(Type.Union([
        Type.Literal('error'), Type.Literal('warning'), Type.Literal('info'), Type.Literal('hint'),
      ]), { minItems: 1, maxItems: 4, uniqueItems: true, description: 'Default: all severities. Counts include unfiltered diagnostics.' })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 30000, description: 'Total deadline including queue time. Default 10000 ms.' })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      discover();
      const report = await client.diagnose(params, ctx.cwd, signal);
      signal?.throwIfAborted();
      const result = await formatReport(report);
      return { content: [{ type: 'text', text: result.text }], details: result.details };
    },
  });
}
