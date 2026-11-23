import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";

const CONFIG_DIR = path.join(os.homedir(), ".config", "servmon");
const REGISTRY_PATH = path.join(CONFIG_DIR, "servers.yaml");

const SKIP_DIRS = new Set([
  "node_modules", ".git", "vendor", "tmp", "log", "coverage",
  "dist", "build", ".bundle", "public",
]);

const FRONTEND_DIR_NAMES = new Set([
  "frontend", "client", "web", "webapp", "ui", "app",
]);

function isWorktreeDir(name) {
  return name.endsWith(".worktrees");
}

// Scratch copies like "nauhu-wt-waveform" are clutter in the folder list.
// (Real git worktrees with their own dev server are still discovered as
// web projects by scanProjects.)
function isScratchCopyDir(name) {
  return name.includes("-wt-");
}

// Generated caches (unsloth_compiled_cache, __pycache__, ...) aren't projects.
function isCacheDir(name) {
  return /(^|[_.-])cache$/i.test(name) || name === "__pycache__";
}

function detectPackageManager(dir) {
  if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

function guessNodeCmd(dir) {
  const pkgPath = path.join(dir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
  const scripts = pkg.scripts || {};
  const pm = detectPackageManager(dir);
  const runner = pm === "npm" ? "npm run" : pm;
  if (scripts.dev) return `${runner} dev`;
  if (scripts.start) return pm === "npm" ? "npm start" : `${runner} start`;
  return null;
}

function guessRailsCmd(dir) {
  const binRails = path.join(dir, "bin", "rails");
  return fs.existsSync(binRails) ? "bin/rails s" : "rails s";
}

function portFromEnvFiles(dir) {
  for (const name of [".env", ".env.local", ".env.development"]) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    const match = fs.readFileSync(p, "utf8").match(/^\s*PORT\s*=\s*(\d+)/m);
    if (match) return Number(match[1]);
  }
  return null;
}

function portFromSourceFallback(dir, pkg) {
  const candidates = new Set(["server.js", "app.js", "index.js"]);
  if (pkg.main) candidates.add(pkg.main);
  for (const rel of candidates) {
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) continue;
    const content = fs.readFileSync(p, "utf8");
    const match = content.match(/process\.env\.PORT\s*(?:\|\||\?\?)\s*(\d+)/);
    if (match) return Number(match[1]);
  }
  return null;
}

function detectNodePort(dir, cmd) {
  const envPort = portFromEnvFiles(dir);
  if (envPort) return { port: envPort, detected: true };

  if (cmd) {
    const match = cmd.match(/(?:PORT=|--port[= ]|-p\s+)(\d+)/);
    if (match) return { port: Number(match[1]), detected: true };
  }

  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {}

  const sourcePort = portFromSourceFallback(dir, pkg);
  if (sourcePort) return { port: sourcePort, detected: true };

  // No guessing (framework defaults are often overridden or bumped): the
  // real port is read from the process once it runs.
  return { port: null, detected: false };
}

