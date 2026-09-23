# pi-claude-code

A custom agent-harness configuration for [**pi**](https://github.com/earendil-works/pi), the
extensible terminal coding agent from Earendil Works.

This repository contains *configuration only*. It does not vendor, build, or install pi
itself — it is the set of files pi reads out of its agent directory.

## What pi is

pi is a terminal AI agent: you give it a goal and a working folder, and it reads files, runs
commands, edits content, and works through multi-step tasks. It ships a small set of built-in
tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) and gets everything else from
resources you supply:

| Resource | What it is |
|---|---|
| **Context files** | `AGENTS.md` / `CLAUDE.md`, discovered from the agent dir, cwd, and parents |
| **System prompt** | `SYSTEM.md` replaces pi's prompt; `APPEND_SYSTEM.md` adds to it |
| **Settings** | `settings.json` — model, thinking level, tools, compaction, UI, resource paths |
| **Extensions** | TypeScript modules that add tools, `/` commands, event handlers, and UI |
| **Skills** | `SKILL.md` instruction packages loaded on demand |
| **Prompts** | Markdown templates exposed as `/` commands |
| **Themes** | JSON terminal themes |

Configuration is layered: user-level in the agent directory (`~/.pi/agent` by default, or
`PI_CODING_AGENT_DIR`), project-level in a `.pi/` directory that loads only after you grant
project trust.

Worth knowing up front: **pi has no built-in permission system.** It runs with the full
permissions of the user that launched it and does not ask before each tool call. Project trust
gates which project *resources* load; it does not sandbox tool calls. Anything resembling
approval prompts, allowlists, or path protection is something you add via an extension — which
is a large part of what this repository is for.

## What this repository is

