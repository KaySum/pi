# Headless Neovim Diagnostics Extension — Plan

**Status:** Initial v1 implemented and verified on macOS. All 22 integration tests
pass, including installed `nvim-lint` coverage. Additional OS/version and large-project
validation remain open below.

This document is the source of truth for the extension. Update it when decisions
change, before implementing the affected behavior. Mark checklist items complete
only after implementation and verification. Keep the eventual README consistent
with this plan.

## Goal

Give Pi an on-demand tool that checks explicitly requested disk files using a
separate headless Neovim instance created for that tool call, using the user's
Neovim configuration. One instance handles the call's entire file list and is shut
down before the call settles. Return actionable diagnostics with honest information
about provider availability and result freshness.

## Agreed decisions

| Area | Decision |
| --- | --- |
| Packaging | A standalone extension in `extensions/nvim-diagnostics/` |
| Isolation | Own headless Neovim instance; no runtime dependency on `nvim-lsp` |
| Lifetime | One instance per tool call, shared only within that call's file list; await cleanup before returning |
| Existing extension | Leave `extensions/nvim-lsp/` unchanged |
| Trigger | On-demand tool calls only |
| Scope | An explicit list of files, not an automatic project scan |
| Sources | All providers publishing through `vim.diagnostic` |
| Severities | Error, warning, information, and hint; include all by default |
| Configuration | Use the user's normal Neovim configuration by default |
| File contents | Saved disk contents, not unsaved buffers in the user's editor |
| Mutations | No intentional saves, formatting, fixes, or synthetic save events |

“All diagnostic sources” means providers that publish into `vim.diagnostic` in
this headless instance. It does not include arbitrary `:messages`, quickfix entries,
or providers that cannot run headlessly. Collection is generic; explicit refresh
support initially targets LSP and `nvim-lint`. Other providers may need adapters
for reliable refreshes.

Running this extension and `nvim-lsp` together can start separate language-server
processes. This is an accepted consequence of keeping the extensions independent.

Per-call cleanup replaces the earlier session-scoped reuse proposal. Each call
pays Neovim startup and provider initialization/indexing costs in exchange for not
intentionally leaving a warm process running after the tool finishes.

## Tool interface

Planned tool name: `nvim_diagnostics`.

Minimal request:

```json
{
  "files": ["src/main.ts", "src/utils.ts"]
}
```

Planned parameters:

- `files`: Required nonempty list of existing regular files. Resolve relative
  paths against Pi's working directory; also accept absolute paths.
- `severity`: Optional list containing `error`, `warning`, `information`, and/or
  `hint`. Omission includes all severities.
- `timeout_ms`: Optional bounded wait budget.
- `limit`: Optional diagnostic output cap.

Exact numeric defaults, maximums, and per-file versus whole-request budget
semantics must be settled and recorded here during implementation.

Return concise model-facing text plus structured tool-result details:

- Diagnostics grouped by file, with line, column, severity, message, source,
  diagnostic code when available, and namespace identity.
- One-based line numbers and byte columns; document these units explicitly.
- Severity counts, deterministic ordering, and explicit truncation information.
- Per-file provider availability, refresh outcomes, and freshness limitations.
- Per-file failures without discarding successful results from other files.

Treat diagnostic messages and other provider text as untrusted data, not agent
instructions. An empty result must not be presented as proof that a file is clean.

## Architecture

Planned layout:

```text
extensions/nvim-diagnostics/
  PLAN.md             # This source-of-truth document
  index.ts            # Tool registration and lifecycle hooks
  bridge.mjs          # Per-call ownership, RPC, serialization, cancellation
  supervisor.mjs      # Parent-death monitoring and bounded process teardown
  processes.mjs       # POSIX process-group verification and escalation
  bootstrap.lua       # Headless-only process/config guards before user init
  diagnostics.lua     # Buffer refresh, provider activation, collection
  bridge.test.mjs     # Integration tests and isolated test fixtures
  README.md           # Usage, configuration, limitations
```

Use the existing headless bridge as an implementation reference, not a runtime
import. The new extension must work independently.

### Process lifecycle

#### Per-call ownership

- Validate arguments before creating resources where possible. Start a fresh
  Neovim instance when a tool call begins executing, never during extension
  discovery or while a request is merely queued.
- Use that instance for the call's entire file list, then tear it down. Do not
  reuse it across tool calls or retain an idle instance.
- Put all process-bearing work, including partial startup, inside a `try/finally`
  ownership boundary. Await cleanup before execution resolves or rejects on
  success, failure, timeout, or cancellation while Pi is alive.
