import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReference, selectBytes, collectReferences, readReferences, estimateTokens, MAX_OUTPUT_TOKENS } from './core.mjs';

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'sidekick-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'my file.ts'), 'abcdef\nghijkl\nmnopqr\n');
  await writeFile(join(cwd, 'other.ts'), 'other');
  return cwd;
}

test('six reference forms and explicit cursor context', async t => {
  const cwd = await fixture(t);
  for (const [suffix, expected] of [
    ['', 'abcdef\nghijkl\nmnopqr\n'], [' :L2', 'ghijkl'],
    [' :L1-L2', 'abcdef\nghijkl'], [' :L2:C3', 'ghijkl'],
    [' :L2:C2-C4', 'hij'], [' :L1:C3-L3:C2', 'cdef\nghijkl\nmn'],
  ]) {
    const { selections, notices } = await collectReferences([`@my file.ts${suffix}`], cwd);
    assert.equal(selections[0].content, expected, suffix);
    assert.equal(notices.length, 0);
    if (suffix === ' :L2:C3') {
      assert.deepEqual(selections[0].cursors, ['L2:C3']);
      assert.equal(selections[0].selection, 'entire line 2');
    }
  }
  assert.match((await readReferences(['@my file.ts :L2:C3'], cwd)).text, /cursor L2:C3; context: entire line 2/);
});

test('exact paths replace filesystem guessing; spaces and literal @ are supported', async t => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, 'my file.ts and explain'), 'longer');
  await writeFile(join(cwd, 'name @with space'), 'at sign');
  const { selections } = await collectReferences(['@my file.ts', '@my file.ts and explain', '@name @with space'], cwd);
  assert.deepEqual(selections.map(s => s.content), ['abcdef\nghijkl\nmnopqr\n', 'longer', 'at sign']);
  await assert.rejects(readReferences(['@other.ts please explain'], cwd), /ENOENT/);
});

test('strict parsing uses last delimiter and rejects surrounding prose', () => {
  assert.equal(parseReference('@odd :L3 name.ts :L1').path, 'odd :L3 name.ts');
  for (const input of ['@', 'explain @foo', '@foo :L1 please', '@foo\n@bar', '@foo\0', '@foo :L1-', '@foo :L1-L', '@foo :L0', '@foo :L3-L1', '@foo :L1:C4-C2', '@foo :L1:C0', '@foo :L99999999999999999999', '@foo :L1:Cnope']) {
    assert.throws(() => parseReference(input), undefined, input);
  }
});

test('canonical paths deduplicate absolute, relative and repeated references', async t => {
  const cwd = await fixture(t);
  const { selections } = await collectReferences(['@other.ts', `@${cwd}/other.ts`, '@./other.ts', '@other.ts'], cwd);
  assert.equal(selections.length, 1);
  assert.equal(selections[0].path, 'other.ts');
});

test('UTF-8 byte columns, CRLF, and split-character rejection', () => {
  const b = Buffer.from('aé漢z\r\n\r\nxyz\r\n');
  assert.equal(selectBytes(b, { line: 1, column: 2, endColumn: 3 }), 'é');
  assert.equal(selectBytes(b, { line: 1, column: 4, endColumn: 6 }), '漢');
  assert.equal(selectBytes(b, { line: 1, endLine: 3 }), 'aé漢z\r\n\r\nxyz');
  assert.equal(selectBytes(b), b.toString());
  assert.throws(() => selectBytes(b, { line: 1, column: 3, endColumn: 3 }), /UTF-8/);
  assert.throws(() => selectBytes(b, { line: 1, column: 2, endColumn: 2 }), /UTF-8/);
});

test('clamping, empty lines and cursor byte metadata', async t => {
  const cwd = await fixture(t);
  const b = Buffer.from('abc\n\nxyz\n');
  assert.equal(selectBytes(b, { line: 1, column: 2147483647, endColumn: 2147483647 }), 'c');
  assert.equal(selectBytes(b, { line: 2, column: 99 }), '');
  assert.equal(selectBytes(b, { line: 3, column: 2, endColumn: 2147483647 }), 'yz');
  assert.equal(selectBytes(b, { line: 1, column: 2147483647 }), 'abc');
  const result = await readReferences(['@my file.ts :L1:C2147483647'], cwd);
  assert.match(result.text, /clamped to 6/);
});

