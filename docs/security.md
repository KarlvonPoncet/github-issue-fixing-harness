# Security and trust model

The harness treats GitHub content and repository code as untrusted. The controls
below reduce accidental scope and credential exposure, but the current Phase
0/1 implementation is **not an OS, container, VM, seccomp, or network sandbox**.
A repository command that passes the application allowlist can still exploit
its host process permissions, filesystem, kernel, or network access available
to the caller. Run untrusted work only in a separately provisioned disposable
environment with no sensitive host or network access.

## Trust boundaries

### GitHub intake

`GitHubWebhookAdapter` verifies the exact request body with an HMAC-SHA-256
signature of the form `sha256=<hex>`. It requires a non-empty configured secret,
uses a timing-safe comparison, rejects malformed webhook requests, filters to
issue and issue-comment events and supported actions, and rejects pull requests.
The in-memory delivery set plus durable delivery keys prevent duplicate
processing in the normal lifetime/local queue path.

`GitHubPollingAdapter` is a caller-supplied integration boundary. It sorts
updates by timestamp and number, deduplicates through the queue, and persists a
checkpoint. It does not itself authenticate a GitHub client or verify a base
commit; the client implementation is responsible for its upstream connection.

### Policy filtering

A repository policy must identify the repository and can restrict issue states,
require opt-in labels, allow or forbid paths, allow named commands, cap issue
and patch sizes and command time, and require review for risk classes. The
normalizer classifies text mentioning credentials/secrets/tokens/passwords,
destructive operations, or uncertainty as review-sensitive; oversized input is
also retained for review. These are conservative filters, not a complete
security classifier. A configured policy and human review remain necessary.

Schema parsers reject unknown fields and enforce type and size limits before
values enter the worker. Issue title/body/comments, authors, links, repository
values, prompts, command output, and stored text pass through the project's
redactor where applicable. Per-run JSON-lines logs contain only safe metadata
for tools and models plus redacted error/check text; provider credentials and
raw tool arguments are not logged. Redaction is pattern-based and cannot
guarantee that every secret format is recognized.

### Workspace guardrails

`Workspace` enforces:

- relative paths rooted in the caller's workspace, with `..`, absolute paths,
  NUL bytes, and symlink escapes rejected;
- forbidden path patterns before allowed-path checks, and configured allowed
  path patterns for inspection and exact edits;
- exact SHA-256 preconditions for replacements, no NUL bytes, a patch byte cap,
  and rejection if replacement text looks secret-like;
- named commands only, with an executable and fixed argument prefix checked
  against the implementation's safe command forms; command path arguments are
  checked against allowed or explicitly permitted command-input paths;
- bounded output, command timeout, and patch collection; and
- a child environment containing only selected locale/path values plus a
  workspace-local `HOME`, `TMPDIR`, and `HARNESS=1`. Provider keys are not
  inherited by these command children.

These controls constrain what the harness asks a model to do. They do not make
an allowlisted interpreter safe against hostile code.

### Credentials and providers

The provider boundary is `ModelTransport` in `src/model.ts`. Provider SDK
objects do not enter queue records, prompts, tools, or evidence; the adapter
returns normalized text, tool calls, and usage. API-key authentication is
resolved by the provider runtime. Codex OAuth is explicitly initiated by the
operator and stores credentials in the private auth file described in
[usage](usage.md#authentication-boundaries). The harness does not copy browser
cookies or session tokens.

Credential files are written with mode `0600` and existing non-private files are
rejected. CLI provider/status output does not print values or local credential
paths. Run logs and artifacts are redacted before string storage and are kept
under private `0700`/`0600` local paths, but operators must still avoid putting
sensitive data in issue bodies, fixtures, prompts, patches, logs, or evidence.
There is no automatic log retention or secure erasure; delete local run data
when it is no longer needed. CI currently runs dependency auditing, project
checks, package content checks, and the offline demo; it does not run secret
scanning. Any manual or release secret scan should record only the match type
and location, not the matched value. See `SECURITY.md` for reporting policy.

## What is not protected today

- There is no OS/network sandbox or resource isolation beyond application
  time/output/size limits.
- Exact event-base checkout and commit provenance are not enforced. The webhook
  currently stores the default-branch field as `baseCommit`; it is not an exact
  commit SHA guarantee.
- The worker can reach `resolved`/`succeeded` without candidate or regression
  checks. Its task-run evidence currently has no check records and must not be
  used as an approval signal.
- Local JSON persistence has no cross-file transaction, distributed lease
  service, or multi-worker coordination.
- No branch, commit, push, PR, merge, or GitHub mutation is performed by this
  phase.

The prioritized remediation sequence is in the [roadmap](roadmap.md). Before
any autonomous GitHub action, the system needs evidence-backed semantics,
provenance enforcement, true sandboxing/resource controls, crash-safe recovery,
and a human-reviewed beta gate.
