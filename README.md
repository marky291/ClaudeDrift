# ClaudeDrift

A Claude Code plugin that detects and fixes **drift** between a project's Claude
artifacts and the project's actual current reality.

## The problem

As a project grows, the Claude configuration that steers Claude on it — `CLAUDE.md`
files, skills, slash commands, subagents, hooks/settings — slowly drifts out of
sync with the code. A skill written months ago references files that moved,
commands that were renamed, or an architecture that has since been rewritten.
Claude then confidently follows stale instructions and makes the wrong call.

ClaudeDrift audits all of those artifacts against the codebase you run it from,
tells you exactly where they've drifted, and offers to fix them.

It catches two kinds of drift:

- **Reference drift** — a path, command, or script the artifact names no longer
  exists. Found deterministically by a bundled Node script.
- **Context drift** — the artifact's *description* of the architecture, workflow,
  tech stack, or conventions no longer matches the code, **even when every file
  path still resolves** (e.g. "we use Redux" when the code moved to Zustand). This
  is the harder, higher-value class, found by a semantic subagent pass that reads
  the code.

## What it checks

- `CLAUDE.md` files (including nested ones)
- `.claude/skills/*/SKILL.md`
- `.claude/commands/**/*.md`
- `.claude/agents/*.md`
- `.claude/settings.json`, `settings.local.json`, and hooks
- `.mcp.json` (project and `.claude/`)
- With `--user`: the same artifacts under `~/.claude` (reported separately)

**Source of truth:** the codebase the command is run from. When an artifact and
the code disagree, the artifact is treated as wrong and gets fixed — never the code.

## How it works

A hybrid of deterministic checks and semantic judgment:

1. **`scripts/discover.mjs`** (Node, zero dependencies) enumerates every artifact
   and hard-verifies the concrete references inside them — file paths, npm /
   composer / make / just / envoy commands, hook & MCP command targets,
   cross-references to other skills/agents, env vars vs `.env.example` — against
   the live filesystem and package manifests. It is **language-agnostic**: a ref
   "looks like a project path" when its first segment is a real top-level directory
   of the project (not a hardcoded `src`/`app` allowlist), so it works for Go, Rust,
   C#, Python, Ruby, PHP, JS and any layout. Precision filters mean it doesn't flag
   globs, placeholders, external `~/` paths, runtime-generated files, example names,
   git-submodule paths, editor/IDE config, or paths a doc explicitly describes as
   removed; every suppressed candidate is reported with a reason. A case-sensitive
   existence check catches refs that work on macOS but break on Linux/CI. Node is
   always present because Claude Code itself runs on Node.
2. **`drift-auditor`** subagents read each *changed* artifact alongside the code it
   describes and judge **context drift** — whether the described architecture,
   workflow, tech stack, and conventions still match — proposing grounded edits
   with evidence. They run even on artifacts with zero broken references, because
   that's where context drift hides.
3. The **`/claude-drift:drift-check`** command orchestrates both passes, lets the
   script deterministically merge and de-duplicate the findings, produces a
   severity-ranked report (🔴 Broken / 🟠 Stale / 🟡 Warning·Outdated) with
   confidence levels, and offers to apply the fixes (then re-verifies them). A
   baseline file enables cheap `--changed-only` re-runs.

## Usage

```
/claude-drift:drift-check                # audit the current project
/claude-drift:drift-check --user         # also audit ~/.claude artifacts
/claude-drift:drift-check --changed-only # only re-audit artifacts changed since baseline
/claude-drift:drift-check --apply        # apply fixes without re-prompting
/claude-drift:drift-check --ci           # non-interactive: write report, no apply
/claude-drift:drift-check /path/to/proj  # audit a different project dir
```

The bundled script can also be run directly (it's what the command calls):

```bash
node scripts/discover.mjs <projectDir> [--user] [--changed-only]
node scripts/discover.mjs <projectDir> --report drift.md   # write a markdown report
node scripts/discover.mjs <projectDir> --baseline          # record state for --changed-only
node scripts/discover.mjs <projectDir> --merge auditor.json # merge semantic findings
node scripts/discover.mjs <projectDir> --ci --fail-on broken # exit non-zero in CI
```

## Install

Try it locally:

```bash
claude --plugin-dir /path/to/ClaudeDrift
```

Or via a marketplace (this repo ships a `.claude-plugin/marketplace.json`):

```
/plugin marketplace add <this-repo>
/plugin install claude-drift
```

## Severity model

| Severity            | Detected by                                              | Confidence |
| ------------------- | -------------------------------------------------------- | ---------- |
| 🔴 Broken           | script: reference/command not on disk or in manifests    | high/med   |
| 🟠 Stale            | drift-auditor: code contradicts the description (context) | medium     |
| 🟡 Warning·Outdated | low-confidence signal (MCP/env/cross-ref) or recency      | low        |

Every finding carries a `confidence` and a `source` (`script`, `auditor`, or
`both`). Candidates the script deliberately ignores are listed under `suppressed`
with a reason, so its decisions are auditable.

## Not in scope (yet)

- Passive/blocking hooks (e.g. SessionStart nudges, PreToolUse warnings) — v1 is
  on-demand only.
- Auto-rewriting artifacts without confirmation.
- Non-`.claude` AI config (e.g. Cursor rules).

## Layout

```
ClaudeDrift/
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── skills/drift-check/SKILL.md   # the /claude-drift:drift-check command
├── agents/drift-auditor.md       # per-artifact semantic (context-drift) auditor
├── scripts/discover.mjs          # deterministic discovery + hard checks + merge/baseline/ci
├── test/run.mjs                  # precision regression suite (npm test)
└── package.json
```

## Development

```bash
npm test    # runs the precision regression suite (test/run.mjs)
```
