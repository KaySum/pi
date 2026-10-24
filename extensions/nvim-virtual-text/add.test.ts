import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeAdd, markOf, parseAdd } from './add.ts';

const at = { buf: 3, line: 12 };
const resolve = (path: string) => `/work/${path}`;

test('options come first, typed as each takes them, then the text', () => {
  assert.deepEqual(parseAdd('position=below wrap=true indent=4 ttl=500 fill=false Why it retries\\nbefore giving up'), {
    options: { position: 'below', wrap: true, indent: 4, ttl: 500, fill: false },
    text: 'Why it retries\nbefore giving up',
  });
  assert.deepEqual(parseAdd('position=40 match="function parse(" sign=▶ hl=PiVirtualTextWarn note'), {
    options: { position: 40, match: 'function parse(', sign: '▶', hl: 'PiVirtualTextWarn' },
    text: 'note',
  });
  // A word that is not a known option starts the text, even one with an `=`.
  assert.deepEqual(parseAdd('a=b and line=3'), { options: {}, text: 'a=b and line=3' });
  assert.deepEqual(parseAdd(''), { options: {}, text: '' });
});

test('a value an option does not take is refused, saying what it takes', () => {
  assert.throws(() => parseAdd('line=twelve x'), /line=twelve .*Line/);
  assert.throws(() => parseAdd('position=sideways x'), /position=sideways/);
  assert.throws(() => parseAdd('fill=yes x'), /fill=yes/);
  assert.throws(() => parseAdd('match= x'), /match=/);
});

test('a mark goes at your cursor unless it says where', () => {
  assert.deepEqual(markOf('hello', at, resolve), { buf: 3, line: 12, text: 'hello' });
  assert.deepEqual(markOf('line=4 hello', at, resolve), { buf: 3, line: 4, text: 'hello' });
  assert.deepEqual(markOf('path=src/a.ts hello', at, resolve), { path: '/work/src/a.ts', line: 1, text: 'hello' });
  assert.deepEqual(markOf('path=a.ts match=target hello', undefined, resolve), { path: '/work/a.ts', match: 'target', line: undefined, text: 'hello' });
  assert.deepEqual(markOf('highlight=Visual', at, resolve), { buf: 3, line: 12, highlight: 'Visual' });
  assert.throws(() => markOf('hello', undefined, resolve), /path=/);
  assert.throws(() => markOf('position=below', at, resolve), /Usage/);
});

test('fg, bg, bold, italic and underline make a style for the text', () => {
  assert.deepEqual(markOf('fg=#ff0000 bold=true hot', at, resolve), { buf: 3, line: 12, text: 'hot', hl: { fg: '#ff0000', bold: true } });
  assert.throws(() => markOf('hl=Title fg=#ff0000 hot', at, resolve), /not both/);
});

test('a color for hl colors the text, and for highlight the lines\' background', () => {
  assert.deepEqual(markOf('hl=#FF9E64 bold=true hot', at, resolve), { buf: 3, line: 12, text: 'hot', hl: { fg: '#FF9E64', bold: true } });
  assert.deepEqual(markOf('highlight=#1e2030 bg=#2d1b0e x', at, resolve), { buf: 3, line: 12, text: 'x', highlight: { bg: '#1e2030' }, hl: { bg: '#2d1b0e' } });
  assert.deepEqual(markOf('hl=Title highlight=Visual x', at, resolve), { buf: 3, line: 12, text: 'x', hl: 'Title', highlight: 'Visual' });
  assert.throws(() => markOf('hl=#ff0000 fg=#00ff00 x', at, resolve), /hl=#… or fg=#…/);
  assert.throws(() => markOf('hl=Title bold=true x', at, resolve), /not both/);
});

test('completion offers option keys, then the values some take, and stops once the text begins', () => {
  assert.deepEqual(completeAdd('pos')?.map(item => item.value), ['position=']);
  assert.deepEqual(completeAdd('wrap=true pos')?.map(item => item.value), ['wrap=true position=']);
  assert.deepEqual(completeAdd('position=b')?.map(item => item.value), ['position=below ']);
  assert.deepEqual(completeAdd('fill=')?.map(item => item.label), ['true', 'false']);
  assert.equal(completeAdd('hl='), null);
  assert.equal(completeAdd('some text pos'), null);
  assert.ok(completeAdd('')!.length > 10);
});
