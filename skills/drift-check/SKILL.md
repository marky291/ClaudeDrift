---
name: drift-check
description: Audit this project's Claude artifacts (CLAUDE.md, skills, commands, agents, hooks/settings, .mcp.json) for drift from the project's actual reality — both broken references AND context drift (stale architecture/workflow/convention descriptions) — using Claude's reasoning via subagents, then produce a ranked report and offer to apply fixes.
argument-hint: "[--user] [--apply] [--changed] [path]"
user-invocable: true
disable-model-invocation: true
allowed-tools: "Bash Read Edit Glob Grep Task"
---

# ClaudeDrift — drift check

Audit every Claude artifact that steers this project and report where it has
**drifted from the project's actual reality**. The source of truth is the codebase
you are invoked from. This is done by **reasoning, not by a deterministic script** —
Claude reads the artifacts and the real code and judges drift, via subagents.

Two kinds of drift matter equally:
- **Reference drift** — a path/command/script an artifact names no longer exists.
- **Context drift** — the artifact's *description* of the architecture, workflow,
  tech stack, or conventions no longer matches the code, even when every path still
  resolves. This is the harder, higher-value class.

Arguments (`$ARGUMENTS`):
- `--user` — also audit `~/.claude` artifacts (separate, clearly-marked section).
- `--changed` — only audit artifacts changed since the last commit (`git diff`),
  for cheap re-runs.
- `--apply` — apply accepted fixes without a second prompt.
- a path — audit a different project directory instead of `$CLAUDE_PROJECT_DIR`.

The target project dir is `$ARGUMENTS`'s path, else `$CLAUDE_PROJECT_DIR`, else the
current working directory.

## Step 1 — Map the Claude flow

Spawn the **`claude-flow-mapper`** subagent (Task tool, `subagent_type:
"claude-flow-mapper"`) on the project dir (pass `--user` if given). It returns the
artifact inventory, a `projectReality` grounding summary, install-state caveats,
and a `driftLikelihood` rating per artifact.

If it finds no Claude artifacts, say so and stop. If `installState` has caveats
(deps not installed, submodule uninitialized), surface them first — note that
findings may include false positives until installed, and offer to run the install
(don't run it without the user's go-ahead).

If `--changed` was passed, intersect the inventory with `git -C <dir> diff --name-only`
(and untracked) to keep only artifacts that changed.

## Step 2 — Deep audit (fan out, reasoned, prioritized)

Spawn a **`drift-auditor`** subagent per artifact (Task tool, in parallel — one
message, multiple Task calls), passing `artifactPath`, `projectDir`, and the
`projectReality` summary from Step 1.

Prioritize and budget — don't blindly spawn dozens:
- Always audit artifacts rated `high`/`medium` drift-likelihood.
- Audit `low`/`none` too, but in later batches; cap concurrency to ~8 at a time.
- On a large surface (say >15 artifacts), audit the high/medium set first, report,
  and tell the user how many low/none remain and offer to continue.

Each auditor reasons about the artifact against the real code and returns findings
(reference + context drift) with evidence and an exact `old → new` edit.

## Step 3 — Synthesize the report (by reasoning)

Collect every auditor's findings and reason over them yourself — merge duplicates,
drop anything an auditor already judged a false positive, and rank by severity and
confidence. Group:
- 🔴 **Broken** — a reference resolves to nothing.
- 🟠 **Stale** — context drift: the description contradicts the current code.
- 🟡 **Outdated / low-confidence** — likely stale, weaker evidence.

For each finding show: the artifact (relative path), the claim, the reality, the
evidence (`file:line`), and the proposed edit. Keep project-scope and `--user`
scope in separate sections. End with per-severity counts; if there are no findings,
report "✅ No significant drift detected." Optionally write the report to
`.claude/drift-report.md`.

## Step 4 — Offer to apply fixes

List the findings that carry a concrete `suggestedEdit`. If `--apply` was given,
apply them; otherwise ask which to apply (all / by number / none).

To apply: re-read the artifact, then use **Edit** with `old_string =
suggestedEdit.old`, `new_string = suggestedEdit.new`. Apply one at a time; if the
`old_string` isn't an exact unique match (e.g. a prior edit shifted things), skip
it and flag for manual fixing — never apply a fuzzy edit, never apply a finding
with no `suggestedEdit`. After applying, briefly re-verify the edited artifacts
(re-read, or re-spawn an auditor on them) and report what changed and what still
needs manual attention.

## Principles

- The codebase is the source of truth — fix the **artifact**, never the code.
- Reason, don't pattern-match: an illustrative example, a subdir/dependency-relative
  path, a created-output path, or prose where a slash means "A and B" is NOT drift.
  This judgment is the whole point of using subagents instead of a script.
- Context drift is the headline: an artifact with zero broken paths can still be
  badly out of date. Always have the auditor read the code, not just check paths.
