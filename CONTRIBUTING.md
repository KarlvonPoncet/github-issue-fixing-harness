# Contributing

Thanks for helping improve issue-harness. Keep changes focused and preserve the
bounded, local-first trust boundaries described in `README.md`.

## Before opening a pull request

```sh
npm ci
npm run check
npm run package:check
npm run demo
```

The checks and demo are offline and must not require credentials. Do not commit
`.harness/`, generated workspaces, credentials, cookies, tokens, local paths,
or machine-specific configuration. Live provider or GitHub integration tests
must be explicit opt-in tests and skip safely when their required credentials
are absent.

Keep CLI stdout structured TOON, stderr for diagnostics, and commands
non-interactive except for the explicit Codex OAuth login flow. Add tests for
changes to trust boundaries, redaction, path or command policy, and benchmark
reproducibility.
