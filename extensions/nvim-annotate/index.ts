import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import register from './annotate.ts';
import { KINDS } from './notes.ts';

// The tool's schema, apart from the rest: its package is Pi's, which the tests run without.
const PARAMETERS = Type.Object({
  action: Type.Union([Type.Literal('add'), Type.Literal('list'), Type.Literal('show'), Type.Literal('clear')]),
  notes: Type.Optional(Type.Array(Type.Object({
    file: Type.String({ minLength: 1, maxLength: 4096, description: 'The file, from the working directory or absolute.' }),
    match: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: 'The code the note is on: lines of it, the space around them aside. Preferred to line.' })),
    line: Type.Optional(Type.Integer({ minimum: 1, description: 'The line the note is on; with match, the occurrence nearest it.' })),
    text: Type.String({ minLength: 1, maxLength: 2000, description: 'The note, drawn above the lines, wrapped to the window.' }),
    kind: Type.Optional(Type.Union(KINDS.map(k => Type.Literal(k)), { description: 'Its color: info (default), hint, warn or error.' })),
  }), { minItems: 1, maxItems: 50, description: 'For add: the notes, in the order to read them.' })),
  note: Type.Optional(Type.Integer({ minimum: 1, description: 'For show: the note\'s number.' })),
  show: Type.Optional(Type.Boolean({ description: 'For add: then take the user to the first note added, as show would.' })),
});

export default (pi: ExtensionAPI) => register(pi, PARAMETERS);
