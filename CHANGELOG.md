# Changelog

All notable changes to ClaudeDrift are documented here. This project follows
[semantic versioning](https://semver.org/).

## [0.7.0] — Legacy narration (forward-looking drift)

**New drift class.** ClaudeDrift now catches a third kind of drift: **legacy
narration** (forward-looking drift). An artifact can be perfectly accurate — every
path resolves, every description matches the code — yet still carry superseded-history
framing a steering doc shouldn't ("Use Laravel Sail (previously Herd)", "X replaced
Y", "Updated &lt;date&gt;: this section previously…"). It makes Claude read the
migration story to act on the present, and risks acting on the dead thing. The fix
states today's reality only.

The value is the *keep/strip judgment*, which is why it runs through the reasoning
agent, not a regex: provenance refs (bug/PR/date), genuine removal-guards (rephrased
forward, never deleted), "instead of" comparisons, and true historical records
(CHANGELOGs, ADRs, release notes) are deliberately left alone.

### Added
- **Legacy-narration detection** in `drift-auditor` — a third drift kind with its own
  `legacy` severity and the explicit keep-vs-strip rules; a `legacy` fix strips a
  history clause or rephrases to present tense, and must preserve any operational
  guard the history wraps.
- **`--forward-only` mode** in `drift-check` — a focused forward-looking pass that
  spotlights only the ⚪ Legacy narration band (reference/context findings suppressed).
- **⚪ Legacy narration** report band (always listed last, softest severity).
- **Legacy-narration weighting** in `claude-flow-mapper` triage, so a path-accurate
  but history-heavy artifact isn't rated `none`; record-role artifacts are exempted.

### Changed
- README, plugin/marketplace descriptions, and the example report updated to describe
  three drift classes (the example report also corrected — it still credited the
  deterministic scanner removed in 0.6.0).

## [0.6.0] — Reasoning engine (deterministic scanner removed)

**Architecture change.** ClaudeDrift no longer uses a deterministic script to find
drift. Validated across ~40 real repos, the regex/heuristic scanner was an endless
catch-up — every new repo surfaced a false-positive class needing another rule —
while the reasoning subagents judged every ambiguous case correctly (example vs
real path, sub-package/dependency paths, prose-where-slash-means-and, generic
templates). So the engine is now **Claude's reasoning, via subagents**.

### Changed
- **`claude-flow-mapper` agent (new)** — determines the project's "Claude flow":
  discovers every artifact, reads the codebase to understand the real
  stack/layout/workflow, notes dependency-install state, and ranks each artifact by
  drift-likelihood so the deep audit is prioritized (not N blind agents).
- **`drift-auditor` agent (rewritten)** — reasons about one artifact vs the real
  code from scratch (reference + context drift); no script-fed hints. Judges
  examples / sub-package paths / created-output / prose itself.
- **`drift-check` skill (rewritten)** — orchestrates map → audit → synthesize →
  apply purely with subagents and reasoning. Args simplified to
  `--user` / `--changed` / `--apply` / `path`.

### Removed
- `scripts/discover.mjs` (the ~1000-line deterministic scanner and all its precision
  rules), `test/run.mjs` (its 53-case suite), and `package.json` (the test runner).
- Script-only modes: `--ci` / `--baseline` / `--preflight` / `--report` /
  `--merge` / `--changed-only`. (Install-state is now reported by the flow-mapper;
  `--changed` uses `git diff`.)

## [0.5.2] — Prose-enumeration false positive

Re-checked against marky291/ragnasync (now well-maintained, CLAUDE.md fully aligned
per the semantic pass). The only deterministic false positive — a bare slash-token
in a prose comma-list of subsystem names (`packet routing, deploy/pulse, …`) flagged
because `deploy/` is a real dir — is fixed.

### Added
- **Backtick provenance + prose-enumeration downgrade** — a BARE (non-code-span)
  ref inside a comma-list of multi-word phrases is downgraded to low; backticked
  refs are exempt (recall-safe; guarded by the recall corpus). Suite 52 → 53.

## [0.5.1] — Recall corpus + scanner refactor (no behavior change)

Hardening the precision work so it can't silently hide real drift.

### Added
- **Recall corpus** — regression tests asserting confirmed real-drift classes (a
  missing path referenced in prose, a renamed make/npm target in an artifact whose
  other commands resolve, a surfaced case-mismatch) *stay* high-confidence. Until
  now every test measured precision (are HIGH findings real?); these guard recall
  (are we over-suppressing?). Suite: 47 → 52 cases.

### Changed
- **`classifyPath` refactored** from a 120-line sequential `if`-gauntlet into a
  declarative, ordered rule pipeline (`RAW_SUPPRESS` / `EARLY_SUPPRESS` /
  `LATE_SUPPRESS` / `DOWNGRADE` tables). Each precision rule is now named and
  individually testable; precedence is explicit. Inline regexes extracted to named
  constants. Behavior is unchanged — all 52 tests pass identically.

## [0.5.0] — 30-source validation sweep

Ran the full plugin flow (preflight + dependency install + discover + semantic
auditor) against **30 real repositories** across 8+ languages, installing deps so
references resolve accurately. Each new false-positive class became a general rule;
the semantic auditor confirmed surviving high-confidence findings are real drift
(e.g. 2anki's `src/lib/Token.ts` in three agents' `HARD_BLOCK_PATHS` safety lists).
Result: **21/30 repos clean**, remaining high-confidence findings are genuine drift
or cases that by design require the semantic pass (illustrative examples in fenced
skill snippets, cross-repo dependency references).

### Added
- **Preflight dependency check** surfaced and used during validation; deps are
  installed (`--ignore-scripts`) before scanning so uninstalled packages don't read
  as drift.
- **Command-corroboration** — if fewer than a third of an artifact's commands exist
  in the project, it's a generic/prescriptive checklist (e.g. an "optimizer" agent
  listing `make build`/`make test-unit`) → downgrade. mcp-skillset 14→2 high.
- **Markdown table cells** and **alternative/candidate path lists** (`a`, `b`, or
  `c`) downgraded — descriptive, not file-existence claims.
- **Basename-exists-elsewhere** downgrade for moved / cwd-relative refs.
- New suppressions: runtime dirs under `.claude/` (`checkpoints`, `logs`, …), env
  config files (`.env.override.local`), doc-template placeholders (`NNN`,
  `short_name`, `bugN`), PascalCase example names (`ComponentName`, `MyComponent`).

### Fixed
- Hook commands with quotes / interpreter prefix (`"$CLAUDE_PROJECT_DIR"/x.sh`,
  `bash x.sh`) now resolve; dotdir fragments (`/.claude/...`) no longer mis-captured.
- `file:line` citations stripped before resolving; tool binaries (`pnpm tsc`,
  `eslint`, `vitest`) no longer reported as missing scripts.
- Context bleed: example/creation keywords no longer cross line boundaries.
- Confidence anchored to real top-level dirs (crate-relative paths → low).

### Coverage
- Regression suite grown to **47 cases**, each derived from a real false/true
  positive observed across the 30 repos.

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
