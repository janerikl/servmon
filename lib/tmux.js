import { execFileSync } from "node:child_process";

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

export function sessionName(server) {
  return `${SESSION_PREFIX}${server.name}`;
}

export function listSessions() {
  const out = run(["list-sessions", "-F", "#{session_name} #{session_created}"]);
  if (!out) return new Map();
  const map = new Map();
  for (const line of out.trim().split("\n")) {
    if (!line) continue;
    const [name, created] = line.split(" ");
    if (name.startsWith(SESSION_PREFIX)) {
      map.set(name.slice(SESSION_PREFIX.length), { created: Number(created) });
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

export function isRunning(server) {
  return listSessions().has(server.name);
}

export function startServer(server) {
  if (isRunning(server)) return { ok: false, error: "already running" };
  const cmdParts = server.cmd.split(" ").filter(Boolean);
  const args = [
    "new-session", "-d",
    "-s", sessionName(server),
    "-c", server.dir,
    "--",
    ...cmdParts,
  ];
  const out = run(args);
  return out === null && !isRunning(server)
    ? { ok: false, error: "failed to start (check tmux/dir/cmd)" }
    : { ok: true };
}

export function stopServer(server) {
  if (!isRunning(server)) return { ok: false, error: "not running" };
  run(["kill-session", "-t", sessionName(server)]);
  return { ok: true };
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
