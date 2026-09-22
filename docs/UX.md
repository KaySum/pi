# Interface parity

pi's terminal UI is already close to Claude Code's in structure: a scrolling transcript, an
editor at the bottom, a footer, slash-command autocomplete, inline images, and markdown
rendering. The differences are in presentation, and those are what this layer changes.

## Transcript layout

pi frames every tool call in a coloured box. Claude Code uses a flat bullet with an indented
result underneath. `extensions/ui.ts` re-registers the built-in tools with
`renderShell: "self"` and custom renderers to match:

```
⏺ Read(src/session.ts)
  ⎿  Read 142 lines

⏺ Update(src/session.ts)
  ⎿  Updated with +12 / -3
     - const timeout = 30
     + const timeout = 60

⏺ Bash(npm test)
  ⎿  PASS  src/session.test.ts
     … +38 lines (ctrl+r to expand)
```

Tool names follow Claude Code's vocabulary rather than pi's: `Read`, `Update`, `Write`,
`Bash`, `Search` (grep), `Glob` (find), `List` (ls), `Task`, `Update Todos`.

Execution is untouched. Each override spreads the original tool definition — description,
parameters, prompt snippet, guidelines, execution mode — and delegates `execute` to the
original instance, replacing only `renderCall` and `renderResult`.

Todos render as a checklist, with completed items dimmed:

```
⏺ Update Todos
  ⎿  ☒ Read the session manager
     ☐ Add the restore path
     ☐ Cover it with a test
```

## Theme

`themes/claude.json` and `themes/claude-light.json` carry Claude's palette: clay/terracotta
accent, warm neutrals, muted syntax colors. `settings.json` selects `claude-light/claude`, so
pi follows the terminal's light or dark appearance the way Claude Code does.

Both files declare the same colour keys as pi's built-in themes, so they validate against
pi's theme schema.

## Header

A welcome box replaces pi's startup header, sized to the terminal:

```
╭────────────────────────────────────────╮
│ ✻ Welcome to pi                        │
│                                        │
│   /help for commands, /plan to plan    │
│                                        │
│   model: claude-sonnet-4-6             │
│   cwd:   ~/code/project                │
╰────────────────────────────────────────╯
```

## Working indicator

A star spinner (`· ✢ ✳ ∗ ✻ ✽`) with a rotating verb, elapsed seconds, and the interrupt hint:

```
✻ Percolating… (14s · esc to interrupt)
```

The word changes every 20 seconds. The timer starts on `agent_start` and is cleared on
`agent_end` and shutdown — never in the extension factory, which pi also loads in contexts
that never start a session.

## Keys

`keybindings.json` moves pi's defaults onto Claude Code's:

| Action | Claude Code | Here |
|---|---|---|
| Expand tool output | `ctrl+r` | `ctrl+r` or `ctrl+o` |
| Cycle plan mode | `shift+tab` | `shift+tab` |
| Interrupt | `esc` | `esc` — pi default |
| Clear editor, then exit | `ctrl+c` | `ctrl+c` — pi default |
| Exit | `ctrl+d` | `ctrl+d` — pi default |
| Newline | `shift+enter` | `shift+enter` or `ctrl+j` — pi default |
| Paste image | `ctrl+v` | `ctrl+v` — pi default |
| Queue a follow-up | — | `alt+enter` — pi only |
| Session tree | — | `ctrl+shift+t` |

`shift+tab` is pi's thinking-level cycle by default. To give it to plan mode the way Claude
Code does, `keybindings.json` moves thinking to `alt+t`. Run `/hotkeys` for the live list.

## Input shortcuts

| Prefix | Effect |
|---|---|
| `/` | Slash commands, with autocomplete — native |
| `!` | Run a shell command directly — native |
| `#` | Append a note to AGENTS.md — `extensions/memory.ts` |
| `@` | Attach a file to the prompt — native on the command line |

## What pi does that Claude Code does not

Worth not flattening away in the name of parity:

- **`/tree`** — the session is a tree, not a line. You can move to any point and branch.
- **Fullscreen mode** (`tuiMode: "fullscreen"`) with transcript search.
- **Model cycling** across a scoped set, with per-model thinking levels.
- **Mermaid diagrams** rendered in the transcript.
- **`/share` and `/export`** to HTML.

## Gaps

- **Vim mode.** pi has a modal-editor extension example that could supply it; this
  configuration does not include one.
- **`@` autocomplete in the editor.** pi resolves `@path` on the command line. In-editor file
  completion is not wired up here.
- **Cost summary on exit.** `/session` shows usage on demand instead.
- **Strikethrough on completed todos.** Rendered dim instead, since theme colours compose more
  reliably than raw ANSI attributes.

## Turning it off

`features.json` in the agent directory:

| Key | Default | Effect |
|---|---|---|
| `uiToolRendering` | `true` | Claude Code tool layout; `false` restores pi's boxes |
| `uiHeader` | `true` | Welcome box |
| `uiWorkingIndicator` | `true` | Spinner, verb, and elapsed time |

Tool rendering is the one to disable first if a built-in tool misbehaves, since it is the only
part that re-registers pi's own tools. Run `/features` to see the current state.