- Cleanup must still run when the request's abort signal is already aborted;
  give teardown its own bounded budget rather than reusing that signal.
- Use a private RPC endpoint; never attach to the user's running editor.
- Pass tool arguments as data, without constructing executable code from paths
  or diagnostic content.
- Serialize requests and initially process files one at a time. Provider callbacks
  and debounced linting must not accidentally operate on another current buffer.
- Do not start the next queued instance until the previous instance's cleanup is
  confirmed. Report unresolved cleanup failures instead of accumulating processes.

#### Bounded teardown

- First request graceful shutdown of Neovim and its supervised language-server
  and linter processes. Do not save buffers during shutdown.
- If graceful shutdown exceeds its deadline, escalate to termination and then
  force-kill. Scope signals to processes/process groups owned by this call; never
  use name-based killing or stop the user's editor or unrelated/shared services.
- Verify process exit, reap direct children, close RPC/liveness handles, clear
  timers, and remove private temporary resources. The supervisor itself must exit
  and be reaped during normal cleanup; it is not a persistent service.
- A cleanup failure must be explicit, not hidden behind an otherwise successful
  diagnostics response. Keep all cleanup paths idempotent.
- Bound startup, diagnostic work, and teardown. Enforce an overall deadline from
  outside Neovim so a blocked Neovim event loop cannot defeat the limit.
- Session shutdown/reload cancels queued work and tears down an active call using
  the same cleanup path. These hooks are a fallback, not the sole lifetime guard.
- No restart command is needed in v1: each new call already starts a fresh instance.

#### Parent-death protection

- Use an independent, per-call supervisor to own Neovim and monitor a liveness
  channel held by Pi. Losing that channel must initiate teardown even when Pi
  crashes or is killed with `SIGKILL` and cannot run extension hooks.
- Establish supervision before launching Neovim, including during startup.
- Do not rely only on Node exit handlers, Pi's `session_shutdown`, or a timer
  running inside Neovim. The supervisor must remain able to enforce teardown if
  Pi disappears or Neovim hangs.
- Validate platform-specific ownership and descendant cleanup. Killing Neovim
  alone, or blindly assuming every provider stays in its process group, is not
  sufficient. Include supported language-server and linter processes in testing.
- No user-space design can guarantee cleanup of arbitrary detached daemons started
  by user plugins or survive every combination of simultaneous process failures.
  Document these limits rather than claiming universal orphan prevention.

### Diagnostic pipeline

For each requested file:

1. Validate the path and load or reload its saved contents. Do not silently discard
   a buffer modified by a plugin.
2. Ensure filetype detection and configured provider activation have occurred.
3. Establish an observation baseline, then refresh supported providers:
   - LSP: support push diagnostics and request pull diagnostics where supported.
   - `nvim-lint`: trigger configured checks while respecting filetype selection,
     conditions, and relevant user configuration.
   - Other providers: collect their namespaces; report unknown freshness when
     refresh/completion cannot be established.
4. Observe provider completion where available and diagnostic updates within a
   bounded wait. A quiet interval or a single update does not prove every provider
   has finished.
5. Collect all relevant `vim.diagnostic` namespaces without requiring an attached
   LSP. Normalize supported pull results consistently and avoid counting the same
   provider result twice through different collection paths.
6. Filter, sort, and format results, preserving source identity and reporting any
   timeout, failure, stale/unknown state, or omitted output.

Checks must work for linter-only files. Rechecking after a fix must not silently
present old diagnostics as fresh. Do not fake `BufWritePost` or save a file to
activate a provider; use a targeted adapter when necessary.

The extension itself will not write or format project files. The user's config,
plugins, and external providers still run with the user's permissions: this is
not a sandbox, and arbitrary plugin side effects cannot be ruled out.

## Things to watch out for

These are implementation risks to review and validate, not a change to the agreed
scope. Mitigations below are proposed where the exact mechanism is not yet settled;
record the chosen approach in this plan before treating a risk as addressed.

### 1. Language servers can outlive Neovim

The inspected Neovim 0.12.5 runtime documents LSP defaults of `detached = true`
and `exit_timeout = false`. A server can run in a separate process group, and
forced shutdown on Neovim exit is not enabled by default. Killing only Neovim or
its process group is therefore insufficient.

Consider headless-only overrides for supported servers, together with explicit
ownership tracking for exceptions. Verify actual behavior rather than assuming
all providers honor the defaults. Test servers that ignore graceful shutdown and
ensure cleanup never targets the user's editor or unrelated services.

### 2. Loading the normal config can have side effects

