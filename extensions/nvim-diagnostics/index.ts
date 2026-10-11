import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { useNvim } from '../nvim-service/api.mjs';
import { diagnose, status, SEVERITIES } from './core.mjs';

export default function (pi: ExtensionAPI) {
  const nvim = useNvim(pi);
  let last: { at: number; ms: number; text: string } | undefined;

  async function check(params: Parameters<typeof diagnose>[1], cwd: string, signal?: AbortSignal, trace = false) {
    const at = Date.now();
    const text = await diagnose(nvim(), params, cwd, signal, { trace });
    last = { at, ms: Date.now() - at, text };
    return text;
  }

  pi.registerTool({
    name: 'nvim_diagnostics',
    label: 'Neovim diagnostics',
    description: 'Check files with the language servers of your Neovim: errors and warnings for the current contents on disk, plus what each server did (answered, reported, silent, starting). Lines and byte columns are 1-based.',
    promptGuidelines: [
      'After editing code, batch the changed files into nvim_diagnostics. Trust a result only as far as its servers: "answered" is a definite reply for that text, "reported" means a server published and went quiet, and anything else is incomplete. No diagnostics does not replace a build or tests.',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      files: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 32, description: 'Paths, relative to cwd or absolute.' }),
      severity: Type.Optional(Type.Union(SEVERITIES.map(level => Type.Literal(level)), { description: 'Least severe level to list. Default warning; counts always include all levels.' })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60000, description: 'How long to wait for the servers. Default 10000.' })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        return { content: [{ type: 'text', text: await check(params, ctx.cwd, signal) }], details: {} };
      } catch (error) {
        // A prompt in the editor blocks every request; show it so it can be answered.
        const screen = (error as { screen?: string }).screen;
        throw screen ? new Error(`${(error as Error).message}\n${screen}`) : error;
      }
    },
  });

  pi.registerCommand('nvim-diagnostics', {
    description: 'Show the language servers and the last check; with file paths, check them and show a timeline',
    handler: async (args, ctx) => {
      const files = args.split(/\s+/).filter(Boolean);
      try {
        if (files.length) return ctx.ui.notify(await check({ files, severity: 'hint' }, ctx.cwd, undefined, true), 'info');
        const recent = last && `Last check ${Math.round((Date.now() - last.at) / 1000)} s ago, took ${last.ms} ms:\n${last.text}`;
        ctx.ui.notify(`${await status(nvim())}\n\n${recent ?? 'No check has run in this session.'}`, 'info');
      } catch (error) {
        ctx.ui.notify(`nvim-diagnostics: ${error instanceof Error ? error.message : String(error)}`, 'warning');
      }
    },
  });
}
