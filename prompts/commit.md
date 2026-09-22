---
description: Commit the current changes with a well-written message
argument-hint: "[message hint]"
---

Commit the current changes.

First look at what you are committing: `git status`, `git diff --staged`, `git diff`, and
`git log --oneline -10` to match the repository's existing message style.

If nothing is staged, stage the files that belong to this change — and only those. Unrelated
edits in the working tree stay out of this commit; say so rather than sweeping them in.

Write the message to explain *why* the change was made, not to list what changed. The diff
already says what changed. Use the imperative mood and the repository's existing conventions.
A one-line subject is enough unless the change genuinely needs a body.

$ARGUMENTS
