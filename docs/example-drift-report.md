# Example drift report

This is an illustrative `/claude-drift:drift-check` report showing the three drift
classes and how findings are presented. Everything here is produced by **reasoning
subagents** — the flow-mapper triages the artifacts, and a drift-auditor judges each
one against the real code. There is no deterministic scanner.

---

# ClaudeDrift report

**5 findings** across 11 artifacts. _(8 artifacts deep-audited after triage; 3 cleared as low-likelihood.)_

## 🔴 Broken (2)

- **.claude/skills/work-issues/SKILL.md** — `…/skill.md` _(confidence: medium)_
  - case mismatch — resolves on macOS/Windows but breaks on case-sensitive filesystems (Linux/CI)
  - fix: `work-issues/skill.md` → `work-issues/SKILL.md`
- **CLAUDE.md** — `npm run test:integration` _(confidence: high)_
  - not defined in `package.json` scripts — the script was renamed to `test:int`
  - fix: `npm run test:integration` → `npm run test:int`

## 🟠 Stale — context drift (1)

- **CLAUDE.md** — "State is managed with **Redux**" _(confidence: medium)_
  - claim: the app uses Redux for state management
  - reality: state is managed with **Zustand** — `src/store/index.ts:1` imports `create` from `zustand`; no `redux` dependency remains in `package.json`
  - fix: `Redux` → `Zustand`

## 🟡 Outdated / low-confidence (1)

- **.claude/agents/api-builder.md** — `lib/api/v1/` _(confidence: low)_
  - the artifact references no paths that resolve in this repo (generic/example or fully stale) — flagged for review rather than an automatic fix

## ⚪ Legacy narration — forward-looking (1)

- **CLAUDE.md** — "Local dev uses **Laravel Sail (previously Herd)**" _(confidence: high)_
  - the claim is *accurate* — the project does use Sail — but the parenthetical narrates a migration a steering doc shouldn't carry
  - reality: `docker-compose.yml` + `vendor/bin/sail` confirm Sail; no Herd config remains
  - fix: `Laravel Sail (previously Herd)` → `Laravel Sail`
  - _left untouched nearby:_ a `(decided #482)` provenance tag and a "don't recreate the old `storage/` symlink" guard — provenance and genuine guards are not cruft

---

**Apply fixes?** ClaudeDrift will apply the four findings that carry a concrete edit
(skipping the low-confidence item for manual review), then re-verify each edited
artifact to confirm the finding is resolved.

### Notes on what was *not* flagged

The auditors read far more than they reported and stayed silent on most of it.
Reasoned-away examples:

| Considered | Why it's not drift |
|---|---|
| `app/Models/User*` | a glob/pattern, not a single path |
| `gitbook/scripts/<name>.md` | `<name>` placeholder |
| `~/.config/credentials.json` | external home path |
| `$ROOT_REPO/.workspace/log.md` | shell/env variable |
| `config/dev.secret.exs` | gitignored (intentionally absent) |
| `bootstrap/cache/config.php` | runtime-generated output |
| `docs/ARCHITECTURE.md` (near "generate") | described as created (output path) |
| `hashql-mir/src/parser.rs` | path relative to another crate/sub-package |
| "we deprecated the v1 endpoint in 2023" (in `CHANGELOG.md`) | a historical record — past tense is the point |
| "use `rg` instead of `grep`" | an "instead of" comparison of current options, not history |

Each silence is a judgment the reasoning agent made by reading the artifact in
context — the distinction between a real claim and an example, a sub-package path, or
history worth keeping is exactly why ClaudeDrift reasons instead of pattern-matching.
