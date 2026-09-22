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

See [`docs/PARITY.md`](docs/PARITY.md) for the feature-by-feature mapping, including the gaps
that configuration cannot close.

## Layout

```
settings.json        pi settings (model, tools, resource paths)
AGENTS.md            user-level instructions applied across working directories
APPEND_SYSTEM.md     additions to pi's system prompt
permissions.json     allow / ask / deny rules for the permissions extension
hooks.json           shell hooks bound to lifecycle events
hooks.example.json   worked hook examples to copy from
agents/              subagent definitions, one Markdown file each
extensions/          TypeScript extensions
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

Commands: `/plan`, `/permissions`, `/agents`, `/todos`, `/jobs`, plus `/init`, `/review`,
`/commit`, `/pr`, `/security-review` from `prompts/`.

Behavior: tool calls pass through `permissions.json` before running, lifecycle events fire
the shell hooks in `hooks.json`, and the footer carries context usage and the git branch.

`web_search` needs a provider key in the environment — `BRAVE_API_KEY` or `TAVILY_API_KEY`.

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

## License

MIT
