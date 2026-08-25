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
   Tool calls and results become typed run events. The worker collects a git
   diff limited to configured paths and writes issue, patch, event-log, and
   evidence artifacts, followed by a run manifest.
7. **Grading and reporting.** `bench grade` independently materializes a fresh
   baseline and candidate, runs baseline/candidate/hidden checks, validates
   changed paths, and emits evidence. `task run` does **not** invoke this
   grader. The CLI emits a compact terminal result, artifact IDs, and model
   usage; non-resolved terminal outcomes return a non-zero status.

The state machine's progression is bounded, but completion is not proof of a
correct patch. In particular, the present `task run` evidence has an empty
checks list and derives its success booleans from the worker terminal outcome.
That is a known correctness gap, not a guarantee.

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
- `src/benchmarks.ts` owns the ten frozen tasks and independent grading. The
  checked-in `fixtures/manifest.json` mirrors solver-facing fixture metadata
  and file hashes.

## Persistence, recovery, and concurrency

JSON files are written through temporary files and renames. The index and queue
have in-process write chains, schema checks, delivery-key deduplication, and
leases. Artifacts are addressed by SHA-256 and each run has a typed record under
`.harness/runs/`. The default local layout is documented in
[operations](usage.md#local-data-and-artifacts).

Recovery is intentionally modest. `DurableQueue.recoverExpired()` requeues
expired `claimed`/`running` entries, and `LocalIndex.recoverInterrupted()`
requeues stale `claimed`/`running` manifests. These are library operations; the
CLI `task run` path does not run a recovery daemon. Atomic file replacement
reduces partial-write risk, but queue, index, artifact, and workspace updates
are not one transaction. A crash can therefore require inspection and an
operator-directed retry.

This design is for one local worker. It has no hosted coordination, database
transaction, inter-process lock, multi-worker fairness guarantee, or distributed
lease authority. Do not run multiple writers against the same `.harness`
directory and infer serialized behavior.

## Base provenance and delivery

`NormalizedIssueTask.baseCommit` is evidence metadata supplied by the source.
The webhook adapter currently fills it from the repository default-branch field
(the branch name, or `unknown`), and the CLI fixture adapter does likewise
unless a library caller supplies another value. No current run path verifies an
exact commit object or checks out that base. The polling client can provide a
value, but it is still not validated by the harness.

No branch creation, commit, push, draft PR, review request, merge, or GitHub
status/reporting action is implemented in this phase. A caller can inspect the
patch artifact and decide what to do; the harness does not deliver it.
