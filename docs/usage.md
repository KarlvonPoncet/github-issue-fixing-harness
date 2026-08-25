# Installation, operation, and CLI usage

## Prerequisites and installation

The supported development runtime is Node.js 22 or newer. The repository
commits `package-lock.json`; install exactly from the checkout with:

```sh
npm ci
npm run build
```

The build writes `dist/`. The package's executable is `dist/cli.js`; use
`node dist/cli.js ...` from a checkout. A published/install-linked package can
expose the same file as `issue-harness`, but this repository's reproducible
examples use the explicit Node command.

For the complete local validation, run:

```sh
npm run check
npm run package:check
npm run demo
```

`npm run check` expands to formatting validation, ESLint, TypeScript typecheck,
tests, and a build. Individual commands are:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run package:check
npm run demo
npm audit --omit=dev --audit-level=high
```

The audit command is the production-dependency check used by CI. The CI
workflow additionally runs `npm ci`, all of `npm run check`, package-content
validation, and the offline demo.

## Offline demo and safe local use

After a build (or directly from TypeScript with the repository's demo script):

```sh
npm run demo
# equivalent source entry point:
node --import tsx src/cli.ts demo
```

The demo creates a temporary fixture workspace, enqueues a signed-fixture-like
task, runs a fake model through the bounded tools, grades the resulting patch,
stores temporary artifacts, prints the result, and removes its temporary root.
It does not use GitHub, a provider, OAuth, browser cookies, or network access.

For local experiments:

- Use a disposable copy or VM/container for repository code. The workspace
  restrictions are application-level checks, **not an OS/network sandbox**.
- Keep `.harness/` and workspaces private and never share them with credentials.
- Use `--transport fake` or `--transport replay` for deterministic development.
  Use live `--transport pi` only when the provider boundary and workspace are
  appropriate for the data involved.
- Do not run multiple workers against one `.harness` directory.
- Inspect terminal evidence and run `bench grade` independently; do not infer
  that `task run` status `succeeded` means tests or regressions were verified.

## Configuration boundaries

There is no general configuration-file loader or hosted service in this phase.
Library callers construct a strict `RepositoryPolicy` (see
`src/schema.ts`) and pass it to the GitHub adapters and workspace. Its fields
cover:

- repository identity, allowed issue states, and opt-in labels;
- allowed and forbidden workspace path patterns;
- named command allowlist;
- issue, patch, and command size/time limits; and
- risk classes requiring human review.

The CLI's fixture-oriented webhook command uses an internal default policy for
the selected repository. It is useful for local ingestion, not a production
GitHub webhook server. `--base-commit` is accepted by the CLI help surface but
is not used to enforce checkout; exact-base provenance is a roadmap item.

Run-specific settings are flags:

- `task run` requires a task ID and caller-provided `--workspace` and accepts
  `--transport pi|replay|fake`, `--replay`, `--provider`, and `--model`.
- `bench grade`, `bench run`, and `bench replay` require `--task` plus either
  `--attempt` directory or `--patch` file.
- `bench summary` accepts `--solutions` or `--attempt-root`.

## Authentication boundaries

OpenAI API-key authentication is resolved by the provider runtime from
`OPENAI_API_KEY` or an injected secret-manager environment. The harness does
not print the key or copy it into prompts, task artifacts, logs, or the child
command environment.

Codex OAuth is the sole interactive operation:

```sh
node dist/cli.js auth login --provider openai-codex
node dist/cli.js auth status
node dist/cli.js auth logout --provider openai-codex
```

Credentials are stored in `${ISSUE_HARNESS_AUTH_FILE}` when set, otherwise
`~/.config/issue-harness/auth.json`. The file is created privately (`0600`),
existing files with group/other permissions are rejected, and status reports
provider IDs and credential types only. The provider owns the OAuth exchange;
the harness bridges an explicit browser URL/manual-code flow and does not copy
cookies or host browser state.

Discover provider setup and available models without printing credential values:

```sh
node dist/cli.js providers list
node dist/cli.js providers models --provider openai
node dist/cli.js providers models --provider openai-codex
```

## CLI command reference

The CLI help is authoritative for the installed version. These commands print
compact TOON on stdout and use exit code 2 for usage errors:

```text
node dist/cli.js
node dist/cli.js --help
node dist/cli.js task list [--state <state>] [--limit <n>]
node dist/cli.js task view --id <task-id>
node dist/cli.js task run --id <task-id> --workspace <dir> [--transport pi|replay|fake] [--replay <json>] [--provider <provider>] [--model <id>]
node dist/cli.js task cancel --id <task-id> [--reason <text>]
node dist/cli.js bench list
node dist/cli.js bench view --task <task-id> [--full]
node dist/cli.js bench grade --task <task-id> (--attempt <dir>|--patch <file>)
node dist/cli.js bench run --task <task-id> (--attempt <dir>|--patch <file>)
node dist/cli.js bench replay --task <task-id> (--attempt <dir>|--patch <file>)
node dist/cli.js bench summary (--solutions|--attempt-root <dir>)
node dist/cli.js webhook ingest --file <event.json> --signature <sha256=...> --secret <secret> [--repository <owner/name>]
node dist/cli.js auth login --provider openai-codex [--manual-code <code>]
node dist/cli.js auth status
node dist/cli.js auth logout --provider <openai|openai-codex>
node dist/cli.js providers list
node dist/cli.js providers models --provider <openai|openai-codex>
node dist/cli.js demo
```

The `bench run` and `bench replay` names are aliases of grading in this phase;
they do not run a model. `webhook ingest` reads a JSON event from disk and
verifies the supplied signature; it is an adapter exercise, not an HTTP
listener. To make a signature for a local body, use a shell tool without
printing the secret:

```sh
SIG="sha256=$(openssl dgst -sha256 -hmac "$SECRET" -binary < event.json | xxd -p -c 256)"
node dist/cli.js webhook ingest --file event.json --signature "$SIG" --secret "$SECRET" --repository owner/repo
```

Only use fixture or sanitized event data in this command. The repository's
library adapter requires event and delivery headers; the CLI supplies those
fixture values internally.

## Local data and artifacts

The default worker root is `.harness/` (ignored by Git):

- `queue.json` contains queue entries, attempts, leases, and delivery keys;
- `store/index.json` contains normalized tasks, run manifests, and checkpoints;
- `artifacts/<prefix>/<sha256>` contains content-addressed data; and
- `runs/<run-id>.*.json` contains typed artifact records.

Runs may include normalized issue, patch, event log, evidence, manifest,
provider/model profile, budget, elapsed time, usage, failure category, and
residual risks. Values pass through redaction, but redaction is not a reason to
store private data. Credentials, cookies, tokens, and private repository data
do not belong in fixtures, prompts, patches, or artifacts.

Atomic JSON writes and local leases support simple restart/requeue workflows,
but they do not provide crash-safe transactions across all files. Recovery
helpers are library APIs and no background worker automatically invokes them.
See [architecture](architecture.md#persistence-recovery-and-concurrency).
