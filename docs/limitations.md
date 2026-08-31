# Current limitations

These are implemented limitations, not merely future features:

- `task run` can reach a successful terminal result without verified candidate
  or regression checks. Its task-run evidence currently contains no checks and
  derives success flags from the worker outcome. Run `bench grade` separately;
  do not use worker success as approval.
- The webhook's `baseCommit` currently comes from the repository default-branch
  field, not an exact immutable event commit checkout. Polling does not verify
  its supplied base value either.
- The caller supplies the workspace. The harness does not clone or checkout a
  repository, and it does not verify that the workspace matches the recorded
  base.
- Workspace path, hash, command, timeout, output, and environment controls are
  application guardrails only. The reduced environment is not an OS/network
  sandbox for untrusted repository code.
- Queue/index/artifact/log updates are separate local JSON/filesystem
  operations. Per-run logs are append-safe and isolated by run ID, but there is
  no crash-safe multi-file transaction, automatic log retention or recovery
  daemon, distributed lock, or multi-worker queue coordination. A crash can
  leave a durable partial log alongside incomplete artifacts.
- No branch, commit, push, draft PR, review request, merge, or other GitHub
  delivery/mutation is implemented.
- The twenty TypeScript/Python fixtures and their hidden checks are a
  deterministic grader sanity suite, not held-out or general-purpose model
  evaluation. They remain small and do not represent broad repository or
  language coverage.

The dependency-ordered remediation plan is in [the roadmap](roadmap.md); the
contracts and recovery assumptions are in
[architecture](architecture.md), and the trust implications are in
[security](security.md).
