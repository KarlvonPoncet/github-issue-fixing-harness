# issue-harness

[![CI](https://github.com/KarlvonPoncet/github-issue-fixing-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/KarlvonPoncet/github-issue-fixing-harness/actions/workflows/ci.yml)

`issue-harness` (the package name is `issue-harness`; the executable is
`issue-harness`) is a local-first research and evaluation harness for bounded
GitHub issue work. It accepts normalized issue events, applies repository
policy, persists a queue, runs an agent through a small tool boundary, stores
redacted evidence, and grades a deterministic fixture benchmark.

## Maturity and phase boundary

This is a credible **local research/evaluation harness**, not a controlled beta
and not a production service. Phases 0/1 deliberately stop at local intake,
queueing, bounded workspace/model execution, artifacts, and evaluation. There
is no hosted control plane, multi-worker deployment, autonomous branch or PR
delivery, merge, or production repository mutation.

The most important current limitation is that the ordinary `task run` path can
report a successful terminal result after the bounded state machine completes
without verifying candidate tests, regression checks, or patch scope. Its
run evidence currently records no checks. Use `bench grade` for the separate
deterministic evaluator; do not treat a successful worker terminal result as a
verified fix. The webhook adapter also records the GitHub default-branch name
as `baseCommit` rather than enforcing checkout of the exact event commit. See
[Current limitations](docs/limitations.md) and the [roadmap](docs/roadmap.md).

## Quick start

Prerequisite: Node.js 22 or newer. From a checkout:

```sh
npm ci
npm run check
npm run package:check
npm run demo
node dist/cli.js bench list
node dist/cli.js bench summary --solutions
```

The final command grades the ten checked-in reference solutions. It is a grader
sanity check, not evidence that a model can solve real issues. The complete
command and development reference is in [Development and CLI usage](docs/usage.md).

The CLI is non-interactive except for the explicit Codex OAuth login flow.
Machine-readable results are TOON on stdout; diagnostics are on stderr. Unknown
commands and flags fail with exit code 2. Run `node dist/cli.js --help` or a
command-specific `--help` for the authoritative, version-matched synopsis.

## How the system fits together

The source-reviewable flow is:

```text
GitHub webhook (HMAC) or reconciliation poll
  -> strict input parsing and repository/issue policy filtering
  -> normalized task and delivery-key deduplication
  -> durable local queue and lease
  -> caller-provided workspace plus provider-independent model transport
  -> inspect -> reproduce -> plan -> edit -> test -> self-review -> terminal
  -> redacted patch/events/evidence/manifests in content-addressed artifacts
  -> optional independent benchmark grading and terminal CLI report
```

The queue, schema, adapters, worker, workspace guardrails, model boundary, and
grader are described in [Architecture and contracts](docs/architecture.md).

## Trust and safety at a glance

- Webhook bodies require an `sha256=` HMAC checked with a configured secret.
- Only configured repositories, allowed issue states, and opt-in labels are
  eligible. Security-sensitive, destructive, oversized, and ambiguous tasks
  are retained for human review rather than queued for normal execution.
- Workspace tools require relative paths, reject forbidden paths and symlink
  escapes, use exact SHA-256 edit preconditions, restrict commands to named
  safe forms, cap output/time/patch sizes, use a small environment, and redact
  secret-like material.
- Provider credentials are kept outside task prompts, artifacts, and child
  command environments. Codex OAuth uses the explicit browser flow; no browser
  cookies are copied.
- **The reduced environment is not an OS or network sandbox.** Repository code
  run by an allowlisted command is still untrusted process code. Use a
  separately provisioned disposable environment and do not expose sensitive
  host or network access.

These are boundaries and precautions, not a claim of production isolation.
Read the full [security and trust model](docs/security.md).

## Authentication and providers

OpenAI API-key use is supplied through `OPENAI_API_KEY` or a secret-manager
injection understood by the provider runtime. Codex uses:

```sh
node dist/cli.js auth login --provider openai-codex
node dist/cli.js auth status
node dist/cli.js auth logout --provider openai-codex
```

The default credential file is `~/.config/issue-harness/auth.json`, or the path
in `ISSUE_HARNESS_AUTH_FILE`; it is written with mode `0600`. Status prints only
provider and credential type. See [usage and authentication](docs/usage.md)
for boundaries and safe local operation.

## Benchmark scope

The frozen benchmark has five TypeScript and five Python fixtures. The grader
runs baseline public checks, candidate public checks, hidden checks, and
allowed-path validation in fresh temporary directories. It reports
`Resolved@1`-compatible success, regression-free status, timing, and failure
categories. `bench grade` and `bench summary` also emit a versioned report with
one case record per fixture; `--output <file>` persists that report as JSON.
The deterministic grader has no model calls, so its per-case token usage is
explicitly `not_applicable` with null token totals rather than fabricated
zeros. Model-run manifests and event logs retain provider-reported token
breakdowns, including partial and missing usage. Reference-solution checks
establish that the grader can recognize known solutions and classify expected
baseline failures; they do not measure model effectiveness, production
reliability, or generalization. Hidden checks are currently in the same
checked-in benchmark implementation, so this is not held-out evaluation. See
[Evaluation methodology](docs/evaluation.md).

## Contributing

Core contracts live in `src/schema.ts`, intake in `src/github.ts`, queue and
persistence in `src/queue.ts` and `src/storage.ts`, execution guardrails in
`src/workspace.ts`, the model seam in `src/model.ts`, the worker in
`src/agent.ts`, and grading in `src/benchmarks.ts`. Start with
[contributor guidance](CONTRIBUTING.md), then run:

```sh
npm run check
npm run package:check
npm run demo
```

Keep CLI stdout as TOON, keep operations non-interactive except Codex OAuth,
and update the relevant documentation when a contract, limitation, command,
security boundary, or evaluation claim changes. See [Security policy](SECURITY.md)
for vulnerability reporting.
