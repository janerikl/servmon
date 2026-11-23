import blessed from "blessed";
import path from "node:path";
import { spawn } from "node:child_process";
import * as tmux from "./tmux.js";
import * as ports from "./ports.js";
import { loadRegistry, generateRegistry, registryPath, registryBackupPath } from "./registry.js";

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

const isWeb = (s) => s.type !== "other";

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

// Web projects first (they're what the server controls are for), plain
// folders after them; alphabetical by group within each block.
function groupServers(servers, root) {
  return [...servers].sort((a, b) => {
    if (isWeb(a) !== isWeb(b)) return isWeb(a) ? -1 : 1;
    const ka = groupKey(a, servers, root);
    const kb = groupKey(b, servers, root);
    if (ka !== kb) return ka.localeCompare(kb);
    return a.name.localeCompare(b.name);
  });
}

const FRONTEND_HINTS = new Set(["frontend", "client", "web", "webapp", "ui", "app"]);

function classify(member) {
  if (member.type === "rails") return "be";
  const base = path.basename(member.dir).toLowerCase();
  const name = member.name.toLowerCase();
  if (FRONTEND_HINTS.has(base) || name.includes("frontend") || name.includes("client")) return "fe";
  return "be";
}

// A project nested below the scan root (e.g. valueinvestor/app) is shown
// with its parent folder so it reads, and sorts, as part of that folder.
// De-duplicated names ("Analytics/client") already carry their path.
function displayName(s, root) {
  const parent = path.dirname(s.dir);
  if (!root || parent === path.resolve(root) || s.name.includes("/")) return s.name;
  return `${path.relative(path.resolve(root), parent)}/${s.name}`;
}

// Builds the app groups: a matched backend/frontend pair becomes one group
// (shown as a group row plus one row per member); anything without exactly
// one mate is a group of its own.
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
      groups.push({ name: displayName(s, root), dir: s.dir, be: null, fe: null, members: [s], solo: s });
    }
  }
  return groups;
}

// The rows of the table. Actions on a group row apply to both members, on a
// member row only to that member.
function buildItems(groups) {
  const items = [];
  for (const g of groups) {
    if (g.solo) {
      items.push({ id: `solo:${g.solo.name}`, kind: isWeb(g.solo) ? "solo" : "plain", g, label: g.name, dir: g.dir, members: [g.solo] });
      continue;
    }
    items.push({ id: `group:${g.dir}`, kind: "group", g, label: g.name, dir: g.dir, members: g.members });
    g.members.forEach((m, i) => {
      items.push({ id: `member:${m.name}`, kind: "member", g, role: i === 0 ? "be" : "fe", last: i === g.members.length - 1, label: m.name, dir: m.dir, members: [m] });
    });
  }
  return items;
}

// A readable name for a listening process. `ss` only knows the 15-char
// thread name ("node-MainThread", "next-server (v1"); the command line says
// what it really is (vite, next, puma, rails).
const INTERPRETERS = new Set(["node", "nodejs", "ruby", "python", "python3", "bun", "deno", "sh", "bash"]);
function procLabel(l) {
  const args = (l.cmdline || "").split(" ").filter(Boolean);
  if (!args.length) return l.command;
  let name = path.basename(args[0]);
  if (INTERPRETERS.has(name)) {
    const script = args.slice(1).find((a) => !a.startsWith("-"));
    if (script) name = path.basename(script);
  }
  return name.replace(/\.[cm]?js$/, "") || l.command;
}

const RUBY_PROC = /ruby|puma|rails|unicorn|thin|falcon/i;
// For a Rails app and a Node frontend sharing one folder, a process started
// there belongs to the one whose runtime it is.
function procMatchesType(l, type) {
  const isRuby = RUBY_PROC.test(`${l.command} ${l.cmdline || ""}`);
  return type === "rails" ? isRuby : !isRuby;
}

const truncate = (str, width) => (str.length > width ? `${str.slice(0, Math.max(0, width - 1))}…` : str);
const uniq = (arr) => [...new Set(arr)];

const KEYS_LONG =
  " [s] start  [x] stop  [r] restart  [k] kill  [l] logs  [c] chrome  [o] folder  [v] vscode" +
  "  [b] shell  [C] claude  [/] search  [f] rescan  [R] reload  [F1] help  [q] quit";
const KEYS_MID = " s/x/r start/stop/restart  k kill  l logs  c chrome  / search  F1 all keys  q quit";
const KEYS_SHORT = " s/x/r  k kill  l logs  / search  F1 keys  q quit";

