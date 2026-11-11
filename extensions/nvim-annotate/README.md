# nvim-annotate

Lets Pi explain code where you read it, in the Neovim it runs inside: notes on the code
itself, above its lines, numbered in the order Pi adds them, so that it can walk you through
code one note at a time. Notes are anchored to their code: they move with your edits, and hide
while their lines are deleted. Built on [nvim-virtual-text](../nvim-virtual-text/README.md),
which draws them, and [nvim-point](../nvim-point/README.md), which takes you to them; needs no
install.

## For you

`:PiNotes next` and `:PiNotes prev` in Neovim go to the next or previous note (passing over
those whose lines are deleted), `:PiNotes 3` to note 3; `:PiNotes` alone is next. Each shows
the note's code in your window, your cursor on it, and says which it is.

In Pi, `/nvim-annotate` lists the notes, where their code is now; `/nvim-annotate next`,
`prev` or a number goes to one, focusing your window; `/nvim-annotate clear` removes them all.
Notes last until cleared, and go when Pi detaches from Neovim.

## The tool

`nvim_annotate({ action, notes?, note?, show? })`

| Action | Does | Needs |
| --- | --- | --- |
| `add` | Places notes after those there, numbered on. All of them or, if one cannot be (its file or code not there), none. Says each as `list` does, so that a `match` that found other code than meant shows; failing, says every note that cannot be placed, and why. With `show: true`, then takes you to the first note added. | `notes` |
| `list` | Each note: its number, file and lines now, the code it is on, and its text. | — |
| `show` | Takes you to a note, as `:PiNotes` would; your focus stays where it is. | `note`, its number |
| `clear` | Removes every note. | — |

Each note in `notes`:

| Field | |
| --- | --- |
| `file` | The file, from Pi's working directory or absolute. |
| `match` | The code it is on: lines of it, the space around them aside. Better than `line`, as it moves with the code; with `line` too, the occurrence nearest it. |
| `line` | Or the line it is on. |
| `text` | The note. It is drawn above the lines, its number first, wrapped to the window and indented to the code. |
| `kind` | Its color: `info` (default), `hint`, `warn` or `error`, as the diagnostics of that name. |

For a walkthrough Pi adds its notes in the order to read them, with `show: true` to take you
to the first; you go on with `:PiNotes next`. When you are typing, showing a note does nothing and says so: Pi's notes
never move your cursor while you are busy.

## Development

```sh
node --test --test-timeout=30000 *.test.ts
../nvim-service/node_modules/.bin/tsc -p tsconfig.json
```

The tests run their own headless Neovim, never the one they might be started from. The tool's
schema is in `index.ts`, apart from the rest (`annotate.ts`), since its package is Pi's own,
which the tests run without.
