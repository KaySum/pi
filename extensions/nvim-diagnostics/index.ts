import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { DiagnosticsClient, formatReport } from './core.mjs';

import { bindDiscovery } from '../nvim-service/discovery.mjs';

export default function (pi: ExtensionAPI) {
  // Registration is inert: no sockets, timers, processes, or filesystem reads.
  const client = new DiagnosticsClient();
  const discover = bindDiscovery(pi, client);

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
