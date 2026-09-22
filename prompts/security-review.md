---
description: Security review of the changes on this branch
argument-hint: "[path or focus area]"
---

Review the changes on this branch for security defects. Focus area, if given: $ARGUMENTS

Diff against the base branch, then read each changed file in context. Trace untrusted input
from where it enters to where it is used.

Look for:

- Injection: SQL, shell, template, path traversal, deserialization of untrusted data
- Authentication and authorization: missing checks, checks on the wrong object, privilege
  escalation through a parameter the caller controls
- Secrets: credentials in source, tokens in logs or error messages, keys in client bundles
- Cryptography: home-rolled primitives, weak or missing randomness, comparisons that leak timing
- Input handling: missing validation on a trust boundary, unsafe defaults, over-broad CORS
- Dependencies: new packages, and what they were given access to

Report each finding with its location, the attack it enables, the conditions required, and the
fix. Distinguish what you confirmed from what you suspect.

Do not report theoretical issues with no path from an attacker to the code. Say so plainly if
the change introduces no security-relevant behavior.
