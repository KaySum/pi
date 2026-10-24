import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launch } from "../nvim-service/service.mjs";
import { attach, connect, type Remote } from "../nvim-remote/remote.ts";
import { FOLLOW, show, type Range } from "./core.ts";

const service = launch({
  cwd: "/tmp",
  init: "NONE",
  graceMs: 100,
  killMs: 300,
});
const { socket } = await service.ready;
after(() => service.stop());
const editor = await connect(socket); // The user.
after(() => editor.close());
const lua = (code: string, ...args: unknown[]): Promise<any> =>
  editor.request("nvim_exec_lua", [code, args]);
const remote: Remote = await attach(socket, { onError: () => {} });
after(() => remote.close());
const follow = (
  path: string,
  ranges: Range[] = [],
  ms = 150,
  cursor: [number, number] | null = null,
  reread = true,
) => show(remote, [path, ranges, ms, "PiFollow", cursor, reread]);

const dir = await realpath(await mkdtemp(join(tmpdir(), "nvim-follow-")));
after(() => rm(dir, { recursive: true, force: true }));
const file = async (name: string, text: string) => {
  const path = join(dir, name);
  await writeFile(path, text);
  return path;
};
const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

/** Like sidekick: the user's window on the left, Pi's terminal on the right, focused and typing. */
async function layout(t: TestContext): Promise<{ code: number; term: number }> {
  const [code, term] = await lua(`vim.cmd('silent! only | enew')
    local code = vim.api.nvim_get_current_win()
    vim.cmd('vsplit | terminal')
    vim.cmd.startinsert()
    return { code, vim.api.nvim_get_current_win() }`);
  await eventually(
    async () => (await editor.request("nvim_get_mode", [])).mode === "t",
  );
  t.after(() =>
    lua('vim.cmd.stopinsert(); vim.cmd("silent! only | silent! %bwipeout!")'),
  );
  return { code, term };
}
const shown = (win: number) =>
  lua(
    "local w = ...; return { vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(w)), vim.api.nvim_win_get_cursor(w)[1] }",
    win,
  );
const marks = (win: number) =>
  lua(
    `local w = ...
  local state = require('nvim_remote.v1').contexts[${remote.channel}].nvim_follow
  return vim.tbl_map(function(m) return { m[2], m[4].end_row } end,
    vim.api.nvim_buf_get_extmarks(vim.api.nvim_win_get_buf(w), state.ns, 0, -1, { details = true }))`,
    win,
  );

async function eventually<T>(
  check: () => Promise<T> | T,
  ms = 3000,
): Promise<T> {
  for (const end = Date.now() + ms; ; await delay(20)) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) assert.fail(`not within ${ms} ms`);
  }
}

// Deleted lines are virtual: surviving lines must not look changed.
test("deleted lines appear above their boundary, below EOF, and clear on timeout or replacement", async (t) => {
  const { code } = await layout(t);
  const path = await file("deleted.txt", "one\nthree\n");
  const display = (line: number, text: string[], ms = 150) =>
    show(remote, [
      path,
      [],
      ms,
      "PiFollow",
      [line, 0],
      true,
      [{ line, lines: text }],
    ]);
  const details = () =>
    lua(
      `local w = ...
    local ns = require('nvim_remote.v1').contexts[${remote.channel}].nvim_follow.ns
    return vim.api.nvim_buf_get_extmarks(vim.api.nvim_win_get_buf(w), ns, 0, -1, { details = true })`,
      code,
    );
  await display(2, ["two"], 1000);
  let mark = (await details())[0];
  assert.equal(mark[1], 1);
  assert.equal(mark[3].virt_lines_above, true);
  assert.deepEqual(mark[3].virt_lines, [[["two", "PiFollowDelete"]]]);
  assert.equal(mark[3].hl_group, undefined);
  assert.deepEqual(await shown(code), [path, 2]);
  assert.deepEqual(
    await lua(
      "return vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(...), 0, -1, true)",
      code,
    ),
    ["one", "three"],
  );
  await display(3, ["four", "five"]);
  mark = (await details())[0];
  assert.equal(mark[1], 1);
  assert.equal(mark[3].virt_lines_above, false);
  assert.equal(mark[3].virt_lines.length, 2);
  await eventually(async () => (await details()).length === 0);
  await display(2, ["two"], 1000);
  await follow(path, [[1, 1]]);
  assert.equal((await details()).length, 1);
  assert.equal((await details())[0][3].virt_lines, undefined);
});

