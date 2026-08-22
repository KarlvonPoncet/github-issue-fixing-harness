# issue-harness

[![CI](https://github.com/KarlvonPoncet/github-issue-fixing-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/KarlvonPoncet/github-issue-fixing-harness/actions/workflows/ci.yml)

`issue-harness` is a local-first, own-agent worker for GitHub issues. It owns intake, a durable queue, a bounded repository worker, artifacts, and deterministic grading; it does **not** launch the Pi TUI or a Pi subprocess.

## Quick start

```sh
npm ci
npm run check
npm run package:check
npm run demo
node dist/cli.js bench list
node dist/cli.js bench summary --solutions
```

The CLI is non-interactive except for `auth login`. Stdout is compact TOON; stderr is reserved for diagnostics. Unknown commands and flags fail with exit code 2 and an actionable error. `issue-harness --help` and every command's `--help` provide concise command-specific references.

## Architecture and trust boundaries

```text
GitHub webhook (HMAC) ─┐
                       ├─> strict normalizer + repository policy ─> durable queue
reconciliation poll ───┘                                             │
                                                                      v
                                                    isolated workspace + ModelTransport
                                                                      │
                                                     inspect → reproduce → plan → edit
                                                                      │
                                                     test → self-review → terminal
                                                                      v
                                               patch/checks/evidence/content-addressed artifacts
```

- GitHub content is untrusted input. Only configured repositories, issue states, and opt-in labels enter the runnable queue. Security-sensitive, destructive, oversized, and ambiguous issues go to human review.
- The model sees a task and harness tools, not credentials or host configuration. Tools allow exact hash-guarded edits, bounded inspection, and named commands only. Paths are workspace-relative, forbidden paths are rejected, environment variables are allowlisted, output and time are capped, and secrets are redacted.
- The worker runs in a caller-provided isolated workspace for `task run`; production integration should provision a disposable checkout at the recorded base commit. The benchmark grader always uses temporary copies.
- `LocalIndex` and `DurableQueue` use schema-versioned JSON, serialized atomic renames, delivery-key deduplication, leases, and recovery. This portable alternative to SQLite is deliberate: it has no native dependency and preserves recovery/deduplication semantics for one local worker. A hosted/multi-worker index is outside these phases.

## Configuration and commands

Repository policy is supplied to the normalizer as a strict `RepositoryPolicy` (see `src/schema.ts`): allowed states, opt-in labels, path/command allowlists, size/time limits, and review-required risk classes. The public library exports all schema parsers and runtime interfaces.

```text
issue-harness                         compact current queue view
issue-harness task list [--state S] [--limit N]
issue-harness task view --id ID
issue-harness task run --id ID --workspace DIR [--transport pi|replay|fake] [--replay FILE]
issue-harness task cancel --id ID [--reason TEXT]
issue-harness bench list|view|grade|run|replay|summary
issue-harness webhook ingest --file EVENT.json --signature sha256=... --secret SECRET
issue-harness auth login --provider openai-codex
issue-harness auth status
issue-harness auth logout --provider openai-codex|openai
issue-harness providers list
issue-harness providers models --provider openai|openai-codex
issue-harness demo
```

`bench grade/run/replay` requires `--task ID` and either `--attempt DIR` or `--patch FILE`. `bench summary --solutions` grades the ten frozen reference candidates and reports Resolved@1-compatible success, regression-free count, elapsed time, and failure categories. `bench summary --attempt-root DIR` grades `DIR/<task-id>` candidates.

## Authentication and model boundary

Standard OpenAI uses `OPENAI_API_KEY` or an injected secret-manager environment. The key is resolved by the embedded provider runtime and is never written to a task, prompt, log, artifact, child-process environment, or fixture. `providers list` reports setup without values.

Codex uses the explicit browser flow:

```sh
issue-harness auth login --provider openai-codex
issue-harness auth status
issue-harness auth logout --provider openai-codex
```

Credentials are app-private at `${ISSUE_HARNESS_AUTH_FILE:-~/.config/issue-harness/auth.json}`, created with mode `0600`; status only reports provider and credential type, never a local path or credential value. No browser cookies, session tokens, or host browser state are copied. The current installed public package is `@earendil-works/pi-ai@0.84.2`, whose authoritative boundary is `createModels()` plus `openaiProvider()` / `openaiCodexProvider()` and `Models.completeSimple()`. `PiModelTransport` normalizes that response into the harness-owned `ModelTransport` interface, so provider SDK types do not enter queue, prompts, tools, or evidence. Fakes and replays implement the same interface for every automated path.

## Webhook and polling adapters

`GitHubWebhookAdapter` requires `sha256=<HMAC>` verification, filters issue events, rejects pull requests, checks policy, normalizes body/comments/links, and deduplicates delivery IDs. `GitHubPollingAdapter` consumes a `GitHubPollClient`, sorts out-of-order updates, and persists an updated-at checkpoint. The recommended production topology is immediate webhook intake plus a slow reconciliation poll; the adapters are independent and tested with in-memory fixtures.

A signed fixture can be ingested without network access:

```sh
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | xxd -p -c 256)"
node dist/cli.js webhook ingest --file fixture.json --signature "$SIG" --secret "$SECRET" --repository owner/repo
```

## Benchmark methodology

There are five compact TypeScript and five Python tasks. Each freezes base files, issue text, commands, allowed paths, public regression checks, and a hidden test. The tracked `fixtures/` tree contains only base files and public checks; `bench view` exposes only solver-facing metadata and base file names, never reference candidates or hidden checks. Grading runs:

1. baseline public checks (the expected failing-before regression signal),
2. candidate public checks,
3. hidden checks,
4. scope/forbidden-path validation, and
5. regression-free aggregation.

Pre-existing baseline failures are explicitly classified, not attributed to a solver. Grading never asks a model whether it succeeded. Every rerun uses fresh temporary directories and fixed fixture inputs.

## Artifacts

Runs are stored locally under `.harness/` (ignored by Git):

- `queue.json`: durable queue entries, leases, and delivery keys;
- `store/index.json`: normalized tasks, run manifests, and checkpoints;
- `artifacts/<digest>`: content-addressed issue, patch, event log, check/evidence, and manifest data;
- `runs/<run-id>.*.json`: typed artifact records.

A terminal run records normalized issue, base commit, provider/model and harness versions, event log, patch, public/hidden outcomes when evaluation is used, usage/cost when available, elapsed time, failure category, and residual risks. Credentials are excluded. Evidence fields are ready for later calibration but are factual outcomes, not probabilities.

## Development

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run demo
```

The lockfile is committed. `npm run package:check` verifies that publication contains only `dist/`, `README.md`, `LICENSE`, and package metadata. Fixtures are source-controlled; generated `.harness`, temporary workspaces, credentials, and run artifacts are not.

## Publication safety

The CI workflow uses least-privilege read-only permissions, immutable action
revisions, clean `npm ci`, production dependency auditing, formatting/lint/type
checks, tests, package-content checks, and the offline demo. Dependabot watches
both npm dependencies and GitHub Actions. No workflow or automated test needs
live GitHub, OpenAI, OAuth, browser-cookie, or API credentials.

Before release, scan the tracked tree and every reachable Git object with a
secret scanner that checks private-key blocks, provider tokens, JWTs, cloud
keys, bearer credentials, and secret-assignment forms. Review redacts values;
only match type and location are recorded. The checked-in fixtures use
constructed placeholders in tests, not live credentials. `npm audit
--omit=dev --audit-level=high` and `npm run package:check` are the dependency
and package-content gates used by CI.

## Phase boundary

Phases 0 and 1 intentionally stop at local queueing, bounded execution, evidence, and evaluation. They do not include hosted control plane, dashboard, multi-tenancy, confidence calibration/probability, automatic draft PR creation, merging, or repository mutation outside a disposable workspace. Future calibration can consume factual evidence plus labels; future PR delivery can consume a reviewed patch and policy decision through explicit extension seams.