test('tool errors for missing, invalid and non-text inputs; mixed batches retain successes', async t => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, 'binary'), Buffer.from([0, 1]));
  await writeFile(join(cwd, 'invalid'), Buffer.from([0xff]));
  await mkdir(join(cwd, 'directory'));
  for (const ref of ['@missing :L1', '@my file.ts :L99', '@binary', '@invalid', '@directory']) {
    await assert.rejects(readReferences([ref], cwd));
  }
  const result = await readReferences(['@missing', '@other.ts'], cwd);
  assert.match(result.text, /other/);
  assert.match(result.text, /ENOENT/);
  assert.equal(result.details.errors, 1);
  assert.equal(result.details.returned, 1);
});

test('explicit whole-file requests use output budget, not former auto-attachment threshold', async t => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, 'medium'), 'x'.repeat(4000));
  assert.ok((await readReferences(['@medium'], cwd)).text.includes('x'.repeat(4000)));
  await writeFile(join(cwd, 'huge'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  await assert.rejects(readReferences(['@huge :L1'], cwd), /built-in read tool/);
});

test('merge overlaps and contained selections, preserving cursors', async t => {
  const cwd = await fixture(t);
  const result = await collectReferences(['@my file.ts :L1-L2', '@./my file.ts :L2-L3', '@my file.ts :L2:C3'], cwd);
  assert.equal(result.selections.length, 1);
  assert.equal(result.selections[0].content, 'abcdef\nghijkl\nmnopqr');
  assert.deepEqual(result.selections[0].cursors, ['L2:C3']);
  const whole = await collectReferences(['@my file.ts', '@my file.ts :L2'], cwd);
  assert.equal(whole.selections.length, 1);
});

test('disjoint selections do not include the gap; invalid intervals cannot hide in merges', async t => {
  const cwd = await fixture(t);
  const result = await collectReferences(['@my file.ts :L1:C1-C2', '@my file.ts :L3:C1-C2'], cwd);
  assert.deepEqual(result.selections.map(s => s.content), ['ab', 'mn']);
  await writeFile(join(cwd, 'unicode'), 'aéz');
  const unicode = await collectReferences(['@unicode', '@unicode :L1:C3-C3'], cwd);
  assert.equal(unicode.selections[0].content, 'aéz');
  assert.match(unicode.notices[0].error, /UTF-8/);
});

test('compact output preserves source and fences safely without absolute path repetition', async t => {
  const cwd = await fixture(t);
  const content = 'const x = "quoted";\n```\n\tend';
  await writeFile(join(cwd, 'fenced'), content);
  const { text } = await readReferences(['@fenced'], cwd);
  assert.ok(text.includes('````\n' + content + '\n````'));
  assert.ok(!text.includes(cwd));
  assert.match(text, /untrusted data/);
});

test('output budget includes framing; oversized results fail with actionable error', async t => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, 'a'), 'a'.repeat(7000));
  await writeFile(join(cwd, 'b'), 'b'.repeat(7000));
  const result = await readReferences(['@a :L1', '@b :L1'], cwd);
  assert.ok(estimateTokens(result.text) <= MAX_OUTPUT_TOKENS);
  assert.ok(result.text.includes('a'.repeat(7000)));
  assert.ok(!result.text.includes('b'.repeat(100)));
  assert.match(result.text, /budget exceeded/);
  assert.equal(result.details.omitted, 1);
  await writeFile(join(cwd, 'oversized'), 'x'.repeat(15000));
  await assert.rejects(readReferences(['@oversized'], cwd), /smaller ranges/);
});

test('argument bounds, aborts and empty files', async t => {
  const cwd = await fixture(t);
  await assert.rejects(readReferences([], cwd), /1 and 32/);
  await assert.rejects(readReferences(Array(33).fill('@other.ts'), cwd), /1 and 32/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readReferences(['@other.ts'], cwd, controller.signal), { name: 'AbortError' });
  await writeFile(join(cwd, 'empty'), '');
  assert.equal((await readReferences(['@empty :L1'], cwd)).details.returned, 1);
  await assert.rejects(readReferences(['@my file.ts :L4'], cwd), /out of range/);
});
