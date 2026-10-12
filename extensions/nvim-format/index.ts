import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { useNvim } from '../nvim-service/api.mjs';
import { format } from './core.mjs';

export default function (pi: ExtensionAPI) {
  const nvim = useNvim(pi);
  let last: { at: number; ms: number; text: string } | undefined;

  async function run(params: Parameters<typeof format>[1], cwd: string, signal?: AbortSignal) {
    const at = Date.now();
    const text = await format(nvim(), params, cwd, signal);
    last = { at, ms: Date.now() - at, text };
    return text;
  }

  pi.registerTool({
    name: 'nvim_format',
    label: 'Neovim format',
    promptSnippet: 'Format files with the formatters configured in Neovim',
    description: 'Format files on disk with the formatters your Neovim is configured with for each file type (conform.nvim, else language servers) and write the result. Reports per file what ran and which lines changed.',
    promptGuidelines: [
      'When you have finished editing code, batch the files you changed into nvim_format instead of running a formatter by hand; do it before nvim_diagnostics. It rewrites the files: where lines are reported as changed, read them again before editing there. If it reformats far more than you touched, the project does not keep that file formatted; say so rather than leaving the noise unmentioned.',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      files: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 32, description: 'Paths, relative to cwd or absolute.' }),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60000, description: 'How long all the files together may take. Default 10000.' })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        return { content: [{ type: 'text', text: await run(params, ctx.cwd, signal) }], details: {} };
      } catch (error) {
        // A prompt in the editor blocks every request; show it so it can be answered.
        const screen = (error as { screen?: string }).screen;
        throw screen ? new Error(`${(error as Error).message}\n${screen}`) : error;
      }
    },
  });

  pi.registerCommand('nvim-format', {
    description: 'Show what the last formatting did; with file paths, format them',
    handler: async (args, ctx) => {
      const files = args.split(/\s+/).filter(Boolean);
      try {
        if (files.length) return ctx.ui.notify(await run({ files }, ctx.cwd), 'info');
        ctx.ui.notify(last ? `Last formatting ${Math.round((Date.now() - last.at) / 1000)} s ago, took ${last.ms} ms:\n${last.text}` : 'Nothing has been formatted in this session.', 'info');
      } catch (error) {
        ctx.ui.notify(`nvim-format: ${error instanceof Error ? error.message : String(error)}`, 'warning');
      }
    },
  });
}