The inspected user config enables plugin update checking, and its LazyVim setup
can install missing tools. Plugins can also write configuration/state files, start
subprocesses, or require UI interaction. Read-only tool operations do not make the
configuration itself read-only or sandboxed.

Define a headless-only policy for update checks, automatic installers, and UI-only
plugins. Consider guards or a custom-init escape hatch; do not silently modify the
user's everyday editor configuration. Validate the selected policy with the real
config and document side effects that remain outside the extension's control.

### 3. Cold starts may not yield complete diagnostics

Every call pays startup and initialization/indexing costs. Large projects or slow
servers may reach the deadline before useful diagnostics arrive. A quiet cache or
an empty result is not evidence that every provider finished checking.

Benchmark cold-start latency on representative projects, including first-run
indexing. Preserve incomplete/unknown status when necessary. Do not silently
reintroduce process reuse to improve performance; that would require a new
lifetime decision.

### 4. Diagnostic providers may need different activation paths

Some providers depend on lazy-loading, save events, buffer transitions, or UI
activity. Reading `vim.diagnostic` alone may return nothing because a configured
provider never ran.

Validate LSP and `nvim-lint` activation independently, including linter-only files.
Adapters should respect filetype selection, conditions, and user settings without
replaying save events or triggering formatting. Distinguish observed diagnostics
from evidence that a provider actually ran; unknown provider coverage stays unknown.

### 5. Files can change while a check is running

The user's editor or another process may modify a file after Neovim loads it. LSP
results and disk-reading linters could then describe different versions, making
locations or messages misleading even within a single tool call.

Consider recording a content fingerprint for the loaded snapshot and comparing
it with disk contents before returning. Flag changed-during-check results as
potentially stale rather than silently trusting their locations. Any retry policy
must remain bounded. Matching fingerprints alone do not prove diagnostic freshness
or completion.

### 6. Resource usage needs explicit bounds

Large file lists, huge/generated files, verbose output, or multiple providers can
consume excessive memory, CPU, and time even with serialized requests.

Choose explicit file-count, file-size, and output caps, plus a whole-call deadline
that includes startup and cleanup. Report skipped files, exceeded limits, and
truncated output. Test limits and hung providers; merely limiting returned
message counts does not bound the work performed by external providers.

### Recommended first validation

Before building out the full interface, use a small end-to-end prototype to prove
useful cold-start diagnostics with the user's setup and reliable teardown of all
supervised processes. Exercise a known error, a subsequent fix, a non-LSP provider,
and cleanup after success, failure, cancellation, and abrupt parent death. Use the
results to settle configuration guards, time budgets, and coverage limitations.

## Implementation checklist

### 1. Independent process lifecycle

- [x] Create the extension entry point, per-call process bridge, and supervisor.
- [x] Implement private RPC, request serialization, and cancellation.
- [x] Implement awaited cleanup for success, failure, timeout, cancellation, and
      partial startup, with graceful shutdown and bounded forced escalation.
- [x] Implement independent parent-death detection and an overall lifetime limit.
- [x] Verify supervised provider cleanup, supervisor exit, and temporary-resource
      removal; expose cleanup failures explicitly.
- [x] Verify one instance per file-list request, no cross-call reuse, and shutdown
      before a normal tool result is returned.

### 2. Reliable single-file diagnostics

- [x] Implement disk reload and provider activation.
- [x] Collect all diagnostic namespaces without an LSP prerequisite.
- [x] Add LSP and `nvim-lint` refresh support.
- [x] Report availability and freshness separately from diagnostic counts.
- [x] Verify that fixed diagnostics disappear and slow providers remain visible
      as pending, timed out, or freshness-unknown rather than falsely clean.

### 3. Batch requests and output

- [x] Add explicit file lists and per-file failure isolation.
- [x] Add severity filtering, bounded waits, and output limits.
- [x] Return concise text and structured details with deterministic ordering.
- [x] Record finalized parameter defaults and result semantics in this document.

### 4. Integration tests and documentation

- [x] Use isolated Neovim configuration and deterministic mock providers in tests,
      rather than loading personal plugins.
- [x] Cover LSP-only, linter-only, and mixed-source files and all four severities.
- [x] Cover multiple files, disk changes, and diagnostics clearing after fixes.
- [x] Cover no configured provider, unavailable executables, provider errors,
      delayed updates, timeouts, and partial batch failures.
- [x] Cover path quoting, Unicode position units, filtering, and truncation.
- [x] Cover concurrent calls, queued cancellation, and session shutdown,
      ensuring each started call owns a distinct instance and awaits cleanup.
- [x] Cover a hung Neovim, refused graceful shutdown, startup failure, and forced
      escalation, including supervised language-server and linter children.
