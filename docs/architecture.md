# Architecture and contracts

This document explains the implemented Phase 0/1 path. The authoritative
runtime contracts remain the TypeScript types and parsers in `src/schema.ts`;
this document intentionally points to them rather than copying every field.

## End-to-end flow

1. **Intake.** `GitHubWebhookAdapter` receives the raw body, `sha256=` HMAC,
   event name, and delivery ID. `GitHubPollingAdapter` receives issue records
   from a caller-supplied `GitHubPollClient` and advances a persisted updated-at
   checkpoint. The adapters are independent; a deployment would normally use
   webhooks for prompt intake and polling for reconciliation.
2. **Parsing and normalization.** The strict schema rejects unknown fields and
   invalid types. Issue body and comments are combined, links and labels are
   normalized, secrets are redacted, and `classifyRisk` recognizes oversized,
   security-sensitive, destructive, and ambiguous work. Repository policy
   supplies allowed states, opt-in labels, allowed/forbidden paths, named
   commands, size/time limits, and review-required risk classes.
3. **Eligibility.** Pull requests and unsupported webhook actions are ignored.
   Unconfigured repositories, disallowed states, missing opt-in labels, and
   non-normal risk do not enter normal execution. Webhook delivery IDs and
   normalized delivery keys make repeated deliveries idempotent within the
   queue/index. Risk-review results are returned to the caller rather than
   queued as runnable work.
4. **Queue and lease.** `DurableQueue` stores queue entries in
   `.harness/queue.json` and task/run data through `LocalIndex` in
   `.harness/store/index.json`. A task is claimed in updated-at order and gets
   a lease (15 minutes by default). A worker transitions it to `running`, then
   to `succeeded`, `failed`, `review`, or `cancelled`.
5. **Workspace and model.** `task run` uses the caller-provided workspace; it
   does not clone a repository or check out `task.baseCommit`. `makeWorkspace`
   creates private harness home and temporary directories. `AgentRunner` asks a
   `ModelTransport` for each bounded state in this order:
   `inspect`, `reproduce`, `plan`, `edit`, `test`, `self_review`, `terminal`.
   `PiModelTransport` is the optional provider adapter. `FakeTransport` and
   `ReplayTransport` use the same harness-owned interface for deterministic
   tests and offline runs.
6. **Tools and evidence.** The model can list files, inspect a file, make an
   exact hash-guarded replacement, run a named command, or signal `finish`.
   Tool calls, results, and one `model_usage` event per attempted model call
   become typed run events. The worker sends that same event stream to
   `RunLogger`, which appends synced, redacted JSON-lines records as the run
   proceeds. It writes a redacted manifest snapshot at run start and refreshes
   it at terminal and artifact-persistence milestones. The event log preserves
   state changes, tool/model metadata, warnings, and errors during a partial
   run. The worker collects a git diff limited to configured paths and
   writes issue, patch, event-log, and evidence artifacts, followed by a run
   manifest. Usage is also recorded in the evidence and manifest; missing
   provider fields remain null.
7. **Grading and reporting.** `bench grade` independently materializes a fresh
   baseline and candidate, runs baseline/candidate/hidden checks, validates
   changed paths, and emits evidence plus a versioned per-case report. Candidate
   public checks remain the regression-free signal; hidden failures prevent
   `Resolved@1` without being mislabeled as public regressions. `task run` does
   **not** invoke this grader. The CLI emits a compact terminal result, artifact
   IDs, model usage, and benchmark report; `--output` persists the report as
   JSON. Non-resolved terminal outcomes return a non-zero status.

The state machine's progression is bounded, but completion is not proof of a
correct patch. In particular, the present `task run` evidence has an empty
checks list and derives its success booleans from the worker terminal outcome.
That is a known correctness gap, not a guarantee.

