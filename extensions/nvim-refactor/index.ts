import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { useNvim } from '../nvim-service/api.mjs';
import { refactor, parse, ACTIONS } from './core.mjs';

export default function (pi: ExtensionAPI) {
  const nvim = useNvim(pi);
  let last: { at: number; ms: number; request: string; text: string } | undefined;

  async function run(params: Parameters<typeof refactor>[1], cwd: string, signal?: AbortSignal) {
    const at = Date.now();
    const text = await refactor(nvim(), params, cwd, signal);
    last = { at, ms: Date.now() - at, request: JSON.stringify(params), text };
    return text;
  }

  pi.registerTool({
    name: 'nvim_refactor',
    label: 'Neovim refactor',
    promptSnippet: 'Rename symbols and apply code actions through language servers',
    description: 'Have the language servers of your Neovim change code and write the result: rename a symbol everywhere it is used (rename), list the fixes and refactorings offered for a place (actions), or carry one out (apply). Point at a symbol with its line and its text on that line. Reports the files and lines that changed.',
    promptGuidelines: [
      'Use nvim_refactor rename instead of editing each use of a symbol by hand: the server knows which uses are that symbol. Point at its definition where you can. A rename that succeeds may still be partial: the server decides which files it covers and does not say when it has left some out, so check that the files you expect are among those changed, and search for the old name if any is missing. To fix a diagnostic, run nvim_diagnostics first, then actions on its line and apply one by its title; without a line, actions covers the whole file, and kind source.organizeImports or source.fixAll names a file-wide one. These rewrite files: where lines are reported as changed, read them again before editing there, and run nvim_diagnostics on them when you are done.',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      action: Type.Union(ACTIONS.map(action => Type.Literal(action))),
      file: Type.String({ minLength: 1, maxLength: 4096, description: 'The file the symbol or place is in, relative to cwd or absolute.' }),
      line: Type.Optional(Type.Integer({ minimum: 1, description: '1-based line. Needed for rename; for actions and apply, leaving it out means the whole file.' })),
      symbol: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: 'The symbol as written on that line; its first occurrence is used. For actions and apply it may be any text on the line, such as an expression to extract.' })),
      column: Type.Optional(Type.Integer({ minimum: 1, description: '1-based byte column, instead of symbol or to pick a later occurrence of it.' })),
      endLine: Type.Optional(Type.Integer({ minimum: 1, description: 'For actions and apply: the last line of a range of whole lines starting at line.' })),
      newName: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: 'For rename: the new name.' })),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 512, description: 'For apply: the title of the action as actions listed it, or a part of it that only one has.' })),
      kind: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: 'For actions and apply: only actions of this kind, e.g. quickfix, refactor.extract, source.organizeImports.' })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60000, description: 'Default 10000.' })),
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

  pi.registerCommand('nvim-refactor', {
    description: 'Show what the last refactoring did; or do one, e.g. "rename src/a.ts 3 greet welcome", "actions src/a.ts 3"',
    handler: async (args, ctx) => {
      try {
        if (args.trim()) return ctx.ui.notify(await run(parse(args), ctx.cwd), 'info');
        ctx.ui.notify(last ? `Last request ${Math.round((Date.now() - last.at) / 1000)} s ago, took ${last.ms} ms: ${last.request}\n${last.text}` : 'Nothing has been refactored in this session.', 'info');
      } catch (error) {
        const usage = 'Usage: /nvim-refactor rename <file> <line> <symbol> <newName> | actions <file> [line] | apply <file> [line] <title>';
        ctx.ui.notify(`nvim-refactor: ${error instanceof Error ? error.message : String(error)}\n${usage}`, 'warning');
      }
    },
  });
}
