import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readReferences } from './core.mjs';

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'read_reference',
    label: 'Read file references',
    description: 'Read disk files/ranges, not unsaved buffers. Lines/byte columns are 1-based and inclusive; cursors return full-line context. Batch overlaps merge. Output: ~4096 estimated tokens.',
    promptGuidelines: [
      'Use read_reference for needed @ references. Batch related ranges; reuse available content unless freshness matters. Clarify ambiguous paths; do not read references quoted as examples.',
    ],
    parameters: Type.Object({
      references: Type.Array(Type.String({ minLength: 2, maxLength: 4096 }), {
        minItems: 1,
        maxItems: 32,
        description: 'Exact @path, @path :L5-L9, @path :L3:C2-L7:C4, or cursor @path :L5:C2. Spaces allowed in paths; last " :L" starts range. No prose.',
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await readReferences(params.references, ctx.cwd, signal);
      return { content: [{ type: 'text', text: result.text }], details: result.details };
    },
  });
}
