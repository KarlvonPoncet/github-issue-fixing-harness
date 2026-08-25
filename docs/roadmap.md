# Roadmap and current limitations

This is a prioritized engineering sequence, not a promise of dates. The order
keeps correctness and trust prerequisites ahead of GitHub automation.

## Current limitations and correctness risks

1. **Worker success is not evidence-backed.** `task run` advances through the
   model state sequence and can return `resolved`/`succeeded` without verified
   candidate tests, regression checks, or patch-scope grading. Its emitted
   evidence currently has an empty `checks` array and success booleans derived
   from the terminal outcome. `bench grade` is separate and must be run when
   check-backed evidence is needed.
2. **Base provenance is advisory.** The webhook path currently stores the
   repository default-branch field as `baseCommit`; it does not enforce an
   exact event commit checkout. Poll-provided base values are not verified by
   the harness either. A workspace is caller-provided and may not match the
   recorded value.
3. **Execution is not a real sandbox.** Path/command/environment checks are
   application guardrails, not OS/network isolation or complete resource
   controls. Allowlisted repository code remains untrusted process code.
4. **Recovery is incomplete.** Atomic writes and lease helpers exist, but queue,
   index, artifacts, and workspace changes are not one crash-safe transaction.
   Recovery helpers are not a running daemon, and the local JSON files have no
   distributed lock or multi-worker coordination.
5. **Delivery is absent.** The harness does not create branches or commits,
   push, open or update PRs, request review, merge, or mutate GitHub.
6. **Evaluation is narrow.** Ten small fixtures and same-repository hidden checks
   establish deterministic grader behavior, not model effectiveness,
   generalization, production reliability, or held-out performance.

## Prioritized milestones

1. **Evidence-backed success semantics.** Make terminal success require an
   independent candidate check, regression check, allowed-path result, and
   explicit evidence reference. Separate “worker completed” from “fix verified”
   in schemas, CLI exit status, artifacts, and docs.
2. **Exact-base and patch provenance.** Resolve the event's immutable commit,
   verify the object, create the workspace from that exact base, record source
   and checkout hashes, and validate the produced patch against provenance.
3. **True sandboxing and resource controls.** Add a reviewed disposable
   execution boundary with filesystem/network isolation, process/CPU/memory
   limits, cancellation, cleanup, and adversarial validation. Retain the
   application-level guardrails as defense in depth.
4. **Crash-safe recovery.** Define transaction boundaries and durable state
   transitions, add restart/crash injection tests, make lease ownership
   explicit, and provide an operator-visible recovery procedure before adding
   more workers.
5. **Solver/evaluator separation.** Keep solver-visible task data independent
   from hidden checks and references; version and review the evaluator, prevent
   accidental leakage, and make evidence reproducible by an independent grader.
6. **Held-out evaluation.** Establish private, frozen corpora; run model and
   harness version matrices with per-task outcomes, costs/times, failure
   categories, and statistical uncertainty. Publish only claims supported by
   the held-out protocol.
7. **Human-reviewed beta.** Run a narrow, non-autonomous canary with selected
   repositories, disposable environments, patch/evidence review, audit logs,
   rollback, and explicit acceptance criteria. Only after that review should
   any autonomous GitHub action be considered.

Branch/commit/push/PR delivery is intentionally after these milestones. A
future delivery adapter must consume verified patch/evidence and a fresh policy
decision; it must not be inferred from the present `resolved` terminal value.
