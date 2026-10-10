import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runAsync(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch {
    return "";
  }
}

// One snapshot of every TCP listener and the process tree, taken with two
// cheap async calls (ss + ps) instead of per-project lsof/pgrep. `ss` also
// reports listeners lsof misses here (lsof can't stat docker overlay/nsfs
// mounts and returns nothing for some processes).
// Returns { listeners: [{port, pid, command}], children: Map<ppid, pid[]> }.
export async function snapshot() {
  const [ssOut, psOut] = await Promise.all([
    runAsync("ss", ["-ltnpH"]),
    runAsync("ps", ["-eo", "pid=,ppid="]),
  ]);

  const listeners = [];
  for (const line of ssOut.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const port = Number(cols[3].slice(cols[3].lastIndexOf(":") + 1));
    if (!port) continue;
    for (const m of line.matchAll(/\("([^"]*)",pid=(\d+),/g)) {
      listeners.push({ port, pid: Number(m[2]), command: m[1] });
    }
  }

  const children = new Map();
  for (const line of psOut.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  return { listeners, children };
}

export function listenersOnPort(snap, port) {
  if (!port) return [];
  const seen = new Map();
  for (const l of snap.listeners) {
    if (l.port === port) seen.set(l.pid, { pid: l.pid, command: l.command });
  }
  return [...seen.values()];
}

export function listenersInTree(snap, rootPid) {
  const tree = new Set([rootPid]);
  const stack = [rootPid];
  while (stack.length) {
    for (const c of snap.children.get(stack.pop()) ?? []) {
      if (!tree.has(c)) {
        tree.add(c);
        stack.push(c);
      }
    }
  }
  const seen = new Map();
  for (const l of snap.listeners) {
    if (tree.has(l.pid) && !seen.has(l.pid)) seen.set(l.pid, { ...l });
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
