#!/usr/bin/env node
// ClaudeDrift — deterministic discovery + hard-reference checker.
//
// Usage:
//   node discover.mjs [projectDir] [options]
//
// Options:
//   --user              also scan ~/.claude artifacts (reported as scope:user)
//   --report <path>     write a markdown report to <path>
//   --merge <file>      merge auditor findings JSON (array) with the hard checks
//                       and emit a single unified, de-duplicated report
//   --baseline          write/update the baseline state file and exit
//   --changed-only      only include artifacts changed since the baseline
//   --ci                CI mode: exit non-zero when findings meet --fail-on
//   --fail-on <sev>     broken | warning | any   (default: broken)
//
// Discovers every Claude artifact that influences a project (CLAUDE.md files,
// skills, commands, agents, settings/hooks, .mcp.json) and verifies the concrete
// references inside them against the live filesystem / package manifests. Emits a
// single JSON object on stdout. No npm dependencies — Node built-ins only, because
// Claude Code itself runs on Node so `node` is always available.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name) {
  return argv.includes(name);
}
function opt(name, def = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const includeUser = flag("--user");
const reportPath = opt("--report");
const mergeFile = opt("--merge");
const writeBaseline = flag("--baseline");
const changedOnly = flag("--changed-only");
const ciMode = flag("--ci");
const preflightOnly = flag("--preflight");
const failOn = opt("--fail-on", "broken");

const positional = argv.filter(
  (a, i) =>
    !a.startsWith("--") &&
    !["--report", "--merge", "--fail-on"].includes(argv[i - 1])
);
const PROJECT_DIR = path.resolve(
  positional[0] || process.env.CLAUDE_PROJECT_DIR || process.cwd()
);
const HOME = os.homedir();
const USER_CLAUDE = path.join(HOME, ".claude");
const BASELINE_PATH = path.join(PROJECT_DIR, ".claude", ".drift-baseline.json");

const IGNORE_DIRS = new Set([
  ".git", "node_modules", ".next", "dist", "build", "out", ".venv", "venv",
  "__pycache__", ".cache", "vendor", "target", ".idea", ".vscode",
]);

// ---------------------------------------------------------------------------
// Small fs helpers
// ---------------------------------------------------------------------------
const exists = (p) => {
  try { fs.accessSync(p); return true; } catch { return false; }
};
const readText = (p) => {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
};
const readJSON = (p) => {
  const t = readText(p);
  if (t == null) return null;
  try { return JSON.parse(t); } catch { return null; }
};
const mtime = (p) => {
  try { return fs.statSync(p).mtimeMs; } catch { return null; }
};
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const rel = (p) => p.replace(PROJECT_DIR + path.sep, "");

// Case-sensitive existence test (macOS/Windows are case-insensitive by default,
// so a ref that "exists" here may still break on Linux/production). Walks the
// path segment by segment checking exact case via readdir.
function caseSensitiveExists(abs) {
  const parts = abs.split(path.sep);
  let cur = parts[0] === "" ? path.sep : parts[0];
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    if (!seg) continue;
    let entries;
    try { entries = fs.readdirSync(cur || path.sep); } catch { return false; }
    if (!entries.includes(seg)) return false;
    cur = path.join(cur, seg);
  }
  return true;
}

function walk(dir, test, maxDepth = 8, depth = 0, acc = []) {
  if (depth > maxDepth || !exists(dir)) return acc;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      walk(full, test, maxDepth, depth + 1, acc);
    } else if (ent.isFile() && test(full, ent.name)) {
      acc.push(full);
    }
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Artifact discovery
// ---------------------------------------------------------------------------
function discoverArtifacts(root, scope) {
  const found = [];
  const add = (p, type) => { if (exists(p)) found.push({ path: p, type, scope }); };

  if (scope === "project") {
    for (const f of walk(root, (_f, name) => name === "CLAUDE.md")) {
      found.push({ path: f, type: "claude-md", scope });
    }
    add(path.join(root, ".mcp.json"), "mcp");
  } else {
    add(path.join(root, "CLAUDE.md"), "claude-md");
  }

  const base = scope === "user" ? root : path.join(root, ".claude");
  add(path.join(base, "settings.json"), "settings");
  add(path.join(base, "settings.local.json"), "settings");
  add(path.join(base, "hooks", "hooks.json"), "hooks");
  add(path.join(base, ".mcp.json"), "mcp");

  for (const f of walk(path.join(base, "skills"), (_f, name) => name === "SKILL.md", 4))
    found.push({ path: f, type: "skill", scope });
  for (const f of walk(path.join(base, "commands"), (_f, name) => name.endsWith(".md"), 4))
    found.push({ path: f, type: "command", scope });
  for (const f of walk(path.join(base, "agents"), (_f, name) => name.endsWith(".md"), 4))
    found.push({ path: f, type: "agent", scope });

  const seen = new Set();
  return found.filter((a) => (seen.has(a.path) ? false : (seen.add(a.path), true)));
}

