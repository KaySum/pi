import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScreen, renderScreen } from './screen.mjs';

const line = (row, column, ...cells) => [1, row, column, cells];

test('grid events build the text a person would see', () => {
  const screen = createScreen();
  assert.equal(screen.apply([['grid_resize', [1, 6, 3]]]), false);
  assert.equal(screen.apply([
    ['grid_line', line(0, 0, ['a'], ['b', 0, 3]), line(1, 1, ['界'], [''], ['!']), line(2, 0, ['z'])],
    ['grid_cursor_goto', [1, 1, 3]], ['hl_attr_define', [1, {}, {}, []]], ['flush', []],
  ]), true);
  assert.deepEqual(screen.lines(), ['abbb', ' 界!', 'z']);
  assert.deepEqual(screen.cursor, { row: 1, column: 3 });
  screen.apply([['grid_resize', [1, 4, 4]]]);
  assert.deepEqual(screen.lines(), ['abbb', ' 界!', 'z', '']);
  screen.apply([['grid_clear', [1]]]);
  assert.deepEqual(screen.lines(), ['', '', '', '']);
});

test('scrolling moves only the given region, in both directions', () => {
  const screen = createScreen();
  screen.apply([['grid_resize', [1, 3, 4]], ['grid_line', line(0, 0, ['aaa']), line(1, 0, ['bbb']), line(2, 0, ['ccc']), line(3, 0, ['ddd'])]]);
  // grid_line cells are single characters in practice; one wide cell here keeps the fixture short.
  const rows = () => screen.lines().map(text => text.slice(0, 1));
  screen.apply([['grid_scroll', [1, 0, 3, 0, 3, 1, 0]]]);
  assert.deepEqual(rows(), ['b', 'c', 'c', 'd']);
  screen.apply([['grid_scroll', [1, 1, 4, 0, 3, -2, 0]]]);
  assert.deepEqual(rows(), ['b', 'c', 'c', 'c']);
});

test('rendering drops trailing blanks and folds long runs of identical rows', () => {
  assert.equal(renderScreen(['one', '~', '~', '~', '~', '~', 'status', '', '']), 'one\n~\n  … 4 more identical rows\nstatus');
  assert.equal(renderScreen(['a', '', '', 'b', 'b', '']), 'a\n\n\nb\nb');
  assert.equal(renderScreen(['', '']), '');
});
