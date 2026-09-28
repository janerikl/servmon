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

function isWorktreeDir(name) {
  return name.endsWith(".worktrees");
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

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.next) return { port: 3000, detected: false };
  if (deps.vite) return { port: 5173, detected: false };
  if (deps["react-scripts"]) return { port: 3000, detected: false };

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

  return { port: 3000, detected: false };
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
        const { port, detected } = detectRailsPort(dir);
        found.push({ name, dir, type: "rails", cmd, port, portDetected: detected });
      } else if (hasPackageJson) {
        let pkgName = null;
        try {
          pkgName = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name;
        } catch {}
        if (pkgName === "servermon") return;
        const cmd = guessNodeCmd(dir);
        if (cmd) {
          const { port, detected } = detectNodePort(dir, cmd);
          found.push({ name, dir, type: "node", cmd, port, portDetected: detected });
        }
      }
      return; // don't descend into a detected project
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

function assignPorts(projects) {
  // Ports read from .env/config/package.json scripts are the real answer —
  // leave them alone. Only projects where nothing could be determined get a
  // sequential guess, and that guess avoids every port already claimed above.
  const usedPorts = new Set(projects.filter((p) => p.port).map((p) => p.port));
  let nextGuess = 3000;

  for (const p of projects) {
    if (p.port) continue;
    while (usedPorts.has(nextGuess)) nextGuess++;
    p.port = nextGuess;
    p.portDetected = false;
    usedPorts.add(nextGuess);
  }
  return projects;
}

export function registryExists() {
  return fs.existsSync(REGISTRY_PATH);
}

export function generateRegistry(root) {
  const projects = assignPorts(scanProjects(root));
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, yaml.dump({ servers: projects }, { lineWidth: 120 }));
  return projects;
}

export function loadRegistry() {
  if (!registryExists()) return [];
  const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
  const data = yaml.load(raw) || {};
  return data.servers || [];
}

export function registryPath() {
  return REGISTRY_PATH;
}