- [x] Abruptly kill a disposable parent test harness during startup and active
      requests; verify the supervisor tears down owned processes and then exits.
- [x] Assert process exit and removal of private socket/state directories after
      success, failure, timeout, and cancellation; test runs exit without hanging.
- [x] Smoke-test provider activation with the user's LazyVim configuration.
- [x] Load and execute the tool through Pi's actual extension loader and exercise
      its shutdown hook without making a model request.
- [x] Document setup, examples, configuration, and limitations in `README.md`.
- [ ] Exercise interactive `/reload` during an active tool call (hook cleanup is
      tested, but the full interactive UI lifecycle has not been driven).

## Acceptance criteria

- Pi can request diagnostics for several explicitly named saved files in one call.
- LSP and non-LSP diagnostics are returned with their source identities and all
  requested severities; a missing LSP does not prevent non-LSP results.
- A second call checks updated disk contents rather than silently trusting stale
  buffer state or diagnostic caches.
- Missing providers, unknown freshness, timeouts, and truncation are explicit.
- The extension does not intentionally save, format, or fix project files and does
  not interact with the user's running editor.
- One headless instance handles a call's file list. No instance is intentionally
  retained between calls, and normal success is returned only after its supervised
  processes have exited and temporary resources have been cleaned up.
- Failures, cancellation, and partial startup use the same bounded teardown path.
  Cleanup failures are reported explicitly.
- An independent supervisor detects Pi's disappearance and performs bounded
  teardown even without session hooks; abrupt-parent-death tests verify this for
  the supported process model.
- The existing `nvim-lsp` extension remains unchanged and independent.

## Out of scope for v1

- Persistent instance pooling, cross-call reuse, or an idle-timeout retention mode.
- Automatic checks after edits or before the agent's final response.
- Whole-project scanning or guarantees about unopened files.
- Access to unsaved buffers in another Neovim instance.
- Hover, navigation, code actions, formatting, or automatic fixes.
- Installing language servers, linters, or Neovim plugins.
- Universal refresh/completion support for arbitrary diagnostic plugins.
- Replacing project tests, builds, or dedicated typecheck commands.

## Implementation decisions

Initial implementation targets Node.js 20.3+ and Neovim 0.11+ on macOS/Linux,
with a `ps` supporting `-axo pid=,pgid=,stat=`. Verification is on Node 26.9.0,
Neovim 0.12.5, and macOS; Linux and minimum versions remain validation targets.
Windows is rejected explicitly until a Windows process-ownership strategy exists.

- `PI_NVIM_DIAGNOSTICS_BIN` selects Neovim (default `nvim`).
  `PI_NVIM_DIAGNOSTICS_INIT` optionally selects an init file (`NONE` for isolation).
- A per-call Node supervisor owns Neovim in a fresh POSIX process group. A Node IPC
  channel is the parent-liveness channel; disconnect triggers teardown. RPC helper
  processes are tracked separately. No runtime npm dependencies are required.
- Bootstrap runs before user init. It forces Lua `vim.uv.spawn` children to remain
  in the owned group and rejects the standard `vim.lsp.rpc.connect` shared/TCP
  connection helper. This covers the inspected LSP and `nvim-lint` launch paths,
  not arbitrary native/plugin launch paths or self-daemonizing tools.
- Headless-only guards disable known Lazy update/install paths and Mason automatic
  installs/registry refreshes. Suppressed Mason installs return a notice rather
  than throwing and aborting installed-provider setup. Set
  `PI_NVIM_DIAGNOSTICS=1` in the child for user-config guards; isolate cache/state
  and `NVIM_LOG_FILE` under its private directory. These are best-effort guards,
  not a sandbox or a blanket no-network guarantee.
- Capture default WARN/ERROR notifications as bounded, deduplicated notices rather
  than rendering them: Neovim's ERROR renderer can otherwise fail the surrounding
  RPC even when a provider failure was handled. Arbitrary replacement notifiers
  or direct error output from plugins may still cause a transport failure.
- Accept 1–20 files, each at most 1 MiB. `timeout_ms` is the per-file observation
  budget, including provider attachment (default 3000, range 100–30000 ms).
  Startup is capped at 15 seconds. The supervisor caps work at 115 seconds,
  reserving approximately 5 seconds for normal teardown (120 seconds nominal).
  Queue wait and preflight file validation are outside the supervisor deadline;
  OS stalls and emergency fallback can exceed these nominal budgets.
