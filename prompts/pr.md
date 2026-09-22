---
description: Open a pull request for the current branch
argument-hint: "[title or context]"
---

Open a pull request for the current branch.

Understand the full set of changes first — not just the latest commit. Check `git status`,
`git log <base>..HEAD`, and `git diff <base>...HEAD` against the branch this will merge into.
Confirm the branch is pushed and has an upstream.

Write the description for a reviewer who has not been following along:

- **What** the change does, in a sentence or two
- **Why** it is being made — the problem, the bug, the requirement
- **How** to verify it: the specific commands, or the steps to exercise it manually

Keep it proportional. A one-file fix does not need five sections.

$ARGUMENTS

Show me the title and body, and ask before creating the PR.