// ---------------------------------------------------------------------------
// Reality context (manifests / known commands / artifact names)
// ---------------------------------------------------------------------------
function buildContext(root) {
  // Union scripts across ALL package.json / composer.json files (monorepos &
  // subprojects keep their own — e.g. web/package.json), not just the root one,
  // so a script defined in a nested manifest isn't reported as missing.
  const collectScripts = (filename) => {
    const names = new Set();
    let any = false;
    for (const p of walk(root, (_f, name) => name === filename, 6)) {
      const j = readJSON(p);
      if (j && j.scripts) { any = true; for (const k of Object.keys(j.scripts)) names.add(k); }
      else if (j) any = true; // manifest exists even with no scripts
    }
    return any ? [...names] : null;
  };
  const npmScriptsAll = collectScripts("package.json");
  const composerScriptsAll = collectScripts("composer.json");

  const makeText = readText(path.join(root, "Makefile")) || readText(path.join(root, "makefile"));
  const makeTargets = makeText
    ? makeText.split("\n").map((l) => l.match(/^([A-Za-z0-9:_-]+):(?!=)/)).filter(Boolean).map((m) => m[1])
    : null;

  // Justfile: recipes (incl. parameters & dependencies) + aliases. If the justfile
  // imports modules we can't resolve them, so just-recipe findings are downgraded.
  const justText = readText(path.join(root, "justfile")) || readText(path.join(root, "Justfile"));
  let justRecipes = null, justHasModules = false;
  if (justText != null) {
    justRecipes = [];
    for (const raw of justText.split("\n")) {
      if (/^\s*(import|mod)\b/.test(raw)) justHasModules = true;
      const alias = raw.match(/^\s*alias\s+([A-Za-z0-9_-]+)\s*:=/);
      if (alias) { justRecipes.push(alias[1]); continue; }
      if (/^\s/.test(raw) || /^[#@\[]/.test(raw) || /^(set|export)\b/.test(raw)) continue; // body/attr/setting
      const m = raw.match(/^@?([A-Za-z0-9_-]+)(?:\s+[^:]*?)?:(?!=)/); // name [params...] [: deps]
      if (m) justRecipes.push(m[1]);
    }
  }

  // Laravel Envoy tasks/stories.
  const envoyText = readText(path.join(root, "Envoy.blade.php"));
  let envoyTasks = null;
  if (envoyText != null) {
    envoyTasks = [];
    for (const m of envoyText.matchAll(/@(?:task|story)\(\s*['"]([^'"]+)['"]/g)) envoyTasks.push(m[1]);
  }

  // env keys from .env.example
  const envText = readText(path.join(root, ".env.example"));
  const envKeys = envText
    ? new Set(envText.split("\n").map((l) => l.match(/^([A-Z][A-Z0-9_]+)=/)).filter(Boolean).map((m) => m[1]))
    : null;

  // Real top-level directories of THIS project — the language-agnostic way to tell
  // a project path from prose/branch-names/import-paths, instead of a hardcoded
  // src/app/lib allowlist that only fits PHP/JS layouts.
  let topDirs = new Set();
  try {
    topDirs = new Set(
      fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !IGNORE_DIRS.has(e.name))
        .map((e) => e.name)
    );
  } catch {}

  // Git submodule paths — legitimately empty until `git submodule update`, so
  // references inside them must not be flagged as missing.
  const gm = readText(path.join(root, ".gitmodules"));
  const submodulePaths = gm ? [...gm.matchAll(/^\s*path\s*=\s*(.+)$/gm)].map((m) => m[1].trim()) : [];

  return {
    npmScripts: npmScriptsAll,
    composerScripts: composerScriptsAll,
    makeTargets,
    justRecipes,
    justHasModules,
    envoyTasks,
    envKeys,
    isIgnored: buildGitignoreMatcher(root),
    topDirs,
    submodulePaths,
  };
}

// Practical .gitignore matcher (common subset: anchored & unanchored patterns,
// trailing-slash dirs, *, **, ?). Used to suppress references to files that are
// intentionally absent (secrets, local settings, build output, caches).
function buildGitignoreMatcher(root) {
  const txt = readText(path.join(root, ".gitignore"));
  if (!txt) return () => false;
  // Escape regex specials but NOT glob wildcards * ? — then translate those.
  const toRe = (seg) =>
    seg
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\x01")
      .replace(/\*/g, "[^/]*")
      .replace(/\x01/g, ".*")
      .replace(/\?/g, "[^/]");
  const pats = [];
  for (let line of txt.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const anchored = line.startsWith("/");
    const name = line.replace(/^\//, "").replace(/\/$/, "");
    if (!name) continue;
    const body = name.split("/").map(toRe).join("/");
    pats.push({ anchored, hasSlash: name.includes("/"), re: new RegExp("^" + body + "(?:$|/)"), bare: new RegExp("(?:^|/)" + body + "(?:$|/)") });
  }
  return (ref) => {
    const r = ref.replace(/^\.\//, "");
    return pats.some((p) => (p.anchored || p.hasSlash ? p.re.test(r) : p.bare.test(r)));
  };
}

// Package-manager subcommands that are NOT user scripts (so "pnpm outdated" etc.
// must not be reported as a missing script).
const NPM_BUILTINS = new Set([
  "install", "i", "ci", "add", "remove", "rm", "uninstall", "update", "up", "upgrade",
  "outdated", "audit", "exec", "dlx", "why", "list", "ls", "link", "unlink", "prune",
  "dedupe", "store", "publish", "pack", "init", "create", "import", "rebuild", "run",
  "run-script", "fund", "view", "info", "config", "cache", "patch", "approve-builds",
  "dedupe", "licenses", "doctor", "ping", "owner", "deprecate", "dist-tag", "set", "get",
  "workspace", "workspaces",
]);

// ---------------------------------------------------------------------------
// Reference extraction (index-aware so we can inspect surrounding context)
// ---------------------------------------------------------------------------
const PATHLIKE = /(?:\.\.?\/|[\w.-]+\/)[\w./-]+/;
const GLOB_CHARS = /[*?{}\[\]]/;
const PLACEHOLDER = /[<>]|\{\{|\}\}|:[a-z]/i;
// "path/to/...", "your-thing/...", "<...>" style instructional placeholders.
const PLACEHOLDER_PATH = /(?:^|\/)(?:path\/to|your[-_/]|some[-_/])/i;
// An ALL_CAPS_UNDERSCORE leading segment is almost always a variable/placeholder
// (ROOT_REPO/, CURRENT_BRANCH/, YOUR_PROJECT/) rather than a real directory.
const PLACEHOLDER_VAR_SEG = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?:\/|$)/;
const NEGATIVE =
  /\b(no longer|does\s*n[o']?t\s+exist|doesn'?t exist|don'?t use|do not use|has been (removed|renamed|moved|replaced|deleted)|was (removed|renamed|moved|replaced|deleted)|(now )?(moved|renamed|relocated|replaced) (to|by|with)|instead of|deprecated|removed in|formerly|used to (be|live)|previously|example only|placeholder|e\.g\.,? |there (is|are|'?s) no|no\s+\w+\s+(directory|folder|file)|must be initialized|not committed|git-?ignored)\b/i;
// The artifact is describing a file it CREATES (an output), not one it references.
const CREATION =
  /\b(creat(e|es|ed|ing)|generat(e|es|ed|ing)|writ(e|es|ten|ing)\b|output(s|ted)?|produc(e|es|ed)|scaffold(s|ed)?|stub(s|bed)?|new file|save(d|s)? (to|as)|stored? (in|at))\b/i;
// Illustrative/example context — the path is a sample, not an assertion the file
// exists. Downgrades confidence (keeps the finding for the semantic pass).
// Note: no leading \b — these markers often sit next to `*`/`(` (e.g. `**Example**:`,
// `(e.g., …)`) where a word boundary fails. Each alternative carries its own anchor.
const EXAMPLE_CONTEXT =
  /\bfor example\b|\bfor instance\b|\bsuch as\b|e\.g\.|\*\*examples?\*\*|\bexamples?\s*[:)]|\bsample (output|input|response|report)\b|\bunreferenced\b|\blast (touched|modified)\b/i;

const CODE_EXT = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".swift", ".sh",
  ".json", ".yaml", ".yml", ".toml", ".md", ".sql", ".html", ".css", ".scss",
  ".vue", ".svelte", ".astro", ".blade.php",
]);
const SRC_PREFIX = /^(src|lib|app|test|tests|scripts|packages|cmd|internal|config|resources|routes|database|bootstrap)\//;
// Common placeholder / example class & file names — not real references.
const EXAMPLE_NAME = /(?:^|\/)(?:Foo|Bar|Baz|Qux|Example|Sample|Dummy|Placeholder|Acme|MyClass|YourClass|SomeClass|File\d+|example[-_.]|sample[-_.]|your[-_]|some[-_]|test_file)[A-Za-z0-9]*(?:\.|\/|$)/i;
// Runtime-generated / ephemeral paths that are legitimately absent on a fresh clone.
const EPHEMERAL = /^(?:bootstrap\/cache|storage\/(?:framework|logs|app)|public\/(?:hot|build|storage)|coverage)\//;

