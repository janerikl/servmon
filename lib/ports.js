import { execFileSync } from "node:child_process";

// Returns [{ pid, command }] of processes listening on the given TCP port,
// regardless of who started them (tmux-managed or not).
export function getPortListeners(port) {
  if (!port) return [];
  let out;
  try {
    out = execFileSync(
      "lsof",
      ["-i", `:${port}`, "-sTCP:LISTEN", "-P", "-n"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch {
    return [];
  }
  const lines = out.trim().split("\n").slice(1); // drop header
  const seen = new Map();
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    const command = cols[0];
    const pid = Number(cols[1]);
    if (!pid) continue;
    seen.set(pid, command);
  }
  return [...seen.entries()].map(([pid, command]) => ({ pid, command }));
}

function descendantPids(pid) {
  const all = [pid];
  let frontier = [pid];
  while (frontier.length) {
    const next = [];
    for (const p of frontier) {
      try {
        const out = execFileSync("pgrep", ["-P", String(p)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        next.push(...out.trim().split("\n").filter(Boolean).map(Number));
      } catch {}
    }
    all.push(...next);
    frontier = next;
  }
  return all;
}

// A managed session's own pid is often a wrapper (e.g. `npm run dev` forks
// the real dev server) — the TCP listener lives on a descendant, not the
// tracked pid itself. Walk the process tree to find what it's really bound
// to, returning the same shape as getPortListeners plus the port each one
// is on, so callers can both display it and kill the real pid.
export function getTreeListeners(pid) {
  const pids = descendantPids(pid);
  if (!pids.length) return [];
  let out;
  try {
    out = execFileSync(
      "lsof",
      ["-a", "-p", pids.join(","), "-i", "-sTCP:LISTEN", "-P", "-n"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch {
    return [];
  }
  const lines = out.trim().split("\n").slice(1);
  const seen = new Map();
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    const command = cols[0];
    const listenerPid = Number(cols[1]);
    const match = line.match(/:(\d+)\s*\(LISTEN\)/);
    if (!listenerPid || !match) continue;
    seen.set(listenerPid, { pid: listenerPid, command, port: Number(match[1]) });
  }
  return [...seen.values()];
}

export function killPid(pid, signal = "SIGKILL") {
  try {
    process.kill(pid, signal);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
