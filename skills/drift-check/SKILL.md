---
name: drift-check
description: Audit this project's Claude artifacts (CLAUDE.md, skills, commands, agents, hooks/settings) for drift from the project's actual current reality, produce a ranked report, and offer to apply fixes.
argument-hint: "[--user] [--apply] [path]"
user-invocable: true
disable-model-invocation: true
allowed-tools: "Bash Read Edit Glob Grep Task"
---

# ClaudeDrift — drift check

Run an on-demand audit of every Claude artifact that steers this project and
report where those artifacts have **drifted from the project's actual reality**.
The reality / source of truth is the codebase you are invoked from.

Arguments (in `$ARGUMENTS`):
- `--user` — also scan user-level artifacts under `~/.claude` (reported in a
  separate, lower-confidence section, since they span many projects).
- `--apply` — after the report, apply accepted fixes without a second prompt.
- a path — audit a different project directory instead of `$CLAUDE_PROJECT_DIR`.

## Step 1 — Deterministic discovery + hard checks

Run the bundled discovery script. Pass `--user` through only if the user did.

```
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/discover.mjs" "${CLAUDE_PROJECT_DIR:-$PWD}" $ARGUMENTS 2>/dev/null`
```

Parse the JSON. It gives you every discovered artifact, the references found in
each, and the `brokenRefs` already verified as broken (dead paths, missing npm
scripts / make targets, missing hook command targets) plus a `recencyStaleDays`
hint. If the JSON has an `error` field, report it and stop. If `artifactCount`
is 0, tell the user no Claude artifacts were found and stop.

## Step 2 — Semantic pass (fan out)

For each discovered artifact, spawn a **`drift-auditor`** subagent (use the Task
tool, `subagent_type: "drift-auditor"`). Run them in parallel — one message with
multiple Task calls. Give each agent:
- `artifactPath`: the artifact's absolute path,
- `projectDir`: the scanned project dir from the script output,
- `hardFindings`: that artifact's `brokenRefs` from Step 1 (so it doesn't
  re-derive them, and folds them into its report).

Skip the semantic pass for an artifact only if it is tiny and had zero refs.
Each agent returns findings JSON (severity, claim vs reality, evidence,
suggestedEdit).

## Step 3 — Aggregate into a ranked report

Merge the hard findings (Step 1) and semantic findings (Step 2). De-duplicate
(a `broken` hard finding and a semantic finding about the same ref are one
entry). Rank and present grouped by severity:

- 🔴 **Broken** — exact reference resolves to nothing. High confidence.
- 🟠 **Stale** — described behavior/architecture contradicts current code.
- 🟡 **Outdated** — lower-confidence / recency-only signal.

Format: group by artifact within each severity. For each finding show the
artifact (relative path), the claim, the reality, and the evidence
(`file:line`). Keep project-scope and user-scope (`--user`) findings in separate
sections. End with a one-line summary: counts per severity.

If there are no findings, report "✅ No significant drift detected" and stop.

Optionally offer to write the full report to `.claude/drift-report.md`.

## Step 4 — Offer to apply fixes

List the findings that carry a concrete `suggestedEdit` (an exact `old → new`).
If `--apply` was passed, apply them directly. Otherwise ask the user which to
apply (all / by number / none).

To apply a fix: use the **Edit** tool on the artifact with `old_string` =
`suggestedEdit.old` and `new_string` = `suggestedEdit.new`. Apply one at a time;
if an `old_string` no longer matches exactly, skip it and note that it needs a
manual fix. Never apply a finding that has no `suggestedEdit`.

After applying, summarize what changed and suggest re-running `/claude-drift:drift-check`
to confirm the drift is resolved.

## Principles

- The codebase is the source of truth — when an artifact and the code disagree,
  the **artifact** is what's wrong and gets fixed.
- Be conservative: only report evidenced drift, never stylistic nitpicks.
- Never edit code or config to match an artifact; only ever edit the artifacts.
