---
description: Write or refresh this project's AGENTS.md
argument-hint: "[extra instructions]"
---

Analyze this repository and write an `AGENTS.md` at its root that would let an agent be
productive here immediately.

Investigate first: the build and test commands that actually work, the directory layout and
what lives where, the conventions the existing code follows, and anything non-obvious that a
newcomer would get wrong. Read the README, the package manifest, the CI config, and a
representative slice of the source.

Write down what is true of this repository, not generic advice. Skip anything an agent can
infer from the file tree in ten seconds.

Cover, only where there is something real to say:

- The commands to build, test, lint, and run — verified, not guessed
- The architecture in a short paragraph: the pieces and how they connect
- Conventions the code actually follows, including ones that differ from the language default
- Traps: generated files, things that must stay in sync, slow or flaky steps

If an `AGENTS.md` or `CLAUDE.md` already exists, update it rather than replacing it, and keep
anything still accurate.

$ARGUMENTS