function detectRailsPort(dir) {
  const envPort = portFromEnvFiles(dir);
  if (envPort) return { port: envPort, detected: true };

  const pumaPath = path.join(dir, "config", "puma.rb");
  if (fs.existsSync(pumaPath)) {
    const content = fs.readFileSync(pumaPath, "utf8");
    const match = content.match(/port\s+ENV\.fetch\(\s*["']PORT["']\s*(?:,|\)\s*\{)\s*["']?(\d+)/);
    if (match) return { port: Number(match[1]), detected: true };
    const plain = content.match(/^\s*port\s+(\d+)/m);
    if (plain) return { port: Number(plain[1]), detected: true };
  }

  return { port: null, detected: false };
}

// Only real (detected or hand-set) ports are stored; no port = learn it from
// the running process.
function entry(name, dir, type, cmd, port) {
  return port ? { name, dir, type, cmd, port } : { name, dir, type, cmd };
}

function scanProjects(root, maxDepth = 2) {
  const found = [];

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const hasPackageJson = entries.some((e) => e.isFile() && e.name === "package.json");
    const hasGemfile = entries.some((e) => e.isFile() && e.name === "Gemfile");

    if (hasPackageJson || hasGemfile) {
      const name = path.basename(dir);
      if (hasGemfile) {
        const cmd = guessRailsCmd(dir);
        const { port } = detectRailsPort(dir);
        found.push(entry(`${name} (backend)`, dir, "rails", cmd, port));
      }
      if (hasPackageJson) {
        let pkgName = null;
        try {
          pkgName = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name;
        } catch {}
        if (pkgName !== "servermon") {
          const cmd = guessNodeCmd(dir);
          if (cmd) {
            const { port } = detectNodePort(dir, cmd);
            found.push(entry(hasGemfile ? `${name} (frontend)` : name, dir, "node", cmd, port));
          }
        }
      }
      // A backend project can have its own frontend nested inside it
      // (e.g. server/client, api/frontend) — check common subdir names
      // for a sibling app before giving up on this branch.
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!FRONTEND_DIR_NAMES.has(entry.name.toLowerCase())) continue;
        walk(path.join(dir, entry.name), depth + 1);
      }
      return; // don't descend into anything else under a detected project
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (isWorktreeDir(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  }

  walk(root, 0);
  return found;
}

// Every top-level folder that isn't (or doesn't contain) a web project is
// still listed so it can be opened in a file manager/editor/Claude; it just
// has no command or port.
function scanPlainProjects(root, webProjects) {
  const absRoot = path.resolve(root);
  let entries;
  try {
    entries = fs.readdirSync(absRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const plain = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    if (isWorktreeDir(entry.name) || isScratchCopyDir(entry.name) || isCacheDir(entry.name)) continue;
    const dir = path.join(absRoot, entry.name);
    const hasWeb = webProjects.some((p) => p.dir === dir || p.dir.startsWith(dir + path.sep));
    if (hasWeb) continue;
    plain.push({ name: entry.name, dir, type: "other" });
  }
  return plain;
}

export function registryExists() {
  return fs.existsSync(REGISTRY_PATH);
}

// Older registries stored guessed ports flagged `portDetected: false`; those
// are dropped so a guess never decides busy/ROGUE or what gets killed.
function readEntries() {
  if (!registryExists()) return [];
  const data = yaml.load(fs.readFileSync(REGISTRY_PATH, "utf8")) || {};
  return (data.servers || []).map((e) => {
    const { portDetected, ...rest } = e;
    if (portDetected === false) delete rest.port;
    return rest;
  });
}

// Each name must be unique (it is the tmux session name). A clash, e.g. two
// projects with a "client" folder, is resolved by using the path relative to
// the scan root ("Analytics/client"); the first one keeps its plain name.
function uniqueNames(list, root) {
  const seen = new Set();
  return list.map((p) => {
    if (!seen.has(p.name)) {
      seen.add(p.name);
      return p;
    }
    const rel = root ? path.relative(path.resolve(root), p.dir) : p.dir;
    const suffix = p.name.match(/ \((?:backend|frontend)\)$/)?.[0] ?? "";
    let name = `${rel}${suffix}`;
    for (let i = 2; seen.has(name); i++) name = `${rel}${suffix} #${i}`;
    seen.add(name);
    return { ...p, name };
  });
}

// Rescan merges with the current file: projects already listed (same folder
// and type) keep their name, cmd and port, so hand edits survive; entries
// whose folder still exists but weren't found (hand-added) are kept; ones
// whose folder is gone are dropped. The previous file is kept as .bak.
// Returns { projects, added, removed }.
export function generateRegistry(root) {
  const prev = readEntries();
  const key = (p) => `${p.dir}\0${p.type}`;
  const prevByKey = new Map(prev.map((p) => [key(p), p]));
  const scanned = scanProjects(root);
  const scannedKeys = new Set(scanned.map(key));

  // Known entries go first so, on a name clash, they keep their name (and
  // with it their running tmux session) and the new project is renamed.
  const known = [];
  const fresh = [];
  for (const p of scanned) {
    const old = prevByKey.get(key(p));
    if (!old) {
      fresh.push(p);
      continue;
    }
    const port = old.port ?? p.port;
    known.push({ ...p, ...old, ...(port ? { port } : {}) });
  }
  let removed = 0;
  for (const old of prev) {
    if (scannedKeys.has(key(old))) continue;
    if (fs.existsSync(old.dir)) known.push(old);
    else removed++;
  }

  const added = fresh.length;
  const projects = uniqueNames([...known, ...fresh], root);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (registryExists()) fs.copyFileSync(REGISTRY_PATH, `${REGISTRY_PATH}.bak`);
  fs.writeFileSync(REGISTRY_PATH, yaml.dump({ servers: projects }, { lineWidth: 120 }));
  return { projects, added, removed };
}

// Plain (non-web) folders aren't stored in the registry file; they're added
// on every load so they show up without needing a rescan.
export function loadRegistry(root) {
  const web = uniqueNames(readEntries(), root);
  return root ? [...web, ...scanPlainProjects(root, web)] : web;
}

export function registryBackupPath() {
  return `${REGISTRY_PATH}.bak`;
}

export function registryPath() {
  return REGISTRY_PATH;
}