test("empty files show deleted text, and detach removes virtual lines", async (t) => {
  const { code } = await layout(t);
  const path = await file("emptied.txt", "");
  const own = await attach(socket, { onError: () => {} });
  t.after(() => own.close());
  await show(own, [
    path,
    [],
    60000,
    "PiFollow",
    [1, 0],
    true,
    [{ line: 1, lines: ["gone"] }],
  ]);
  const ns = await own.lua("return remote.nvim_follow.ns");
  const remaining = () =>
    lua(
      "local w, ns = ...; return vim.api.nvim_buf_get_extmarks(vim.api.nvim_win_get_buf(w), ns, 0, -1, { details = true })",
      code,
      ns,
    );
  assert.equal((await remaining())[0][3].virt_lines_above, true);
  await own.close();
  assert.equal((await remaining()).length, 0);
});

test("a shrinking replacement displays deleted text and highlights the new line", async (t) => {
  const { code } = await layout(t);
  const path = await file("replacement.txt", "keep\nreplacement\nend\n");
  await show(remote, [
    path,
    [[2, 2]],
    1000,
    "PiFollow",
    [2, 0],
    true,
    [{ line: 2, lines: ["first", "second", "third"] }],
  ]);
  const details = await lua(
    `local w = ...
    local ns = require('nvim_remote.v1').contexts[${remote.channel}].nvim_follow.ns
    return vim.api.nvim_buf_get_extmarks(vim.api.nvim_win_get_buf(w), ns, 0, -1, { details = true })`,
    code,
  );
  assert.equal(details.length, 2);
  assert.equal(details[0][3].hl_group, "PiFollow");
  assert.deepEqual(details[1][3].virt_lines, [
    [["first", "PiFollowDelete"]],
    [["second", "PiFollowDelete"]],
    [["third", "PiFollowDelete"]],
  ]);
  assert.equal(details[1][3].virt_lines_above, true);
});

test("older deletion timers leave newer virtual lines intact, including across files", async (t) => {
  const { code } = await layout(t);
  const a = await file("rapid-a.txt", "keep\n"),
    b = await file("rapid-b.txt", "keep\n");
  const display = (path: string, text: string, ms: number) =>
    show(remote, [
      path,
      [],
      ms,
      "PiFollow",
      [1, 0],
      true,
      [{ line: 1, lines: [text] }],
    ]);
  const deleted = (path: string) =>
    lua(
      `local path = ...
    local ns = require('nvim_remote.v1').contexts[${remote.channel}].nvim_follow.ns
    return vim.api.nvim_buf_get_extmarks(vim.fn.bufnr(path), ns, 0, -1, { details = true })`,
      path,
    );
  await display(a, "old", 300);
  await display(a, "new", 1500);
  await display(b, "other file", 300);
  await eventually(async () => (await deleted(b)).length === 0);
  assert.deepEqual((await deleted(a))[0][3].virt_lines, [
    [["new", "PiFollowDelete"]],
  ]);
  await eventually(async () => (await deleted(a)).length === 0);
  void code;
});

