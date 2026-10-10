# Diagnostics snapshot and check contracts

This is the completion model, not a promise that every project checker has run.
No quiet period is evidence that an unobserved provider completed.

## Inputs

- `mode: "snapshot"` is the default and preserves the existing best-effort cache
  reader. `requiredClients` is not accepted in this mode.
- `mode: "check"` requires 1–16 unique, exact, case-sensitive LSP client names in
  `requiredClients`, for example `["pyright"]` (not diagnostic source `Pyright`).
  The same requirements apply to every explicit file; batch files by requirements.
- The existing whole-call deadline includes queue time, loading, discovery,
  requests, conversion, and final source verification. No server is installed,
  enabled, restarted, or inferred from the file extension to satisfy a requirement.

## Snapshot mode

Snapshots read all `vim.diagnostic` namespaces after best-effort collection.
Their `updated`/`cached` statuses describe observations, never a completed check.
Missing providers cannot be inferred from the set of providers already observed.
The existing quiet-period heuristic is only a snapshot collection policy.

## Check mode

Check completion concerns **owned document-diagnostic responses for the declared
client names**, not the diagnostic cache and not Neovim's automatic requests.

For each file:

1. At least one attached instance of every required name must be observed.
2. All currently observed attached instances matching a required name must be
   initialized and expose their applicable document-pull registrations. Track
   provider identifiers independently. A single-match legacy accessor is not
   evidence that every matching dynamic registration was enumerated.
3. Every current required provider must answer this call's own **uncancelled**
   request with a valid `full` response. A reply to an observed cancelled request
   cannot satisfy the check, even if the server returns an ordinary empty `full`
   result instead of a cancellation error. An `unchanged` response without a
   baseline, an arbitrary diagnostic event, a cache hit, or a push publication
   cannot satisfy the check.
4. The requested source revision must remain stable. The loaded logical UTF-8
   lines must match the disk snapshot; preserve modified-buffer conflicts.
   Reverify disk hashes and buffer revisions before reporting completion.
5. The responses must be safely converted and retained within collection limits.
   Malformed/unconvertible diagnostics and collection omissions cannot turn into
   a complete zero-diagnostic result.

Only required clients receive tool-owned pulls in check mode. Unrelated clients
are visible but cannot satisfy the requirements or delay a completed check.
Other consumers' requests and configured automatic diagnostics are not cancelled.

Check diagnostics come from retained **owned replies**, converted against the
input snapshot, not from rereading a cache which unrelated/late publications
can overwrite. Only the anchor document is checked; related-document results do
not establish coverage for additional files.

`check.status` is separate from observation/file statuses and diagnostic severity:

| Status | Meaning |
| --- | --- |
| `not_requested` | Snapshot mode; no check was attempted. |
| `complete` | Every file satisfies the required-provider response and source-verification conditions. Type errors may still be present. |
| `incomplete` | The deadline or a final verification race prevented establishing completion, including missing/initializing clients, pending replies, or unverifiable push-only completion. |
| `failed` | A required request/lookup failed, a source conflicted/changed, or response validation/collection failed. Partial useful results may remain. |

A permanently missing checker and a checker that might attach later look alike
until the deadline. Public Neovim discovery currently omits clients waiting for
initialization, so those remain `missing` (not observed), not a fabricated
`initializing` or proven absent state. A push-only client stays unconfirmed; a dynamic pull capability
can still arrive before that deadline. Neither condition is a successful check.
Terminal required-provider failures may finish the check early. Client detachment
invalidates its participation. Provider disappearance, identifier changes, or
changes to the matching registration option values retire obsolete owned work.
Equivalent registration aliases and duplicate selector matches do not: UUIDs,
object identities, and duplicate counts are not distinct diagnostic providers.
Only currently applicable providers can satisfy completion. Client-instance
(16 per file), provider-identifier (16 per client/file), and attempt (three per
identifier) limits apply across the call, not anew for each registry change or
retry. Identifiers are bounded to 512 bytes; each lookup permits at most 128
matching registrations, including duplicates. Canonical option encoding is bounded
to 64 KiB, 2048 visited keys/values, and nesting depth 16 per lookup; invalid or
excessive option structures fail explicitly.

A public cancellation event marks the owned attempt unusable but does **not**
complete it. Wait for its reply/completion before retrying, within the original
three-attempt limit and deadline. Discard cancelled replies before retaining check
results or invoking the snapshot cache handler. Cancellation acknowledgements
whose callbacks Neovim suppresses still use deferred completion bookkeeping.

The boundary is deliberately finite: required names and the attached matching
instances/registrations observed at final verification. It does not certify that
no additional instance or registration will appear later, that a server's entire
workspace index is current, that the server is correct, or that builds/tests pass.
Push-only observations remain available through snapshot mode.

## Visible evidence

Model-visible output, not just Pi's UI-only `details`, must show:

- Mode, check status, request ID, requested deadline, elapsed time, and stop reason.
- The serving socket/PID and whether the connection identity was verified.
  An advertised but uncontacted service is not evidence that it served the call.
- Per-file source hash/revision and disk verification; required names and reasons
  for requirements that remain missing, pending, unconfirmed, or failed.
- Observed client IDs, names, roots, initialization and attachment state.
- Per-provider identifier, owned request ID, state, attempts, reply kind, request
  and completion offsets when available, observed cancellation state/time,
  cancelled-attempt/discarded-reply counts, and failures/omissions.
- Cache namespaces in snapshots; client/provider provenance for direct replies.

Timing fields are recorded at transitions, not continuously mutated observation
fields that would themselves prevent a quiet period. Report schema version 2
remains compatible; helper protocol **3** rejects older helpers that may accept
cancelled replies or misidentify equivalent registration aliases. Neither version
is a Git checkout/build identity claim.

## Required regression boundaries

- A fast empty linter may end a snapshot, but cannot finish a check requiring a
  type checker that attaches later. Use a new service and an already-bad file.
- A missing, initializing, push-only, or hanging required client is not complete.
- Required clients apply independently to every file; unrelated hanging clients
  do not block checks. Duplicate names cannot hide a failed matching instance.
- Cancellation acknowledgements and ordinary full replies after cancellation
  cannot produce false completion; cancellation alone cannot trigger overlapping
  retries. Equivalent registration aliases do not consume attempts; meaningful
  option changes (including in-place mutations) still invalidate old work.
- Multiple identifiers, omitted providers/results, malformed responses, and
  oversized/invalid registration options retain explicit outcomes.
- Cache contamination cannot add/remove owned check results. Source/disk/buffer
  races invalidate completion even when useful diagnostics have been retrieved.
- Queued timeouts do not falsely claim contact with a service. Service replacement,
  shutdown, or identity mismatch is an explicit error, not an empty success.
- Warm edits issue new requests and never use an earlier check as fresh evidence.

Tests establish these invariants before live retests; longer sleeps are not the
completion condition. Existing snapshot callers and shared-service safety remain
regression requirements.
