# Token efficiency

What Claude Code does to keep context small, and where each mechanism lives here.

## Progressive disclosure

Only names and descriptions sit in the system prompt; the body loads when it is needed.

| Resource | In context always | Loaded on demand |
|---|---|---|
| Skills | name, description | `SKILL.md` body, when the task matches or you run `/skill:name` |
| Subagents | name, description, inside the `task` tool description | the agent's full instructions, inside the subagent process |
| Prompt templates | command name | the template body, when invoked |

This is pi's native behavior for skills and templates. Writing a skill description that says
both *what it does* and *when to use it* is what makes the lazy load fire at the right time.

## Context isolation

`task` runs a subagent as a separate `pi --print` process. Its file reads, greps, and dead ends
stay in that process; only the final report crosses back. That is the single largest lever for
a search-heavy question, and the reason `agents/explore.md` is told to report locations rather
than paste file contents.

## Output caps

An uncapped tool result is the most common way a window fills up without anyone noticing. Every
tool here bounds what reaches the model, while keeping the full text in the result `details`,
which pi does not send:

| Tool | Cap | Which end is kept |
|---|---|---|
| `web_fetch` | 60,000 chars | Start, with a pointer to fetch the rest |
| `web_search` | 10 results, 300 chars per snippet | Snippets are for choosing what to fetch |
| `task` | 30,000 chars | Start of the report |
| `bash_output` | 16,000 chars | **End** — for a build or test run the newest output is the point |

`bash_output` keeps a 200,000-character rolling buffer but only sends the tail, so a chatty dev
server does not cost 50k tokens per read.

## Prompt caching

The system prompt has to be byte-identical across requests to stay cached. Nothing here
rewrites it per turn: `SYSTEM.md` is absent, `APPEND_SYSTEM.md` is static, and no extension
returns `systemPrompt` from `before_agent_start`.

Plan mode injects its reminder as a message **once per activation** rather than once per
request. Re-sending it every turn would both cost tokens and accumulate copies of itself.

`cacheWarming` is set to `streaming` in `settings.json`, and `showCacheMissNotices` is on so a
cache miss is visible rather than silent.

## Compaction

pi compacts automatically. `settings.json` reserves 16,384 tokens for the response and keeps
24,000 tokens of recent turns unsummarized — slightly above pi's default, trading a little
context for fewer summarization passes on long sessions.

`/compact` takes custom instructions if you want the summary to preserve something specific.

## Behavior

The rest is prompt discipline, in the "Context discipline" section of `APPEND_SYSTEM.md`:
search before reading, read with `offset`/`limit` rather than whole files, never re-read a file
to confirm a write, pipe command output through `head`/`grep` instead of dumping it, batch
independent tool calls, and prefer `edit` over `write` so only the changed region is sent.

## What costs tokens here

Being honest about the other side of the ledger:

- **16 tools** are registered — 7 built-in plus 9 custom. Each carries a description and a JSON
  schema in every request. They cache, but they are not free. Trim `defaultTools` in
  `settings.json` for the built-ins, and switch off what you do not use in `features.json`.
- **`APPEND_SYSTEM.md`** adds roughly 900 tokens to the cached prefix.
- **The `task` tool description** grows with each file in `agents/`, since the roster is
  embedded in it.
- **Checkpoint entries** cost nothing: they are `CustomEntry` records, which pi keeps out of
  model context entirely.
