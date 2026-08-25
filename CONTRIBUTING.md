# Contributing

Thanks for helping improve issue-harness. Keep changes focused and preserve the
bounded, local-first trust boundaries described in the [README](README.md).
This project is a local research/evaluation harness, not a production service;
do not broaden claims when adding a feature.

## Where contracts live

Use the implementation as the source of truth and update the relevant tests and
docs together:

- schemas, parser strictness, states, budgets, evidence, and artifact records:
  `src/schema.ts`;
- GitHub HMAC intake, polling, normalization, eligibility, and risk filtering:
  `src/github.ts`;
- queue transitions, leases, and delivery deduplication: `src/queue.ts`;
- JSON index, checkpoints, atomic writes, and content-addressed artifacts:
  `src/storage.ts` and `src/util.ts`;
- path/command/edit/environment guardrails: `src/workspace.ts`;
- provider-independent model contract and provider adapters: `src/model.ts`;
- bounded worker state machine: `src/agent.ts`;
- frozen fixtures and independent grading: `src/benchmarks.ts` and
  `fixtures/manifest.json`;
- CLI flags and authoritative command help: `src/cli.ts`.

Prefer a concise pointer to these contracts or `node dist/cli.js <command>
--help` over duplicating field lists in documentation. If a contract changes,
update the appropriate document under `docs/` and the README's maturity and
limitation statements.

## Adding code safely

### Tools

A new model tool must be added to the harness-owned `ModelToolCall` union,
validated by replay parsing, described in the provider tool schema, dispatched
in `AgentRunner`, and guarded by `Workspace` or another explicit boundary.
Add success, malformed-input, policy, timeout, and redaction tests. Do not add
an unrestricted shell or a path escape. Keep tool arguments structured and
bounded.

### Providers

Implement a `ModelTransport` adapter. Provider SDK types must stop at
`src/model.ts`; queue records, prompts, tools, and evidence use normalized
harness-owned types. Add fake/replay coverage and safe behavior when
credentials are absent. Never print or persist credential values, browser
cookies, or provider response material without redaction.

### Fixtures and evaluation

A fixture needs a frozen base, solver-facing issue and public command, allowed
paths, a reference solution, and an independent hidden check. Keep hidden data
out of solver-facing views and update `fixtures/manifest.json` hashes when the
fixture contract changes. Add deterministic baseline, candidate, hidden,
forbidden-path, and repeatability assertions. A reference-solution pass is
only grader sanity; document any evaluation claim with its corpus and protocol.

### Trust-boundary changes

Add tests for HMAC and delivery deduplication, policy filtering, traversal and
symlink defenses, exact edit hashes, command arguments, environment stripping,
time/output/patch limits, redaction, private credentials, persistence/recovery,
and provider failures as applicable. Treat the current reduced environment as
unsandboxed: tests must not imply OS or network isolation that the code does not
provide.

## Required local checks

Before opening a pull request, run the exact offline checks:

```sh
npm ci
npm run check
npm run package:check
npm run demo
```

`npm run check` runs formatting, lint, typecheck, tests, and build. CI also
runs `npm audit --omit=dev --audit-level=high`. These checks must not require
GitHub, OpenAI, OAuth, browser cookies, or live credentials. Live integration
tests, if added, must be explicit opt-in tests and skip safely when their
credentials are absent.

Keep CLI stdout as structured TOON, stderr for diagnostics, and commands
non-interactive except the explicit Codex OAuth login. Do not commit
`.harness/`, generated workspaces, credentials, cookies, tokens, local paths,
or machine-specific configuration. Keep package contents limited to the
existing publication contract unless the package contract is intentionally
changed and documented.
