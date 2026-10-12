// Text model of Neovim's screen, built from `ext_linegrid` redraw events. Without
// `ext_multigrid`, floating windows, popups and messages are all composed into grid 1.
export function createScreen() {
  let rows = [];
  let cursor = { row: 0, column: 0 };
  const blank = width => Array(width).fill(' ');

  const events = {
    grid_resize(_grid, width, height) {
      rows = Array.from({ length: height }, (_, y) => Object.assign(blank(width), rows[y]?.slice(0, width)));
    },
    grid_clear() { rows = rows.map(row => blank(row.length)); },
    grid_cursor_goto(_grid, row, column) { cursor = { row, column }; },
    grid_line(_grid, row, column, cells) {
      for (const [text, , repeat = 1] of cells) {
        for (let i = 0; i < repeat; i++) rows[row][column++] = text; // '' follows a double-width character.
      }
    },
    grid_scroll(_grid, top, bottom, left, right, count) {
      const copy = (to, from) => rows[to].splice(left, right - left, ...rows[from].slice(left, right));
      if (count > 0) for (let y = top; y < bottom - count; y++) copy(y, y + count);
      else for (let y = bottom - 1; y >= top - count; y--) copy(y, y + count);
    },
  };

  return {
    /** Apply one `redraw` notification; returns true if it completed a frame. */
    apply(batches) {
      let flushed = false;
      for (const [name, ...calls] of batches) {
        if (name === 'flush') flushed = true;
        for (const args of events[name] ? calls : []) events[name](...args);
      }
      return flushed;
    },
    get cursor() { return cursor; },
    lines: () => rows.map(row => row.join('').trimEnd()),
  };
}

/** Render lines compactly: drop trailing blank rows and fold runs of identical rows. */
export function renderScreen(lines) {
  const out = [];
  const end = lines.findLastIndex(line => line) + 1;
  for (let i = 0; i < end;) {
    let run = 1;
    while (i + run < end && lines[i + run] === lines[i]) run++;
    out.push(lines[i]);
    if (run > 3) out.push(`  … ${run - 1} more identical rows`);
    else for (let j = 1; j < run; j++) out.push(lines[i]);
    i += run;
  }
  return out.join('\n');
}
