import assert from 'node:assert/strict';
import { test } from 'node:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { editChanges, editsOf, pathOf, readRanges, writeChanges } from './core.ts';

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const apply = (text: string, edits: { oldText: string; newText: string }[]) =>
  edits.reduce((result, edit) => result.replace(edit.oldText, edit.newText), text);

// Paths, as Pi's edit and write tools resolve them

test('paths resolve as the tools resolve them', () => {
  assert.equal(pathOf({ path: 'src/a.ts' }, '/work'), '/work/src/a.ts');
  assert.equal(pathOf({ path: '../b.ts' }, '/work/src'), '/work/b.ts');
  assert.equal(pathOf({ path: '/abs/./c.ts' }, '/work'), '/abs/c.ts');
  assert.equal(pathOf({ path: '@src/a.ts' }, '/work'), '/work/src/a.ts'); // A mention.
  assert.equal(pathOf({ path: '~' }, '/work'), homedir());
  assert.equal(pathOf({ path: '~/notes.md' }, '/work'), join(homedir(), 'notes.md'));
  assert.equal(pathOf({ path: pathToFileURL('/abs/with space.ts').href }, '/work'), '/abs/with space.ts');
  assert.equal(pathOf({ path: 'a b.ts' }, '/work'), '/work/a b.ts'); // A no-break space.
  assert.equal(pathOf({ path: '~user/x' }, '/work'), '/work/~user/x'); // Only ~ and ~/ expand.
});

test('without a usable path there is nothing to follow', () => {
  assert.equal(pathOf({}, '/work'), undefined);
  assert.equal(pathOf({ path: '' }, '/work'), undefined);
  assert.equal(pathOf({ path: 42 }, '/work'), undefined);
});

// Edits

test('the edit tool input is read in its current form and the legacy one', () => {
  assert.deepEqual(editsOf({ edits: [{ oldText: 'a', newText: 'b' }] }), [{ oldText: 'a', newText: 'b' }]);
  assert.deepEqual(editsOf({ oldText: 'a', newText: 'b' }), [{ oldText: 'a', newText: 'b' }]);
  assert.deepEqual(editsOf({ edits: [{ oldText: 'a' }, null, { oldText: 'c', newText: 'd' }] }), [{ oldText: 'c', newText: 'd' }]);
  assert.deepEqual(editsOf({}), []);
});

test('an edit is placed by its old text, shifted by the edits above it', () => {
  const before = lines(10);
  const edits = [
    { oldText: 'line 8\n', newText: 'eight\n' },
    { oldText: 'line 2\n', newText: 'a\nb\nc\n' }, // Two lines more, above line 8.
    { oldText: 'line 5\nline 6\n', newText: 'five\n' }, // One line fewer, also above.
  ];
  assert.deepEqual(editChanges(before, apply(before, edits), edits), { ranges: [[2, 4], [7, 7], [9, 9]], cursor: [2, 0] });
});

test('a new text that also occurs elsewhere does not mislead', () => {
  const before = lines(50);
  const edits = [{ oldText: 'line 40\n', newText: 'line 3\n' }];
  // Only the digits differ: the change is "3" where "40" was.
  assert.deepEqual(editChanges(before, apply(before, edits), edits), { ranges: [[40, 40]], cursor: [40, 5] });
});

test('context an old text carries to be unique is left out', () => {
  const before = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 1;\n}\n';
  // The old text repeats the line above and below so that it is unique; only "2" is new.
  const edits = [{ oldText: 'function b() {\n  return 1;\n}', newText: 'function b() {\n  return 2;\n}' }];
  assert.deepEqual(editChanges(before, apply(before, edits), edits), { ranges: [[6, 6]], cursor: [6, 9] });
});

