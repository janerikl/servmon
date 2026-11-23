import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";

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
// Each listener also carries its working directory and full command line
// (from /proc), so it can be credited to the project it was started in
// rather than whichever project happens to guess the same port; both are
// null when /proc isn't readable (another user's process, containers).
// Returns { listeners: [{port, pid, command, cwd, cmdline}], children: Map<ppid, pid[]> }.
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
      const pid = Number(m[2]);
      listeners.push({ port, pid, command: m[1], ...procInfo(pid) });
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

function procInfo(pid) {
  let cwd = null;
  let cmdline = null;
  try {
    cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {}
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ") || null;
  } catch {}
  return { cwd, cmdline };
}

// Ports the kernel hands out to "listen on any free port" callers (editor
// helpers, language servers, CLI tools). Dev servers don't land here, so a
// listener in this range isn't mistaken for a project's server.
let ephemeral = null;
export function isEphemeralPort(port) {
  if (!ephemeral) {
    ephemeral = [32768, 60999];
    try {
      const [lo, hi] = fs.readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number);
      if (lo && hi) ephemeral = [lo, hi];
    } catch {}
  }
  return port >= ephemeral[0] && port <= ephemeral[1];
}

export function listenersOnPort(snap, port) {
  if (!port) return [];
  const seen = new Map();
  for (const l of snap.listeners) {
    if (l.port === port && !seen.has(l.pid)) seen.set(l.pid, { ...l });
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
  return uniqueListeners(snap.listeners.filter((l) => tree.has(l.pid)));
}

// One entry per (pid, port): ss lists IPv4 and IPv6 sockets separately, but
// a process listening on two ports should show both.
export function uniqueListeners(list) {
  return [...new Map(list.map((l) => [`${l.pid}:${l.port}`, l])).values()];
}

export function killPid(pid, signal = "SIGKILL") {
  try {
    process.kill(pid, signal);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