test("edits default to the added color and preserve custom highlight definitions", async (t) => {
  await layout(t);
  const path = await file("colors.txt", "changed\n");
  await follow(path, [[1, 1]]);
  assert.equal(
    await lua(
      'return vim.api.nvim_get_hl(0, { name = "PiFollow", link = true }).link',
    ),
    "DiffAdd",
  );
  t.after(() =>
    lua('vim.api.nvim_set_hl(0, "PiFollow", { link = "DiffAdd" })'),
  );
  await lua('vim.api.nvim_set_hl(0, "PiFollow", { link = "Search" })');
  await follow(path, [[1, 1]]);
  assert.equal(
    await lua(
      'return vim.api.nvim_get_hl(0, { name = "PiFollow", link = true }).link',
    ),
    "Search",
  );
});

// Where it shows

test("the file opens beside Pi at the change, and Pi keeps focus and terminal mode", async (t) => {
  const { code, term } = await layout(t);
  const path = await file("a.txt", lines(100));
  assert.equal(await follow(path, [[60, 62]]), "shown");
  assert.deepEqual(await shown(code), [path, 60]);
  assert.equal(await lua("return vim.api.nvim_get_current_win()"), term);
  assert.equal((await editor.request("nvim_get_mode", [])).mode, "t");
});

test("a window already showing the file is used, over the one the user came from", async (t) => {
  const { code, term } = await layout(t);
  const path = await file("b.txt", lines(30)),
    other = await file("c.txt", "x\n");
  const showing = await lua(
    `local code, term, path, other = ...
    vim.api.nvim_win_call(code, function() vim.cmd.edit(vim.fn.fnameescape(other)) end)
    vim.api.nvim_set_current_win(code)
    vim.cmd('belowright split ' .. vim.fn.fnameescape(path))
    local showing = vim.api.nvim_get_current_win()
    vim.api.nvim_set_current_win(code)
    vim.api.nvim_set_current_win(term) -- Came from the other window, not the one showing the file.
    return showing`,
    code,
    term,
    path,
    other,
  );
  await follow(path, [[20, 20]]);
  assert.deepEqual(await shown(showing), [path, 20]);
  assert.deepEqual(await shown(code), [other, 1]);
});

test("otherwise the window the user came from is used, over others", async (t) => {
  const { code, term } = await layout(t);
  const [left, right] = await lua(
    `local code, term = ...
    vim.api.nvim_set_current_win(code)
    vim.cmd('belowright split | enew')
    local right = vim.api.nvim_get_current_win()
    vim.api.nvim_set_current_win(term) -- Came from the split.
    return { code, right }`,
    code,
    term,
  );
  const path = await file("d.txt", lines(5));
  await follow(path, [[3, 3]]);
  assert.deepEqual(await shown(right), [path, 3]);
  assert.deepEqual(await shown(left), ["", 1]);
});

test("the window the user is typing in is left alone, even when it is the only one", async (t) => {
  const { code, term } = await layout(t);
  const path = await file("e.txt", lines(5));
  // Typing in a second normal window: the first one is used instead.
  const typing = await lua(
    `local code = ...
    vim.cmd.stopinsert()
    vim.api.nvim_set_current_win(code)
    vim.cmd('belowright split | enew')
    return vim.api.nvim_get_current_win()`,
    code,
  );
  await editor.request("nvim_input", ["i"]);
  await eventually(
    async () => (await editor.request("nvim_get_mode", [])).mode === "i",
  );
  await follow(path, [[2, 2]]);
  assert.deepEqual(await shown(typing), ["", 1]);
  assert.deepEqual(await shown(code), [path, 2]);
  // Typing in the only normal window: nothing to show it in.
  await lua(
    `local code, typing = ...; vim.api.nvim_win_close(code, true)`,
    code,
    typing,
  );
  assert.equal(await follow(await file("f.txt", "x\n")), "no window");
  assert.deepEqual(await shown(typing), ["", 1]);
  await editor.request("nvim_input", ["<Esc>"]);
  void term;
});

