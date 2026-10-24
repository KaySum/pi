import assert from "node:assert/strict";
import { test } from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { after } from "node:test";
import { patchChanges, pathOf, readRanges, writeChanges } from "./core.ts";

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

// Pi's own edit tool, from the package nvim-service installs: its patches are what follow reads.
const { createEditTool } = await import(
  new URL(
    "../nvim-service/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
    import.meta.url,
  ).href
);
const dir = await mkdtemp(join(tmpdir(), "nvim-follow-patch-"));
after(() => rm(dir, { recursive: true, force: true }));
let files = 0;
/** What follow makes of an edit Pi's edit tool really makes to `text`. */
async function edited(
  text: string,
  edits: { oldText: string; newText: string }[],
) {
  const name = `f${++files}.txt`;
  await writeFile(join(dir, name), text);
  const { details } = await createEditTool(dir).execute("id", {
    path: name,
    edits,
  });
  return patchChanges(details.patch);
}

// Paths, as Pi's edit and write tools resolve them

test("paths resolve as the tools resolve them", () => {
  assert.equal(pathOf({ path: "src/a.ts" }, "/work"), "/work/src/a.ts");
  assert.equal(pathOf({ path: "../b.ts" }, "/work/src"), "/work/b.ts");
  assert.equal(pathOf({ path: "/abs/./c.ts" }, "/work"), "/abs/c.ts");
  assert.equal(pathOf({ path: "@src/a.ts" }, "/work"), "/work/src/a.ts"); // A mention.
  assert.equal(pathOf({ path: "~" }, "/work"), homedir());
  assert.equal(
    pathOf({ path: "~/notes.md" }, "/work"),
    join(homedir(), "notes.md"),
  );
  assert.equal(
    pathOf({ path: pathToFileURL("/abs/with space.ts").href }, "/work"),
    "/abs/with space.ts",
  );
  assert.equal(pathOf({ path: "a b.ts" }, "/work"), "/work/a b.ts"); // A no-break space.
  assert.equal(pathOf({ path: "~user/x" }, "/work"), "/work/~user/x"); // Only ~ and ~/ expand.
});

test("without a usable path there is nothing to follow", () => {
  assert.equal(pathOf({}, "/work"), undefined);
  assert.equal(pathOf({ path: "" }, "/work"), undefined);
  assert.equal(pathOf({ path: 42 }, "/work"), undefined);
});

// Edits: from the patch Pi's edit tool returns

test("several edits in one call are each placed, shifted by those above them", async () => {
  const edits = [
    { oldText: "line 8\n", newText: "eight\n" },
    { oldText: "line 2\n", newText: "a\nb\nc\n" }, // Two lines more, above line 8.
    { oldText: "line 5\nline 6\n", newText: "five\n" }, // One line fewer, also above.
  ];
  assert.deepEqual(await edited(lines(10), edits), {
    ranges: [
      [2, 4],
      [7, 7],
      [9, 9],
    ],
    cursor: [2, 0],
    deletions: [{ line: 7, lines: ["line 5", "line 6"] }],
  });
});

test("shrinking replacements show the removed block alongside the replacement", async () => {
  assert.deepEqual(
    await edited("keep\nfirst\nsecond\nthird\nend\n", [
      { oldText: "first\nsecond\nthird\n", newText: "replacement\n" },
    ]),
    {
      ranges: [[2, 2]],
      cursor: [2, 0],
      deletions: [{ line: 2, lines: ["first", "second", "third"] }],
    },
  );
});

test("a new text that also occurs elsewhere does not mislead", async () => {
  // Only the digits differ: the cursor goes to "3" where "40" was.
  assert.deepEqual(
    await edited(lines(50), [{ oldText: "line 40\n", newText: "line 3\n" }]),
    { ranges: [[40, 40]], cursor: [40, 5] },
  );
});

test("context an edit carries to be unique is left out", async () => {
  const before =
    "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 1;\n}\n";
  const edits = [
    {
      oldText: "function b() {\n  return 1;\n}",
      newText: "function b() {\n  return 2;\n}",
    },
  ];
  assert.deepEqual(await edited(before, edits), {
    ranges: [[6, 6]],
    cursor: [6, 9],
  });
});

test("the cursor goes to the column where the change starts, counted in bytes", async () => {
  // "const ünïcode = \"→ " is 20 characters but 23 bytes: ü, ï are 2 bytes and → is 3.
  assert.deepEqual(
    (
      await edited('const ünïcode = "→ old";\n', [
        { oldText: '"→ old"', newText: '"→ new"' },
      ])
    ).cursor,
    [1, 23],
  );
  assert.deepEqual(
    (await edited("a 😀 b\n", [{ oldText: "😀 b", newText: "😀 c" }])).cursor,
    [1, 7],
  ); // After a 4-byte emoji.
});

