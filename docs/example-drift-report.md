# Example drift report

This is an illustrative `/claude-drift:drift-check` report showing both drift
types and how findings are presented. Reference-drift findings come from the
deterministic scanner; context-drift findings come from the semantic pass.

---

# ClaudeDrift report

**4 findings** across 11 artifacts. _(312 reference candidates analyzed, 308 ignored with reasons.)_

## 🔴 Broken (2)

- **.claude/skills/work-issues/SKILL.md** — `…/skill.md` _(confidence: medium, via script)_
  - case mismatch — resolves on macOS/Windows but breaks on case-sensitive filesystems (Linux/CI)
  - fix: `work-issues/skill.md` → `work-issues/SKILL.md`
- **CLAUDE.md** — `npm run test:integration` _(confidence: high, via script)_
  - not defined (package.json scripts) — the script was renamed to `test:int`
  - fix: `npm run test:integration` → `npm run test:int`

## 🟠 Stale — context drift (1)

- **CLAUDE.md** — "State is managed with **Redux**" _(confidence: medium, via auditor)_
  - claim: the app uses Redux for state management
  - reality: state is managed with **Zustand** — `src/store/index.ts:1` imports `create` from `zustand`; no `redux` dependency remains in `package.json`
  - fix: `Redux` → `Zustand`

## 🟡 Warning (1)

- **.claude/agents/api-builder.md** — `lib/api/v1/` _(confidence: low, via script)_
  - artifact references no paths that resolve in this repo (generic/example or fully stale; needs semantic review)

---

**Apply fixes?** ClaudeDrift will apply the three findings with a concrete edit
(skipping the low-confidence warning), then re-run the scanner on those artifacts
to confirm each finding is resolved.

### Notes on what was *not* reported

The scanner analyzed 312 candidate references and deliberately ignored 308,
including:

| Ignored | Why |
|---|---|
| `app/Models/User*` | glob/pattern |
| `gitbook/scripts/<name>.md` | placeholder |
| `~/.config/credentials.json` | external home path |
| `$ROOT_REPO/.workspace/log.md` | shell/env variable |
| `config/dev.secret.exs` | gitignored (intentionally absent) |
| `bootstrap/cache/config.php` | runtime-generated |
| `docs/ARCHITECTURE.md` (near "generate") | described as created (output path) |
| `app/Services/FooService.php` | example/placeholder name |

Every ignored candidate appears in the machine-readable output with its reason,
so the tool's decisions are fully auditable.