test("in normal mode, with no other window, the window the user is in is used", async (t) => {
  await layout(t);
  const only = await lua(
    `vim.cmd.stopinsert(); vim.cmd('silent! only | enew'); return vim.api.nvim_get_current_win()`,
  );
  await eventually(
    async () => (await editor.request("nvim_get_mode", [])).mode === "n",
  );
  const path = await file("g.txt", lines(9));
  assert.equal(await follow(path, [[7, 7]]), "shown");
  assert.deepEqual(await shown(only), [path, 7]);
});

test("floating windows and other special windows are never used", async (t) => {
  const { code } = await layout(t);
  await lua(`local buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_open_win(buf, false, { relative = 'editor', row = 1, col = 1, width = 10, height = 2 })
    vim.cmd('botright split'); vim.cmd.help(); vim.cmd.wincmd('p')`);
  const path = await file("h.txt", lines(4));
  await follow(path, [[4, 4]]);
  assert.deepEqual(await shown(code), [path, 4]);
});

// What it leaves alone

test("a file already open is reread", async (t) => {
  const { code } = await layout(t);
  const path = await file("i.txt", "old\n");
  await follow(path);
  await lua('vim.cmd("rightbelow split | enew")'); // The buffer stays loaded, now hidden.
  await writeFile(path, "new\n");
  await follow(path, [[1, 1]]);
  assert.deepEqual(
    await lua(
      `return vim.api.nvim_buf_get_lines(vim.fn.bufnr(...), 0, -1, true)`,
      path,
    ),
    ["new"],
  );
  void code;
});

test("a file is read from disk once per follow, and not at all to show a read of one loaded", async (t) => {
  const { code } = await layout(t);
  await lua(`_G.reads = {}
    vim.api.nvim_create_autocmd('BufReadPost', { group = vim.api.nvim_create_augroup('count-reads', {}), callback = function(ev)
      _G.reads[ev.file] = (_G.reads[ev.file] or 0) + 1
    end })`);
  t.after(() => lua(`vim.api.nvim_del_augroup_by_name('count-reads')`));
  const reads = async (path: string) =>
    (await lua("return _G.reads[...] or 0", path)) as number;
  const path = await file("once.txt", lines(5));
  await follow(path, [[2, 2]]); // Not loaded yet: opened.
  assert.equal(await reads(path), 1);
  await follow(path, [[3, 3]]); // Loaded and shown: reread for the change.
  assert.equal(await reads(path), 2);
  await lua("vim.api.nvim_win_call(..., function() vim.cmd.enew() end)", code); // Loaded, hidden.
  await follow(path, [[4, 4]]);
  assert.equal(await reads(path), 3);
  await lua("vim.api.nvim_win_call(..., function() vim.cmd.enew() end)", code);
  await follow(path, [[4, 4]], 150, null, false); // A read: switched to, not reread.
  assert.equal(await reads(path), 3);
  assert.deepEqual(await shown(code), [path, 4]);
  // Listed but never loaded (:badd): loaded once, not then reread.
  const listed = await file("listed.txt", lines(5));
  await lua("vim.cmd.badd(vim.fn.fnameescape(...))", listed);
  await follow(listed, [[2, 2]]);
  assert.equal(await reads(listed), 1);
});

test("unsaved changes are never reloaded over", async (t) => {
  const { code } = await layout(t);
  const path = await file("j.txt", "disk\n");
  await follow(path);
  await lua(
    'vim.api.nvim_buf_set_lines(vim.api.nvim_win_get_buf(...), 0, -1, true, { "mine" })',
    code,
  );
  await writeFile(path, "pi\n");
  assert.equal(await follow(path, [[1, 1]]), "modified");
  assert.deepEqual(
    await lua(
      "return vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(...), 0, -1, true)",
      code,
    ),
    ["mine"],
  );
});

