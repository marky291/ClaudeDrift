<div align="center">

# 🧭 ClaudeDrift

### Your `CLAUDE.md`, skills, and agents rot as your code changes. ClaudeDrift reasons out where — and fixes it.

[![version](https://img.shields.io/badge/version-0.8.0-blue)](https://github.com/marky291/ClaudeDrift/releases)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-8A63D2)](https://code.claude.com/docs/en/plugins)
[![reasoning](https://img.shields.io/badge/engine-reasoning%2C%20not%20regex-brightgreen)](./agents)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

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
them.** Run it on demand.

## Three kinds of drift it catches

| | |
|---|---|
| 🔗 **Reference drift** | A path, command, or script an artifact names no longer exists. |
| 🧠 **Context drift** | The *description* of your architecture, workflow, tech stack, or conventions no longer matches the code — **even when every file path still resolves** ("we use Redux" → you're on Zustand). |
| 🧭 **Legacy narration** | The artifact is *accurate*, but carries superseded-history framing a steering doc shouldn't — "Use Laravel Sail (previously Herd)", "X replaced Y", "Updated &lt;date&gt;: previously…". It should state today's reality, not the migration path that led there. |

Most tools can only do the first. The second and third are where the real damage
hides — context that's subtly wrong, or live instructions buried under migration
backstory Claude re-reads every session.

## Reasoning, not regex

ClaudeDrift doesn't scan your docs with a pile of pattern-matching rules. It uses
**Claude's own reasoning, via subagents**, to read each artifact alongside the code
it describes and *judge* whether it's still true.

That distinction matters. A regex can't tell:

- a real path from an **illustrative example** (`e.g. \`src/Foo.tsx\``, a fenced
  sample, a `your-component` placeholder);
- a missing file from one **relative to a sub-package, crate, or dependency**
  (`hashql-mir/src/...`, "files to modify in `eufy-security-client`");
- a broken reference from a path the doc **creates as output** or documents as
  *already removed*;
- a path from **prose where a slash means "and"** (`prover/requestor`, `CUDA/Metal`);
- a renamed command from a **generic "best-practices" template** that lists ideal
  commands a project *should* have.

This project started as a deterministic scanner. Validated across ~40 real repos,
that scanner needed an endless stream of new rules for each of the cases above —
and still got them wrong at the edges. The reasoning agents got every one right by
*understanding* the artifact. So the scanner is gone; reasoning is the engine.

## What it looks like

> **The one a regex could never find.** In `platformplatform/PlatformPlatform`
> (39 artifacts) an agent told Claude to "create a new tab group via
> `tabs_context_mcp`" — a tool that exists **nowhere** in the repo (the project's
> MCP servers are `shadcn`/`aspire`/`azure-*`, and the agent itself calls this "the
> Chrome extension" two lines later). A hallucinated tool name that looks exactly
> like a real one. ClaudeDrift cross-referenced `.mcp.json`, settings, and the rest
> of the repo, flagged it, and proposed the one-line fix — while correctly leaving
> the genuine Chrome-automation capability alone.

> **A dangerous one, caught.** In a real TypeScript repo (2anki/server) ClaudeDrift
> found `src/lib/Token.ts` referenced in the `HARD_BLOCK_PATHS` safety list of
> **three** agents/commands — gating real "stop and use a worktree" logic — on a
> file that no longer exists. The guard had quietly become a no-op. No grep would
> have told you the *guard itself* was dead.

> **Context drift, caught.** In a C inference engine, a `refs/` reference tree was
> cited as required reading by `CLAUDE.md`, *every* agent, and several commands —
> but it's gitignored and absent on disk, so every "read `refs/` first" workflow
> silently fails. The same audit measured the actual WASM bundle (doc said 192KB,
> it's ~295KB) and counted the header (15K LOC → 17.7K). Things no scanner can know.

> **A subtle one, caught.** A skill referenced its own file as `…/skill.md`
> (lowercase). Works on the maintainer's Mac; **breaks the moment it runs in Linux
> CI** (case-sensitive filesystem). Surfaced as a real, actionable finding.

> **Forward-looking, enforced.** A `CLAUDE.md` said "Local dev uses Laravel Sail
> (previously Herd)" and a skill carried "Updated 2026-04: this step previously used
> the old API." Both were *accurate* — every path resolved — but each forced Claude
> to read a migration story to act on the present. ClaudeDrift flagged the history
> framing and proposed the present-tense rewrite, while deliberately leaving a nearby
> "don't recreate the old `vendor/` junction" guard (a real instruction) and a
> `(Bug 96280)` provenance tag untouched. Knowing which history to cut and which to
> keep is the judgment, and the reason this is a reasoning agent.

> **Memory that outlived the code.** Claude's native auto-memory recorded a project
> note — "the login regression fix lives in `AuthGuard.tsx::validateSession`" — written
> when it was true. Three months later the guard had been extracted to
> `auth/sessionValidator.ts` and the method renamed, so every session Claude recalled a
> file/function pair that no longer existed. ClaudeDrift read the memory body, resolved
> the claim against the real tree, flagged the dead reference with the current location
> as the fix — and, crucially, left an *unresolved* `[[oauth-migration]]` cross-link
> alone (the memory system allows links to not-yet-written memories; a regex flagging
> it would be wrong). Memory is rarely revised, so this is exactly where drift hides.
>
> **A false alarm, *not* raised.** `CLAUDE.md` mentioned "deploy/pulse" in a prose
> list of subsystem names, and `deploy/` is a real directory. A scanner flags it.
> ClaudeDrift read the sentence, saw it was a name and not a path, and stayed quiet.

Across a healthy 39-artifact repo, the flow-mapper triaged everything and sent only
**3 artifacts** to a deep audit (not 39) — finding the one real bug and clearing the
rest. Thorough, precise, and cheap because it reasons about *where to look* first.

Then it offers to apply the fix and re-verifies it's gone.

## How it works

Three reasoning passes, orchestrated by the `/claude-drift:drift-check` command:

1. **Map the Claude flow** — the **`claude-flow-mapper`** subagent discovers every
   artifact (`CLAUDE.md`, skills, commands, agents, settings, hooks, `.mcp.json`),
   reads enough of the codebase to understand the real stack/layout/workflow, notes
   whether dependencies are installed, and ranks each artifact by how likely it has
   drifted — so the deep audit is **prioritized, not 50 blind agents**.
2. **Audit** — a **`drift-auditor`** subagent reasons about each artifact against the
   real code (reference, context, *and* legacy-narration drift), returning evidenced
   findings with an exact `old → new` fix. It judges, on the spot, what's a real claim
   vs an example, a sub-package path, or prose — and, for legacy narration, what
   history to strip vs. keep (provenance refs, genuine removal-guards, and true
   historical records like CHANGELOGs are left alone).
3. **Synthesize & apply** — the command merges and ranks the findings, shows you a
   report grouped 🔴 Broken / 🟠 Stale / 🟡 Outdated / ⚪ Legacy narration with
   evidence, and offers to apply the fixes (then re-verifies them).

**Source of truth is your codebase.** When an artifact and the code disagree, the
artifact is what's wrong — ClaudeDrift never edits your code.

## What it audits

- `CLAUDE.md` files (including nested ones)
- `.claude/skills/*/SKILL.md`, `.claude/commands/**/*.md`, `.claude/agents/*.md`
- `.claude/settings.json`, `settings.local.json`, hooks, `.mcp.json`
- **Memory** — whichever memory systems the project actually uses, discovered from
  its own artifacts and MCP config (not hardcoded): Claude's native file memory
  (`~/.claude/projects/<proj>/memory/MEMORY.md` + topic files — index pointers,
  frontmatter, and body file/function/flag claims checked against the code) and any
  memory MCP server (a doc that routes work to a memory tool no longer in `.mcp.json`
  is caught as a broken reference). No live MCP calls — it audits from files alone.
- With `--user`: the same artifacts under `~/.claude`

## Usage

```
/claude-drift:drift-check                  # audit the current project
/claude-drift:drift-check --user           # also audit ~/.claude artifacts
/claude-drift:drift-check --changed        # only audit artifacts changed since last commit
/claude-drift:drift-check --forward-only   # forward-looking pass: report only legacy-narration drift
/claude-drift:drift-check --apply          # apply fixes without re-prompting
/claude-drift:drift-check /path/to/proj    # audit a different project directory
```

## Install

Try it locally:

```bash
claude --plugin-dir /path/to/ClaudeDrift
```

Or install it as a plugin:

```
/plugin marketplace add marky291/ClaudeDrift
/plugin install claude-drift
```

> **Cost & footprint.** Nothing runs until you invoke the command — **no MCP server,
> no always-on hooks**. When you do run it, it spends model tokens proportional to
> your artifact count (one mapping pass plus a deep audit of the artifacts that
> warrant it). For first/clean dependency state, run after `npm install` /
> `composer install` so references resolve.

## Layout

```
ClaudeDrift/
├── skills/drift-check/SKILL.md        # the /claude-drift:drift-check command (orchestrator)
├── agents/claude-flow-mapper.md       # maps the project's Claude flow + prioritizes
└── agents/drift-auditor.md            # reasons about one artifact vs the real code
```

Pure prompt-engineered Claude Code components — no runtime, no dependencies, no
deterministic scanner.

## Roadmap

- Passive nudges (SessionStart / PreToolUse hooks) — warn the moment you act on a drifted artifact
- A cheap "map-only" mode for quick health checks
- Drift reports committed to the repo for review-time diffing

## License

MIT © Mark Hester — see [LICENSE](./LICENSE).

<div align="center">
<sub>Built for <a href="https://code.claude.com">Claude Code</a>. If ClaudeDrift caught real drift in your project, a ⭐ helps others find it.</sub>
</div>
