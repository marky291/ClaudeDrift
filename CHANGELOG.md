# Changelog

All notable changes to ClaudeDrift are documented here. This project follows
[semantic versioning](https://semver.org/).

## [0.4.1] — Example/sample-output precision

Continued rich-artifact validation surfaced one more false-positive class:
illustrative paths in agent/skill instructions.

### Added
- **Example-context downgrade** — paths in lines marked `e.g.`, `for example`,
  `**Example**:`, `such as`, or sample-report markers (`unreferenced`, `last
  touched`) are downgraded to low confidence (kept for the semantic pass).
- **Agent/command fenced sample blocks** — paths inside ``` fences in agents and
  commands (where sample I/O lives) are downgraded to low.

### Fixed
- Example-context regex no longer fails next to `**`/`(` (a leading `\b` broke
  `**Example**` and `e.g.`).

### Results
- ts2anki high-confidence findings cut to only genuine drift, independently
  confirmed by the semantic auditor (e.g. `src/lib/Token.ts` referenced in three
  agents' `HARD_BLOCK_PATHS` safety lists but absent from the repo). Suite: 37 cases.

## [0.4.0] — Rich-artifact validation + preflight

Validated against real repositories with **populated `.claude/` surfaces** —
agents, skills, and commands (2anki/server: 12 agents + 8 skills + 17 commands;
basedosdados/pipelines; hashintel/hash) — not just CLAUDE.md. Each false positive
became a general rule.

### Added
- **Preflight dependency check** (`--preflight`) — before validating, the skill
  verifies dependencies/submodules are installed (`node_modules`, `vendor`, a
  Python virtualenv, initialized submodules) and warns up front, because refs into
  uninstalled packages otherwise look like drift. Surfaced in every run under
  `preflight` and as a `Step 0` in the command.
- **Nested-manifest awareness** — npm/composer scripts are unioned across *all*
  `package.json`/`composer.json` files (monorepos/subprojects keep their own, e.g.
  `web/package.json`), so a script defined in a subproject isn't reported missing.
- **`file:line` citations** (`foo.ts:78`) have the line/col suffix stripped before
  resolving — extremely common in agent docs.
- **Confidence anchored to real top-level dirs** — a missing multi-segment path is
  HIGH only if its first segment is an actual top-level dir; otherwise LOW (handles
  monorepo crate-relative paths like `hashql-mir/src/...`). Root-level files stay HIGH.

### Fixed
- CLI flags captured as script names (`pnpm --filter web build` no longer reports
  `--filter`); `yarn workspace` builtin excluded.
- Build-output/generated dirs anywhere in a path (`web/build/…`, `dist/`, `target/`).
- Truncated template refs (`docs/spec-`).
- **Context bleed** — negative/creation keywords on an adjacent line no longer
  suppress an unrelated reference (context window is now the current line only).

### Results
- ts2anki (37 artifacts): noise cut to a small set of high-confidence findings that
  are genuine drift (`Documentation/specs`, `src/lib/Token.ts` cited across many
  artifacts); remaining items are agent sample-output paths left for the semantic
  pass. Regression suite grown to 35 cases.

## [0.3.0] — Cross-ecosystem precision

Validated against real GitHub repositories shipping Claude artifacts across many
language ecosystems (PHP, Go, Python, C#, Ruby, Rust, JavaScript, Elixir). Every
false positive found became a general precision rule — not a hardcoded exception.

### Added
- **Language-agnostic project-path detection** — a reference "looks like a project
  path" when its first segment is a real top-level directory of *this* project,
  replacing the PHP/JS-biased `src`/`app` allowlist. Catches real refs in Go
  (`internal/`), C# (`modules/`), Rust (`crates/`) layouts while still ignoring
  branch names (`feature/x`) and import paths (`github.com/...`).
- **Git submodule awareness** — paths under a declared `.gitmodules` submodule are
  not flagged (legitimately empty until `git submodule update`).
- **Editor/IDE config suppression** — `.vscode`, `.idea`, `.fleet`, `.zed` are
  treated as local-only, not drift.
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
- **Stronger negative context** — "there is no X directory", "must be initialized",
  "git-ignored" now recognized as describing absence.
- New suppressions: shell/env vars (`$ROOT_REPO`), absolute machine paths,
  `ALL_CAPS`/`path/to` placeholder segments, `File1`/`example-` names.

### Fixed
- Gitignore glob matcher crash on patterns like `*.ez`.

### Results
- ragnasync 19 → 2 findings; PlatformPlatform 9 → 1 high; zaq's high-confidence
  findings confirmed as genuine drift (e.g. a renamed module). Re-validated on 5
  more real repos (Go/C#/Ruby/Rust/Python) — only genuine drift surfaced (e.g. a
  Go repo documenting a `run.sh` that isn't committed), zero false positives. The
  semantic pass independently caught dependency-version and CI-workflow context
  drift the deterministic layer can't see. Regression suite grown to 27 cases.

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
