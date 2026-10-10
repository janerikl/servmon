import blessed from "blessed";
import path from "node:path";
import { spawn } from "node:child_process";
import * as tmux from "./tmux.js";
import * as ports from "./ports.js";
import { loadRegistry, generateRegistry, registryPath } from "./registry.js";

function openDetached(cmd, args) {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function formatUptime(createdEpochSeconds) {
  if (!createdEpochSeconds) return "-";
  const secs = Math.floor(Date.now() / 1000) - createdEpochSeconds;
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d${hrs % 24}h`;
}

// Clusters backend/frontend pairs of the same app together (nested dir, e.g.
// Analytics/client, or siblings under a shared parent, e.g. app/backend +
// app/frontend) instead of scattering them alphabetically by name.
function groupKey(s, servers, root) {
  const parent = servers.find(
    (o) => o !== s && (s.dir === o.dir || s.dir.startsWith(o.dir + path.sep))
  );
  if (parent) return parent.dir;

  // Siblings (e.g. app/backend + app/frontend) only count as a pair when
  // their shared parent is itself a project folder, not the scan root —
  // otherwise every unrelated top-level project would "sibling-match" the
  // first other project found directly under the scanned root.
  const parentDir = path.dirname(s.dir);
  if (root && parentDir !== path.resolve(root)) {
    const sibling = servers.find((o) => o !== s && path.dirname(o.dir) === parentDir);
    if (sibling) return parentDir;
  }

  return s.dir;
}

function groupMates(s, servers, root) {
  const key = groupKey(s, servers, root);
  return servers.filter((o) => o !== s && groupKey(o, servers, root) === key);
}

function groupServers(servers, root) {
  return [...servers].sort((a, b) => {
    const ka = groupKey(a, servers, root);
    const kb = groupKey(b, servers, root);
    if (ka !== kb) return ka.localeCompare(kb);
    return a.name.localeCompare(b.name);
  });
}

const isWeb = (s) => s.type !== "other";

const FRONTEND_HINTS = new Set(["frontend", "client", "web", "webapp", "ui", "app"]);

function classify(member) {
  if (member.type === "rails") return "be";
  const base = path.basename(member.dir).toLowerCase();
  const name = member.name.toLowerCase();
  if (FRONTEND_HINTS.has(base) || name.includes("frontend") || name.includes("client")) return "fe";
  return "be";
}

// Builds the rows actually shown in the table: a matched backend/frontend
// pair collapses into one row with separate FE/BE columns so the two halves
// of one app don't need two rows; anything without exactly one mate is
// shown on its own row as before.
function buildGroups(servers, root) {
  const seen = new Set();
  const groups = [];
  for (const s of servers) {
    if (seen.has(s)) continue;
    const mates = groupMates(s, servers, root);
    if (isWeb(s) && mates.length === 1 && isWeb(mates[0])) {
      const [a, b] = [s, mates[0]];
      seen.add(a);
      seen.add(b);
      const be = classify(a) === "be" ? a : classify(b) === "be" ? b : a;
      const fe = be === a ? b : a;
      const key = groupKey(s, servers, root);
      groups.push({ name: path.basename(key), dir: key, be, fe, members: [be, fe] });
    } else {
      seen.add(s);
      groups.push({ name: s.name, dir: s.dir, be: null, fe: null, members: [s], solo: s });
    }
  }
  return groups;
}

export function runTui(scanRoot) {
  let servers = groupServers(loadRegistry(scanRoot), scanRoot);

  const screen = blessed.screen({ smartCSR: true, title: "servermon" });

  const header = blessed.box({
    top: 0, left: 0, width: "100%", height: 1,
    content: " servermon — Development server monitor",
    style: { fg: "white", bg: "blue" },
  });

  const table = blessed.listtable({
    top: 1, left: 0, width: "100%", height: "100%-3",
    keys: true,
    mouse: true,
    align: "left",
    tags: true,
    style: {
      header: { bold: true, fg: "cyan" },
      cell: { selected: { bg: "blue", fg: "white" } },
      border: { fg: "gray" },
    },
    border: { type: "line" },
  });

  const footer = blessed.box({
    bottom: 0, left: 0, width: "100%", height: 2,
    content: "",
    style: { fg: "white" },
  });

  const searchLabel = blessed.box({
    bottom: 0, left: 0, width: 8, height: 1, hidden: true,
    content: " search:",
    style: { fg: "black", bg: "yellow" },
  });

  const searchInput = blessed.textbox({
    bottom: 0, left: 8, width: "100%-8", height: 1, hidden: true,
    inputOnFocus: true,
    style: { fg: "black", bg: "yellow" },
  });

  const helpBox = blessed.box({
    top: "center", left: "center", width: 50, height: 19,
    hidden: true,
    tags: true,
    label: " Keyboard commands ",
    border: { type: "line" },
    style: { border: { fg: "cyan" }, fg: "white", bg: "black" },
    content:
      "\n" +
      "  {bold}Up/Down{/bold}    move selection\n" +
      "  {bold}s{/bold}          start selected server\n" +
      "  {bold}x{/bold}          stop selected server\n" +
      "  {bold}r{/bold}          restart selected server\n" +
      "  {bold}f{/bold}          rescan projects, refresh registry\n" +
      "  {bold}k{/bold}          kill process occupying selected port\n" +
      "  {bold}c{/bold}          open project URL in Chrome\n" +
      "  {bold}o{/bold}          open project folder in file manager\n" +
      "  {bold}v{/bold}          open project folder in VS Code\n" +
      "  {bold}b{/bold}          open zsh in project folder (new terminal)\n" +
      "  {bold}C{/bold}          start claude in project folder (new terminal)\n" +
      "  {bold}/{/bold}          search projects (Enter keep, Esc clear)\n" +
      "  {bold}F1{/bold}         toggle this help screen\n" +
      "  {bold}q{/bold} / {bold}Ctrl-C{/bold}  quit\n" +
      "\n" +
      "  Port with {bold}?{/bold} suffix = guessed, not detected\n" +
      "  Press F1 or Esc to close",
  });

  screen.append(header);
  screen.append(table);
  screen.append(footer);
  screen.append(searchLabel);
  screen.append(searchInput);
  screen.append(helpBox);

  function setStatusMsg(msg) {
    footer.setContent(
      " [s] start  [x] stop  [r] restart  [k] kill port  [c] chrome  [o] folder  [v] vscode  [b] shell  [/] search  [f] rescan  [F1] help  [q] quit\n" +
      (msg ? ` ${msg}` : query ? "" : ` registry: ${registryPath()}`) +
      (query ? ` filter: "${query}" (/ to edit, Esc in search to clear)` : "")
    );
    screen.render();
  }

  function toggleHelp() {
    helpBox.hidden = !helpBox.hidden;
    if (!helpBox.hidden) helpBox.setFront();
    screen.render();
  }

  // server.name -> { listeners: [{pid, command}], managed: bool }
  const portInfoCache = new Map();
  let groups = [];
  let query = "";
  let searching = false;

  function matchesQuery(g) {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [g.name, g.dir, ...g.members.map((m) => m.name)].some((t) => t.toLowerCase().includes(q));
  }

  const STATUS_RANK = { stopped: 0, rogue: 1, starting: 2, running: 3 };

  function memberInfo(s, sessions, snap) {
    if (!isWeb(s)) {
      return { statusKey: "none", pid: null, created: null, managed: false, portOwner: "-", portLabel: "-" };
    }
    const managed = sessions.has(s.name); // servermon started this tmux session
    const pid = managed ? sessions.get(s.name).pid : null;
    const created = managed ? sessions.get(s.name).created : null;
    let listeners = ports.listenersOnPort(snap, s.port);
    let listening = listeners.length > 0;

    // A port held while servermon has no managed session for it means a
    // leftover/rogue process owns it and will block the next `s` (start).
    const rogue = !managed && listening;

    // A managed session that isn't listening on its expected port is often
    // still fine — the real process (a child of a wrapper like `npm run
    // dev`) just bound a different port (e.g. Vite auto-bumping away from
    // one already taken). Check what it's actually listening on before
    // calling it "starting" forever, and use those as the killable
    // listeners so `k` targets the real process, not the guessed port.
    let actualPort = null;
    if (managed && pid && !listening) {
      const treeListeners = ports.listenersInTree(snap, pid);
      if (treeListeners.length > 0) {
        listening = true;
        actualPort = treeListeners[0].port;
        listeners = treeListeners;
      }
    }

    portInfoCache.set(s.name, { listeners, managed, actualPort });

    let statusKey;
    if (managed && listening) statusKey = "running";
    else if (managed && !listening) statusKey = "starting";
    else if (rogue) statusKey = "rogue";
    else statusKey = "stopped";

    let portOwner = "-";
    if (listeners.length > 0) {
      const label = listeners.map((l) => `${l.command}(${l.pid})`).join(", ");
      portOwner =
        rogue
          ? `{magenta-fg}{bold}${label}{/bold}{/magenta-fg}`
          : actualPort
            ? `{green-fg}actual:${actualPort} ${label}{/green-fg}`
            : `{green-fg}${label}{/green-fg}`;
    }

    // A port found by watching the real process wins over the guessed one.
    const portLabel = actualPort
      ? String(actualPort)
      : s.port ? `${s.port}${s.portDetected ? "" : "?"}` : "-";

    return { statusKey, pid, created, managed, portOwner, portLabel };
  }

  function statusTag(key) {
    if (key === "running") return "{green-fg}running{/green-fg}";
    if (key === "starting") return "{yellow-fg}starting{/yellow-fg}";
    if (key === "rogue") return "{magenta-fg}{bold}ROGUE{/bold}{/magenta-fg}";
    if (key === "none") return "-";
    return "{red-fg}stopped{/red-fg}";
  }

  function rows(sessions, snap) {
    groups = buildGroups(servers, scanRoot).filter(matchesQuery);
    const head = ["Name", "Type", "Status", "FE Port", "BE Port", "PID", "Uptime", "Port Owner", "Dir"];
    const data = groups.map((g) => {
      if (g.solo) {
        const s = g.solo;
        const info = memberInfo(s, sessions, snap);
        const isFe = isWeb(s) && classify(s) === "fe";
        return [
          s.name,
          isWeb(s) ? s.type : "-",
          statusTag(info.statusKey),
          isFe ? info.portLabel : "-",
          isFe ? "-" : info.portLabel,
          info.pid ? String(info.pid) : "-",
          info.managed ? formatUptime(info.created) : "-",
          info.portOwner,
          s.dir,
        ];
      }

      const beInfo = memberInfo(g.be, sessions, snap);
      const feInfo = memberInfo(g.fe, sessions, snap);
      const worstKey = [beInfo.statusKey, feInfo.statusKey].sort(
        (a, b) => STATUS_RANK[a] - STATUS_RANK[b]
      )[0];

      return [
        g.name,
        `${g.be.type}/${g.fe.type}`,
        statusTag(worstKey),
        feInfo.portLabel,
        beInfo.portLabel,
        `be:${beInfo.pid ?? "-"} fe:${feInfo.pid ?? "-"}`,
        `be:${beInfo.managed ? formatUptime(beInfo.created) : "-"} fe:${feInfo.managed ? formatUptime(feInfo.created) : "-"}`,
        `be:${beInfo.portOwner} fe:${feInfo.portOwner}`,
        g.dir,
      ];
    });
    return [head, ...data];
  }

  // Gathering state is async so keypresses never wait behind subprocesses;
  // only one gather runs at a time, and a request that arrives meanwhile
  // (e.g. an action's status message) runs right after it.
  let refreshing = false;
  let pending = null;
  async function refresh(msg) {
    if (refreshing) {
      pending = { msg: msg ?? pending?.msg };
      return;
    }
    refreshing = true;
    try {
      const [sessions, snap] = await Promise.all([tmux.snapshotSessions(), ports.snapshot()]);
      const selected = table.selected;
      table.setData(rows(sessions, snap));
      table.select(Math.min(selected || 0, Math.max(groups.length, 1)));
      setStatusMsg(msg);
      screen.render();
    } finally {
      refreshing = false;
      if (pending) {
        const { msg: m } = pending;
        pending = null;
        refresh(m);
      }
    }
  }

  function selectedGroup() {
    const idx = table.selected - 1; // row 0 is header
    if (idx < 0 || idx >= groups.length) return null;
    return groups[idx];
  }

  // Server actions (start/stop/restart/kill/open URL) only make sense for web
  // projects; plain folders just get the folder actions.
  function notWeb(g) {
    if (g.members.some(isWeb)) return false;
    refresh(`${g.name} is not a web project`);
    return true;
  }

  table.key(["s"], () => {
    const g = selectedGroup();
    if (!g || notWeb(g)) return;
    const killedRogues = [];
    for (const m of g.members) {
      const info = portInfoCache.get(m.name);
      if (!info || info.managed || info.listeners.length === 0) continue;
      // A rogue process already owns this port — clear it first so the new
      // tmux session doesn't just fail to bind (or silently do nothing).
      for (const l of info.listeners) {
        const res = ports.killPid(l.pid);
        if (res.ok) killedRogues.push(l.pid);
      }
    }
    const results = g.members.map((m) => ({ m, res: tmux.startServer(m) }));
    const failed = results.filter((r) => !r.res.ok);
    const prefix = killedRogues.length ? `killed rogue pid(s) ${killedRogues.join(", ")}, ` : "";
    if (failed.length) refresh(`${prefix}error: ${failed.map((f) => `${f.m.name}: ${f.res.error}`).join("; ")}`);
    else refresh(`${prefix}started ${g.name}`);
  });

  table.key(["x"], () => {
    const g = selectedGroup();
    if (!g || notWeb(g)) return;
    const results = g.members.map((m) => ({ m, res: tmux.stopServer(m) }));
    const failed = results.filter((r) => !r.res.ok);
    if (failed.length) refresh(`error: ${failed.map((f) => `${f.m.name}: ${f.res.error}`).join("; ")}`);
    else refresh(`stopped ${g.name}`);
  });

  table.key(["r"], () => {
    const g = selectedGroup();
    if (!g || notWeb(g)) return;
    const results = g.members.map((m) => ({ m, res: tmux.restartServer(m) }));
    const failed = results.filter((r) => !r.res.ok);
    if (failed.length) refresh(`error: ${failed.map((f) => `${f.m.name}: ${f.res.error}`).join("; ")}`);
    else refresh(`restarted ${g.name}`);
  });

  table.key(["f"], () => {
    generateRegistry(scanRoot);
    servers = groupServers(loadRegistry(scanRoot), scanRoot);
    refresh(`rescanned ${scanRoot}, found ${servers.length} project(s)`);
  });

  table.key(["k"], () => {
    const g = selectedGroup();
    if (!g || notWeb(g)) return;
    let killedAny = false;
    const errors = [];
    for (const m of g.members) {
      const info = portInfoCache.get(m.name);
      if (!info || info.listeners.length === 0) continue;
      for (const l of info.listeners) {
        const res = ports.killPid(l.pid);
        if (res.ok) killedAny = true;
        else errors.push(res.error);
      }
      // If this was our own managed session, its tmux session can briefly
      // linger after its process dies (showing as "starting" until tmux
      // notices) — reap it now so the status reflects "stopped" right away.
      if (info.managed) tmux.stopServer(m);
    }
    if (errors.length) refresh(`error killing: ${errors[0]}`);
    else if (!killedAny) refresh(`nothing is listening on ${g.name}'s port(s)`);
    else refresh(`killed processes on ${g.name}'s port(s)`);
  });

  table.key(["c"], () => {
    const g = selectedGroup();
    if (!g || notWeb(g)) return;
    const target = g.fe || g.solo || g.be;
    if (!target.port) {
      refresh(`port not detected for ${g.name}`);
      return;
    }
    const wasRunning = tmux.isRunning(target);
    const res = wasRunning ? { ok: true } : tmux.startServer(target);
    if (!res.ok) {
      refresh(`error starting ${target.name}: ${res.error}`);
      return;
    }
    const cachedPort = portInfoCache.get(target.name)?.actualPort;
    const openPort = cachedPort || target.port;
    openDetached("xdg-open", [`http://localhost:${openPort}`]);
    refresh(
      wasRunning
        ? `opened http://localhost:${openPort} in browser`
        : `started ${target.name}, opened http://localhost:${openPort} in browser`
    );
  });

  table.key(["o"], () => {
    const g = selectedGroup();
    if (!g) return;
    openDetached("xdg-open", [g.dir]);
    refresh(`opened ${g.dir} in file manager`);
  });

  table.key(["C", "S-c"], () => {
    const g = selectedGroup();
    if (!g) return;
    openDetached("gnome-terminal", ["--working-directory", g.dir, "--", "claude"]);
    refresh(`started claude in ${g.dir}`);
  });

  table.key(["b"], () => {
    const g = selectedGroup();
    if (!g) return;
    openDetached("gnome-terminal", ["--working-directory", g.dir, "--", "zsh", "-i"]);
    refresh(`opened zsh in ${g.dir}`);
  });

  table.key(["v"], () => {
    const g = selectedGroup();
    if (!g) return;
    openDetached("code", [g.dir]);
    refresh(`opened ${g.dir} in VS Code`);
  });

  function closeSearch() {
    searching = false;
    searchLabel.hide();
    searchInput.hide();
    table.focus();
    table.select(1);
    refresh();
  }

  table.key(["/"], () => {
    searching = true;
    searchLabel.show();
    searchInput.show();
    searchInput.setValue(query);
    searchInput.focus();
    screen.render();
  });

  // Filter live as the user types; the value updates after the keypress lands.
  searchInput.on("keypress", () => {
    setImmediate(() => {
      query = searchInput.getValue();
      table.select(1);
      refresh();
    });
  });
  searchInput.on("submit", closeSearch);
  searchInput.on("cancel", () => {
    query = "";
    closeSearch();
  });

  table.key(["q", "C-c"], () => process.exit(0));
  // While typing in the search box, "q" is just a letter.
  screen.key(["q", "C-c"], (ch, key) => {
    if (searching && key.full === "q") return;
    process.exit(0);
  });

  screen.key(["f1"], () => toggleHelp());
  screen.key(["escape"], () => {
    if (!helpBox.hidden) toggleHelp();
  });

  table.focus();
  refresh();
  setInterval(() => refresh(), 2000);
  screen.render();
}