A configuration that makes pi behave like [Claude Code](https://claude.com/claude-code):
the same tool surface, the same safety rails, the same authoring conventions for subagents,
slash commands, hooks, and skills.

pi already covers a good part of that natively — context files, sessions and forking,
compaction, skills, prompt templates. The rest is supplied here as extensions.

See [`docs/PARITY.md`](docs/PARITY.md) for the feature-by-feature mapping and the gaps
configuration cannot close, and [`docs/TOKENS.md`](docs/TOKENS.md) for how context is kept
small.

## Layout

```
settings.json        pi settings (model, tools, resource paths)
AGENTS.example.md    template for your own instructions (not loaded)
APPEND_SYSTEM.md     additions to pi's system prompt
permissions.json     allow / ask / deny rules for the permissions extension
checkpoints.json     working-tree snapshot and restore settings
features.json        one switch per feature this config adds
keybindings.json     key assignments
themes/              Claude palette, light and dark
hooks.json           shell hooks bound to lifecycle events
hooks.example.json   worked hook examples to copy from
agents/              subagent definitions, one Markdown file each
extensions/          TypeScript extensions
lib/                 shared helpers the extensions import
prompts/             slash-command templates
skills/              on-demand instruction packages
docs/                parity notes
```

## What it adds

Tools, on top of pi's built-in `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`:

| Tool | Claude Code equivalent |
|---|---|
| `todo_write` | `TodoWrite` |
| `task` | `Task` — runs a subagent from `agents/` in its own process |
| `web_fetch`, `web_search` | `WebFetch`, `WebSearch` |
| `ask_user` | `AskUserQuestion` |
| `exit_plan_mode` | `ExitPlanMode` |
| `bash_background`, `bash_output`, `bash_kill` | background `Bash`, `BashOutput`, `KillShell` |

Commands: `/plan`, `/rewind`, `/permissions`, `/agents`, `/todos`, `/jobs`, plus `/init`,
`/review`, `/commit`, `/pr`, `/security-review` from `prompts/`.

Behavior: tool calls pass through `permissions.json` before running, lifecycle events fire
the shell hooks in `hooks.json`, and the footer carries context usage and the git branch.

The working tree is checkpointed as you go and restored when you move around pi's session
tree — backwards, forwards, or onto a sibling branch. Snapshots are commits in a shadow git
repository that never touches the project's own `.git`. See
[`docs/CHECKPOINTS.md`](docs/CHECKPOINTS.md).

Interface: tool calls render as `⏺ Read(file.ts)` with an indented `⎿` result, the theme
carries Claude's palette in light and dark, `shift+tab` toggles plan mode, `ctrl+r` expands
tool output, and `#` appends a note to AGENTS.md. See [`docs/UX.md`](docs/UX.md).

## Whose preferences

This configuration matches **stock** Claude Code, not anyone's personal setup. It ships no
`AGENTS.md`, because a fresh Claude Code install has no user-level `CLAUDE.md` either — its
behavior comes from the system prompt. `APPEND_SYSTEM.md` carries that: tone, scope, context
discipline, verification, corrections, safety. Your own preferences go in an `AGENTS.md` you
write; `AGENTS.example.md` is a starting point.

Permissions match Claude Code's default mode: read-only tools run unprompted, everything else
asks, with the same "yes / yes, don't ask again this session / no" choices. The one deliberate
addition is a short deny list for credential files — empty `deny` in `permissions.json` for
literal stock behavior.

## Turning things off

Everything this configuration adds has a switch in `features.json`. Nothing is load-bearing for
anything else, so you can run as much or as little of it as you want - no subagents, no
checkpoints, pi's own tool rendering, whichever combination suits you.

```json
{ "task": false, "checkpoints": false, "uiHeader": false }
```

Keys default to `true`, so a missing key is never a silent disable. Run `/features` to see the
current state, and `/reload` after editing.

| Key | What it turns off |
|---|---|
| `permissions` | allow / ask / deny rules on every tool call |
| `hooks` | shell commands bound to lifecycle events |
| `checkpoints` | working-tree snapshots and `/rewind` |
| `task` | subagents |
| `todo` | the `todo_write` task list |
| `webFetch`, `webSearch` | reading pages, and search |
| `ask` | `ask_user` multiple-choice questions |
| `planMode` | `/plan` and the mutation block |
| `backgroundBash` | background jobs |
| `statusline` | context usage and branch in the footer |
| `memory` | the `#` shortcut |
| `uiToolRendering`, `uiHeader`, `uiWorkingIndicator` | the interface layer |

Switches are read from the agent directory only. A project's `.pi/features.json` is
deliberately ignored: extensions load before pi resolves project trust, so honouring one would
let a cloned repository switch off the permission gate that exists to contain it.

## Credentials

Nothing here requires an API key, a login, or a network account. Clone it, point pi at it, and
everything works — beyond the model provider pi itself is already configured with.

That includes `web_search`, which goes through DuckDuckGo's lite endpoint. That endpoint
rate-limits by IP and answers a burst of rapid queries with an anti-bot challenge instead of
results, so searches are serialized and spaced apart, and a challenge is retried once before
being reported. A handful of searches across a session stays well inside the limit.

Setting `BRAVE_API_KEY` or `TAVILY_API_KEY` switches to that provider and sidesteps the rate
limit. It is an upgrade, never a requirement.

The only external programs anything here calls are `git` (checkpoints and the status line, which
report and carry on if it is missing) and `pi` itself (subagents). `hooks.json` ships empty;
`hooks.example.json` is reference material and runs nothing until you copy from it.

## Using it

pi reads its user configuration from `~/.pi/agent`. Point that at this checkout — either by
symlinking it, or by setting `PI_CODING_AGENT_DIR` to this directory when you launch pi:

```sh
PI_CODING_AGENT_DIR=/path/to/this/repo pi
```

Run `/reload` inside a session after editing settings, instructions, or any resource.

## Caveats

The extensions here are written against pi's documented `ExtensionAPI` but have not been
executed against a pi install. Treat them as a starting point to verify, not as tested code.

## Contributing

Commit messages in this repository follow
[Conventional Commits](https://www.conventionalcommits.org): `type(scope): subject`, imperative
and lowercase after the colon, with the body explaining *why*. `git log` is the reference.

## License

MIT
