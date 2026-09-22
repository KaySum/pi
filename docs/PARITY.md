# Claude Code parity

What this configuration provides, what pi already had, and what configuration cannot reach.

## Tools

| Claude Code | Here | Notes |
|---|---|---|
| `Bash` | `bash` | Built in |
| `Read` | `read` | Built in; reads text files and supported images |
| `Edit` | `edit` | Built in |
| `Write` | `write` | Built in |
| `Glob` | `find` | Built in |
| `Grep` | `grep` | Built in |
| `TodoWrite` | `todo_write` | `extensions/todo.ts` |
| `Task` | `task` | `extensions/task.ts` |
| `WebFetch` | `web_fetch` | `extensions/web.ts` |
| `WebSearch` | `web_search` | `extensions/web.ts`; optional, registered only when a key is set |
| `AskUserQuestion` | `ask_user` | `extensions/ask.ts`; single question, no multi-select |
| `ExitPlanMode` | `exit_plan_mode` | `extensions/plan-mode.ts` |
| `Bash(run_in_background)` | `bash_background` | `extensions/background-bash.ts` |
| `BashOutput` | `bash_output` | `extensions/background-bash.ts` |
| `KillShell` | `bash_kill` | `extensions/background-bash.ts` |
| `NotebookEdit` | — | Not implemented; `edit` works on `.ipynb` JSON at your own risk |
| `SlashCommand` | — | The model cannot invoke a slash command; the user runs it |

## Configuration

| Claude Code | Here | Notes |
|---|---|---|
| `CLAUDE.md` memory | `AGENTS.md` | Native. pi also reads `CLAUDE.md` from the agent dir, cwd, and parents |
| Output styles | `APPEND_SYSTEM.md` | Adds to pi's prompt; `SYSTEM.md` replaces it entirely |
| `.claude/settings.json` | `settings.json` | Different keys — see pi's settings reference |
| Permissions (`allow`/`ask`/`deny`) | `permissions.json` | `extensions/permissions.ts` |
| Permission modes | `defaultMode` + `/plan` | `allow` ≈ acceptEdits, `ask` ≈ default, `deny` ≈ deny-by-default |
| Hooks | `hooks.json` | `extensions/hooks.ts` |
| Subagents (`.claude/agents`) | `agents/` | Also reads `.pi/agents/` and `.claude/agents/` |
| Skills | `skills/` | Native, plus `~/.agents/skills/` and `.agents/skills/` |
| Slash commands | `prompts/` | Native prompt templates |
| Checkpoint / restore | `checkpoints.json` | `extensions/checkpoints.ts`; see [CHECKPOINTS.md](CHECKPOINTS.md) |
| Status line | `extensions/statusline.ts` | Built-in text, or an executable `statusline` in the agent dir |
| Transcript layout | `extensions/ui.ts` | Bullet/branch tool rendering; see [UX.md](UX.md) |
| Theme | `themes/claude*.json` | Claude palette, light and dark |
| Keybindings | `keybindings.json` | `ctrl+r` expand, `shift+tab` plan mode |
| `#` memory shortcut | `extensions/memory.ts` | Appends a note to AGENTS.md |
| Themes | `themes/` | Native |
| Plugins / marketplace | pi packages | `pi install npm:…` or `git:…`; different ecosystem |
| MCP servers | — | pi has no MCP client. See below |

## Sessions

| Claude Code | Here | Notes |
|---|---|---|
| `/compact` | `/compact` | Native, plus automatic compaction |
| `/resume`, `--continue` | `/resume`, `-c` | Native |
| `/clear` | `/new` | Native |
| `/export` | `/export`, `/share` | Native |
| `/rewind` checkpoints | `/rewind`, `/tree`, `/fork` | `extensions/checkpoints.ts` — restores code in both directions |
| Background tasks | `bash_background` | `extensions/background-bash.ts` |

## Gaps

**MCP.** pi has no MCP client, so MCP servers cannot be configured here. The closest
equivalent is writing an extension that registers the tools directly, or exposing the server
through a CLI the agent calls with `bash`.

**Sandboxing.** pi deliberately ships no permission system; `permissions.json` here is an
extension gating tool calls inside the process, not an OS boundary. A blocked rule stops the
agent, not a process the agent already started. For a real boundary, run pi in a container —
pi documents Docker, a Gondolin micro-VM, and OpenShell patterns.

**Keyless web search.** There is no search backend that works without a credential.
DuckDuckGo's HTML endpoint answers a few queries and then returns an anti-bot challenge, its
official API returns nothing for ordinary queries, and the independent engines require
JavaScript to pass a challenge. `web_search` is therefore registered only when a provider key
is configured; `web_fetch` covers reading known pages without one.

**Notebooks.** No structured notebook editing.

**Hosted surfaces.** IDE extensions, the desktop and web apps, and GitHub Actions are
product surfaces, not configuration. pi offers its own integration paths instead: print mode,
a JSON event stream, an RPC protocol, and a TypeScript SDK.

## Known rough edges

- Bash permission rules match the whole command string, so `cd app && git push` does not match
  `bash(git push:*)`. Compound commands can slip past a prefix rule.
- `bash_background` is checked against the `bash(...)` rules, since it runs the same shell.
- `task` shells out to `pi` on `PATH`. If pi is installed elsewhere, the tool fails at spawn.
- `web_fetch` strips HTML with regular expressions. It is fine for documentation and issues,
  and poor on heavily scripted pages.
- Plan mode's read-only bash allowlist is conservative; expect to approve things it rejects.
- `extensions/ui.ts` re-registers pi's built-in tools to restyle them. It preserves their
  definitions and delegates execution, but it is the riskiest piece here; set
  `toolRendering: false` in `ui.json` to fall back to pi's own rendering.
- Checkpoints cover the working directory only. A restore cannot undo a migration that already
  ran, a request already sent, or a file written outside the project.
