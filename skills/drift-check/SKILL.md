---
name: drift-check
description: Audit this project's Claude artifacts (CLAUDE.md, skills, commands, agents, hooks/settings, .mcp.json) for drift from the project's actual current reality — both broken references AND context drift (stale architecture/workflow/convention descriptions) — then produce a ranked report and offer to apply fixes.
argument-hint: "[--user] [--apply] [--changed-only] [--ci] [path]"
user-invocable: true
disable-model-invocation: true
allowed-tools: "Bash Read Edit Glob Grep Task"
---

# ClaudeDrift — drift check

Audit every Claude artifact that steers this project and report where it has
**drifted from the project's actual reality**. The reality / source of truth is
the codebase you are invoked from. Two kinds of drift matter equally:

- **Reference drift** — a path/command/script the artifact names no longer exists.
- **Context drift** — the artifact's *description* of the architecture, workflow,
  tech stack, or conventions no longer matches the code, **even when every file
  path still resolves**. This is the harder, higher-value class and is found by
  the semantic pass, not the script.

Arguments (`$ARGUMENTS`):
- `--user` — also scan `~/.claude` artifacts (separate, lower-confidence section).
- `--changed-only` — only audit artifacts changed since the last baseline (cheap re-runs).
- `--apply` — apply accepted fixes without a second prompt.
- `--ci` — non-interactive: write the report and stop (no apply).
- a path — audit a different project directory instead of `$CLAUDE_PROJECT_DIR`.

## Step 0 — Preflight: are dependencies installed?

Before validating, check that the project's dependencies and submodules are
installed — otherwise references *into* uninstalled packages show up as false
"missing reference" drift.

```
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/discover.mjs" "${CLAUDE_PROJECT_DIR:-$PWD}" --preflight 2>/dev/null`
```

Read the `preflight` object. If `clean` is true, proceed silently. If it has
`warnings` (e.g. `node_modules`/`vendor` missing, an uninitialized submodule),
**surface them to the user first** and note that some findings may be false
positives until those are installed. Offer to run the suggested `fix` command
(e.g. `npm install`, `composer install`, `git submodule update --init`) before
continuing — but do not run installs without the user's go-ahead. The user may
choose to proceed anyway; that's fine, just keep the caveat in the final report.

## Step 1 — Deterministic discovery + hard checks

```
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/discover.mjs" "${CLAUDE_PROJECT_DIR:-$PWD}" $ARGUMENTS 2>/dev/null`
```

(The full run also includes the same `preflight` object, so re-surface any
warnings in the report header if the user proceeded without installing.)

Parse the JSON. Key fields:
- `artifacts[]` — each with `rel`, `type`, `brokenRefs` (already-verified reference
  drift, with `confidence`), `suppressed` (candidates deliberately ignored, with
  reasons — do not re-report these), `needsSemanticPass`, `recencyStaleDays`.
- `summary.artifactsNeedingSemanticPass` — the list to fan out in Step 2.
- `findings[]` — the flattened, ranked reference-drift findings.

If JSON has an `error`, report it and stop. If `artifactCount` is 0, say no
Claude artifacts were found and stop.

## Step 2 — Semantic / context-drift pass (fan out)

For **every artifact in `summary.artifactsNeedingSemanticPass`** (NOT only the
ones with broken refs — context drift usually has zero broken refs), spawn a
**`drift-auditor`** subagent via the Task tool (`subagent_type: "drift-auditor"`),
in parallel (one message, multiple Task calls). Give each:
- `artifactPath`, `projectDir`,
- `hardFindings`: that artifact's `brokenRefs` (so it folds in / rejects them).

Each auditor reads the artifact against the real code and returns findings JSON
focused on context drift (stale architecture/workflow/tech/convention claims)
plus confirmed reference drift, each with evidence and an exact `old → new` edit.

Collect every auditor's JSON into an array and write it to a temp file, e.g.
`/tmp/claudedrift-auditor.json`.

## Step 3 — Merge into one ranked report (deterministic)

Let the script merge + de-duplicate the hard findings and the auditor findings,
so you don't have to reconcile them by hand:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/discover.mjs" "<projectDir>" --merge /tmp/claudedrift-auditor.json --report .claude/drift-report.md
```

Present the merged `findings`, grouped by severity:
- 🔴 **Broken** — reference resolves to nothing.
- 🟠 **Stale** — context drift: description contradicts current code.
- 🟡 **Warning / Outdated** — lower-confidence or recency-only.

For each: the artifact (`rel` path), claim, reality, evidence (`file:line`), and
the proposed edit. Keep project-scope and `--user` scope in separate sections.
End with the per-severity counts. If `findings` is empty, report
"✅ No significant drift detected" and stop. The full report is saved to
`.claude/drift-report.md`.

## Step 4 — Offer to apply fixes

(Skip this step entirely if `--ci` was passed.)

List the findings that carry a concrete `suggestedEdit` (`old → new`). If
`--apply` was passed, apply them directly; otherwise ask which to apply
(all / by number / none).

To apply: use **Edit** on the artifact with `old_string = suggestedEdit.old`,
`new_string = suggestedEdit.new`. Apply one at a time. If `old_string` is not an
exact unique match, skip it and flag for manual fixing — never apply a fuzzy
edit, and never apply a finding with no `suggestedEdit`.

**Verify after applying:** re-run Step 1 (optionally `--changed-only`) on the
edited artifacts and confirm the resolved findings no longer appear. Report what
changed and what still needs manual attention.

## Step 5 — Offer to update the baseline

Offer to record the current state as the baseline so future runs can use
`--changed-only`:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/discover.mjs" "<projectDir>" --baseline
```

## Principles

- The codebase is the source of truth — when an artifact and the code disagree,
  the **artifact** is wrong and gets fixed. Never edit code to match an artifact.
- Context drift is the point: an artifact with no broken paths can still be badly
  out of date. Always run the semantic pass on changed artifacts.
- Be conservative — only report evidenced drift; never re-report `suppressed` items.