test("lines added, removed, and changed within a line", async () => {
  const before = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
  assert.deepEqual(
    await edited(before, [{ oldText: "b = 2", newText: "b = 20" }]),
    { ranges: [[2, 2]], cursor: [2, 11] },
  );
  assert.deepEqual(
    await edited(before, [{ oldText: "const b = 2;\n", newText: "" }]),
    {
      ranges: [],
      cursor: [2, 0],
      deletions: [{ line: 2, lines: ["const b = 2;"] }],
    },
  ); // Where it went.
  assert.deepEqual(
    await edited(before, [
      { oldText: "const c = 3;\n", newText: "const c = 3;\nconst d = 4;\n" },
    ]),
    { ranges: [[4, 4]], cursor: [4, 0] },
  );
  assert.deepEqual(
    await edited(before, [{ oldText: "const c = 3;\n", newText: "" }]),
    {
      ranges: [],
      cursor: [3, 0],
      deletions: [{ line: 3, lines: ["const c = 3;"] }],
    },
  ); // The last line went.
});

test("edits far apart come out as separate changes, in file order", async () => {
  const edits = [
    { oldText: "line 150\n", newText: "x\n" },
    { oldText: "line 10\n", newText: "y\n" },
    { oldText: "line 90\n", newText: "z\n" },
  ];
  assert.deepEqual(await edited(lines(200), edits), {
    ranges: [
      [10, 10],
      [90, 90],
      [150, 150],
    ],
    cursor: [10, 0],
  });
});

test("what the tool did with line endings, a byte order mark, or a loose match is what is shown", async () => {
  // CRLF: Pi matches "two\n" against "two\r\n" and keeps the file's line endings.
  assert.deepEqual(
    await edited("one\r\ntwo\r\nthree\r\n", [
      { oldText: "two\n", newText: "TWO\n" },
    ]),
    { ranges: [[2, 2]], cursor: [2, 0] },
  );
  // A byte order mark, which Neovim does not show either, does not shift the column.
  assert.deepEqual(
    await edited("\uFEFFkeep = old\n", [{ oldText: "old", newText: "new" }]),
    { ranges: [[1, 1]], cursor: [1, 7] },
  );
  // Curly quotes in the file, straight ones in the edit: Pi matches loosely; "say " is kept.
  assert.deepEqual(
    await edited("say \u201chello\u201d\nend\n", [
      { oldText: 'say "hello"', newText: 'say "bye"' },
    ]),
    { ranges: [[1, 1]], cursor: [1, 4] },
  );
});

test("a file without a final newline", async () => {
  assert.deepEqual(await edited("a\nb", [{ oldText: "b", newText: "B" }]), {
    ranges: [[2, 2]],
    cursor: [2, 0],
  });
  assert.deepEqual(await edited("a\nb", [{ oldText: "b", newText: "b\nc" }]), {
    ranges: [[2, 3]],
    cursor: [2, 1],
  });
});

test("a patch with nothing in it marks nothing", () => {
  assert.deepEqual(patchChanges(""), { ranges: [], cursor: undefined });
  assert.deepEqual(patchChanges("--- a.txt\n+++ a.txt\n"), {
    ranges: [],
    cursor: undefined,
  });
});

test("hunks with an empty range are placed by the line they name", () => {
  // As a diff without context writes them: "+3,0" is "after line 3".
  assert.deepEqual(patchChanges("--- a\n+++ a\n@@ -4,1 +3,0 @@\n-gone\n"), {
    ranges: [],
    cursor: [4, 0],
    deletions: [{ line: 4, lines: ["gone"] }],
  });
  assert.deepEqual(patchChanges("--- a\n+++ a\n@@ -2,0 +3,1 @@\n+new\n"), {
    ranges: [[3, 3]],
    cursor: [3, 0],
  });
});

// Writes

test("a write marks what changed between what it kept, with the cursor where that starts", () => {
  const before = lines(10);
  assert.deepEqual(
    writeChanges(before, before.replace("line 4\n", "four\nmore\n")),
    { ranges: [[4, 5]], cursor: [4, 0] },
  );
  assert.deepEqual(writeChanges(before, before + "line 11\n"), {
    ranges: [[11, 11]],
    cursor: [11, 0],
  }); // Appended.
  assert.deepEqual(writeChanges(before, "line 0\n" + before), {
    ranges: [[1, 1]],
    cursor: [1, 0],
  }); // A whole new line.
  assert.deepEqual(
    writeChanges(
      before,
      before.replace("line 2\n", "two\n").replace("line 9\n", "nine\n"),
    ),
    { ranges: [[2, 9]], cursor: [2, 0] },
  );
  assert.deepEqual(writeChanges(before, before.replace("line 7", "line 77")), {
    ranges: [[7, 7]],
    cursor: [7, 6],
  }); // Within a line.
});

