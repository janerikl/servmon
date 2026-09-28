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

export function killPid(pid, signal = "SIGKILL") {
  try {
    process.kill(pid, signal);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