test('the cursor goes to the column where the change starts, counted in bytes', () => {
  const before = 'const ünïcode = "→ old";\n';
  const edits = [{ oldText: '"→ old"', newText: '"→ new"' }];
  // "const ünïcode = \"→ " is 17 characters but 21 bytes: ü, ï are 2 bytes and → is 3.
  assert.deepEqual(editChanges(before, apply(before, edits), edits), { ranges: [[1, 1]], cursor: [1, 23] });
  const emoji = 'a 😀 b\n';
  const edit = [{ oldText: '😀 b', newText: '😀 c' }];
  assert.deepEqual(editChanges(emoji, apply(emoji, edit), edit).cursor, [1, 7]); // After a 4-byte emoji.
});

test('edits within a line, deletions, and edits at the very end', () => {
  const before = 'const a = 1;\nconst b = 2;\nconst c = 3;';
  const change = (oldText: string, newText: string) => editChanges(before, before.replace(oldText, newText), [{ oldText, newText }]);
  assert.deepEqual(change('b = 2', 'b = 20'), { ranges: [[2, 2]], cursor: [2, 11] });
  assert.deepEqual(change('const b = 2;\n', ''), { ranges: [[2, 2]], cursor: [2, 0] }); // Where it went.
  assert.deepEqual(change('c = 3;', 'c = 3;\nconst d = 4;'), { ranges: [[3, 4]], cursor: [3, 12] });
});

test('an edit matched loosely is placed by its new text, when that is unambiguous', () => {
  const before = 'one\r\ntwo\r\nthree\r\n'; // The tool matched "two\n" against CRLF.
  const after = 'one\r\nTWO\r\nthree\r\n';
  assert.deepEqual(editChanges(before, after, [{ oldText: 'two\n', newText: 'TWO' }]), { ranges: [[2, 2]], cursor: [2, 0] });
  assert.deepEqual(editChanges('x\ny\n', 'TWO\nTWO\n', [{ oldText: 'z', newText: 'TWO' }]), { ranges: [], cursor: undefined }); // Either.
  assert.deepEqual(editChanges('x\n', 'x\n', [{ oldText: 'z', newText: '' }]), { ranges: [], cursor: undefined }); // Nothing to look for.
});

test('where an edit should be is checked against the file after it', () => {
  // The old text is found, but the tool also changed something above it (line endings, say):
  // the reckoned place holds other text, so the new text is looked for instead.
  const before = 'a\r\nb\nkeep\nold\n';
  const after = 'a\nb\nkeep\nnew\n';
  assert.deepEqual(editChanges(before, after, [{ oldText: 'old', newText: 'new' }]), { ranges: [[4, 4]], cursor: [4, 0] });
});

test('ranges come out in file order whatever order the edits came in', () => {
  const before = lines(20);
  const edits = [{ oldText: 'line 15\n', newText: 'x\n' }, { oldText: 'line 1\n', newText: 'y\n' }, { oldText: 'line 9\n', newText: 'z\n' }];
  assert.deepEqual(editChanges(before, apply(before, edits), edits), { ranges: [[1, 1], [9, 9], [15, 15]], cursor: [1, 0] });
});

// Writes

test('a write marks what changed between what it kept, with the cursor where that starts', () => {
  const before = lines(10);
  assert.deepEqual(writeChanges(before, before.replace('line 4\n', 'four\nmore\n')), { ranges: [[4, 5]], cursor: [4, 0] });
  assert.deepEqual(writeChanges(before, before + 'line 11\n'), { ranges: [[11, 11]], cursor: [11, 0] }); // Appended.
  assert.deepEqual(writeChanges(before, 'line 0\n' + before), { ranges: [[1, 1]], cursor: [1, 0] }); // A whole new line.
  assert.deepEqual(writeChanges(before, before.replace('line 2\n', 'two\n').replace('line 9\n', 'nine\n')), { ranges: [[2, 9]], cursor: [2, 0] });
  assert.deepEqual(writeChanges(before, before.replace('line 7', 'line 77')), { ranges: [[7, 7]], cursor: [7, 6] }); // Within a line.
});