test("a write that removes lines shows the removed text at its boundary", () => {
  assert.deepEqual(writeChanges(lines(5), lines(5).replace("line 3\n", "")), {
    ranges: [],
    cursor: [3, 0],
    deletions: [{ line: 3, lines: ["line 3"] }],
  });
  assert.deepEqual(writeChanges(lines(5), "line 1\nline 2\n"), {
    ranges: [],
    cursor: [3, 0],
    deletions: [{ line: 3, lines: ["line 3", "line 4", "line 5"] }],
  });
});

test("a new file is all change; an emptied one shows what was removed", () => {
  assert.deepEqual(writeChanges(undefined, "a\nb\nc\n"), {
    ranges: [[1, 3]],
    cursor: [1, 0],
  });
  assert.deepEqual(writeChanges("", "a\n"), {
    ranges: [[1, 1]],
    cursor: [1, 0],
  });
  assert.deepEqual(writeChanges(lines(3), lines(3)), { ranges: [] });
  assert.deepEqual(writeChanges(lines(3), ""), {
    ranges: [],
    cursor: [1, 0],
    deletions: [{ line: 1, lines: ["line 1", "line 2", "line 3"] }],
  });
});

test("repeated lines and a missing final newline do not confuse it", () => {
  assert.deepEqual(writeChanges("a\na\na\n", "a\na\na\na\n"), {
    ranges: [[4, 4]],
    cursor: [4, 0],
  });
  assert.deepEqual(writeChanges("a\nb", "a\nb\n"), { ranges: [] }); // The same lines.
  assert.deepEqual(writeChanges("a\nb\n", "a\nB"), {
    ranges: [[2, 2]],
    cursor: [2, 0],
  });
});

test("an insertion or deletion that could go in several places goes at a line start", () => {
  // "a0" inserted above "a1": character by character it could be "0\na" after the first "a".
  assert.deepEqual(writeChanges("x\na1\n", "x\na0\na1\n"), {
    ranges: [[2, 2]],
    cursor: [2, 0],
  });
  // A duplicated line removed: marked, like any deletion, at the line now where it was.
  assert.deepEqual(writeChanges("a\nsame\nsame\nb\n", "a\nsame\nb\n"), {
    ranges: [],
    cursor: [3, 0],
    deletions: [{ line: 3, lines: ["same"] }],
  });
  // Within a line, nothing to slide to: left where the characters differ.
  assert.deepEqual(writeChanges("abcabc\n", "abcXabc\n"), {
    ranges: [[1, 1]],
    cursor: [1, 3],
  });
});

test("a surrogate pair is never split", () => {
  // The two emoji share their first UTF-16 unit; the change must start before it, not inside.
  assert.deepEqual(writeChanges("x 😀\n", "x 😁\n"), {
    ranges: [[1, 1]],
    cursor: [1, 2],
  });
});

// Reads

test("a read marks the lines it asked for", () => {
  assert.deepEqual(readRanges({ path: "a", offset: 40, limit: 20 }), [
    [40, 59],
  ]);
  assert.deepEqual(readRanges({ path: "a", limit: 10 }), [[1, 10]]); // From the top.
  assert.deepEqual(readRanges({ path: "a", offset: 300 }), [[300, 300]]); // Where it started, to the end.
  assert.deepEqual(readRanges({ path: "a" }), []); // The whole file.
  assert.deepEqual(readRanges({ path: "a", offset: 1 }), []);
});

test("odd offsets and limits are made sense of", () => {
  assert.deepEqual(readRanges({ path: "a", offset: 0, limit: 5 }), [[1, 5]]);
  assert.deepEqual(readRanges({ path: "a", offset: -3 }), []);
  assert.deepEqual(readRanges({ path: "a", offset: 7.8, limit: 2.5 }), [
    [7, 8],
  ]);
  assert.deepEqual(readRanges({ path: "a", offset: 5, limit: 0 }), [[5, 5]]);
  assert.deepEqual(readRanges({ path: "a", offset: "5", limit: null }), []);
  assert.deepEqual(readRanges({ path: "a", offset: Infinity, limit: NaN }), []);
});
