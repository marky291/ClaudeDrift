# Changelog

All notable changes to ClaudeDrift are documented here. This project follows
[semantic versioning](https://semver.org/).

## [0.3.0] — Cross-ecosystem precision

Validated against real GitHub repositories shipping Claude artifacts across **6
language ecosystems** (PHP, Elixir, Python, C#, JavaScript, Rust/Lua). Every
false positive found became a general precision rule — not a hardcoded exception.

### Added
- **`.gitignore`-aware suppression** — references to ignored files (secrets, local
  settings, build output) are no longer reported as missing.
- **Creation-context detection** — a path a doc says it *creates* ("writes `x`") is
  treated as an output, not a missing reference.
- **Corroboration rule** — a broken path is high-confidence only if the artifact
  also names a path that resolves; ungrounded artifacts (generic toolkits, fully
  stale docs) are downgraded to low for the semantic pass to adjudicate.
- **Command precision** — commands are only checked inside code spans/fences (no
  prose false matches); package-manager builtins excluded; unresolved module/colon
  recipes downgraded.
- New suppressions: shell/env vars (`$ROOT_REPO`), absolute machine paths,
  `ALL_CAPS`/`path/to` placeholder segments, `File1`/`example-` names.

### Fixed
- Gitignore glob matcher crash on patterns like `*.ez`.

### Results
- ragnasync 19 → 2 findings; PlatformPlatform 9 → 1 high; zaq's high-confidence
  findings confirmed as genuine drift (e.g. a renamed module). Regression suite
  grown to 21 cases.

## [0.2.0] — Precision, coverage, context drift & productization

### Added
- **Precision filters** with auditable `suppressed[]` output: globs, placeholders,
  external `~/` paths, example names, runtime-generated files, negative context.
- **Case-sensitive existence check** — catches references that resolve on
  macOS/Windows but break on Linux/CI.
- **Coverage**: composer / envoy / just / make / npm commands, cross-references to
  other skills/agents, `.mcp.json` command resolution, env vars vs `.env.example`.
- **Confidence + source** on every finding; `--merge` mode to deterministically
  merge semantic findings.
- **Context drift** made the primary objective of the `drift-auditor` agent and the
  orchestration — the semantic pass runs on every changed artifact.
- **Productization**: `--baseline` / `--changed-only` incremental mode, `--ci` with
  `--fail-on` exit codes, `--report` markdown, hardened apply loop with re-verify,
  and a precision regression suite (`npm test`).

## [0.1.0] — Initial release

- The `/claude-drift:drift-check` command, `drift-auditor` agent, and the
  zero-dependency `discover.mjs` scanner. Discovers project Claude artifacts and
  hard-verifies their references against the filesystem and package manifests.
