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

## What it checks

- `CLAUDE.md` files (including nested ones)
- `.claude/skills/*/SKILL.md`
- `.claude/commands/**/*.md`
- `.claude/agents/*.md`
- `.claude/settings.json`, `settings.local.json`, and hooks
- With `--user`: the same artifacts under `~/.claude` (reported separately)

**Source of truth:** the codebase the command is run from. When an artifact and
the code disagree, the artifact is treated as wrong and gets fixed — never the code.

## How it works

A hybrid of deterministic checks and semantic judgment:

1. **`scripts/discover.mjs`** (Node, zero dependencies) enumerates every artifact
   and hard-verifies the concrete references inside them — file paths, npm scripts,
   make targets, hook command targets — against the live filesystem and package
   manifests. Node is always present because Claude Code itself runs on Node.
2. **`drift-auditor`** subagents read each artifact alongside the code it
   describes and judge whether the described behaviour/architecture still matches,
   proposing grounded edits with evidence.
3. The **`/claude-drift:drift-check`** command orchestrates both passes, produces a
   severity-ranked report (🔴 Broken / 🟠 Stale / 🟡 Outdated), and offers to apply
   the fixes.

## Usage

```
/claude-drift:drift-check                # audit the current project
/claude-drift:drift-check --user         # also audit ~/.claude artifacts
/claude-drift:drift-check --apply        # apply fixes without re-prompting
/claude-drift:drift-check /path/to/proj  # audit a different project dir
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

| Severity     | Detected by                                              | Confidence |
| ------------ | -------------------------------------------------------- | ---------- |
| 🔴 Broken    | script: reference not on disk / not in manifests         | high       |
| 🟠 Stale     | drift-auditor: code contradicts the description          | medium     |
| 🟡 Outdated  | script: artifact predates major changes to what it cites | low        |

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
├── agents/drift-auditor.md       # per-artifact semantic auditor subagent
└── scripts/discover.mjs          # deterministic discovery + hard checks
```