const norm = (s) => s.replace(/[),.;:]+$/, "").replace(/\/$/, "");
const looksLikePath = (s) =>
  PATHLIKE.test(s) && !s.includes("://") && !s.startsWith("http") &&
  !/\s/.test(s) && !s.startsWith("$") && !s.includes("${") && s.length < 200;

function contextWindow(text, idx) {
  // The CURRENT line only — spanning the previous line lets a creation/negative
  // word from an adjacent (unrelated) bullet bleed onto this ref and wrongly
  // suppress it.
  const lineStart = text.lastIndexOf("\n", idx) + 1;
  let lineEnd = text.indexOf("\n", idx);
  if (lineEnd < 0) lineEnd = text.length;
  return text.slice(lineStart, lineEnd);
}

// Byte ranges covered by inline code spans / fenced code blocks. Commands are
// only trusted inside these — "just the right way" in prose is not a `just` call.
function codeRanges(text) {
  const ranges = [];
  let m;
  const fence = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
  while ((m = fence.exec(text))) ranges.push([m.index, m.index + m[0].length]);
  const inline = /`[^`\n]+`/g;
  while ((m = inline.exec(text))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}
const inRanges = (ranges, i) => ranges.some(([s, e]) => i >= s && i < e);

// Fenced code blocks only (``` … ``` / ~~~ … ~~~). In instructional artifacts
// (agents/commands) these usually hold sample I/O with illustrative paths.
function fenceRanges(text) {
  const ranges = [];
  let m;
  const fence = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
  while ((m = fence.exec(text))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

// Yield path candidates with index + neighbouring chars.
function* pathCandidates(text) {
  // backticked tokens
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const inner = m[1].trim();
    const first = inner.split(/\s+/)[0];
    const raw = looksLikePath(first) ? first : looksLikePath(inner) ? inner : null;
    if (raw) yield { raw, idx: m.index + 1, before: text.slice(Math.max(0, m.index - 1), m.index + 1), after: "`" };
  }
  // bare tokens — capture trailing glob chars so we can detect (not truncate) globs
  for (const m of text.matchAll(/(?<![\w/])((?:\.\.?\/)?(?:[\w.-]+\/){1,}[\w.@*?{}-]+(?:\.[A-Za-z0-9]+)?)/g)) {
    yield {
      raw: m[1],
      idx: m.index,
      before: text.slice(Math.max(0, m.index - 4), m.index),
      after: text[m.index + m[0].length] || "",
    };
  }
}

