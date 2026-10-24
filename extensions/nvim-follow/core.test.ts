import assert from 'node:assert/strict';
import { test } from 'node:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { editRanges, editsOf, pathOf, writeRanges } from './core.ts';

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
  assert.deepEqual(editRanges(before, apply(before, edits), edits), [[2, 4], [7, 7], [9, 9]]);
});

test('a new text that also occurs elsewhere does not mislead', () => {
  const before = lines(50);
  const edits = [{ oldText: 'line 40\n', newText: 'line 3\n' }];
  assert.deepEqual(editRanges(before, apply(before, edits), edits), [[40, 40]]);
});

test('edits within a line, deletions, and edits at the very end', () => {
  const before = 'const a = 1;\nconst b = 2;\nconst c = 3;';
  assert.deepEqual(editRanges(before, '', [{ oldText: 'b = 2', newText: 'b = 20' }]), [[2, 2]]);
  assert.deepEqual(editRanges(before, '', [{ oldText: 'const b = 2;\n', newText: '' }]), [[2, 2]]); // Where it went.
  assert.deepEqual(editRanges(before, '', [{ oldText: 'c = 3;', newText: 'c = 3;\nconst d = 4;' }]), [[3, 4]]);
});

test('an edit matched loosely is placed by its new text, when that is unambiguous', () => {
  const before = 'one\r\ntwo\r\nthree\r\n'; // The tool matched "two\n" against CRLF.
  const after = 'one\r\nTWO\r\nthree\r\n';
  assert.deepEqual(editRanges(before, after, [{ oldText: 'two\n', newText: 'TWO' }]), [[2, 2]]);
  const twice = 'TWO\nTWO\n';
  assert.deepEqual(editRanges('x\ny\n', twice, [{ oldText: 'z', newText: 'TWO' }]), []); // Could be either.
  assert.deepEqual(editRanges('x\n', 'x\n', [{ oldText: 'z', newText: '' }]), []); // Nothing to look for.
});

test('ranges come out in file order whatever order the edits came in', () => {
  const before = lines(20);
  const edits = [{ oldText: 'line 15\n', newText: 'x\n' }, { oldText: 'line 1\n', newText: 'y\n' }, { oldText: 'line 9\n', newText: 'z\n' }];
  assert.deepEqual(editRanges(before, apply(before, edits), edits), [[1, 1], [9, 9], [15, 15]]);
});

// Writes

test('a write marks the lines between those it kept', () => {
  const before = lines(10);
  assert.deepEqual(writeRanges(before, before.replace('line 4\n', 'four\nmore\n')), [[4, 5]]);
  assert.deepEqual(writeRanges(before, before + 'line 11\n'), [[11, 11]]); // Appended.
  assert.deepEqual(writeRanges(before, 'line 0\n' + before), [[1, 1]]); // Prepended.
  assert.deepEqual(writeRanges(before, before.replace('line 2\n', 'two\n').replace('line 9\n', 'nine\n')), [[2, 9]]); // Spread out.
});

test('a write that removes lines marks where they were', () => {
  assert.deepEqual(writeRanges(lines(5), lines(5).replace('line 3\n', '')), [[3, 3]]);
  assert.deepEqual(writeRanges(lines(5), 'line 1\nline 2\n'), [[2, 2]]); // The end went: the last line left.
});

test('a new file is all change; an unchanged or emptied one marks nothing', () => {
  assert.deepEqual(writeRanges(undefined, 'a\nb\nc\n'), [[1, 3]]);
  assert.deepEqual(writeRanges('', 'a\n'), [[1, 1]]);
  assert.deepEqual(writeRanges(lines(3), lines(3)), []);
  assert.deepEqual(writeRanges(lines(3), ''), []);
});

test('repeated lines and a missing final newline do not confuse the diff', () => {
  assert.deepEqual(writeRanges('a\na\na\n', 'a\na\na\na\n'), [[4, 4]]);
  assert.deepEqual(writeRanges('a\nb', 'a\nb\n'), []); // The same lines.
  assert.deepEqual(writeRanges('a\nb\n', 'a\nB'), [[2, 2]]);
});
