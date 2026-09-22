# Your instructions

Copy this to `AGENTS.md` in the agent directory to apply it to every working directory, or to
the root of a project to apply it there.

This configuration deliberately ships **no** `AGENTS.md`. A fresh Claude Code install has no
user-level `CLAUDE.md` either — its behavior comes from the system prompt, not from a memory
file — so shipping one would bake somebody else's preferences into your sessions.

pi reads whichever of these it finds: `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`.
Everything in the file goes into the system prompt on every request, so keep it to things that
genuinely change what the agent does.

Some things people put here:

```markdown
## Code

- Match the conventions of the surrounding code.
- Prefer the shortest solution that stays readable.

## Git

- Never change git state without asking first.
- Write commit messages as Conventional Commits.

## Verification

- Run the project's tests and linter before reporting work as done.
```

Two shortcuts for filling it in:

- `#` followed by a note appends a line to it without leaving the session.
- `/init` writes a project-level `AGENTS.md` by reading the repository.
