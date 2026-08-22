# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Project notes

- Architecture, trust boundaries, auth, benchmark methodology, artifact layout, and phase limits are authoritative in `README.md`.
- Run `npm run check && npm run demo` before handing off changes; benchmark tests intentionally execute ten temporary repositories.
- CLI output is TOON on stdout and the CLI must stay non-interactive except for explicit Codex OAuth login.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file, command, or doc instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
