#!/usr/bin/env node
// ClaudeDrift — deterministic discovery + hard-reference checker.
//
// Usage:  node discover.mjs [projectDir] [--user]
//
// Discovers every Claude artifact that influences a project (CLAUDE.md files,
// skills, commands, agents, settings/hooks) and verifies the concrete references
// inside them against the live filesystem / package manifests. Emits a single
// JSON object on stdout. No npm dependencies — Node built-ins only, because
// Claude Code itself runs on Node so `node` is always available.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const includeUser = argv.includes("--user");
const positional = argv.filter((a) => !a.startsWith("--"));
const PROJECT_DIR = path.resolve(
  positional[0] || process.env.CLAUDE_PROJECT_DIR || process.cwd()
);
const HOME = os.homedir();
const USER_CLAUDE = path.join(HOME, ".claude");

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "vendor",
  "target",
  ".idea",
  ".vscode",
]);

// ---------------------------------------------------------------------------
// Small fs helpers
// ---------------------------------------------------------------------------
function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}
function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
function readJSON(p) {
  const t = readText(p);
  if (t == null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}
function mtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

// Recursively walk, returning files matching `test`, skipping IGNORE_DIRS.
function walk(dir, test, maxDepth = 8, depth = 0, acc = []) {
  if (depth > maxDepth || !exists(dir)) return acc;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
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
  const add = (p, type) => {
    if (exists(p)) found.push({ path: p, type, scope });
  };

  if (scope === "project") {
    // All CLAUDE.md anywhere in the tree (nested memory files).
    for (const f of walk(root, (_full, name) => name === "CLAUDE.md")) {
      found.push({ path: f, type: "claude-md", scope });
    }
  } else {
    add(path.join(root, "CLAUDE.md"), "claude-md");
  }

  const dotClaude = path.join(root, ".claude");
  const base = scope === "user" ? root : dotClaude; // user artifacts live under ~/.claude directly

  // settings / hooks
  add(path.join(base, "settings.json"), "settings");
  add(path.join(base, "settings.local.json"), "settings");
  add(path.join(base, "hooks", "hooks.json"), "hooks");

  // skills: <base>/skills/<name>/SKILL.md
  const skillsDir = path.join(base, "skills");
  for (const f of walk(skillsDir, (_full, name) => name === "SKILL.md", 4)) {
    found.push({ path: f, type: "skill", scope });
  }

  // commands: <base>/commands/**/*.md
  const cmdDir = path.join(base, "commands");
  for (const f of walk(cmdDir, (_full, name) => name.endsWith(".md"), 4)) {
    found.push({ path: f, type: "command", scope });
  }

  // agents: <base>/agents/*.md
  const agentsDir = path.join(base, "agents");
  for (const f of walk(agentsDir, (_full, name) => name.endsWith(".md"), 4)) {
    found.push({ path: f, type: "agent", scope });
  }

  // de-dup by path
  const seen = new Set();
  return found.filter((a) => {
    if (seen.has(a.path)) return false;
    seen.add(a.path);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Reference extraction
// ---------------------------------------------------------------------------

// Path-like tokens: backticked paths, ./ ../ relative, or dir/seg/seg with an
// extension or known source dir prefix. Conservative to limit false positives.
const PATH_IN_BACKTICKS = /`([^`\n]+)`/g;
const PATH_BARE =
  /(?<![\w/])((?:\.\.?\/)?(?:[\w.-]+\/){1,}[\w.-]+(?:\.[A-Za-z0-9]+)?)/g;
const NPM_SCRIPT =
  /\b(?:npm run|pnpm run|pnpm|yarn(?: run)?|bun run)\s+([A-Za-z0-9:_-]+)/g;
const MAKE_TARGET = /\bmake\s+([A-Za-z0-9:_-]+)/g;

const PATHLIKE = /(?:\.\.?\/|[\w.-]+\/)[\w./-]+/;
const LOOKS_LIKE_PATH = (s) =>
  PATHLIKE.test(s) &&
  !s.includes("://") &&
  !s.startsWith("http") &&
  !/\s/.test(s) &&
  !s.startsWith("$") &&
  !s.includes("${") &&
  !s.includes("*") &&
  s.length < 200;

const CODE_EXT = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".swift", ".sh",
  ".json", ".yaml", ".yml", ".toml", ".md", ".sql", ".html", ".css", ".scss",
  ".vue", ".svelte", ".astro",
]);

function extractRefs(text) {
  const paths = new Set();
  const npmScripts = new Set();
  const makeTargets = new Set();

  // Normalize a path token: strip trailing punctuation and a single trailing
  // slash so `src/handlers` and `src/handlers/` collapse to one ref.
  const norm = (s) => s.replace(/[),.;:]+$/, "").replace(/\/$/, "");

  let m;
  // Backtick contents that look like paths.
  PATH_IN_BACKTICKS.lastIndex = 0;
  while ((m = PATH_IN_BACKTICKS.exec(text))) {
    const inner = m[1].trim();
    // a backticked command line — pull the first token if it's a path
    const first = inner.split(/\s+/)[0];
    if (LOOKS_LIKE_PATH(first)) paths.add(norm(first));
    else if (LOOKS_LIKE_PATH(inner)) paths.add(norm(inner));
  }
  // Bare path tokens in prose.
  PATH_BARE.lastIndex = 0;
  while ((m = PATH_BARE.exec(text))) {
    const tok = norm(m[1]);
    if (LOOKS_LIKE_PATH(tok)) paths.add(tok);
  }
  NPM_SCRIPT.lastIndex = 0;
  while ((m = NPM_SCRIPT.exec(text))) npmScripts.add(m[1]);
  MAKE_TARGET.lastIndex = 0;
  while ((m = MAKE_TARGET.exec(text))) makeTargets.add(m[1]);

  return {
    paths: [...paths],
    npmScripts: [...npmScripts],
    makeTargets: [...makeTargets],
  };
}

// Frontmatter (very small YAML subset) — pull tool/agent/hook hints.
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
// Hard verification against the live tree
// ---------------------------------------------------------------------------
function loadPackageScripts(root) {
  const pkg = readJSON(path.join(root, "package.json"));
  return pkg && pkg.scripts ? Object.keys(pkg.scripts) : null;
}
function loadMakeTargets(root) {
  const mk = readText(path.join(root, "Makefile")) || readText(path.join(root, "makefile"));
  if (mk == null) return null;
  const targets = [];
  for (const line of mk.split("\n")) {
    const mm = line.match(/^([A-Za-z0-9:_-]+):(?!=)/);
    if (mm) targets.push(mm[1]);
  }
  return targets;
}

function resolvePath(ref, root, artifactPath) {
  // Try: relative to project root, relative to artifact's dir, and as-is.
  const candidates = [
    path.resolve(root, ref),
    path.resolve(path.dirname(artifactPath), ref),
  ];
  return candidates.some((c) => exists(c));
}

function verifyArtifact(artifact, root, pkgScripts, makeTargets, gitLastMs) {
  const text = readText(artifact.path);
  if (text == null) {
    return { ...artifact, error: "unreadable", brokenRefs: [], refs: {} };
  }
  const refs = extractRefs(text);
  const fm = extractFrontmatter(text);
  const brokenRefs = [];

  for (const ref of refs.paths) {
    // Skip refs that point outside / are clearly not project files.
    if (resolvePath(ref, root, artifact.path)) continue;
    // Only flag refs that look like real project artifacts (known ext or src-ish).
    const ext = path.extname(ref).toLowerCase();
    const looksReal = CODE_EXT.has(ext) || /^(src|lib|app|test|tests|scripts|packages|cmd|internal)\//.test(ref);
    if (!looksReal) continue;
    brokenRefs.push({ ref, kind: "path", reason: "path not found on disk" });
  }

  if (pkgScripts) {
    for (const s of refs.npmScripts) {
      if (!pkgScripts.includes(s)) {
        brokenRefs.push({ ref: s, kind: "npm-script", reason: "not in package.json scripts" });
      }
    }
  }
  if (makeTargets) {
    for (const t of refs.makeTargets) {
      if (!makeTargets.includes(t)) {
        brokenRefs.push({ ref: t, kind: "make-target", reason: "not in Makefile" });
      }
    }
  }

  // hook command targets inside settings/hooks files
  if (artifact.type === "hooks" || artifact.type === "settings") {
    const json = readJSON(artifact.path);
    for (const cmd of collectHookCommands(json)) {
      const cleaned = cmd
        .replace(/\$\{CLAUDE_PROJECT_DIR\}/g, root)
        .replace(/\$CLAUDE_PROJECT_DIR/g, root)
        .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, "")
        .trim();
      const firstTok = cleaned.split(/\s+/)[0];
      if (firstTok && (firstTok.includes("/") || firstTok.startsWith(".")) && !cleaned.includes("${")) {
        if (!resolvePath(firstTok, root, artifact.path) && !exists(firstTok)) {
          brokenRefs.push({ ref: firstTok, kind: "hook-command", reason: "hook command target not found" });
        }
      }
    }
  }

  // recency hint: artifact older than most recent commit by a wide margin
  const aMtime = mtime(artifact.path);
  const recencyStale =
    gitLastMs && aMtime && gitLastMs - aMtime > 1000 * 60 * 60 * 24 * 30
      ? Math.round((gitLastMs - aMtime) / (1000 * 60 * 60 * 24))
      : null;

  return {
    path: artifact.path,
    type: artifact.type,
    scope: artifact.scope,
    frontmatter: fm,
    refs,
    brokenRefs,
    recencyStaleDays: recencyStale,
  };
}

function collectHookCommands(json, acc = []) {
  if (!json || typeof json !== "object") return acc;
  if (Array.isArray(json)) {
    for (const x of json) collectHookCommands(x, acc);
    return acc;
  }
  for (const [k, v] of Object.entries(json)) {
    if (k === "command" && typeof v === "string") acc.push(v);
    else if (typeof v === "object") collectHookCommands(v, acc);
  }
  return acc;
}

function gitLastCommitMs(root) {
  try {
    const out = execFileSync("git", ["-C", root, "log", "-1", "--format=%ct"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? parseInt(out, 10) * 1000 : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  if (!exists(PROJECT_DIR)) {
    console.log(JSON.stringify({ error: `project dir not found: ${PROJECT_DIR}` }));
    process.exit(0);
  }

  const pkgScripts = loadPackageScripts(PROJECT_DIR);
  const makeTargets = loadMakeTargets(PROJECT_DIR);
  const gitLastMs = gitLastCommitMs(PROJECT_DIR);

  let artifacts = discoverArtifacts(PROJECT_DIR, "project");
  if (includeUser && exists(USER_CLAUDE)) {
    artifacts = artifacts.concat(discoverArtifacts(USER_CLAUDE, "user"));
  }

  const results = artifacts.map((a) =>
    verifyArtifact(a, PROJECT_DIR, pkgScripts, makeTargets, gitLastMs)
  );

  const totalBroken = results.reduce((n, r) => n + (r.brokenRefs?.length || 0), 0);
  const output = {
    projectDir: PROJECT_DIR,
    scannedUser: includeUser,
    hasPackageJson: pkgScripts != null,
    hasMakefile: makeTargets != null,
    summary: {
      artifactCount: results.length,
      artifactsWithBrokenRefs: results.filter((r) => (r.brokenRefs?.length || 0) > 0).length,
      totalBrokenRefs: totalBroken,
    },
    artifacts: results,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

main();
