# nvim-navigation

Lets Pi follow code by meaning, through the language servers of its own Neovim. Requires
[`nvim-service`](../nvim-service/README.md); it has no dependencies or install step of
its own.

## The tool

`nvim_navigate({ action, file, line?, symbol?, column?, query?, timeoutMs? })`

| Action | Answers | Needs |
| --- | --- | --- |
| `definition` | Where the symbol is defined | `line` and `symbol` or `column` |
| `type` | Where its type is defined | same |
| `implementation` | What implements it | same |
| `declaration` | Where it is declared | same |
| `references` | Everywhere it is used, declaration included | same |
| `hover` | Its type and documentation | same |
| `symbols` | The file's outline, optionally filtered by `query` | — |
| `workspace_symbols` | Symbols across the project whose name matches `query` | `query` |

A symbol is pointed at by its line and its text on that line: `{ line: 3, symbol: "greet" }`
means the first `greet` on line 3. `column` (1-based, in bytes) picks a later occurrence
or replaces `symbol`.

```
4 references for greet — vtsls
src/defs.ts
  8:17  export function greet(name: string): string {
src/main.ts
  1:10  import { greet, FriendlyGreeter } from "./defs";
  3:17  const message = greet("Pi");
  5:41  console.log(message, g.greet("é😀"), greet("x"));
```

```
5 symbols in src/defs.ts — vtsls
  1: interface Greeter
    1: method greet
  3: class FriendlyGreeter
    4: method greet
  8: function greet
```

Every location comes with its source line, so Pi rarely has to open the file to see what
it found. Lines and byte columns are 1-based. At most 100 results are listed.

## Debugging: `/nvim-navigation`

Without arguments it lists the language servers in Pi's Neovim, whether each is ready, and
which actions it can answer, followed by the most recent question and its answer:

```
Language servers in Pi's Neovim:
  rust-analyzer (1): ready; 1 buffer; root /Users/xsv/project
    answers: declaration, definition, hover, implementation, references, symbols, type, workspace_symbols

Last question 8 s ago, took 4 ms: {"action":"references","file":"src/main.rs","line":1,"symbol":"Point"}
3 references for Point — rust-analyzer
  ...
```

With a question it asks it and adds a timeline of every wait, request and reply:

```
/nvim-navigation definition src/main.rs 9 sum
/nvim-navigation hover src/main.rs 8 13            (a number instead of a symbol is a column)
/nvim-navigation symbols src/main.rs [filter]
/nvim-navigation workspace_symbols src/main.rs Point
```

```
1 definition for sum — rust-analyzer
src/main.rs
  4:8  fn sum(&self) -> i32 { self.x + self.y }

Timeline (4666 ms):
  244 ms  main.rs: loaded
  244 ms  asking about "sum" at 9:22
  370 ms  rust-analyzer is just started
  872 ms  rust-analyzer is ready
  872 ms  main.rs: sent under a new document version
  872 ms  rust-analyzer asked for textDocument/definition
  872 ms  rust-analyzer answered with nothing
  874 ms  nothing, from a server that started recently or about a file it was only just shown; waiting for calm, then asking again
 4664 ms  rust-analyzer asked for textDocument/definition
 4666 ms  rust-analyzer answered with a result
```

Arguments are split on whitespace, so the command cannot take a path or symbol containing
spaces.

## What it takes care of

- **The files on disk are what is asked about.** Every loaded buffer that no longer
  matches its file is reloaded first, not only the one named: where a symbol is defined
  or used is a question about the whole project, and a server answers from the buffers
  it has open. A buffer with unsaved changes is used as it is, and the answer is marked
  `(unsaved buffer)`. A buffer whose file has been deleted is closed, so its contents
  stop counting as part of the project.
- **The server is made to notice.** Neovim opens a reloaded document under its old
  version number, and some servers cache by version (vtsls would return the old
  outline). Each such document is sent again under a new version, once its servers are
  attached again after the reload.
- **A symbol is the whole word.** `symbol: "name"` means the word `name`, not the end of
  `rename`; inside a longer word only if that is all the line has.
- **A server that is still loading is not believed.** One that has just started, or is
  showing progress, is waited for. rust-analyzer answers "nothing" before it has loaded
  the project and only then starts showing progress, so an empty answer from a server
  that started in the last 15 s is asked for again once it has been calm for 0.7 s. So is
  an empty answer about a file the editor has only just opened: a new Rust module means
  nothing to rust-analyzer until it has noticed the `mod` line in another file.
- **A server whose state changed under the request** (it says so with an error) is asked
  again, up to three times.
- **Every server that can answer is asked**, and their answers are merged without
  duplicates. One that failed is named in the header; one that does not support the
  action is left out.

If the header says servers were still loading, the answer may be incomplete: ask again.
An empty result from a server that answered is real.

Measured with Neovim 0.12.6: a question to a running server takes 3–60 ms. The first one
to a server takes as long as it needs to load the project: about 1 s for pyright, 2 s
for vtsls and lua_ls, 4.5 s for rust-analyzer.

## Development

```sh
node --test --test-timeout=40000 *.test.mjs
../nvim-service/node_modules/.bin/tsc -p .
```

The tests run a real Neovim against [`test/lsp.mjs`](test/lsp.mjs), a scriptable language
server. They need `nvim-service`'s dev dependencies (`npm ci --prefix ../nvim-service`).

### Checking answers against known truth

The tests cannot show that an answer about real code is right, and a fake server attaches
and loads in ways real ones do not. [`test/oracle.mjs`](test/oracle.mjs) checks the tool
against your real servers with answers that are known without asking anyone:

```sh
node test/oracle.mjs                       # TypeScript, Python and Rust; takes several minutes
node test/oracle.mjs rust --seed=7         # one language, one particular project
node test/oracle.mjs --rounds=10 --questions=50 --keep
```

It generates a project in which every symbol has a unique name. For such a name, "every
reference" is exactly "every whole-word occurrence in the project", which a text search
finds, and the generator knows where and how it defined each one. It then changes the
project on disk over and over (lines inserted, symbols renamed, functions moved between
files, the order of a file shuffled, files added and removed) and after every change asks
random questions and compares each answer, exactly, with that truth: the one place for a
definition, the complete set for references, the line of every symbol in an outline.

Some questions are not left to chance, because the bugs they catch need a particular
sequence: one file's outline is asked for twice running with a change in between (a
server may cache the last outline it gave), and a name that stands on a line after a
longer name containing it is asked for by its text.

Each language runs under three schedules:

| Schedule | Stands for |
| --- | --- |
| asked at once after a change to open files | A formatter or `git` rewriting files the editor has open |
| asked 1 s after each change | Any outside change, including files added and removed |
| asked while a diagnostics warm-up runs | Pi's own edit followed at once by a question |

The first round of each is a cold start. A wrong answer is printed with what was expected,
and the seed replays the same project and questions. Putting each fixed bug back, one at
a time, makes it fail; that is how its sensitivity was checked.

What a pass means: for these three languages, every kind of question, and the changes and
schedules above, the answers were exactly right. What it does not cover:

- **An outside change to a file that is not open, asked about at once.** Servers learn of
  those from their file watchers, which take a moment; the second schedule allows 1 s.
  Pi's own edits are not affected: the warm-up opens the file.
- **Projects much larger than the generated one**, where a server may load for longer, or
  more quietly, than the waits described above allow for.
- **Code a server is itself unsure about** (overloads, macros, dynamic dispatch). Unique
  names sidestep that on purpose.
- **`type` for Rust.** rust-analyzer gives no type definition for the name of a static
  item, which is the only typed value the generated code has.
