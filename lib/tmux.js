import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SESSION_PREFIX = "servermon-";
const KEEPALIVE_SESSION = "_servermon_keepalive_";

function run(args) {
  try {
    return execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    return null;
  }
}

// tmux's server process exits as soon as it has zero sessions, and its
// "no server running" error bypasses stdio (written straight to /dev/tty),
// which corrupts the blessed screen. Keep a hidden session alive so the
// server (and therefore list-sessions/list-panes) always succeeds cleanly.
export function ensureServerAlive() {
  run(["set-option", "-g", "exit-empty", "off"]);
  run(["new-session", "-d", "-s", KEEPALIVE_SESSION]);
}

// tmux silently rewrites "." and ":" in session names to "_", so a project
// like "reseptivihko.net" would get a session we could never find again.
// "/" (from de-duplicated names like "Analytics/client") is replaced too.
// Every lookup goes through this key so both sides agree.
export function sessionKey(name) {
  return name.replace(/[.:/]/g, "_");
}

export function sessionName(server) {
  return `${SESSION_PREFIX}${sessionKey(server.name)}`;
}

export function listSessions() {
  const out = run(["list-sessions", "-F", "#{session_name}\t#{session_created}"]);
  if (!out) return new Map();
  const map = new Map();
  for (const line of out.trim().split("\n")) {
    if (!line) continue;
    const [name, created] = line.split("\t");
    if (name.startsWith(SESSION_PREFIX)) {
      map.set(name.slice(SESSION_PREFIX.length), { created: Number(created) });
    }
  }
  return map;
}

// Async single-call snapshot: Map<name, { created, pid, dead, exitStatus }>
// for managed sessions. Sessions are kept after their process exits
// (remain-on-exit), so a crashed server shows as dead with its exit code and
// its output stays readable.
export async function snapshotSessions() {
  const map = new Map();
  let sessions = "";
  let panes = "";
  try {
    [sessions, panes] = (await Promise.all([
      execFileAsync("tmux", ["list-sessions", "-F", "#{session_name}\t#{session_created}"], { encoding: "utf8" }),
      execFileAsync(
        "tmux",
        ["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}"],
        { encoding: "utf8" }
      ),
    ])).map((r) => r.stdout);
  } catch {
    return map;
  }
  for (const line of sessions.trim().split("\n")) {
    if (!line) continue;
    const [name, created] = line.split("\t");
    if (name.startsWith(SESSION_PREFIX)) {
      map.set(name.slice(SESSION_PREFIX.length), { created: Number(created), pid: null, dead: false, exitStatus: null });
    }
  }
  // Not trim(): the last line can end in an empty (tab-separated) field.
  for (const line of panes.split("\n")) {
    const [name, pid, dead, status] = line.split("\t");
    const entry = name?.startsWith(SESSION_PREFIX) && map.get(name.slice(SESSION_PREFIX.length));
    if (entry && entry.pid === null) {
      entry.pid = Number(pid);
      entry.dead = dead === "1";
      // tmux fills the status in a moment after the pane dies.
      entry.exitStatus = entry.dead && /^\d+$/.test(status ?? "") ? Number(status) : null;
    }
  }
  return map;
}

export function getPanePid(server) {
  const out = run(["list-panes", "-t", sessionName(server), "-F", "#{pane_pid}"]);
  if (!out) return null;
  const pid = out.trim().split("\n")[0];
  return pid ? Number(pid) : null;
}

function hasSession(server) {
  return listSessions().has(sessionKey(server.name));
}

function isDead(server) {
  const out = run(["list-panes", "-t", sessionName(server), "-F", "#{pane_dead}"]);
  return out !== null && out.trim().split("\n")[0] === "1";
}

// A session whose process has exited (kept only for its output) doesn't
// count as running.
export function isRunning(server) {
  return hasSession(server) && !isDead(server);
}

export function startServer(server) {
  if (!server.cmd) return { ok: false, error: "no start command in servers.yaml" };
  if (hasSession(server)) {
    if (!isDead(server)) return { ok: false, error: "already running" };
    run(["kill-session", "-t", sessionName(server)]); // clear the crashed one
  }
  const cmdParts = server.cmd.split(" ").filter(Boolean);
  const name = sessionName(server);
  // Set in the same command list as new-session, so even a process that
  // dies instantly leaves its pane (and error output) behind.
  const args = [
    "new-session", "-d",
    "-s", name,
    "-c", server.dir,
    "--",
    ...cmdParts,
    ";", "set-option", "-w", "-t", name, "remain-on-exit", "on",
  ];
  const out = run(args);
  return out === null && !hasSession(server)
    ? { ok: false, error: "failed to start (check tmux/dir/cmd)" }
    : { ok: true };
}

// Also clears a crashed session (wasDead tells the caller which it was).
export function stopServer(server) {
  if (!hasSession(server)) return { ok: false, error: "not running" };
  const wasDead = isDead(server);
  run(["kill-session", "-t", sessionName(server)]);
  return { ok: true, wasDead };
}

// The session's recent output (scrollback included), or null without one.
export function captureOutput(server, lines = 2000) {
  const out = run(["capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", sessionName(server)]);
  return out === null ? null : out.replace(/\s+$/, "");
}

export function restartServer(server) {
  stopServer(server);
  return startServer(server);
}

export function tmuxAvailable() {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
