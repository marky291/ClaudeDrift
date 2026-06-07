<div align="center">

# 🧭 ClaudeDrift

### Your `CLAUDE.md`, skills, and agents rot as your code changes. ClaudeDrift finds out where — and fixes it.

[![version](https://img.shields.io/badge/version-0.3.0-blue)](https://github.com/marky291/ClaudeDrift/releases)
[![tests](https://img.shields.io/badge/tests-27%20passing-brightgreen)](./test/run.mjs)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-8A63D2)](https://code.claude.com/docs/en/plugins)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![zero deps](https://img.shields.io/badge/dependencies-0-blue)](./scripts/discover.mjs)

```
/claude-drift:drift-check
```

</div>

---

## The problem

You set up Claude for your project months ago. A `CLAUDE.md` describing the
architecture. A few skills. Some agents. Then the project **kept moving** — files
got renamed, the deploy flow changed, you swapped Redux for Zustand, a directory
moved.

Your Claude artifacts didn't move with it.

Now Claude confidently follows a skill that points at a file that no longer
exists, or a `CLAUDE.md` that describes an architecture you abandoned. Stale
context produces wrong work — quietly, every session.

**ClaudeDrift is a Claude Code plugin that audits all of those artifacts against
your actual codebase, shows you exactly where they've drifted, and offers to fix
them.** Run it on demand. No setup, no config, zero dependencies.

## Two kinds of drift it catches

| | |
|---|---|
| 🔗 **Reference drift** | A path, command, or script an artifact names no longer exists. Found instantly by a deterministic scanner. |
| 🧠 **Context drift** | The *description* of your architecture, workflow, tech stack, or conventions no longer matches the code — **even when every file path still resolves** ("we use Redux" → you're on Zustand). Found by a semantic pass that actually reads your code. |

Most tools can only do the first. The second is where the real damage hides.

## Quickstart

```bash
# Try it instantly against any project (no install)
claude --plugin-dir /path/to/ClaudeDrift

# then, inside Claude Code:
/claude-drift:drift-check
```

Or install it as a plugin:

```
/plugin marketplace add marky291/ClaudeDrift
/plugin install claude-drift
```

That's it. Point it at any repo that uses Claude artifacts and run the command.

> **Featherweight.** ClaudeDrift adds **~250 tokens** to a session — it's a single
> on-demand command plus one auditor agent, with **no MCP server and no always-on
> hooks**. The expensive semantic pass only runs when you ask it to. Install costs
> you almost nothing until you use it.

## What it looks like

Run against a real production repo (a Laravel app with **13** Claude artifacts):

```
ClaudeDrift report — 2 findings across 13 artifacts (256 candidates analyzed)

🔴 Broken (2)
- .claude/skills/ragnasync-work-github-issues/SKILL.md
  → `…/skill.md`  (confidence: medium)
  case mismatch — resolves on macOS/Windows but BREAKS on case-sensitive
  filesystems (Linux / CI). The skill references its own file in lowercase.
```

> **Real bug, caught.** That skill worked fine on the maintainer's Mac and would
> have silently broken the moment it ran in Linux CI. ClaudeDrift analyzed **256**
> reference candidates, correctly ignored **254** (globs, placeholders, generated
> files, gitignored secrets, example paths…), and surfaced the **2** that mattered.

Then it offers to apply the fix and re-verifies it's gone.

## Why you can trust the findings

False positives kill tools like this. ClaudeDrift is tuned for precision and was
**validated across 6 language ecosystems** (PHP, Elixir, Python, C#, JavaScript,
Rust/Lua) — every false positive became a general rule, not a hack:

- **Knows what to ignore:** globs, `<placeholders>`, `$SHELL_VARS`, `~/` and
  absolute machine paths, example names (`FooService`), runtime-generated files,
  and anything in your `.gitignore` (secrets, local settings, build output).
- **Reads context:** a file a doc says it *creates* — or documents as *removed* —
  is never flagged as missing.
- **Corroboration rule:** a broken path is only **high confidence** if the same
  artifact also names a path that *does* resolve — proof it really describes *this*
  repo. Ungrounded artifacts are flagged low and left for the semantic pass, so you
  never get drowned in noise.

Every finding carries a **confidence** level and **evidence**. Every ignored
candidate is listed with a reason, so the tool is fully auditable.

## What it audits

- `CLAUDE.md` files (including nested ones)
- `.claude/skills/*/SKILL.md`
- `.claude/commands/**/*.md`
- `.claude/agents/*.md`
- `.claude/settings.json`, `settings.local.json`, hooks
- `.mcp.json`
- With `--user`: the same artifacts under `~/.claude`

**Source of truth is your codebase.** When an artifact and the code disagree, the
artifact is what's wrong — ClaudeDrift never edits your code.

## Usage

```
/claude-drift:drift-check                # audit the current project
/claude-drift:drift-check --user         # also audit ~/.claude artifacts
/claude-drift:drift-check --changed-only # only re-audit what changed since baseline
/claude-drift:drift-check --apply        # apply fixes without re-prompting
/claude-drift:drift-check --ci           # non-interactive: write report, no apply
```

The bundled scanner also runs standalone (and in CI):

```bash
node scripts/discover.mjs <projectDir> --report drift.md   # markdown report
node scripts/discover.mjs <projectDir> --baseline          # snapshot for --changed-only
node scripts/discover.mjs <projectDir> --ci --fail-on broken # exit non-zero on drift
```

See a full sample report in [`docs/example-drift-report.md`](./docs/example-drift-report.md).

## How it works

1. **`scripts/discover.mjs`** (Node, **zero dependencies**) enumerates every
   artifact and hard-verifies the concrete references inside them against the live
   filesystem and package manifests, applying the precision rules above. Node is
   always present — Claude Code itself runs on it.
2. **`drift-auditor`** subagents read each *changed* artifact alongside the code it
   describes and judge **context drift**, proposing grounded edits with evidence —
   even on artifacts with zero broken references, because that's where context
   drift hides.
3. **`/claude-drift:drift-check`** orchestrates both passes, merges and de-dupes the
   findings deterministically, produces a severity-ranked report, applies accepted
   fixes, and re-verifies them.

```
ClaudeDrift/
├── skills/drift-check/SKILL.md   # the /claude-drift:drift-check command
├── agents/drift-auditor.md       # per-artifact semantic (context-drift) auditor
├── scripts/discover.mjs          # deterministic scanner + merge/baseline/ci
└── test/run.mjs                  # 27-case precision regression suite
```

## Roadmap

- Passive nudges (SessionStart / PreToolUse hooks) — warn the moment you act on a drifted artifact
- GitHub Action for drift checks on every PR
- Auto-extend precision rules per detected ecosystem

## Contributing

```bash
npm test    # 27-case precision regression suite
```

Found a false positive in your ecosystem? Open an issue with the artifact snippet —
that's exactly how the rule set grows. PRs welcome.

## License

MIT © Mark Hester — see [LICENSE](./LICENSE).

<div align="center">
<sub>Built for <a href="https://code.claude.com">Claude Code</a>. If ClaudeDrift caught real drift in your project, a ⭐ helps others find it.</sub>
</div>