test("the user's jumplist and alternate file stay theirs", async (t) => {
  const { code } = await layout(t);
  const mine = await file("mine.txt", lines(20)),
    other = await file("other.txt", "x\n");
  const history = `local w = ...
    return { #vim.fn.getjumplist(w)[1], vim.api.nvim_win_call(w, function() return vim.fn.expand('#:p') end) }`;
  await lua(
    `local w, a, b = ...
    vim.api.nvim_win_call(w, function() vim.cmd.edit(vim.fn.fnameescape(a)); vim.cmd.edit(vim.fn.fnameescape(b)) end)`,
    code,
    mine,
    other,
  );
  const before = await lua(history, code);
  assert.equal(before[1], mine);
  await follow(await file("pi1.txt", lines(30)), [[25, 25]]);
  await follow(await file("pi2.txt", lines(30)), [[5, 5]]);
  assert.deepEqual(await lua(history, code), before);
});

test("a file that is gone is not opened", async (t) => {
  await layout(t);
  assert.equal(await follow(join(dir, "never-written.txt")), "missing");
  assert.equal(
    await lua("return vim.fn.bufnr(...)", join(dir, "never-written.txt")),
    -1,
  );
});

test("odd file names open as themselves", async (t) => {
  const { code } = await layout(t);
  for (const name of [
    "with space.txt",
    "per%cent#hash.txt",
    "ünï cödé.txt",
    "quote'd.txt",
  ]) {
    const path = await file(name, lines(3));
    assert.equal(await follow(path, [[2, 2]]), "shown");
    assert.deepEqual(await shown(code), [path, 2]);
  }
});

test("a path through a symlink finds the buffer already open for the real file", async (t) => {
  const { code } = await layout(t);
  const real = await file("real.txt", lines(5));
  const link = join(dir, "link.txt");
  await symlink(real, link);
  await follow(real);
  const count = await lua("return #vim.api.nvim_list_bufs()");
  await lua(
    'vim.api.nvim_buf_set_lines(vim.fn.bufnr(...), 0, 1, true, { "unsaved" })',
    real,
  );
  assert.equal(await follow(link, [[2, 2]]), "modified"); // Recognized as the same, modified file.
  assert.equal(await lua("return #vim.api.nvim_list_bufs()"), count);
  void code;
});

test("the buffer is found by its name, with the file system asked only once per name", async (t) => {
  const { code } = await layout(t);
  const many = await Promise.all(
    Array.from({ length: 50 }, (_, i) => file(`many${i}.txt`, "x\n")),
  );
  await lua(
    "for _, p in ipairs(...) do vim.cmd.badd(vim.fn.fnameescape(p)) end",
    many,
  );
  await lua(`local real = vim.uv.fs_realpath
    _G.realpaths = 0
    _G.restore_realpath = function() vim.uv.fs_realpath = real end
    vim.uv.fs_realpath = function(...) _G.realpaths = _G.realpaths + 1; return real(...) end`);
  t.after(() => lua("_G.restore_realpath()"));
  const asked = async (work: () => Promise<unknown>) => {
    await lua("_G.realpaths = 0");
    await work();
    return lua("return _G.realpaths") as Promise<number>;
  };
  // Open under its own name: found at once.
  assert.equal(await asked(() => follow(many[20], [[1, 1]])), 0);
  // Not open: every buffer's real path is looked up, once; the next time, none is.
  const fresh = await file("fresh.txt", "x\n");
  const first = await asked(() => follow(fresh, [[1, 1]]));
  const fresher = await file("fresher.txt", "x\n");
  const second = await asked(() => follow(fresher, [[1, 1]]));
  assert.ok(first > 50, `${first} lookups the first time`);
  assert.ok(second <= 3, `${second} lookups the second time`);
  void code;
});

