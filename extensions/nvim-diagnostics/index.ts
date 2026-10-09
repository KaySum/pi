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
    description: 'Read disk diagnostics through Pi-owned Neovim. Default snapshot mode reads best-effort diagnostic caches, not a completed check. Explicit check mode requires named LSP clients and their own document-pull replies for verified input snapshots; missing or push-only providers cannot count as complete. Never saves files. Returns check/coverage states, request/service identity, provider evidence, and diagnostics. Lines/UTF-8 byte columns are 1-based; ends exclusive. Text capped at 16 KiB; larger reports go to a private file.',
    promptGuidelines: [
      'After editing, batch changed files into nvim_diagnostics. Use mode: check with requiredClients when the expected LSP client names are known; the same names are required for every file, so group batches accordingly. Inspect check status separately from diagnostic counts: complete means selected requests answered, not that the file passed. Snapshot emptiness, cached results, and push-only observations do not establish completion. Neither mode replaces tests, builds, or linters.',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      files: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
        minItems: 1, maxItems: 32,
        description: 'Explicit file paths relative to cwd or absolute. No glob expansion or reference/range syntax. UTF-8 text, at most 2 MiB each.',
      }),
      mode: Type.Optional(Type.Union([Type.Literal('snapshot'), Type.Literal('check')], {
        description: 'Default snapshot: best-effort cache observations, no completion claim. Check: require explicit clients and fresh owned full document-diagnostic replies, with final source verification.',
      })),
      requiredClients: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
        minItems: 1, maxItems: 16, uniqueItems: true,
        description: 'Required only in check mode; forbidden in snapshot mode. Exact case-sensitive LSP client names, e.g. pyright (not source Pyright). Every name applies to every file. Missing, initializing, or push-only clients remain incomplete at the deadline.',
      })),
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
