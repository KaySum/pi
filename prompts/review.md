---
description: Review the current diff for correctness bugs and cleanups
argument-hint: "[path or focus area]"
---

Review the uncommitted changes in this repository. Focus area, if given: $ARGUMENTS

Start with `git status` and `git diff` (and `git diff --staged`), then read each changed file
around the change — a diff hunk rarely carries the context needed to judge it.

Look for, in this order:

1. **Correctness** — logic that produces a wrong result, unhandled cases, broken invariants,
   race conditions, resource leaks, off-by-one and boundary errors.
2. **Reuse** — code that reimplements something the codebase already has.
3. **Simplification** — the same behavior with materially less code.
4. **Efficiency** — work done repeatedly that could be done once, on a path where it matters.

Only report a finding you can state as a concrete failure: the inputs or state, and what goes
wrong as a result. If you cannot describe the failure, it is a preference — leave it out.

For each finding, give the location as `path/to/file.ts:42`, one sentence on the defect, the
failure scenario, and the fix. Order them most severe first.

Say "no findings" plainly if the change is sound. Do not comment on formatting a linter owns.
