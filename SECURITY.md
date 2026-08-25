# Security policy

Please do not report a suspected vulnerability in a public issue. Use the
repository's GitHub **Report a vulnerability** flow so that details and
credentials are not disclosed publicly. If private vulnerability reporting is
unavailable, contact the maintainers through the repository owner profile
before sharing reproduction details.

This project is local-first. CI and the offline demo do not require GitHub,
OpenAI, OAuth, browser cookies, or other live credentials. Do not include
credentials, cookies, session tokens, or private repository data in issues,
fixtures, prompts, patches, logs, or evidence bundles. The Phase 0/1 workspace
controls are application guardrails, not an OS or network sandbox; do not run
untrusted repository code with sensitive host access. See the full
[security and trust model](docs/security.md) and [current limitations](docs/limitations.md).

Supported releases are the default branch and the latest published package
version, when a package release exists.