function classifyPath(cand, text, root, artifactPath, ctx, opts = {}) {
  const { raw, idx, before, after } = cand;
  const refRaw = raw;
  // strip a trailing file:line[:col] citation (common in agent docs: `foo.ts:78`)
  const ref = norm(raw.replace(GLOB_CHARS, "")).replace(/:\d+(?::\d+)?$/, "");
  const topDirs = ctx?.topDirs || new Set();
  const submodulePaths = ctx?.submodulePaths || [];

  // glob / pattern — never a single concrete file
  if (GLOB_CHARS.test(refRaw) || GLOB_CHARS.test(after)) return { suppress: { ref: refRaw, why: "glob/pattern" } };
  // placeholder tokens
  if (PLACEHOLDER.test(refRaw)) return { suppress: { ref: refRaw, why: "placeholder" } };
  if (!looksLikePath(ref)) return null;
  // shell / env variable reference, e.g. "$ROOT_REPO/..." (the `$` was dropped by the lookbehind)
  if (before.endsWith("$")) return { suppress: { ref, why: "shell/env variable" } };
  // external / home paths (the `~/` was stripped by the lookbehind — detect via `before`)
  if (before.includes("~") || raw.startsWith("~")) return { suppress: { ref, why: "external home path (~)" } };
  // PHP/namespace separator immediately before
  if (before.endsWith("\\")) return { suppress: { ref, why: "namespace (backslash)" } };
  // token is the tail of a longer path/filename, e.g. "Herd.app/Contents/..."
  if (/[A-Za-z0-9]\.$/.test(before)) return { suppress: { ref, why: "partial of a longer path" } };
  // leading ALL_CAPS_UNDERSCORE segment → a variable/placeholder (ROOT_REPO/, CURRENT_BRANCH/)
  if (PLACEHOLDER_VAR_SEG.test(ref)) return { suppress: { ref, why: "placeholder/variable segment" } };
  // instructional placeholder paths (path/to/..., your-thing/...)
  if (PLACEHOLDER_PATH.test(ref)) return { suppress: { ref, why: "instructional placeholder path" } };
  // example/placeholder class or file names
  if (EXAMPLE_NAME.test(ref)) return { suppress: { ref, why: "example/placeholder name" } };
  // incomplete/template ref left dangling on a separator (e.g. `docs/spec-` from `docs/spec-<id>`)
  if (/[-_]$/.test(ref)) return { suppress: { ref, why: "incomplete/template reference" } };
  // git submodule contents — legitimately absent until `git submodule update`
  const refClean = ref.replace(/^\.\//, "");
  if (submodulePaths.some((s) => refClean === s || refClean.startsWith(s + "/"))) return { suppress: { ref, why: "git submodule path (may be uninitialized)" } };
  // editor / IDE config — usually local-only / git-ignored
  if (/^\.(vscode|idea|fleet|zed|vs)\//.test(refClean)) return { suppress: { ref, why: "editor/IDE config (often local-only)" } };

  // Resolve against project root, the artifact's dir, and (for leading-slash refs
  // written as repo-relative) the root with the slash stripped.
  const candidates = [path.resolve(root, ref), path.resolve(path.dirname(artifactPath), ref)];
  if (ref.startsWith("/")) candidates.push(path.resolve(root, ref.replace(/^\/+/, "")));
  const foundAbs = candidates.find((c) => exists(c)) || null;
  if (foundAbs) {
    if (caseSensitiveExists(foundAbs)) return { ok: true }; // genuinely fine (counts as a resolving ref)
    return {
      emit: {
        ref, kind: "path", severity: "broken", confidence: "medium",
        reason: "case mismatch — resolves on macOS/Windows but breaks on case-sensitive filesystems (Linux/CI)",
      },
    };
  }

  const ext = path.extname(ref).toLowerCase();
  // Language-agnostic: a ref "looks like a project file" if it has a known code
  // extension OR its first segment is a real top-level directory of THIS project
  // (Go internal/, C# modules/, Rust crates/, …) — not just the PHP/JS allowlist.
  const firstSeg = refClean.split("/")[0];
  const looksReal = CODE_EXT.has(ext) || topDirs.has(firstSeg) || SRC_PREFIX.test(ref);
  if (!looksReal) return { suppress: { ref, why: "not clearly a project file" } };

  // gitignored → intentionally absent (secrets, local settings, build output, caches)
  if (ctx.isIgnored && ctx.isIgnored(ref.replace(/^\/+/, ""))) return { suppress: { ref, why: "gitignored (intentionally absent)" } };

  // runtime-generated / ephemeral — legitimately absent on a fresh clone
  if (EPHEMERAL.test(ref)) return { suppress: { ref, why: "runtime-generated/ephemeral path" } };
  // build output / generated directory anywhere in the path (web/build/, dist/, target/)
  if (/(?:^|\/)(?:build|dist|out|target|coverage|node_modules|\.next|\.nuxt)\//.test(ref)) return { suppress: { ref, why: "build output / generated dir" } };

  const ctxLine = contextWindow(text, idx);
  // negative context — the doc is *describing* the absence, not asserting presence
  if (NEGATIVE.test(ctxLine)) return { suppress: { ref, why: "documented as removed/moved (negative context)" } };
  // creation context — the doc describes a file it CREATES (an output), not a reference
  if (CREATION.test(ctxLine)) return { suppress: { ref, why: "described as created (output path)" } };

  // namespace-like: no extension, PascalCase tail, sibling .php files exist
  if (!ext && namespaceLike(ref, root)) return { suppress: { ref, why: "namespace-like (matching class exists)" } };

  // High confidence only if the ref is anchored to a REAL project top-level dir.
  // SRC_PREFIX is a guess (it lets `routes/x` look real even with no routes/ dir),
  // so it must NOT raise confidence — only an actual top-level dir match does.
  // Otherwise the ref is likely written relative to a subdir/crate/package we can't
  // see (monorepo `hashql-mir/src/...` → really `libs/@local/hashql/mir/...`), so
  // downgrade to low and let the semantic pass adjudicate.
  // A single-segment ref (e.g. `./run.sh`, `Makefile`) is a root-level file —
  // anchored to the project root. A multi-segment ref is anchored only if its
  // first segment is a real top-level directory.
  const anchored = refClean.split("/").length === 1 || topDirs.has(firstSeg);

  // Illustrative context downgrades to low: an example line ("e.g. `x`"), or a
  // path inside a fenced sample block of an instructional artifact (agent/command).
  const exampleCtx = EXAMPLE_CONTEXT.test(ctxLine);
  const inSampleFence = opts.instructional && opts.fences && inRanges(opts.fences, idx);
  if (anchored && !exampleCtx && !inSampleFence)
    return { emit: { ref, kind: "path", severity: "broken", confidence: "high", reason: "path not found on disk" } };
  const reason = exampleCtx || inSampleFence
    ? "path not found; appears in example/sample context — likely illustrative (needs semantic review)"
    : "path not found; first segment is not a project top-level dir (may be relative to a subdir/crate)";
  return { emit: { ref, kind: "path", severity: "broken", confidence: "low", reason } };
}

function namespaceLike(ref, root) {
  const tail = ref.split("/").pop();
  if (!/^[A-Z][A-Za-z0-9]+$/.test(tail)) return false;
  let dir = path.dirname(path.resolve(root, ref));
  while (dir.length >= root.length && !exists(dir)) dir = path.dirname(dir);
  if (!exists(dir)) return false;
  try {
    return fs.readdirSync(dir).some((f) => f === `${tail}.php` || f.startsWith(tail));
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Command references
// ---------------------------------------------------------------------------
const COMPOSER_BUILTINS = new Set([
  "install", "update", "require", "remove", "dump-autoload", "du", "run", "run-script",
  "exec", "create-project", "global", "self-update", "selfupdate", "validate", "show",
  "why", "why-not", "outdated", "audit", "archive", "check-platform-reqs", "clear-cache",
  "clearcache", "cc", "config", "diagnose", "fund", "init", "licenses", "prohibits",
  "reinstall", "search", "status", "suggests", "depends", "bump", "browse", "home",
]);
const CMD_PATTERNS = [
  { re: /\b(?:npm run|pnpm run|pnpm|yarn(?: run)?|bun run)\s+([A-Za-z0-9:_-]+)/g, kind: "npm-script", ctx: "npmScripts", skip: (n) => NPM_BUILTINS.has(n) },
  { re: /\bcomposer(?:\s+run(?:-script)?)?\s+([A-Za-z0-9:_-]+)/g, kind: "composer-script", ctx: "composerScripts", skip: (n) => COMPOSER_BUILTINS.has(n) },
  { re: /\bmake\s+([A-Za-z0-9:_-]+)/g, kind: "make-target", ctx: "makeTargets" },
  { re: /\benvoy\s+run\s+([A-Za-z0-9:_-]+)/g, kind: "envoy-task", ctx: "envoyTasks" },
  { re: /\bjust\s+([A-Za-z0-9:_-]+)/g, kind: "just-recipe", ctx: "justRecipes" },
];

function checkCommands(text, ctx) {
  const broken = [];
  const ranges = codeRanges(text);
  for (const { re, kind, ctx: ctxKey, skip } of CMD_PATTERNS) {
    const known = ctx[ctxKey];
    if (!known) continue; // manifest absent → cannot verify
    for (const m of text.matchAll(re)) {
      if (!inRanges(ranges, m.index)) continue; // ignore prose ("just the right way")
      const after = text[m.index + m[0].length] || "";
      if (after === "{" || after === "*" || after === ",") continue; // brace/glob expansion, not a literal name
      if (/^-/.test(m[1])) continue; // a CLI flag (e.g. `pnpm --filter web build`), not a script name
      const name = m[1].replace(/[-:]+$/, ""); // strip trailing punctuation contamination
      if (!name || (skip && skip(name))) continue;
      if (known.includes(name)) continue;
      // just recipes we can't resolve (modules/imports, or a `:` submodule name) → medium
      const confidence =
        ctxKey === "justRecipes" && (ctx.justHasModules || name.includes(":")) ? "medium" : "high";
      broken.push({ ref: name, kind, severity: "broken", confidence, reason: `not defined (${ctxKey})` });
    }
  }
  return broken;
}

// ---------------------------------------------------------------------------
// Hook command targets inside settings/hooks/mcp files
// ---------------------------------------------------------------------------
function collectCommands(json, key, acc = []) {
  if (!json || typeof json !== "object") return acc;
  if (Array.isArray(json)) { for (const x of json) collectCommands(x, key, acc); return acc; }
  for (const [k, v] of Object.entries(json)) {
    if (k === key && typeof v === "string") acc.push(v);
    else if (typeof v === "object") collectCommands(v, key, acc);
  }
  return acc;
}

const KNOWN_RUNNERS = new Set(["npx", "node", "nodejs", "uvx", "uv", "python", "python3", "docker", "deno", "bun", "sh", "bash", "pnpm", "yarn", "go", "cargo", "php", "ruby", "java"]);

function checkConfigCommands(artifact, root) {
  const json = readJSON(artifact.path);
  const broken = [];
  if (!json) return broken;
  if (artifact.type === "hooks" || artifact.type === "settings") {
    for (const cmd of collectCommands(json, "command")) {
      const cleaned = cmd.replace(/\$\{CLAUDE_PROJECT_DIR\}/g, root).replace(/\$CLAUDE_PROJECT_DIR/g, root).trim();
      if (cleaned.includes("${")) continue;
      const tok = cleaned.split(/\s+/)[0];
      if (tok && (tok.includes("/") || tok.startsWith(".")) && !exists(path.resolve(root, tok)) && !exists(tok)) {
        broken.push({ ref: tok, kind: "hook-command", severity: "broken", confidence: "high", reason: "hook command target not found" });
      }
    }
  }
  if (artifact.type === "mcp" && json.mcpServers) {
    for (const [name, srv] of Object.entries(json.mcpServers)) {
      const cmd = (srv.command || "").replace(/\$\{[^}]+\}/g, "").trim();
      if (!cmd) continue;
      if (cmd.includes("/") || cmd.startsWith(".")) {
        if (!exists(path.resolve(root, cmd)) && !exists(cmd)) {
          broken.push({ ref: `${name}: ${srv.command}`, kind: "mcp-command", severity: "broken", confidence: "medium", reason: "MCP server command path not found" });
        }
      } else if (!KNOWN_RUNNERS.has(cmd)) {
        broken.push({ ref: `${name}: ${cmd}`, kind: "mcp-command", severity: "warning", confidence: "low", reason: "MCP server command may not be installed" });
      }
    }
  }
  return broken;
}

// ---------------------------------------------------------------------------
// Cross-references to other skills/agents + env var coverage
// ---------------------------------------------------------------------------
function checkCrossRefs(text, knownNames, prefix, selfName) {
  if (!prefix) return [];
  const broken = [];
  const seen = new Set();
  const re = new RegExp(`\\b(${prefix}[a-z0-9-]+)\\b`, "g");
  for (const m of text.matchAll(re)) {
    const name = m[1].replace(/-$/, "");
    if (name === selfName || seen.has(name)) continue;
    // Gate on context: only treat as a skill/agent reference when the surrounding
    // text actually talks about skills/agents — the project prefix is often reused
    // for service/process names (e.g. systemd units) that are not Claude artifacts.
    if (!/\b(skill|agent|subagent|delegate|invoke)\b/i.test(contextWindow(text, m.index))) continue;
    seen.add(name);
    if (!knownNames.has(name)) {
      broken.push({ ref: name, kind: "cross-ref", severity: "warning", confidence: "medium", reason: "references a skill/agent that does not exist" });
    }
  }
  return broken;
}

const ENV_SUFFIX = /_(KEY|SECRET|TOKEN|ID|URL|DSN|HOST|PASSWORD|USER|PORT|REGION|BUCKET|ENDPOINT)$/;
function checkEnvVars(text, envKeys) {
  if (!envKeys) return [];
  const broken = [];
  const seen = new Set();
  for (const m of text.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)) {
    const v = m[1];
    if (seen.has(v) || !ENV_SUFFIX.test(v)) continue;
    seen.add(v);
    if (!envKeys.has(v)) {
      broken.push({ ref: v, kind: "env-var", severity: "warning", confidence: "low", reason: "env var not present in .env.example" });
    }
  }
  return broken;
}

// ---------------------------------------------------------------------------
// Frontmatter (small YAML subset)
// ---------------------------------------------------------------------------
function extractFrontmatter(text) {
  const fm = {};
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return fm;
  for (const line of match[1].split("\n")) {
    const mm = line.match(/^([\w-]+):\s*(.*)$/);
    if (mm) fm[mm[1]] = mm[2].trim();
  }
  return fm;
}

// ---------------------------------------------------------------------------
// Per-artifact verification
// ---------------------------------------------------------------------------
function verifyArtifact(artifact, root, ctx, names, baseline) {
  const text = readText(artifact.path);
  if (text == null) return { path: artifact.path, type: artifact.type, scope: artifact.scope, error: "unreadable", brokenRefs: [], suppressed: [] };

  const fm = extractFrontmatter(text);
  const brokenRefs = [];
  const suppressed = [];
  let resolvedReal = 0;

  // Agents/commands are instructional — paths in their fenced sample blocks are
  // usually illustrative output, so downgrade those to low.
  const instructional = artifact.type === "agent" || artifact.type === "command";
  const fences = instructional ? fenceRanges(text) : null;

  for (const cand of pathCandidates(text)) {
    const res = classifyPath(cand, text, root, artifact.path, ctx, { instructional, fences });
    if (!res) continue;
    if (res.ok) resolvedReal++;
    else if (res.suppress) suppressed.push(res.suppress);
    else if (res.emit) brokenRefs.push(res.emit);
  }
  // de-dup brokenRefs by ref+kind
  const seen = new Set();
  const dedupBroken = brokenRefs.filter((b) => { const k = b.kind + "|" + b.ref; return seen.has(k) ? false : (seen.add(k), true); });

  // Corroboration rule: a broken path is only HIGH confidence if the artifact is
  // demonstrably grounded in THIS repo — i.e. at least one other path it names
  // actually resolves. If NONE of its real-looking paths resolve, the artifact is
  // either a generic/example template (toolkit skills, instructional agents) or is
  // wholesale stale; either way "high-confidence broken" is wrong. Downgrade its
  // path findings to low and let the semantic pass adjudicate.
  if (resolvedReal === 0) {
    for (const b of dedupBroken) {
      if (b.kind !== "path") continue;
      b.confidence = "low";
      b.reason += " — artifact references no paths that resolve in this repo (generic/example or fully stale; needs semantic review)";
    }
  }

  dedupBroken.push(...checkCommands(text, ctx));
  dedupBroken.push(...checkConfigCommands(artifact, root));
  if (artifact.type !== "settings" && artifact.type !== "mcp")
    dedupBroken.push(...checkCrossRefs(text, names.known, names.prefix, fm.name || path.basename(artifact.path, ".md")));
  if (artifact.type === "claude-md") dedupBroken.push(...checkEnvVars(text, ctx.envKeys));

  // recency hint
  const aMtime = mtime(artifact.path);
  const recencyStaleDays =
    ctx.gitLastMs && aMtime && ctx.gitLastMs - aMtime > 1000 * 60 * 60 * 24 * 30
      ? Math.round((ctx.gitLastMs - aMtime) / (1000 * 60 * 60 * 24)) : null;

  // baseline / changed detection
  const hash = sha(text);
  const prev = baseline && baseline[rel(artifact.path)];
  const changed = !prev || prev.hash !== hash;

  // Every CHANGED artifact warrants a semantic/context-drift pass — context drift
  // (an out-of-date architecture/workflow description) usually has NO broken ref,
  // so we must NOT gate the semantic pass on hard findings. Baseline/--changed-only
  // is what controls cost; a fresh run (no baseline) treats everything as changed.
  const hasHigh = dedupBroken.some((b) => b.confidence === "high" || b.severity === "broken");
  const needsSemanticPass = changed;

  return {
    path: artifact.path,
    rel: rel(artifact.path),
    type: artifact.type,
    scope: artifact.scope,
    frontmatter: fm,
    brokenRefs: dedupBroken,
    suppressed,
    recencyStaleDays,
    hash,
    changed,
    needsSemanticPass,
    _hasHigh: hasHigh,
  };
}

// ---------------------------------------------------------------------------
// Names (known skills/agents + common project prefix)
// ---------------------------------------------------------------------------
function collectNames(artifacts) {
  const known = new Set();
  for (const a of artifacts) {
    if (a.type === "skill") known.add(path.basename(path.dirname(a.path)));
    if (a.type === "agent" || a.type === "command") {
      known.add(path.basename(a.path, ".md"));
      const fm = extractFrontmatter(readText(a.path) || "");
      if (fm.name) known.add(fm.name);
    }
  }
  // common prefix up to first hyphen, shared by >=2 names
  const prefixes = {};
  for (const n of known) {
    const m = n.match(/^([a-z0-9]+-)/);
    if (m) prefixes[m[1]] = (prefixes[m[1]] || 0) + 1;
  }
  const prefix = Object.entries(prefixes).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return { known, prefix };
}

function gitLastCommitMs(root) {
  try {
    const out = execFileSync("git", ["-C", root, "log", "-1", "--format=%ct"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out ? parseInt(out, 10) * 1000 : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Preflight: are the project's dependencies installed? Uninstalled deps and
// uninitialized submodules make references INTO them look like drift, so we
// surface these as warnings up front to reduce false positives at validation.
// ---------------------------------------------------------------------------
function checkPreflight(root) {
  const warnings = [];
  const ok = [];
  const dirEmpty = (p) => { try { return fs.readdirSync(p).length === 0; } catch { return true; } };

  // package.json → node_modules (any common manager)
  if (exists(path.join(root, "package.json"))) {
    if (exists(path.join(root, "node_modules")) && !dirEmpty(path.join(root, "node_modules"))) ok.push("node_modules");
    else warnings.push({ tool: "node", missing: "node_modules", fix: "npm install (or pnpm/yarn/bun install)", message: "package.json present but node_modules/ is missing — dependencies are not installed." });
  }
  // composer.json → vendor
  if (exists(path.join(root, "composer.json"))) {
    if (exists(path.join(root, "vendor")) && !dirEmpty(path.join(root, "vendor"))) ok.push("vendor");
    else warnings.push({ tool: "composer", missing: "vendor", fix: "composer install", message: "composer.json present but vendor/ is missing — PHP dependencies are not installed." });
  }
  // python: a declared project but no virtualenv / installed packages
  if (exists(path.join(root, "requirements.txt")) || exists(path.join(root, "pyproject.toml")) || exists(path.join(root, "Pipfile"))) {
    const hasVenv = ["venv", ".venv", "env", ".env-venv"].some((d) => exists(path.join(root, d)));
    if (!hasVenv) warnings.push({ tool: "python", missing: "virtualenv", fix: "python -m venv .venv && pip install -r requirements.txt (or `uv sync` / `poetry install`)", message: "Python project detected but no virtualenv (.venv/) found — dependencies may not be installed." });
    else ok.push(".venv");
  }
  // git submodules declared but not checked out
  const gm = readText(path.join(root, ".gitmodules"));
  if (gm) {
    for (const m of gm.matchAll(/^\s*path\s*=\s*(.+)$/gm)) {
      const sp = m[1].trim();
      if (dirEmpty(path.join(root, sp))) warnings.push({ tool: "git", missing: sp, fix: `git submodule update --init --recursive`, message: `Submodule '${sp}' is not initialized (empty) — its contents will look like missing references.` });
      else ok.push(`submodule:${sp}`);
    }
  }
  return { ok, warnings, clean: warnings.length === 0 };
}

// ---------------------------------------------------------------------------
// Reporting + merge
// ---------------------------------------------------------------------------
const SEV_RANK = { broken: 0, stale: 1, warning: 2, outdated: 3 };
const SEV_EMOJI = { broken: "🔴", stale: "🟠", warning: "🟡", outdated: "🟡" };

function flattenFindings(artifacts) {
  const out = [];
  for (const a of artifacts) {
    for (const b of a.brokenRefs || []) {
      out.push({
        artifact: a.rel, scope: a.scope, type: a.type, source: "script",
        severity: b.severity || "broken", confidence: b.confidence || "high",
        ref: b.ref, kind: b.kind, reason: b.reason, suggestedEdit: null,
      });
    }
  }
  return out;
}

// Merge auditor findings (array of {artifactPath, findings:[...]}) with script findings.
function mergeAuditor(scriptFindings, auditor, root) {
  const merged = [...scriptFindings];
  for (const a of auditor || []) {
    const aRel = (a.artifactPath || "").replace(root + path.sep, "");
    for (const f of a.findings || []) {
      // dedupe: a script finding whose ref appears in the auditor finding text
      const dupe = merged.find(
        (s) => s.artifact === aRel && s.source === "script" &&
          (JSON.stringify(f).includes(s.ref) || (f.location || "").includes(s.ref))
      );
      if (dupe) {
        dupe.source = "both";
        dupe.severity = f.severity || dupe.severity;
        dupe.reality = f.reality;
        dupe.claim = f.claim;
        dupe.evidence = f.evidence;
        dupe.suggestedEdit = f.suggestedEdit || dupe.suggestedEdit;
      } else {
        merged.push({
          artifact: aRel, scope: "project", source: "auditor",
          severity: f.severity || "stale", confidence: "medium",
          claim: f.claim, reality: f.reality, evidence: f.evidence,
          ref: f.location, suggestedEdit: f.suggestedEdit || null,
        });
      }
    }
  }
  return merged.sort((x, y) => (SEV_RANK[x.severity] ?? 9) - (SEV_RANK[y.severity] ?? 9));
}

function markdownReport(findings, summary) {
  const lines = ["# ClaudeDrift report", "", `**${summary.totalFindings} findings** across ${summary.artifactCount} artifacts.`, ""];
  const groups = { broken: [], stale: [], warning: [], outdated: [] };
  for (const f of findings) (groups[f.severity] || groups.outdated).push(f);
  const titles = { broken: "🔴 Broken", stale: "🟠 Stale", warning: "🟡 Warning", outdated: "🟡 Outdated" };
  for (const sev of ["broken", "stale", "warning", "outdated"]) {
    if (!groups[sev].length) continue;
    lines.push(`## ${titles[sev]} (${groups[sev].length})`, "");
    for (const f of groups[sev]) {
      const what = f.ref || f.claim || "";
      lines.push(`- **${f.artifact}** — \`${what}\`${f.confidence ? ` _(confidence: ${f.confidence}, via ${f.source})_` : ""}`);
      if (f.reason) lines.push(`  - ${f.reason}`);
      if (f.reality) lines.push(`  - reality: ${f.reality}`);
      if (f.evidence) lines.push(`  - evidence: ${f.evidence}`);
      if (f.suggestedEdit && f.suggestedEdit.old != null) lines.push(`  - fix: \`${f.suggestedEdit.old}\` → \`${f.suggestedEdit.new}\``);
    }
    lines.push("");
  }
  if (!findings.length) lines.push("✅ No significant drift detected.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  if (!exists(PROJECT_DIR)) {
    console.log(JSON.stringify({ error: `project dir not found: ${PROJECT_DIR}` }));
    process.exit(0);
  }

  // --preflight: just check that dependencies/submodules are installed and exit.
  // Run this BEFORE the full validation so uninstalled deps don't cause spurious
  // "missing reference" findings. Exits non-zero when there are warnings.
  if (preflightOnly) {
    const pf = checkPreflight(PROJECT_DIR);
    process.stdout.write(JSON.stringify({ projectDir: PROJECT_DIR, preflight: pf }, null, 2) + "\n");
    process.exit(pf.clean ? 0 : 1);
  }

  const ctx = buildContext(PROJECT_DIR);
  ctx.gitLastMs = gitLastCommitMs(PROJECT_DIR);
  const baseline = changedOnly || writeBaseline ? readJSON(BASELINE_PATH) : null;

  let artifacts = discoverArtifacts(PROJECT_DIR, "project");
  if (includeUser && exists(USER_CLAUDE)) artifacts = artifacts.concat(discoverArtifacts(USER_CLAUDE, "user"));

  const names = collectNames(artifacts);
  let results = artifacts.map((a) => verifyArtifact(a, PROJECT_DIR, ctx, names, baseline));

  // --baseline: persist current state and exit
  if (writeBaseline) {
    const state = {};
    for (const r of results) state[r.rel] = { hash: r.hash, type: r.type };
    try {
      fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(state, null, 2));
      console.log(JSON.stringify({ ok: true, baseline: BASELINE_PATH, artifacts: results.length }));
    } catch (e) {
      console.log(JSON.stringify({ error: String(e) }));
    }
    process.exit(0);
  }

  if (changedOnly) results = results.filter((r) => r.changed);

  let findings = flattenFindings(results);

  // --merge: fold in auditor JSON
  if (mergeFile) {
    const auditor = readJSON(mergeFile);
    findings = mergeAuditor(findings, Array.isArray(auditor) ? auditor : auditor?.findings || [], PROJECT_DIR);
  }

  const summary = {
    artifactCount: results.length,
    artifactsWithFindings: results.filter((r) => (r.brokenRefs?.length || 0) > 0).length,
    totalFindings: findings.length,
    bySeverity: findings.reduce((m, f) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {}),
    artifactsNeedingSemanticPass: results.filter((r) => r.needsSemanticPass).map((r) => r.rel),
    suppressedCount: results.reduce((n, r) => n + (r.suppressed?.length || 0), 0),
  };

  const output = {
    projectDir: PROJECT_DIR,
    scannedUser: includeUser,
    preflight: checkPreflight(PROJECT_DIR),
    context: { hasPackageJson: !!ctx.npmScripts, hasComposer: !!ctx.composerScripts, hasMakefile: !!ctx.makeTargets, hasEnvoy: !!ctx.envoyTasks, hasEnvExample: !!ctx.envKeys },
    summary,
    findings,
    artifacts: results.map(({ _hasHigh, ...r }) => r),
  };

  if (reportPath) {
    try { fs.writeFileSync(reportPath, markdownReport(findings, summary)); output.reportWritten = reportPath; } catch (e) { output.reportError = String(e); }
  }

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");

  if (ciMode) {
    const threshold = failOn === "any" ? 9 : SEV_RANK[failOn] ?? 0;
    const hit = findings.some((f) => (SEV_RANK[f.severity] ?? 9) <= threshold);
    process.exit(hit ? 1 : 0);
  }
}

main();
