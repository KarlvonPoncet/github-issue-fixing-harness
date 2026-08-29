# Evaluation and testing guide

## What the current benchmark is

The checked-in benchmark contains ten small frozen fixtures: five TypeScript
and five Python tasks covering arithmetic, positive-value validation, contact
formatting, stable uniqueness, and zero-valued configuration. Each task fixes
base files, issue text, public command(s), allowed paths, and a hidden check.
`fixtures/manifest.json` exposes solver-facing metadata and base-file hashes;
reference candidates and hidden checks are implementation data in
`src/benchmarks.ts` and are not exposed by `bench view`.

`gradeBenchmark` creates fresh temporary baseline, candidate, and hidden
copies. It performs, in order:

1. baseline public checks, classifying a non-failing baseline as a
   `pre_existing_failure` condition rather than attributing it to a solver;
2. candidate public checks;
3. hidden checks added to a separate copy;
4. changed-file and allowed-path validation; and
5. evidence and failure-category aggregation.

`Resolved@1`-compatible success means that the expected baseline failure is
known, all candidate checks (public and hidden) pass, and no forbidden path was
changed. `regressionFree` is a separate check-derived result. Timing and raw
check outcomes are recorded. Grading never asks a model whether it succeeded.

`bench summary --solutions` materializes the ten checked-in reference solutions
and grades them. This is **grader sanity**, demonstrating that the evaluator can
recognize intended solutions and expected baseline failures. It is not model
effectiveness, not a reliability estimate, and not evidence of production
performance. A candidate attempt can be supplied with `bench grade --task
<TASK> --attempt <DIR>` or `--patch <FILE>`; inspect the command help for the
current exact synopsis.

## What it does not prove

- Ten tiny tasks do not establish broad language, repository, issue, or model
  coverage.
- Reference-solution success does not show that a model can find the solution.
- The hidden checks are checked into the same benchmark implementation, not a
  held-out corpus. A solver or evaluator maintainer with repository access may
  learn fixture structure and solutions.
- The public checks are intentionally small and can under-specify behavior.
- Fresh temporary copies improve repeatability but do not model CI, dependency
  installation, large repositories, flaky services, or adversarial code.
- The ordinary `task run` flow is not automatically graded. Its current
  evidence can be success-shaped with an empty checks list, so worker terminal
  success must not be reported as verified correctness.

Do not publish an aggregate benchmark claim without naming the fixture set,
solver/model version, evaluator version, attempt policy, timeout, and whether
results are reference sanity or model runs.

## Reports and token accounting

`bench grade` and `bench summary` include a versioned `report` in their TOON
output. Pass `--output <file>` to persist the same report as redacted JSON.
Each report records the fixture-set/evaluator version, case identity and base
state, attempt policy, timeout, provider/model identity when supplied, seed
when supplied, start/end timestamps, per-case outcome and timing, and aggregate
counts. The evidence alongside each case remains the source for individual
check commands, statuses, and redacted output.

The deterministic grader does not invoke a model. Its every-case usage record
therefore has `provenance: not_applicable` and null token totals; null means
that a value was not reported, never zero usage. When a model run is associated
with a grade through the library API, one usage sample is retained per model
call, including retries and provider failures that carry usage. Input, output,
cached-input, cache-write, reasoning, and total token fields are summed only
when present for every relevant call; otherwise the aggregate field is null.
`missingCalls`, `partialCalls`, and `provenance` make incomplete accounting
explicit. Costs stay null unless pricing is explicitly marked configured and
trusted; `costProvenance` records that decision. No secret, credential, or
local attempt path belongs in a report.

## Required test layers for future work

The existing `test/core.test.ts` covers important deterministic contracts:
strict schemas, queue deduplication and lease recovery, webhook signatures and
filtering, polling checkpoints, workspace boundaries and redaction, credential
privacy, provider fakes/replays, worker state/budget behavior, all ten fixture
solutions, and test-input protection. Keep these tests fast and offline.

Changes should add the appropriate layer rather than relying on one broad
end-to-end test:

- **Unit/property tests:** parsers, normalization, risk classification, path
  matching, redaction, queue transitions, artifact hashes, and budget/timeout
  accounting. Generate traversal, malformed schema, duplicate delivery, and
  boundary-size cases where useful.
- **Fake integrations:** exercise webhook/poll clients, provider transports,
  credential stores, and clock/lease seams without live GitHub, OAuth, or model
  calls.
- **Deterministic failure injection:** force crashes between persistence
  steps, expired leases, model timeouts, command timeouts, malformed provider
  responses, edit conflicts, output overflow, and partial artifact writes.
  Assert the documented recovery and evidence outcome.
- **Realistic fixture repositories:** include multiple files, package/build
  conventions, pre-existing failures, generated files, and issue context while
  preserving solver/evaluator separation.
- **Adversarial sandbox tests:** test symlink races, path traversal, forbidden
  files, interpreter escape attempts, environment inheritance, command
  argument injection, network access, CPU/memory/process exhaustion, and
  cleanup. The current application guardrails are not a replacement for this
  layer or for an OS sandbox.
- **Held-out corpora:** keep private, independently maintained tasks and hidden
  tests. Freeze the corpus and evaluator before a model run; never use it to
  tune prompts and then call it held out.
- **Model/version matrices:** record provider, model ID/version, harness
  version, prompt/tool contract, temperature or equivalent settings when
  available, retry/budget policy, and all attempts. Use identical fixture and
  timeout inputs across cells.
- **Statistical reporting:** report per-task outcomes, pass counts and
  confidence intervals, failure categories, retries, time/cost distributions,
  missing/invalid runs, and relevant paired comparisons. Do not hide failures
  behind one mean or claim significance without a predeclared method.

## Release and canary criteria

Before a controlled beta, require at minimum:

1. evidence-backed success semantics that run candidate and regression checks;
2. exact-base checkout and patch provenance;
3. a reviewed OS/network sandbox with resource controls;
4. crash/restart recovery tests and a clear operator procedure;
5. separate solver and evaluator ownership plus held-out evaluation;
6. repeated model/version matrix results with statistical reporting;
7. adversarial and realistic repository suites; and
8. documented rollback, artifact retention, credential handling, and human
   approval paths.

A canary should be limited to human-selected repositories and issues, use a
non-delivery mode, require a human to inspect patch and evidence, and record
all failures. No canary result authorizes autonomous branch, PR, merge, or
production actions. Those actions require a later, explicit product and
security review.
