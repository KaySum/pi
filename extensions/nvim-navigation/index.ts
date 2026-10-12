import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { useNvim } from '../nvim-service/api.mjs';
import { navigate, ACTIONS } from './core.mjs';

export default function (pi: ExtensionAPI) {
  const nvim = useNvim(pi);

  pi.registerTool({
    name: 'nvim_navigate',
    label: 'Neovim navigation',
    promptSnippet: 'Find definitions, references, types and symbols through language servers',
    description: 'Ask the language servers of your Neovim about code: where a symbol is defined (definition, type, implementation, declaration), everywhere it is used (references), its type and documentation (hover), a file\'s outline (symbols), or symbols across the project by name (workspace_symbols). Point at a symbol with its line and its text on that line. Results are path, line:column and the source line.',
    promptGuidelines: [
      'Use nvim_navigate to follow code by meaning instead of text search: definition before reading an unfamiliar function, references before changing a signature, hover for an inferred type. An empty result from a server that answered is real; one marked as still loading is not, so ask again.',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      action: Type.Union(ACTIONS.map(action => Type.Literal(action))),
      file: Type.String({ minLength: 1, maxLength: 4096, description: 'The file the symbol is in; for symbols, the file to outline; for workspace_symbols, any file of the project.' }),
      line: Type.Optional(Type.Integer({ minimum: 1, description: '1-based line of the symbol. Not for symbols or workspace_symbols.' })),
      symbol: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: 'The symbol as written on that line; its first occurrence is used.' })),
      column: Type.Optional(Type.Integer({ minimum: 1, description: '1-based byte column, instead of symbol or to pick a later occurrence of it.' })),
      query: Type.Optional(Type.String({ maxLength: 256, description: 'Name to search for (workspace_symbols) or to filter by (symbols).' })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 60000, description: 'Default 10000.' })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        return { content: [{ type: 'text', text: await navigate(nvim(), params, ctx.cwd, signal) }], details: {} };
      } catch (error) {
        // A prompt in the editor blocks every request; show it so it can be answered.
        const screen = (error as { screen?: string }).screen;
        throw screen ? new Error(`${(error as Error).message}\n${screen}`) : error;
      }
    },
  });
}
