---
name: harness-authoring
description: Add or change a resource in this pi configuration - an extension, subagent, skill, prompt template, permission rule, or hook. Use when asked to extend, customize, or debug the agent harness itself.
---

# Authoring harness resources

This configuration is the agent directory pi reads at startup: `settings.json`, context files,
`extensions/`, `agents/`, `skills/`, `prompts/`, plus `permissions.json` and `hooks.json` that
the extensions here define. Run `/reload` after changing any of them.

Pick the smallest resource that does the job. Reach for an extension only when instructions
genuinely cannot express the behavior.

| Need | Resource |
|---|---|
| A reusable prompt | `prompts/<name>.md` → `/<name>` |
| Instructions loaded on demand | `skills/<name>/SKILL.md` |
| Work delegated to its own context window | `agents/<name>.md` |
| Always-on instructions | `AGENTS.md` or `APPEND_SYSTEM.md` |
| A new tool, command, or event handler | `extensions/<name>.ts` |
| Gate a tool call | a rule in `permissions.json` |
| Run a shell command on an event | an entry in `hooks.json` |

## Prompt templates

Markdown with optional `description` and `argument-hint` frontmatter. The filename becomes the
command name. Arguments substitute as `$1`, `$2`, `$@`, `$ARGUMENTS`, and `${1:-default}`.

## Skills

A directory with `SKILL.md`: frontmatter `name` (lowercase, hyphens, ≤64 chars) and
`description` (≤1024 chars), then the instructions. pi indexes the description at startup and
loads the body only when it matches the task, so the description must say both *what it does*
and *when to use it*. Supporting scripts and references live alongside it.

## Subagents

Markdown with `name` and `description` frontmatter, optional `tools` and `model`; the body is
the subagent's instructions. It runs in a separate process with no view of the parent
conversation, so its instructions must specify the exact shape of the report it returns.

## Extensions

A `.ts` file exporting a default factory that receives `ExtensionAPI`. pi loads it through
jiti, so there is no build step.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({ name, label, description, parameters, execute });
  pi.registerCommand(name, { description, handler });
  pi.on("tool_call", (event, ctx) => ({ block: true, reason: "..." }));
}
```

Rules worth remembering:

- Do not start processes, sockets, watchers, or timers in the factory — some invocations load
  extensions without starting a session. Start them from `session_start`, and release them
  from an idempotent `session_shutdown`.
- A `tool_call` handler that throws blocks the tool. That is the intended fail-safe, but it
  means a bug in a handler stops real work.
- Tool state that should follow session branching belongs in the tool result's `details`, not
  in a module-level variable alone; rebuild it from `ctx.sessionManager.getBranch()` on
  `session_start` and `session_tree`.
- Guard terminal-only UI with `ctx.mode === "tui"`, and dialogs with `ctx.hasUI`. Extensions
  also load in print, JSON, and RPC modes, where there is no one to answer a prompt.
- Extensions run with full user permissions and can see prompts, files, and credentials.

Types are documented in pi's `packages/coding-agent/src/core/extensions/types.ts`, and there
are worked examples in `packages/coding-agent/examples/extensions/`.