test("follow.lua is sent once to an attachment, then only called", async (t) => {
  const { code } = await layout(t);
  const fresh = await attach(socket, { onError: () => {} });
  t.after(() => fresh.close());
  const sent: string[] = [];
  const counting = {
    lua: (code: string, args: unknown[], options?: { timeout?: number }) => {
      sent.push(code);
      return fresh.lua(code, args, options);
    },
  };
  const path = await file("once-sent.txt", lines(5));
  for (const line of [2, 3, 4])
    assert.equal(
      await show(counting, [path, [[line, line]], 150, "PiFollow", null, true]),
      "shown",
    );
  assert.equal(sent.filter((c) => c === FOLLOW).length, 1);
  assert.ok(
    sent.filter((c) => c !== FOLLOW).every((c) => c.length < 200),
    "every other call is the short one",
  );
  // A new attachment (after /reload, say) has it installed afresh.
  const again = await attach(socket, { onError: () => {} });
  t.after(() => again.close());
  const sentAgain: string[] = [];
  await show(
    {
      lua: (code, args, options) => {
        sentAgain.push(code);
        return again.lua(code, args, options);
      },
    },
    [path, [[2, 2]], 150, "PiFollow", null, true],
  );
  assert.equal(sentAgain.filter((c) => c === FOLLOW).length, 1);
  void code;
});

// The cursor and the highlight

test("ranges past the end are clamped, and no ranges leaves the cursor where it was", async (t) => {
  const { code } = await layout(t);
  const path = await file("k.txt", lines(3));
  await follow(path, [[9, 12]]);
  assert.deepEqual(await shown(code), [path, 3]);
  await lua("vim.api.nvim_win_set_cursor(..., { 2, 0 })", code);
  await follow(path, []);
  assert.deepEqual(await shown(code), [path, 2]);
});

test("the cursor goes to the exact column given, clamped to the line and the file", async (t) => {
  const { code } = await layout(t);
  const path = await file("n.txt", 'short\nconst ünï = "→ x";\nlast\n');
  const at = () => lua("return vim.api.nvim_win_get_cursor(...)", code);
  await follow(path, [[2, 2]], 150, [2, 19]); // The byte column of "x", past ü, ï and →.
  assert.deepEqual(await at(), [2, 19]);
  assert.equal(
    await lua(
      "return vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(...), 1, 2, true)[1]:sub(20, 20)",
      code,
    ),
    "x",
  );
  await follow(path, [[1, 1]], 150, [1, 99]); // Past the end of the line: on its last character.
  assert.deepEqual(await at(), [1, 4]);
  await follow(path, [[9, 9]], 150, [9, 3]); // Past the end of the file.
  assert.deepEqual(await at(), [3, 3]);
  await follow(path, [[2, 2]], 150, null); // None given: the first range's start.
  assert.deepEqual(await at(), [2, 0]);
});

/** The first and last lines in view, the window's height, and the cursor's line. */
const view = (win: number) =>
  lua(
    `local w = ...
  return vim.api.nvim_win_call(w, function()
    return { vim.fn.line('w0'), vim.fn.line('w$'), vim.api.nvim_win_get_height(w), vim.api.nvim_win_get_cursor(w)[1] }
  end)`,
    win,
  );

test("changes that fit in the window are all brought into view", async (t) => {
  const { code } = await layout(t);
  const path = await file("s1.txt", lines(200));
  await follow(
    path,
    [
      [100, 100],
      [108, 110],
    ],
    150,
    [100, 0],
  );
  const [first, last, height, at] = await view(code);
  assert.ok(height >= 12, `the window is ${height} lines`);
  assert.ok(first <= 100 && last >= 110, `${first}-${last} shows 100-110`);
  assert.equal(at, 100); // The cursor stays on the first change.
  // Centered: about as much room above the first change as below the last.
  assert.ok(
    Math.abs(100 - first - (last - 110)) <= 1,
    `${first}-${last} is centered on 100-110`,
  );
});