Each run carries a parsed `Budget` that caps state-machine steps, model calls,
per-state retries, model-call time, model input/output, and patch size. Usage
accounting counts attempted calls, including retries and failures. It sums a
token field only when every relevant response reports that field; otherwise the
aggregate is null and its provenance is `partial` or `unavailable`. Costs are
withheld unless pricing is explicitly trusted. The worker retries a failed
state only within that run and records each retry as a warning event; it has no
cross-run retry scheduler or backoff policy. Reaching
the step or model-call cap produces a budget failure, a model-call timeout
produces a timed-out outcome, and exhausting state retries produces a failed or
timed-out outcome according to the failure category. The CLI's current `task
run` budget allows 20 steps, 20 model calls, and one retry per state. Its
model-call timeout is the task policy's `maxCommandMs` value. These execution
bounds do not impose CPU, memory, process, or network limits on repository
commands.

## Core contracts

- `src/schema.ts` defines version `v1`, normalized tasks, policy, queue/agent
  states, budgets, manifests, checks, evidence, and artifact records. Its
  `parse*` functions reject unknown fields and enforce scalar/size bounds.
- `src/github.ts` owns HMAC verification, event filtering, polling order and
  checkpoints, normalization, risk classification, and policy decisions.
- `src/queue.ts` owns valid queue transitions, delivery-key deduplication,
  attempts, leases, and expired-lease requeueing.
- `src/storage.ts` owns schema-versioned local index files, run manifests,
  checkpoints, atomic persistence, and content-addressed artifact storage.
- `src/workspace.ts` owns path, symlink, command, edit, output, timeout, and
  environment restrictions. Its command allowlist is deliberately narrow:
  supported forms are the named Node test, Python unittest, and configured
  workspace `git-diff` forms.
- `src/model.ts` owns the provider boundary. Provider SDK objects do not cross
  `ModelTransport`; only normalized text, tool calls, and usage do.
- `src/benchmarks.ts` owns the twenty frozen tasks, stable base-state seeds,
  and independent grading. The checked-in `fixtures/manifest.json` mirrors
  solver-facing fixture metadata and base-file hashes.

## Persistence, recovery, and concurrency

JSON files are written through temporary files and renames. The index and queue
have in-process write chains, schema checks, delivery-key deduplication, and
leases. Artifacts are addressed by SHA-256 and each run has a typed record under
`.harness/runs/`. `RunLogStore` exclusively creates
`.harness/logs/<run-id>.jsonl` and appends one synced event at a time; the
matching `<run-id>.manifest.json` is atomically replaced as lifecycle milestones
complete. Distinct run IDs therefore cannot overwrite one another, including
when runs execute concurrently. Finalized run manifests contain the aggregate
usage summary; event logs preserve usage and errors recorded before an
interrupted run. Benchmark reports can likewise be persisted as redacted JSON.
There is no automatic retention or cleanup: operators may remove a complete
run's log, manifest, and artifacts when they no longer need them. The default
local layout is documented in [operations](usage.md#local-data-and-artifacts).

Recovery is intentionally modest. `DurableQueue.recoverExpired()` requeues
expired `claimed`/`running` entries, and `LocalIndex.recoverInterrupted()`
requeues stale `claimed`/`running` manifests. These are library operations; the
CLI `task run` path does not run a recovery daemon. Atomic file replacement
reduces partial-write risk, but queue, index, artifact, and workspace updates
are not one transaction. A crash can therefore require inspection and an
operator-directed retry.

This design is for one local queue/index worker. It has no hosted coordination,
database transaction, multi-worker fairness guarantee, or distributed lease
authority. Run logs are isolated and append-safe across concurrent run IDs, but
queue/index updates still have no cross-process lock; do not run multiple queue
writers against the same `.harness` directory and infer serialized behavior.

## Base provenance and delivery

`NormalizedIssueTask.baseCommit` is evidence metadata supplied by the source.
The webhook adapter currently fills it from the repository default-branch field
(the branch name, or `unknown`), including when invoked by the CLI fixture
command. Although that command currently accepts `--base-commit`, it does not
apply the flag. No current run path verifies an exact commit object or checks
out that base. The polling client can provide a value, but it is still not
validated by the harness.

No branch creation, commit, push, draft PR, review request, merge, or GitHub
status/reporting action is implemented in this phase. A caller can inspect the
patch artifact and decide what to do; the harness does not deliver it.