test('a write that removes lines marks where they were', () => {
  assert.deepEqual(writeChanges(lines(5), lines(5).replace('line 3\n', '')), { ranges: [[3, 3]], cursor: [3, 0] }); // At the start of where it was.
  assert.deepEqual(writeChanges(lines(5), 'line 1\nline 2\n'), { ranges: [[3, 3]], cursor: [3, 0] }); // The end went: just after the last line left.
});

test('a new file is all change; an unchanged or emptied one marks nothing', () => {
  assert.deepEqual(writeChanges(undefined, 'a\nb\nc\n'), { ranges: [[1, 3]], cursor: [1, 0] });
  assert.deepEqual(writeChanges('', 'a\n'), { ranges: [[1, 1]], cursor: [1, 0] });
  assert.deepEqual(writeChanges(lines(3), lines(3)), { ranges: [] });
  assert.deepEqual(writeChanges(lines(3), ''), { ranges: [] });
});

test('repeated lines and a missing final newline do not confuse it', () => {
  assert.deepEqual(writeChanges('a\na\na\n', 'a\na\na\na\n'), { ranges: [[4, 4]], cursor: [4, 0] });
  assert.deepEqual(writeChanges('a\nb', 'a\nb\n'), { ranges: [] }); // The same lines.
  assert.deepEqual(writeChanges('a\nb\n', 'a\nB'), { ranges: [[2, 2]], cursor: [2, 0] });
});

test('an insertion or deletion that could go in several places goes at a line start', () => {
  // "a0" inserted above "a1": character by character it could be "0\na" after the first "a".
  const insert = [{ oldText: 'a1\n', newText: 'a0\na1\n' }];
  assert.deepEqual(editChanges('x\na1\n', 'x\na0\na1\n', insert), { ranges: [[2, 2]], cursor: [2, 0] });
  // A duplicated line removed: marked, like any deletion, at the line now where it was.
  assert.deepEqual(writeChanges('a\nsame\nsame\nb\n', 'a\nsame\nb\n'), { ranges: [[3, 3]], cursor: [3, 0] });
  // Within a line, nothing to slide to: left where the characters differ.
  assert.deepEqual(writeChanges('abcabc\n', 'abcXabc\n'), { ranges: [[1, 1]], cursor: [1, 3] });
});

test('a surrogate pair is never split', () => {
  // The two emoji share their first UTF-16 unit; the change must start before it, not inside.
  assert.deepEqual(writeChanges('x 😀\n', 'x 😁\n'), { ranges: [[1, 1]], cursor: [1, 2] });
});

// Reads

test('a read marks the lines it asked for', () => {
  assert.deepEqual(readRanges({ path: 'a', offset: 40, limit: 20 }), [[40, 59]]);
  assert.deepEqual(readRanges({ path: 'a', limit: 10 }), [[1, 10]]); // From the top.
  assert.deepEqual(readRanges({ path: 'a', offset: 300 }), [[300, 300]]); // Where it started, to the end.
  assert.deepEqual(readRanges({ path: 'a' }), []); // The whole file.
  assert.deepEqual(readRanges({ path: 'a', offset: 1 }), []);
});

test('odd offsets and limits are made sense of', () => {
  assert.deepEqual(readRanges({ path: 'a', offset: 0, limit: 5 }), [[1, 5]]);
  assert.deepEqual(readRanges({ path: 'a', offset: -3 }), []);
  assert.deepEqual(readRanges({ path: 'a', offset: 7.8, limit: 2.5 }), [[7, 8]]);
  assert.deepEqual(readRanges({ path: 'a', offset: 5, limit: 0 }), [[5, 5]]);
  assert.deepEqual(readRanges({ path: 'a', offset: '5', limit: null }), []);
  assert.deepEqual(readRanges({ path: 'a', offset: Infinity, limit: NaN }), []);
});