test("'scrolloff' is kept, and changes too far apart to fit center on the first", async (t) => {
  const { code } = await layout(t);
  await lua(`vim.wo[...].scrolloff = 4`, code);
  const path = await file("s2.txt", lines(200));
  const [, , height] = await view(code);
  // A span just too tall once scrolloff is kept above the cursor: the first change, centered.
  const end = 100 + height - 4;
  await follow(
    path,
    [
      [100, 100],
      [end, end],
    ],
    150,
    [100, 0],
  );
  const [first, last, , at] = await view(code);
  assert.equal(at, 100);
  assert.ok(
    Math.abs((first + last) / 2 - 100) <= 1,
    `${first}-${last} is centered on 100`,
  );
  // One that fits with room for scrolloff: all of it, the cursor at least 4 lines from the top.
  await follow(
    path,
    [
      [60, 60],
      [60 + height - 6, 60 + height - 6],
    ],
    150,
    [60, 0],
  );
  const [top, bottom] = await view(code);
  assert.ok(
    top <= 56 && bottom >= 60 + height - 6,
    `${top}-${bottom} shows 56-${60 + height - 6}`,
  );
});

test("a single change is centered, as before", async (t) => {
  const { code } = await layout(t);
  const path = await file("s3.txt", lines(200));
  await follow(path, [[120, 120]], 150, [120, 0]);
  const [first, last] = await view(code);
  assert.ok(
    Math.abs((first + last) / 2 - 120) <= 1,
    `${first}-${last} is centered on 120`,
  );
});

test("the changed lines flash, then clear; a quick second change keeps its own", async (t) => {
  const { code } = await layout(t);
  const path = await file("l.txt", lines(20));
  await follow(
    path,
    [
      [3, 4],
      [10, 10],
    ],
    150,
  );
  assert.deepEqual(await marks(code), [
    [2, 4],
    [9, 10],
  ]);
  await eventually(async () => (await marks(code)).length === 0);
  await follow(path, [[5, 5]], 150);
  await delay(100);
  await follow(path, [[6, 6]], 300); // The first timer fires during this one's.
  await delay(150);
  assert.deepEqual(await marks(code), [[5, 6]]);
});

test("changes to two files in quick succession both clear", async (t) => {
  const { code } = await layout(t);
  const a = await file("qa.txt", lines(5)),
    b = await file("qb.txt", lines(5));
  await follow(a, [[2, 2]], 150);
  await delay(50);
  await follow(b, [[3, 3]], 150); // Before the first file's highlight has cleared.
  const left = () =>
    lua(`local ns = require('nvim_remote.v1').contexts[${remote.channel}].nvim_follow.ns
    local n = 0
    for _, buf in ipairs(vim.api.nvim_list_bufs()) do n = n + #vim.api.nvim_buf_get_extmarks(buf, ns, 0, -1, {}) end
    return n`);
  await eventually(async () => (await left()) === 0);
  void code;
});

test("highlights live apart from what other features put in remote.ns, and go on detach", async (t) => {
  const { code } = await layout(t);
  const own = await attach(socket, { onError: () => {} });
  const path = await file("m.txt", lines(5));
  // Another feature of the same Pi marks the buffer through remote.ns.
  await own.lua(
    `local path = ...
    vim.cmd('badd ' .. vim.fn.fnameescape(path))
    vim.fn.bufload(vim.fn.bufnr(path))
    vim.api.nvim_buf_set_extmark(vim.fn.bufnr(path), remote.ns, 0, 0, { hl_group = 'Search', end_col = 1 })`,
    [path],
  );
  await show(own, [path, [[2, 3]], 60000, "PiFollow", null, true]);
  const count = (ns: string) =>
    own.lua(
      `local path = ...
    local ns = ${ns}
    return #vim.api.nvim_buf_get_extmarks(vim.fn.bufnr(path), ns, 0, -1, {})`,
      [path],
    );
  assert.equal(await count("remote.ns"), 1); // Not cleared by follow.
  assert.equal(await count("remote.nvim_follow.ns"), 1);
  const ns = await own.lua("return remote.nvim_follow.ns");
  await own.close();
  assert.equal(
    await lua(
      "return #vim.api.nvim_buf_get_extmarks(vim.fn.bufnr(...), select(2, ...), 0, -1, {})",
      path,
      ns,
    ),
    0,
  );
  void code;
});