- Cleanup requests graceful exit through a separately bounded RPC (500 ms), then
  waits up to 750 ms before SIGTERM, 500 ms before SIGKILL, and 1500 ms for exit.
  Process-inspection calls have their own 1-second caps. Pi allows 8 seconds for
  supervisor cleanup before attempting emergency group cleanup; unresolved cleanup
  poisons the bridge. These checks count live processes, not OS-adopted zombies.
- `limit` is a request-wide diagnostic cap (default 100, range 1–500). Model text is
  capped at 30 KB; diagnostic fields at 1000 bytes, source/code/namespace fields at
  200 (plus truncation markers), provider metadata at 50 entries per file, unique
  notices at 30 per call, and each RPC response at 4 MiB. Escape terminal controls.
- Fingerprint files before loading and again before returning; flag changed files.
  Verify actual loaded text as well as modified/changedtick state, because
  `BufReadPost` edits can have their modified flag reset. Handle BOM/line endings
  explicitly. Reject FIFOs/special files without a blocking open.
- The lint adapter handles filetype/compound matches, fallback/global linters, and
  conditions. After activation, suppress its standard automatic group/`try_lint`
  callbacks in the child so debounced work does not cancel explicit checks.
- No automatic retry or global claim of diagnostic completeness.

### Result contract (v1)

The structured tool details contain `files`, `counts`, `omitted`, `complete: false`,
and a limitation note. When a process ran, they also contain `elapsed_ms`, verified
`cleanup`, and any bounded `runtimeLog`. Counts include all severities before
filtering, after same-client push/pull deduplication. Independent sources are kept.

Each file includes its canonical `file` and original `input`, plus a fingerprint
when readable. A checked file includes diagnostics, providers, counts, omissions,
notices, and text/provider truncation flags when applicable. Locations are one-based
lines and byte columns. File statuses are:

- `snapshot`: observation window ended; not a completeness/cleanliness assertion.
- `timed_out`: a known provider remained pending, or the file exhausted the budget.
- `error`: preflight or per-file checking failed; inspect `error`.
- `changed_during_check`: disk contents changed/disappeared before return; retry.

Provider statuses preserve specific evidence: `unavailable`,
`not_configured_for_file`, `skipped_condition`, `initializing`,
`attached_no_update_observed`, `pull_pending`, `pull_responded`,
`pull_unchanged_or_unknown`, `push_update_observed`, `pending`,
`no_update_observed`, `update_observed`, `cached_or_unknown`, or `error`.
Diagnostic freshness is `update_observed` or `cached_or_unknown`. Neither observed
updates nor empty lists establish complete coverage. Namespace IDs are per-process,
not durable identifiers. Startup/transport/cleanup failures fail the whole call;
ordinary per-file/provider failures remain visible alongside other results.

## Validation record and remaining work

Verified on this machine:

- 22 passing integration tests with the optional installed `nvim-lint` checkout
  enabled; otherwise that optional test is skipped. Tests use isolated config and
  deterministic providers, including stubborn real-plugin linter subprocesses.
- Actual Pi extension loader registers the tool without errors; executing it with
  isolated Neovim config and calling its shutdown hook succeeds.
- Real user LazyVim/lua_ls smoke check on a temporary project returned two intended
  syntax errors with an 8-second observation budget (about 9 seconds total).
  A fresh call after the fix returned no diagnostics with a 5-second budget (about
  6 seconds total), but no push update was observed, so it was not labeled clean.
- Both real-config calls verified cleanup. A final check with the default 3-second
  observation budget also returned both syntax errors in about 3.6 seconds total,
  with verified cleanup and one deduplicated blocked-install notice.
- Known automatic install attempts were blocked and surfaced as notices. No
  changes were made to `nvim-lsp` or the user's tracked Neovim configuration.

Open validation/risk items:

- [ ] Run the suite on Linux and the minimum advertised Node/Neovim versions.
- [ ] Exercise interactive reload during an active call, beyond tested hook cleanup.
- [ ] Benchmark representative large projects and additional language servers;
      refine budgets only with recorded decisions and no silent process reuse.
- [ ] Expand compatibility coverage for plugin versions and custom lint wrappers.
- [ ] Investigate stronger containment if needed for native/detached/daemonizing
      launch paths outside `vim.uv.spawn`; current process-group guarantees do not
      cover those. Abrupt supervisor failure before ownership handoff, simultaneous
      failures, and OS-level uninterruptible work remain exceptional limitations.
- [ ] Reassess notification/config guards if a plugin bypasses or replaces them;
      they cannot guarantee zero network or filesystem side effects.

Keep these limits explicit. Do not weaken per-call ownership or report an empty
snapshot as a clean file to make a compatibility or performance test pass.
