#!/usr/bin/env node
// ClaudeDrift test suite. Builds a fixture project exercising every precision
// rule (each case derived from a real false positive or true positive observed
// in the wild) and asserts discover.mjs classifies it correctly.
//
//   node test/run.mjs
//
// Exits non-zero on any failed assertion. No dependencies — Node built-ins only.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "scripts", "discover.mjs");

// ---------------------------------------------------------------------------
// Build fixture
// ---------------------------------------------------------------------------
const FX = path.join(os.tmpdir(), `claudedrift-test-${process.pid}`);
function write(rel, content) {
  const p = path.join(FX, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
fs.rmSync(FX, { recursive: true, force: true });
fs.mkdirSync(FX, { recursive: true });

// real files that DO exist
write("src/Real.ts", "export const x = 1;\n");
write("app/Models/User.php", "<?php class User {}\n");
write("app/Services/PaymentService.php", "<?php class PaymentService {}\n");
write("bootstrap/cache/.gitkeep", "");
write("package.json", JSON.stringify({ scripts: { build: "tsc" } }));
write("composer.json", JSON.stringify({ scripts: { test: "phpunit" } }));
write("Envoy.blade.php", "@task('deploy') echo hi @endtask\n");
// nested manifest (monorepo): a script defined only in a subproject's package.json
write("web/package.json", JSON.stringify({ scripts: { "test:e2e": "playwright" } }));
write("web/src/styles/shared.css", ".x{}\n"); // real file referenced as shared.css:78
write("tools/helper.sh", "#!/bin/bash\n");     // basename exists here; referenced as ./helper.sh at root
write(".claude/hooks/real-hook.sh", "#!/bin/bash\n"); // referenced via "$CLAUDE_PROJECT_DIR"/... (quoted)
write(".claude/settings.json", JSON.stringify({
  hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/real-hook.sh' }] }] },
}));
// cross-language: a real top-level dir with a non-PHP/JS name (no SRC_PREFIX match)
write("crates/realcrate/lib.rs", "pub fn x() {}\n");
// a declared git submodule path (its contents are legitimately absent here)
write(".gitmodules", '[submodule "vendored"]\n\tpath = modules/vendored\n\turl = https://example.com/x\n');

// two real skills sharing the 'proj-' prefix (so cross-ref prefix is detected)
write("skills/proj-foo/SKILL.md", "---\ndescription: foo\n---\nfoo skill\n");
write("skills/proj-bar/SKILL.md", "---\ndescription: bar\n---\nbar skill\n");
// a generic/template artifact: references several real-looking paths, NONE resolve
write(
  "skills/proj-template/SKILL.md",
  [
    "---", "description: generic scaffolder", "---",
    "The auth flow lives in `src/api/login.ts` and `src/api/refresh.ts`.",
    "Tokens come from `src/db/pool.ts`, middleware from `src/middleware/auth.ts`,",
    "types from `src/types/user.ts`, and config from `src/config/app.ts`.",
  ].join("\n")
);

// the project uses .claude/ layout for the rest
fs.cpSync(path.join(FX, "skills"), path.join(FX, ".claude", "skills"), { recursive: true });
fs.rmSync(path.join(FX, "skills"), { recursive: true });

// a generic/prescriptive agent: lists several commands, none of which exist in the
// project's manifests -> all downgraded to low by command-corroboration.
write(
  ".claude/agents/generic-opt.md",
  [
    "---", "name: generic-opt", "description: d", "---",
    "Standard setup: run `npm run alpha`, then `npm run beta`, then `npm run gamma`.",
  ].join("\n")
);

// an agent with a real ref (so corroboration does NOT fire) plus a fenced sample
// block whose path is illustrative — must be downgraded to LOW by the fence rule.
write(
  ".claude/agents/demo-agent.md",
  [
    "---", "name: demo-agent", "description: d", "---",
    "Real file: `src/Real.ts`.", // resolves -> grounds the artifact
    "Sample output:", "```", "[unreferenced] web/src/Gone.tsx", "```",
  ].join("\n")
);

// CLAUDE.md packed with every case
write(
  "CLAUDE.md",
  [
    "# Fixture",
    "",
    "## True positives (should be FOUND)",
    "- The real entry is `app/Models/User.php`.", // resolves -> grounds the artifact (corroboration)
    "- Entry point is `src/main.ts`.", // missing path -> broken (HIGH, because corroborated)
    "- Run `npm run test` to test.", // missing npm script -> broken
    "- Run `composer run lint`.", // missing composer script -> broken
    "- Deploy with `envoy run ghost`.", // missing envoy task -> broken
    "- See `src/real.ts` for details.", // case mismatch (real file is src/Real.ts)
    "- Use the proj-missing skill to do X.", // cross-ref to non-existent skill
    "- A crate lives at `crates/realcrate/missing.rs`.", // dynamic top-dir: crates/ real, file missing
    "- For example see `app/Models/Ghost.php`.", // example-context -> LOW (app is real top-dir, file missing)
    "- New ADRs: copy template to `docs/adr/NNN-descriptive-title.md`.", // doc-template placeholder -> suppressed
    "- Run the shared `./helper.sh` script.", // basename exists in tools/ -> LOW, not HIGH
    "| Indexer | reads `app/TableGhost.php` for lifecycle |", // table cell -> LOW, not HIGH
    "",
    "## False positives (should be SUPPRESSED)",
    "- Submodule code at `modules/vendored/core.rs`.", // git submodule path (declared in .gitmodules)
    "- Debug config in `.vscode/launch.json`.", // editor/IDE config
    "- Currently on branch `feature/login-form`.", // not a real top-level dir -> not a project file
    "- Run `pnpm --filter web build` for the UI.", // --filter is a flag, not a script
    "- E2E lives in the web subproject: `pnpm run test:e2e`.", // script in nested web/package.json
    "- Token offsets at `web/src/styles/shared.css:78`.", // file:line citation -> strip :78, file exists
    "- Output goes to `web/build/assets/main.js`.", // build output / generated dir
    "- Crate-relative path `someCrate/src/lib.rs`.", // first segment not a top-level dir -> LOW, not HIGH
    "- Specs go in `docs/spec-`.", // truncated template reference
    "- All models live in `app/Models/User*`.", // glob
    "- Templates: `gitbook/scripts/<name>.md`.", // placeholder
    "- Secrets in `~/.config/app/secret.json`.", // external home path
    "- Built by `/opt/tools/Build.app/Contents/runner`.", // partial of longer abs path
    "- Example: `app/Services/FooService.php`.", // example/placeholder name
    "- Cache at `bootstrap/cache/config.php`.", // ephemeral/runtime-generated
    "- The file `src/old.ts` no longer exists.", // negative context
    "- The PaymentService class via `app/Services/PaymentService`.", // namespace-like (PHP class exists)
    "- Use the proj-foo skill (this one exists).", // cross-ref that resolves -> no finding
    "",
    "## Env",
    "- Needs `STRIPE_SECRET_KEY`.", // not in .env.example (none) -> no env check (envKeys null)
  ].join("\n")
);

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
let out;
try {
  out = execFileSync("node", [SCRIPT, FX], { encoding: "utf8" });
} catch (e) {
  console.error("discover.mjs crashed:", e.message);
  process.exit(1);
}
const j = JSON.parse(out);

const findingRefs = new Set(j.findings.map((f) => f.ref));
const suppressed = j.artifacts.flatMap((a) => a.suppressed || []);
const suppressedReasons = suppressed.map((s) => s.why);
const findingHas = (sub) => [...findingRefs].some((r) => r.includes(sub));
const suppressedHas = (why) => suppressedReasons.some((w) => w.includes(why));
// a ref was NOT emitted as a finding (i.e. correctly not flagged)
const notFlagged = (sub) => ![...findingRefs].some((r) => r.includes(sub));
const findingFor = (sub) => j.findings.find((f) => (f.ref || "").includes(sub));
const confidenceOf = (sub) => (findingFor(sub) || {}).confidence;

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
const tests = [
  // true positives
  ["finds missing path src/main.ts", () => findingHas("src/main.ts")],
  ["finds missing npm script 'test'", () => findingRefs.has("test")],
  ["finds missing composer script 'lint'", () => findingRefs.has("lint")],
  ["finds missing envoy task 'ghost'", () => findingRefs.has("ghost")],
  ["finds case-mismatch src/real.ts", () => findingHas("src/real.ts")],
  ["finds cross-ref proj-missing", () => findingRefs.has("proj-missing")],
  ["finds missing file under real top-dir crates/", () => findingHas("crates/realcrate/missing.rs")],
  // false positives correctly suppressed
  ["suppresses glob app/Models/User*", () => suppressedHas("glob")],
  ["suppresses placeholder <name>.md", () => suppressedHas("placeholder")],
  ["suppresses external ~/.config path", () => suppressedHas("external")],
  ["suppresses partial-of-longer-path", () => suppressedHas("partial")],
  ["suppresses example FooService", () => suppressedHas("example")],
  ["suppresses ephemeral bootstrap/cache", () => suppressedHas("ephemeral")],
  ["suppresses negative-context src/old.ts", () => suppressedHas("negative")],
  ["suppresses git submodule path", () => suppressedHas("submodule")],
  ["suppresses editor/IDE config", () => suppressedHas("IDE")],
  ["suppresses build output dir (web/build)", () => suppressedHas("build output")],
  ["suppresses truncated template ref (docs/spec-)", () => suppressedHas("template")],
  ["suppresses doc-template NNN placeholder", () => suppressedHas("doc-template")],
  ["does NOT flag quoted hook command (file exists)", () => notFlagged("real-hook.sh")],
  ["basename-exists-elsewhere ref is LOW", () => {
    const f = j.findings.find((x) => (x.ref || "").includes("helper.sh"));
    return f && f.confidence === "low";
  }],
  // nested-manifest, file:line, flag, crate-relative
  ["does NOT flag --filter as npm-script", () => notFlagged("filter")],
  ["does NOT flag test:e2e (defined in web/package.json)", () => !findingRefs.has("test:e2e")],
  ["does NOT flag shared.css:78 (file exists; strip :line)", () => notFlagged("shared.css")],
  ["crate-relative path is LOW confidence", () => {
    const f = j.findings.find((x) => (x.ref || "").includes("someCrate/src/lib.rs"));
    return f && f.confidence === "low";
  }],
  ["example-context ref is LOW confidence", () => {
    const f = j.findings.find((x) => (x.ref || "").includes("app/Models/Ghost.php"));
    return f && f.confidence === "low";
  }],
  ["table-cell ref is LOW confidence", () => {
    const f = j.findings.find((x) => (x.ref || "").includes("app/TableGhost.php"));
    return f && f.confidence === "low";
  }],
  ["generic command list (none resolve) is LOW", () => {
    const f = j.findings.find((x) => x.ref === "alpha");
    return f && f.confidence === "low";
  }],
  ["agent fenced sample path is LOW confidence", () => {
    const f = j.findings.find((x) => (x.ref || "").includes("web/src/Gone.tsx"));
    return f && f.confidence === "low";
  }],
  // things that must NOT be flagged
  ["does NOT flag glob User*", () => notFlagged("app/Models/User*")],
  ["does NOT flag FooService", () => notFlagged("FooService")],
  ["does NOT flag bootstrap/cache", () => notFlagged("bootstrap/cache")],
  ["does NOT flag external secret.json", () => notFlagged("secret.json")],
  ["does NOT flag negative src/old.ts", () => notFlagged("src/old.ts")],
  ["does NOT flag resolving cross-ref proj-foo", () => !findingRefs.has("proj-foo")],
  ["does NOT flag submodule modules/vendored", () => notFlagged("modules/vendored")],
  ["does NOT flag .vscode/launch.json", () => notFlagged("launch.json")],
  ["does NOT flag git branch feature/login-form", () => notFlagged("feature/login-form")],
  // preflight: deps not installed should be flagged before validation
  ["preflight warns missing node_modules", () => (j.preflight?.warnings || []).some((w) => w.missing === "node_modules")],
  ["preflight warns uninitialized submodule", () => (j.preflight?.warnings || []).some((w) => w.tool === "git")],
  // corroboration: grounded artifact keeps HIGH; ungrounded template drops to LOW
  ["corroborated broken ref is HIGH confidence", () => confidenceOf("src/main.ts") === "high"],
  ["template artifact (no resolving paths) is LOW", () => {
    const tf = j.findings.filter((f) => f.artifact.includes("proj-template") && f.kind === "path");
    return tf.length >= 3 && tf.every((f) => f.confidence === "low");
  }],
];

let failed = 0;
for (const [name, fn] of tests) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (!ok) failed++;
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed) {
  console.log("\nFindings:", [...findingRefs].join(", "));
  console.log("Suppressed reasons:", [...new Set(suppressedReasons)].join(", "));
}
fs.rmSync(FX, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