const HELP_LINES = [
  "",
  "  {bold}Up/Down{/bold}       move selection",
  "  {bold}PgUp/PgDn{/bold}     move one page",
  "  {bold}Home/g End/G{/bold}  first / last row",
  "  {bold}s{/bold}             start selected server",
  "  {bold}x{/bold}             stop server (also clears a crashed one)",
  "  {bold}r{/bold}             restart selected server",
  "  {bold}k{/bold}             kill the process listening for it",
  "  {bold}l{/bold}             show server output (logs)",
  "  {bold}f{/bold}             rescan projects (press twice; keeps edits)",
  "  {bold}R{/bold}             reload servers.yaml after editing it",
  "  {bold}c{/bold}             open in Chrome (starts it, waits for port)",
  "  {bold}o{/bold}             open project folder in file manager",
  "  {bold}v{/bold}             open project folder in VS Code",
  "  {bold}b{/bold}             open zsh in project folder (new terminal)",
  "  {bold}C{/bold}             start claude in project folder",
  "  {bold}/{/bold}             search (Enter keeps, Esc clears)",
  "  {bold}Esc{/bold}           clear the active filter",
  "  {bold}F1{/bold}            toggle this help screen",
  "  {bold}q{/bold} / {bold}Ctrl-C{/bold}    quit (servers keep running)",
  "",
  "  On a pair's group row actions apply to both be and fe;",
  "  on a be/fe row only to that one.",
  "",
  "  {green-fg}running{/green-fg}  started by servmon, listening",
  "  {yellow-fg}starting{/yellow-fg} started by servmon, not listening yet",
  "  {red-fg}{bold}crashed{/bold}{/red-fg}  process exited; press l for its output",
  "  {magenta-fg}{bold}ROGUE{/bold}{/magenta-fg}    running, but not started by servmon",
  "  {cyan-fg}busy{/cyan-fg}     its port is used by another project",
  "  Port '-' = not in config; shown once it runs",
  "",
  "  Press F1 or Esc to close",
];

const MESSAGE_MS = 6000;
const CONFIRM_MS = 3000;
const OPEN_WAIT_MS = 60000;
const STATUS_RANK = { crashed: 0, stopped: 1, busy: 2, rogue: 3, starting: 4, running: 5 };

// Table columns; `drop` = order in which they're hidden when the terminal is
// too narrow, `min` = how far they may be truncated after that.
const COLUMNS = [
  { key: "name", head: "Name", min: 14 },
  { key: "type", head: "Type", drop: 2 },
  { key: "status", head: "Status", min: 7 },
  { key: "port", head: "Port", min: 4 },
  { key: "pid", head: "PID", drop: 3 },
  { key: "uptime", head: "Uptime", drop: 1 },
  { key: "owner", head: "Port Owner", min: 10 },
];

