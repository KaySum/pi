import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import register from './annotate.ts';
import { KINDS } from './notes.ts';

const KIND = 'What the note is, which sets its color: info (default) explains; hint is a suggestion or aside; warn, a risk or something easy to get wrong; error, a bug. Not for emphasis: most notes are info.';
// The tool's schema, apart from the rest: its package is Pi's, which the tests run without.
const PARAMETERS = Type.Object({
  action: Type.Union(['add', 'list', 'show', 'update', 'remove', 'clear'].map(action => Type.Literal(action))),
  notes: Type.Optional(Type.Array(Type.Object({
    file: Type.String({ minLength: 1, maxLength: 4096, description: 'The file, from the working directory or absolute.' }),
    match: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: 'The code the note is on: lines of it, the space around them aside. Preferred to line.' })),
    line: Type.Optional(Type.Integer({ minimum: 1, description: 'The line the note is on; with match, the occurrence nearest it.' })),
    text: Type.String({ minLength: 1, maxLength: 2000, description: 'The note, drawn above the lines, wrapped to the window.' }),
    kind: Type.Optional(Type.Union(KINDS.map(k => Type.Literal(k)), { description: KIND })),
  }), { minItems: 1, maxItems: 50, description: 'For add: the notes, in the order to read them.' })),
  note: Type.Optional(Type.Union([
    Type.Integer({ minimum: 1 }),
    Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: 50 }),
  ], { description: 'For show and update: the note\'s number. For remove: one, or a list of them.' })),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: 'For update: the note\'s new text.' })),
  kind: Type.Optional(Type.Union(KINDS.map(k => Type.Literal(k)), { description: `For update: ${KIND}` })),
  show: Type.Optional(Type.Boolean({ description: 'For add: then take the user to the first note added, as show would.' })),
  replace: Type.Optional(Type.Boolean({ description: 'For add: instead of the notes there, numbered from 1 again; those stay if the new cannot be placed.' })),
});

export default (pi: ExtensionAPI) => register(pi, PARAMETERS);