export function runTui(scanRoot) {
  let servers = groupServers(loadRegistry(scanRoot), scanRoot);

  const screen = blessed.screen({ smartCSR: true, title: "servmon" });

  const header = blessed.box({
    top: 0, left: 0, width: "100%", height: 1,
    tags: true,
    style: { fg: "white", bg: "blue" },
  });

  const table = blessed.listtable({
    top: 1, left: 0, width: "100%", height: "100%-4",
    keys: true,
    mouse: true,
    align: "left",
    tags: true,
    // Keep status colours on the highlighted row (blessed resets its fg).
    invertSelected: false,
    style: {
      header: { bold: true, fg: "cyan" },
      cell: { selected: { bg: "blue" } },
      border: { fg: "gray" },
    },
    border: { type: "line" },
  });
  // ListTable re-lays out its old rows on resize and, whenever they don't fit
  // (which happens on every shrink, since blessed redraws before our resize
  // handler runs), permanently drops its width: the table turns shrink-sized
  // and columns vanish. Keep the width; render() re-fits the rows to it.
  const tableResize = table.listeners("resize").at(-1);
  table.removeListener("resize", tableResize);
  const calculateMaxes = table._calculateMaxes;
  table._calculateMaxes = function () {
    const width = this.position.width;
    const out = calculateMaxes.call(this);
    if (width != null && this.position.width == null) this.position.width = width;
    return out;
  };

  // Three lines: key bar, details of the selected row, status message.
  const footer = blessed.box({
    bottom: 0, left: 0, width: "100%", height: 3,
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
    top: "center", left: "center", width: 62, height: HELP_LINES.length + 2,
    hidden: true,
    tags: true,
    // Scrolls (Up/Down) when the terminal is shorter than the list.
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    border: { type: "line" },
    style: { border: { fg: "cyan" }, fg: "white", bg: "black" },
    content: HELP_LINES.join("\n"),
  });

  const logBox = blessed.box({
    top: 1, left: 0, width: "100%", height: "100%-4",
    hidden: true,
    tags: false,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: true,
    border: { type: "line" },
    scrollbar: { ch: " ", style: { bg: "gray" } },
    style: { border: { fg: "yellow" }, fg: "white", bg: "black" },
  });

  screen.append(header);
  screen.append(table);
  screen.append(footer);
  screen.append(searchLabel);
  screen.append(searchInput);
  screen.append(helpBox);
  screen.append(logBox);

  // server.name -> what memberInfo found (listeners, managed, dead, ...)
  const portInfoCache = new Map();
  let items = [];
  let lastSessions = null;
  let lastSnap = null;
  let query = "";
  let searching = false;
  // The 2s poll re-renders constantly; a message is kept until it expires
  // instead of being wiped by the next poll.
  let message = null;
  let messageUntil = 0;
  // Destructive actions that need a second press: { key, id, until }.
  let confirm = null;
  // `c` on a server that isn't listening yet: { member, until }.
  let pendingOpen = null;
  // The item whose output the log viewer shows.
  let logTarget = null;
  // Column widths only grow between resizes/filter changes, so the table
  // doesn't jitter as uptimes and PIDs change length.
  let stickyWidths = {};

  function setMessage(msg) {
    message = msg;
    messageUntil = Date.now() + MESSAGE_MS;
  }

  function needsConfirm(key, id, prompt) {
    const now = Date.now();
    if (confirm && confirm.key === key && confirm.id === id && now < confirm.until) {
      confirm = null;
      return false;
    }
    confirm = { key, id, until: now + CONFIRM_MS };
    setMessage(prompt);
    messageUntil = confirm.until; // the prompt goes away when it stops applying
    renderChrome();
    return true;
  }

  // ---- state -------------------------------------------------------------

  // The known project a process was started in: the one whose folder most
  // specifically contains its working directory.
  function ownerOf(cwd) {
    if (!cwd) return null;
    let best = null;
    for (const o of servers) {
      if ((cwd === o.dir || cwd.startsWith(o.dir + path.sep)) && (!best || o.dir.length > best.dir.length)) {
        best = o;
      }
    }
    return best;
  }

  function memberInfo(s, sessions, snap) {
    const session = sessions.get(tmux.sessionKey(s.name));
    const managed = Boolean(session); // servmon started this tmux session
    const dead = managed && session.dead;

    // Who a listener belongs to, judged by where the process was started:
    // "own" = this project's folder, "foreign" = another known project,
    // "unknown" = no readable cwd or outside every project.
    const ownerKind = (l) => {
      const o = ownerOf(l.cwd);
      if (!o) return "unknown";
      return o.dir === s.dir ? "own" : "foreign";
    };
    // Only a port from config (never a guess) can be "busy" or blamed on an
    // unknown process.
    const onPort = ports.listenersOnPort(snap, s.port);
    const foreignOnPort = onPort.filter((l) => ownerKind(l) === "foreign");
    const sameDir = servers.some((o) => o !== s && o.dir === s.dir && isWeb(o));

    let listeners = []; // this project's own server processes
    let unknown = []; // unknown processes on its configured port
    let statusKey;

    if (dead) {
      statusKey = "crashed";
    } else if (managed) {
      // The real process is a child of the session (often of a wrapper like
      // `npm run dev`) and may have bound another port than the configured
      // one (or there is none) — what it actually listens on is the truth.
      const tree = session.pid ? ports.listenersInTree(snap, session.pid) : [];
      const rank = (l) => (l.port === s.port ? 0 : ports.isEphemeralPort(l.port) ? 2 : 1);
      listeners = tree.sort((a, b) => rank(a) - rank(b));
      if (!listeners.length) listeners = onPort.filter((l) => ownerKind(l) === "own");
      statusKey = listeners.length ? "running" : "starting";
    } else {
      // Not started by servmon. A process started in this project's folder
      // is this project running outside servmon, on whatever port it bound.
      const own = snap.listeners.filter(
        (l) =>
          ownerKind(l) === "own" &&
          (!sameDir || procMatchesType(l, s.type)) &&
          (l.port === s.port || !ports.isEphemeralPort(l.port))
      );
      listeners = ports.uniqueListeners(own).sort((a, b) => (a.port === s.port ? -1 : b.port === s.port ? 1 : 0));
      unknown = onPort.filter((l) => ownerKind(l) === "unknown");
      if (listeners.length || unknown.length) statusKey = "rogue";
      else if (foreignOnPort.length) statusKey = "busy";
      else statusKey = "stopped";
    }

    const busyBy = statusKey === "busy" ? ownerOf(foreignOnPort[0].cwd) : null;
    const busyListeners = busyBy ? foreignOnPort : [];
    const live = [...listeners, ...unknown];
    const info = {
      statusKey,
      managed,
      dead,
      exitStatus: dead ? session.exitStatus : null,
      panePid: managed && !dead ? session.pid : null,
      created: managed && !dead ? session.created : null,
      listeners,
      unknown,
      busyBy,
      busyListeners,
      livePorts: uniq(live.map((l) => l.port)),
    };
    portInfoCache.set(s.name, info);
    return info;
  }

  // ---- table cells -------------------------------------------------------

  const cell = (t, color, bold) => ({ t: String(t), color, bold });
  const STATUS_CELL = {
    running: cell("running", "green"),
    starting: cell("starting", "yellow"),
    rogue: cell("ROGUE", "magenta", true),
    busy: cell("busy", "cyan"),
    stopped: cell("stopped", "red"),
  };
  function statusCell(info) {
    if (info.statusKey === "crashed") return cell(info.exitStatus === 0 ? "exited" : "crashed", "red", true);
    return STATUS_CELL[info.statusKey];
  }

  function memberCells(s, info) {
    let port = s.port ? String(s.port) : "-";
    if (info.livePorts.length) {
      port = info.livePorts.join(",");
      if (s.port && !info.livePorts.includes(s.port)) port += ` (cfg ${s.port})`;
    }
    const live = [...info.listeners, ...info.unknown];
    const pids = uniq(live.map((l) => l.pid));
    let owner = cell("-");
    if (info.statusKey === "crashed") {
      const code = info.exitStatus === null ? "" : ` ${info.exitStatus}`;
      owner = cell(`exit${code} · press l for output`, "red");
    } else if (live.length) {
      owner = cell(uniq(live.map(procLabel)).join(", "), info.managed ? "green" : "magenta", !info.managed && !info.listeners.length);
    } else if (info.busyBy) {
      owner = cell(`used by ${displayName(info.busyBy, scanRoot)}`, "cyan");
    }
    return {
      type: cell(s.type),
      status: statusCell(info),
      port: cell(port),
      pid: cell(pids.length ? pids.join(",") : info.panePid ? info.panePid : "-"),
      uptime: cell(info.created ? formatUptime(info.created) : "-"),
      owner,
    };
  }

  function itemCells(item, sessions, snap) {
    if (item.kind === "plain") return { name: cell(item.label, "gray") };
    if (item.kind === "group") {
      const infos = item.members.map((m) => memberInfo(m, sessions, snap));
      const worst = infos.reduce((a, b) => (STATUS_RANK[b.statusKey] < STATUS_RANK[a.statusKey] ? b : a));
      const upCount = infos.filter((i) => i.statusKey === "running").length;
      // One half up, the other simply stopped: say so instead of "stopped".
      const partial = upCount > 0 && worst.statusKey === "stopped";
      return {
        name: cell(item.label, null, true),
        type: cell(item.members.map((m) => m.type).join("/")),
        status: partial ? cell(`partial ${upCount}/${infos.length}`, "yellow") : statusCell(worst),
      };
    }
    const m = item.members[0];
    const cells = memberCells(m, memberInfo(m, sessions, snap));
    const name = item.kind === "member" ? `  ${item.last ? "└" : "├"} ${item.role} ${m.name}` : item.label;
    return { ...cells, name: cell(name) };
  }

  // Fits the columns into the table: drop the least useful ones first, then
  // truncate Port Owner and Name. ListTable needs sum(widths) + cols + 1 to
  // be no wider than the table.
  function layout(cellRows) {
    const natural = {};
    for (const c of COLUMNS) {
      natural[c.key] = Math.max(c.head.length, ...cellRows.map((r) => (r[c.key]?.t ?? "").length));
    }
    const sticky = {};
    for (const c of COLUMNS) sticky[c.key] = Math.max(natural[c.key], stickyWidths[c.key] ?? 0);
    // Remembered widths must never be the reason a column is hidden.
    let result = fitColumns(sticky);
    if (result.cols.length < COLUMNS.length) result = fitColumns(natural);
    stickyWidths = result.cols.length < COLUMNS.length ? natural : sticky;
    return result;
  }

  function fitColumns(natural) {
    let cols = [...COLUMNS];
    const widths = { ...natural };
    const total = () => cols.reduce((sum, c) => sum + widths[c.key], 0) + cols.length + 1;
    // One column of slack: blessed wraps a row that fills the line exactly
    // and ends in a non-space (a truncated cell), hiding its last word.
    const avail = table.width - 1;
    for (const c of [...COLUMNS].filter((c) => c.drop).sort((a, b) => a.drop - b.drop)) {
      if (total() <= avail) break;
      cols = cols.filter((x) => x !== c);
    }
    for (const key of ["owner", "name", "port", "status"]) {
      if (!cols.some((c) => c.key === key)) continue;
      const over = total() - avail;
      if (over <= 0) break;
      const min = COLUMNS.find((c) => c.key === key).min;
      widths[key] = Math.max(min, widths[key] - over);
    }
    return { cols, widths };
  }

  function renderCell(c, width) {
    if (!c) return "";
    const text = blessed.escape(truncate(c.t, width));
    if (!c.color) return c.bold ? `{bold}${text}{/bold}` : text;
    const tagged = `{${c.color}-fg}${text}{/${c.color}-fg}`;
    return c.bold ? `{bold}${tagged}{/bold}` : tagged;
  }

  function matchesQuery(g) {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [g.name, g.dir, ...g.members.map((m) => m.name)].some((t) => t.toLowerCase().includes(q));
  }

  // Builds the table from the last snapshot (no subprocesses), so filtering
  // and resizing are instant.
  function render() {
    if (!lastSnap) return;
    const prevId = selectedItem()?.id;
    // Every project, not just the filtered ones, so the header counts are complete.
    for (const s of servers.filter(isWeb)) memberInfo(s, lastSessions, lastSnap);
    items = buildItems(buildGroups(servers, scanRoot).filter(matchesQuery));
    let cellRows = items.map((it) => itemCells(it, lastSessions, lastSnap));
    if (!items.length) {
      const text = query ? `no projects match "${query}" — Esc clears the filter` : "no projects found — press f to rescan";
      cellRows = [{ name: cell(text, "gray") }];
    }
    const { cols, widths } = layout(cellRows);
    const head = cols.map((c) => c.head);
    const data = cellRows.map((r) => cols.map((c) => renderCell(r[c.key], widths[c.key])));
    table.setData([head, ...data]);
    const idx = items.findIndex((it) => it.id === prevId);
    table.select(idx >= 0 ? idx + 1 : 1);
    checkPendingOpen();
    if (!logBox.hidden) renderLogs();
    renderChrome();
    screen.render();
  }

  // Gathering state is async so keypresses never wait behind subprocesses;
  // only one gather runs at a time, and a request that arrives meanwhile
  // (e.g. right after an action) runs right after it.
  let refreshing = false;
  let pending = false;
  async function refresh(msg) {
    if (msg) setMessage(msg);
    if (refreshing) {
      pending = true;
      return;
    }
    refreshing = true;
    try {
      [lastSessions, lastSnap] = await Promise.all([tmux.snapshotSessions(), ports.snapshot()]);
      render();
    } finally {
      refreshing = false;
      if (pending) {
        pending = false;
        refresh();
      }
    }
  }

  function selectedItem() {
    const idx = table.selected - 1; // row 0 is header
    if (idx < 0 || idx >= items.length) return null;
    return items[idx];
  }

  // ---- header / footer ---------------------------------------------------

  function renderHeader() {
    const counts = { running: 0, starting: 0, crashed: 0, rogue: 0, busy: 0 };
    const web = servers.filter(isWeb);
    for (const s of web) {
      const k = portInfoCache.get(s.name)?.statusKey;
      if (k in counts) counts[k]++;
    }
    const parts = [
      counts.running && `{green-fg}${counts.running} running{/green-fg}`,
      counts.starting && `{yellow-fg}${counts.starting} starting{/yellow-fg}`,
      counts.crashed && `{red-fg}{bold}${counts.crashed} crashed{/bold}{/red-fg}`,
      counts.rogue && `{magenta-fg}{bold}${counts.rogue} ROGUE{/bold}{/magenta-fg}`,
      counts.busy && `{cyan-fg}${counts.busy} busy{/cyan-fg}`,
    ].filter(Boolean);
    const left = ` servmon — ${parts.length ? parts.join(" · ") : "nothing running"}`;
    const pos = items.length ? `${Math.max(1, table.selected)}/${items.length}${query ? " (filtered)" : ""} ` : "";
    const plainLen = blessed.stripTags(left).length;
    const width = screen.width;
    const gap = width - plainLen - pos.length;
    header.setContent(gap > 0 ? `${left}${" ".repeat(gap)}${pos}` : left);
  }

  function shortDir(dir) {
    const home = process.env.HOME;
    return home && dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir;
  }

  function detailLine() {
    const it = selectedItem();
    if (!it) return "";
    const parts = [shortDir(it.dir)];
    for (const m of it.members.filter(isWeb)) {
      const info = portInfoCache.get(m.name);
      const tag = it.kind === "group" ? `${classify(m)}: ` : "";
      let text = m.cmd || "no start command";
      const live = info ? [...info.listeners, ...info.unknown] : [];
      if (info?.dead) {
        const code = info.exitStatus === null ? "" : ` with code ${info.exitStatus}`;
        text += ` → exited${code} (l shows its output)`;
      }
      else if (live.length) {
        const l = live[0];
        const more = live.length > 1 ? ` +${live.length - 1} more` : "";
        const outside = info.listeners.length ? "" : " — not from this project";
        text += ` → ${l.cmdline || l.command} (pid ${l.pid}, :${l.port})${more}${outside}`;
      } else if (info?.busyBy) {
        const l = info.busyListeners[0];
        text += ` → port ${m.port} used by ${displayName(info.busyBy, scanRoot)}: ${l.cmdline || l.command} (pid ${l.pid})`;
      }
      parts.push(`${tag}${text}`);
    }
    return parts.join("  |  ");
  }

  function renderChrome() {
    renderHeader();
    const width = Math.max(10, screen.width - 1);
    const keys = [KEYS_LONG, KEYS_MID, KEYS_SHORT].find((k) => k.length <= width) ?? KEYS_SHORT;
    let status;
    if (message && Date.now() < messageUntil) status = ` ${message}`;
    else if (!logBox.hidden) status = " logs: ↑↓/PgUp/PgDn/g/G scroll, l or Esc closes";
    else if (query) status = ` filter: "${query}"  (Esc clears, / edits)`;
    else status = ` registry: ${shortDir(registryPath())}  (edit, then R to reload)`;
    footer.setContent(
      [truncate(keys, width), truncate(` ${detailLine()}`, width), truncate(status, width)].join("\n")
    );
  }

  function setStatusMsg(msg) {
    if (msg) setMessage(msg);
    renderChrome();
    screen.render();
  }

  // ---- overlays ----------------------------------------------------------

  function toggleHelp() {
    if (searching) return;
    helpBox.hidden = !helpBox.hidden;
    // Give the help box focus so keys don't reach the table (and start/kill
    // servers) behind it; screen-level keys (F1, Esc, q) still work.
    if (!helpBox.hidden) {
      const full = HELP_LINES.length + 2;
      helpBox.height = Math.min(full, screen.height - 2);
      helpBox.setLabel(helpBox.height < full ? " Keyboard commands (↑↓ scroll) " : " Keyboard commands ");
      helpBox.scrollTo(0);
      helpBox.setFront();
      helpBox.focus();
    } else {
      (logBox.hidden ? table : logBox).focus();
    }
    screen.render();
  }

  function renderLogs() {
    const atBottom = logBox.getScrollPerc() >= 100 || logBox.getScrollHeight() <= logBox.height;
    const sections = logTarget.members.map((m) => {
      const out = tmux.captureOutput(m);
      const head = logTarget.members.length > 1 ? `──── ${classify(m)}: ${m.name} ────\n` : "";
      return `${head}${out === null ? "(no servmon session — not started from servmon, or stopped)" : out || "(no output yet)"}`;
    });
    logBox.setContent(sections.join("\n\n"));
    if (atBottom) logBox.setScrollPerc(100);
  }

  function openLogs(it) {
    if (!it.members.some((m) => portInfoCache.get(m.name)?.managed)) {
      const rogue = it.members.some((m) => portInfoCache.get(m.name)?.statusKey === "rogue");
      setStatusMsg(
        rogue
          ? `${it.label} is running outside servmon, so its output isn't captured (s restarts it under servmon)`
          : `no output for ${it.label}: it isn't running in servmon (s starts it)`
      );
      return;
    }
    logTarget = it;
    logBox.setLabel(` output: ${it.label} `);
    logBox.show();
    logBox.setFront();
    logBox.focus();
    logBox.setContent("");
    renderLogs();
    logBox.setScrollPerc(100);
    renderChrome();
    screen.render();
  }

  function closeLogs() {
    logBox.hide();
    logTarget = null;
    table.focus();
    renderChrome();
    screen.render();
  }

  logBox.key(["l", "escape"], () => closeLogs());
  logBox.key(["pageup"], () => {
    logBox.scroll(-(logBox.height - 3));
    screen.render();
  });
  logBox.key(["pagedown"], () => {
    logBox.scroll(logBox.height - 3);
    screen.render();
  });
  logBox.key(["home"], () => {
    logBox.scrollTo(0);
    screen.render();
  });
  logBox.key(["end"], () => {
    logBox.setScrollPerc(100);
    screen.render();
  });

  // ---- actions -----------------------------------------------------------

  // Moving the selection changes the details line and position; keep in sync.
  table.on("select item", () => setStatusMsg());

  // Server actions only make sense for web projects; plain folders just get
  // the folder actions.
  function notWeb(it) {
    if (it.members.some(isWeb)) return false;
    refresh(`${it.label} is a plain folder, not a web project (o/v/b/C still work)`);
    return true;
  }

  const plural = (arr, one, many) => `${arr.length === 1 ? one : many} ${arr.join(", ")}`;
  const failMsg = (failed) => `error: ${failed.map((f) => `${f.m.name}: ${f.res.error}`).join("; ")}`;

  table.key(["s"], () => {
    const it = selectedItem();
    if (!it || notWeb(it)) return;
    const infos = it.members.map((m) => ({ m, info: portInfoCache.get(m.name) }));
    // Never kill a process that belongs to a different project just because
    // it sits on this one's port.
    const blocked = infos.find(({ info }) => info?.busyBy);
    if (blocked) {
      const { m, info } = blocked;
      refresh(
        `not started: port ${m.port} is used by ${displayName(info.busyBy, scanRoot)} (stop it, or k twice to kill)`
      );
      return;
    }
    // A process of unknown origin on the configured port is only killed on
    // purpose (it could be anything: a container, another checkout).
    const unknown = infos.flatMap(({ info }) => (info && !info.managed ? info.unknown : []));
    if (unknown.length) {
      const desc = uniq(unknown.map((l) => `${procLabel(l)} (pid ${l.pid}, :${l.port})`)).join(", ");
      if (needsConfirm("s", it.id, `${desc} is not from this project — press s again to kill it and start`)) return;
    }
    const killed = [];
    for (const { info } of infos) {
      if (!info || info.managed) continue;
      // This project is already running outside servmon — clear it first so
      // the new tmux session doesn't just fail to bind.
      for (const l of [...info.listeners, ...info.unknown]) {
        if (ports.killPid(l.pid).ok) killed.push(l.pid);
      }
    }
    // On a pair, a half that's already up is left alone.
    const up = it.members.filter((m) => tmux.isRunning(m));
    const todo = it.members.filter((m) => !up.includes(m));
    if (!todo.length) {
      refresh(`${it.label} is already running (r restarts)`);
      return;
    }
    const results = todo.map((m) => ({ m, res: tmux.startServer(m) }));
    const failed = results.filter((r) => !r.res.ok);
    const prefix = killed.length ? `killed rogue ${plural(uniq(killed), "pid", "pids")}, ` : "";
    const started = results.filter((r) => r.res.ok).map((r) => r.m.name);
    const note = up.length ? ` (${up.map((m) => m.name).join(", ")} already running)` : "";
    refresh(
      failed.length
        ? `${prefix}${failMsg(failed)}`
        : `${prefix}started ${it.kind === "group" ? started.join(", ") : it.label}${note} (l shows output)`
    );
  });

  table.key(["x"], () => {
    const it = selectedItem();
    if (!it || notWeb(it)) return;
    const results = it.members.map((m) => ({ m, res: tmux.stopServer(m) }));
    // On a pair, a half that wasn't running isn't an error.
    const failed = results.filter((r) => !r.res.ok && r.res.error !== "not running");
    const done = results.filter((r) => r.res.ok);
    const rogue = it.members.some((m) => portInfoCache.get(m.name)?.statusKey === "rogue");
    if (!done.length && !failed.length) {
      refresh(rogue ? `${it.label} wasn't started by servmon — k kills it` : `${it.label} isn't running`);
    } else if (failed.length) refresh(failMsg(failed));
    else if (results.every((r) => r.res.wasDead)) refresh(`cleared crashed session of ${it.label}`);
    else refresh(`stopped ${it.label}`);
  });

  table.key(["r"], () => {
    const it = selectedItem();
    if (!it || notWeb(it)) return;
    const results = it.members.map((m) => ({ m, res: tmux.restartServer(m) }));
    const failed = results.filter((r) => !r.res.ok);
    refresh(failed.length ? failMsg(failed) : `restarted ${it.label}`);
  });

  function reloadServers() {
    servers = groupServers(loadRegistry(scanRoot), scanRoot);
    portInfoCache.clear();
    stickyWidths = {};
  }

  table.key(["f"], () => {
    if (needsConfirm("f", "rescan", "press f again to rescan (keeps your edits to known projects, saves a .bak)")) return;
    const { added, removed } = generateRegistry(scanRoot);
    reloadServers();
    refresh(
      `rescanned: ${servers.filter(isWeb).length} web project(s), ${added} new, ${removed} removed; backup at ${shortDir(registryBackupPath())}`
    );
  });

  table.key(["R", "S-r"], () => {
    try {
      reloadServers();
      refresh(`reloaded ${shortDir(registryPath())}: ${servers.filter(isWeb).length} web project(s)`);
    } catch (err) {
      refresh(`couldn't read ${shortDir(registryPath())}: ${err.message.split("\n")[0]}`);
    }
  });

  table.key(["k"], () => {
    const it = selectedItem();
    if (!it || notWeb(it)) return;
    const infos = it.members.map((m) => ({ m, info: portInfoCache.get(m.name) })).filter(({ info }) => info);
    // Killing another project's server is allowed, but only on purpose.
    const foreign = infos.filter(({ info }) => info.busyListeners.length);
    if (foreign.length) {
      const names = uniq(foreign.map(({ info }) => displayName(info.busyBy, scanRoot))).join(", ");
      if (needsConfirm("k", it.id, `port is used by ${names} — press k again to kill it`)) return;
    }
    let killedAny = false;
    let cleared = false;
    const errors = [];
    for (const { m, info } of infos) {
      for (const l of [...info.listeners, ...info.unknown, ...info.busyListeners]) {
        const res = ports.killPid(l.pid);
        if (res.ok) killedAny = true;
        else errors.push(res.error);
      }
      // Our own session (crashed or not) goes too, so the row reads
      // "stopped" right away instead of lingering as "starting"/"crashed".
      if (info.managed) cleared = tmux.stopServer(m).ok || cleared;
    }
    if (errors.length) refresh(`error killing: ${errors[0]}`);
    else if (killedAny) refresh(`killed processes of ${it.label}`);
    else if (cleared) refresh(`stopped ${it.label} (nothing was listening)`);
    else refresh(`nothing is listening for ${it.label}`);
  });

  // The port to open in a browser, once the server listens: the configured
  // one if it's among the live ones, else the first port it really bound.
  function livePort(m) {
    const info = portInfoCache.get(m.name);
    if (!info?.livePorts.length) return null;
    return info.livePorts.includes(m.port) ? m.port : info.livePorts[0];
  }

  function openUrl(m, port) {
    openDetached("xdg-open", [`http://localhost:${port}`]);
    setMessage(`opened http://localhost:${port} (${m.name}) in browser`);
  }

  function checkPendingOpen() {
    if (!pendingOpen) return;
    const { member: m, until } = pendingOpen;
    const info = portInfoCache.get(m.name);
    const port = livePort(m);
    if (port) {
      pendingOpen = null;
      openUrl(m, port);
    } else if (info?.dead) {
      pendingOpen = null;
      setMessage(`${m.name} exited before listening — press l for its output`);
    } else if (Date.now() > until) {
      pendingOpen = null;
      setMessage(`${m.name} isn't listening after ${OPEN_WAIT_MS / 1000}s — press l for its output`);
    }
  }

  table.key(["c"], () => {
    const it = selectedItem();
    if (!it || notWeb(it)) return;
    const g = it.g;
    const m = it.kind === "member" ? it.members[0] : g.fe || g.solo || g.be;
    const port = livePort(m);
    if (port) {
      openUrl(m, port);
      refresh();
      return;
    }
    const info = portInfoCache.get(m.name);
    if (info?.busyBy) {
      refresh(`not started: port ${m.port} is used by ${displayName(info.busyBy, scanRoot)}`);
      return;
    }
    if (!tmux.isRunning(m)) {
      const res = tmux.startServer(m);
      if (!res.ok) {
        refresh(`error starting ${m.name}: ${res.error}`);
        return;
      }
    }
    pendingOpen = { member: m, until: Date.now() + OPEN_WAIT_MS };
    refresh(`starting ${m.name} — the browser opens once it's listening`);
  });

  table.key(["l"], () => {
    const it = selectedItem();
    if (!it || notWeb(it)) return;
    openLogs(it);
  });

  table.key(["o"], () => {
    const it = selectedItem();
    if (!it) return;
    openDetached("xdg-open", [it.dir]);
    refresh(`opened ${shortDir(it.dir)} in file manager`);
  });

  table.key(["C", "S-c"], () => {
    const it = selectedItem();
    if (!it) return;
    openDetached("gnome-terminal", ["--working-directory", it.dir, "--", "claude"]);
    refresh(`started claude in ${shortDir(it.dir)}`);
  });

  table.key(["b"], () => {
    const it = selectedItem();
    if (!it) return;
    openDetached("gnome-terminal", ["--working-directory", it.dir, "--", "zsh", "-i"]);
    refresh(`opened zsh in ${shortDir(it.dir)}`);
  });

  table.key(["v"], () => {
    const it = selectedItem();
    if (!it) return;
    openDetached("code", [it.dir]);
    refresh(`opened ${shortDir(it.dir)} in VS Code`);
  });

  // Paging; blessed's own vi mode would steal k (kill), so these are manual.
  function moveTo(row) {
    table.select(Math.min(Math.max(row, 1), Math.max(items.length, 1)));
    screen.render();
  }
  const pageSize = () => Math.max(1, table.height - 4);
  table.key(["home", "g"], () => moveTo(1));
  table.key(["end", "G", "S-g"], () => moveTo(items.length));
  table.key(["pageup"], () => moveTo(table.selected - pageSize()));
  table.key(["pagedown"], () => moveTo(table.selected + pageSize()));

  // ---- search ------------------------------------------------------------

  function setQuery(q) {
    query = q;
    stickyWidths = {};
    table.select(1);
    render();
  }

  function closeSearch() {
    searching = false;
    searchLabel.hide();
    searchInput.hide();
    table.focus();
    setQuery(query);
  }

  // The search box only starts reading keys a tick after it gets focus, so
  // characters typed in the same burst as "/" are caught here instead.
  let earlyKeys = "";
  searchInput.on("keypress", (ch, key) => {
    if (!searching || searchInput.__listener) return;
    if (ch && !key.ctrl && !key.meta && ch.length === 1 && ch >= " ") earlyKeys += ch;
  });

  table.key(["/"], () => {
    searching = true;
    earlyKeys = "";
    searchLabel.show();
    searchInput.show();
    searchInput.setValue(query);
    searchInput.focus();
    setImmediate(() => {
      if (searching && earlyKeys) {
        searchInput.setValue(searchInput.getValue() + earlyKeys);
        earlyKeys = "";
        setQuery(searchInput.getValue());
      }
    });
    screen.render();
  });

  table.key(["escape"], () => {
    if (query) setQuery("");
  });

  // Filter live as the user types; the value updates after the keypress lands.
  // Once the box has closed (Enter/Esc), its leftover value must not be read
  // back — on Esc that would undo the clear.
  searchInput.on("keypress", () => {
    setImmediate(() => {
      if (!searching || searchInput.getValue() === query) return;
      setQuery(searchInput.getValue());
    });
  });
  searchInput.key(["C-u"], () => searchInput.setValue(""));
  searchInput.on("submit", closeSearch);
  searchInput.on("cancel", () => {
    query = "";
    searchInput.setValue("");
    closeSearch();
  });

  // ---- global keys -------------------------------------------------------

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

  screen.on("resize", () => {
    stickyWidths = {};
    if (!helpBox.hidden) helpBox.height = Math.min(HELP_LINES.length + 2, screen.height - 2);
    // Element positions settle after the resize event.
    setImmediate(render);
  });

  table.focus();
  refresh();
  setInterval(() => refresh(), 2000);
  screen.render();
}
