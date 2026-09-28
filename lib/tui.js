import blessed from "blessed";
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

export function runTui(scanRoot) {
  let servers = loadRegistry();

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

  const helpBox = blessed.box({
    top: "center", left: "center", width: 50, height: 17,
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
      "  {bold}R{/bold}          rescan projects, refresh registry\n" +
      "  {bold}k{/bold}          kill process occupying selected port\n" +
      "  {bold}c{/bold}          open project URL in Chrome\n" +
      "  {bold}o{/bold}          open project folder in file manager\n" +
      "  {bold}v{/bold}          open project folder in VS Code\n" +
      "  {bold}F1{/bold}         toggle this help screen\n" +
      "  {bold}q{/bold} / {bold}Ctrl-C{/bold}  quit\n" +
      "\n" +
      "  Port with {bold}?{/bold} suffix = guessed, not detected\n" +
      "  Press F1 or Esc to close",
  });

  screen.append(header);
  screen.append(table);
  screen.append(footer);
  screen.append(helpBox);

  function setStatusMsg(msg) {
    footer.setContent(
      " [s] start  [x] stop  [r] restart  [k] kill port  [c] chrome  [o] folder  [v] vscode  [R] rescan  [F1] help  [q] quit\n" +
      (msg ? ` ${msg}` : ` registry: ${registryPath()}`)
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

  function rows() {
    const sessions = tmux.listSessions();
    const head = ["Name", "Type", "Status", "Port", "PID", "Uptime", "Port Owner", "Dir"];
    const data = servers.map((s) => {
      const managed = sessions.has(s.name); // servermon started this tmux session
      const pid = managed ? tmux.getPanePid(s) : null;
      const created = managed ? sessions.get(s.name).created : null;
      const listeners = ports.getPortListeners(s.port);
      const listening = listeners.length > 0;
      portInfoCache.set(s.name, { listeners, managed });

      // A port held while servermon has no managed session for it means a
      // leftover/rogue process owns it and will block the next `s` (start).
      const rogue = !managed && listening;

      let status;
      if (managed && listening) status = "{green-fg}running{/green-fg}";
      else if (managed && !listening) status = "{yellow-fg}starting{/yellow-fg}";
      else if (rogue) status = "{magenta-fg}{bold}ROGUE{/bold}{/magenta-fg}";
      else status = "{red-fg}stopped{/red-fg}";

      let portOwner = "-";
      if (listening) {
        const label = listeners.map((l) => `${l.command}(${l.pid})`).join(", ");
        portOwner = rogue ? `{magenta-fg}{bold}${label}{/bold}{/magenta-fg}` : `{green-fg}${label}{/green-fg}`;
      }

      const portLabel = s.port ? `${s.port}${s.portDetected ? "" : "?"}` : "-";

      return [
        s.name,
        s.type,
        status,
        portLabel,
        pid ? String(pid) : "-",
        managed ? formatUptime(created) : "-",
        portOwner,
        s.dir,
      ];
    });
    return [head, ...data];
  }

  function refresh(msg) {
    const selected = table.selected;
    table.setData(rows());
    table.select(Math.min(selected || 0, Math.max(servers.length, 1)));
    setStatusMsg(msg);
    screen.render();
  }

  function selectedServer() {
    const idx = table.selected - 1; // row 0 is header
    if (idx < 0 || idx >= servers.length) return null;
    return servers[idx];
  }

  table.key(["s"], () => {
    const s = selectedServer();
    if (!s) return;
    const res = tmux.startServer(s);
    refresh(res.ok ? `started ${s.name}` : `error: ${res.error}`);
  });

  table.key(["x"], () => {
    const s = selectedServer();
    if (!s) return;
    const res = tmux.stopServer(s);
    refresh(res.ok ? `stopped ${s.name}` : `error: ${res.error}`);
  });

  table.key(["r"], () => {
    const s = selectedServer();
    if (!s) return;
    const res = tmux.restartServer(s);
    refresh(res.ok ? `restarted ${s.name}` : `error: ${res.error}`);
  });

  table.key(["R"], () => {
    servers = generateRegistry(scanRoot);
    refresh(`rescanned ${scanRoot}, found ${servers.length} project(s)`);
  });

  table.key(["k"], () => {
    const s = selectedServer();
    if (!s) return;
    const info = portInfoCache.get(s.name);
    if (!info || info.listeners.length === 0) {
      refresh(`nothing is listening on port ${s.port}`);
      return;
    }
    const results = info.listeners.map((l) => ports.killPid(l.pid));
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      refresh(`error killing pid on port ${s.port}: ${failed[0].error}`);
    } else {
      refresh(`killed ${info.listeners.map((l) => l.pid).join(", ")} on port ${s.port}`);
    }
  });

  table.key(["c"], () => {
    const s = selectedServer();
    if (!s) return;
    if (!s.port || !s.portDetected) {
      refresh(`port not detected for ${s.name}`);
      return;
    }
    openDetached("xdg-open", [`http://localhost:${s.port}`]);
    refresh(`opened http://localhost:${s.port} in browser`);
  });

  table.key(["o"], () => {
    const s = selectedServer();
    if (!s) return;
    openDetached("xdg-open", [s.dir]);
    refresh(`opened ${s.dir} in file manager`);
  });

  table.key(["v"], () => {
    const s = selectedServer();
    if (!s) return;
    openDetached("code", [s.dir]);
    refresh(`opened ${s.dir} in VS Code`);
  });

  table.key(["q", "C-c"], () => process.exit(0));
  screen.key(["q", "C-c"], () => process.exit(0));

  screen.key(["f1"], () => toggleHelp());
  screen.key(["escape"], () => {
    if (!helpBox.hidden) toggleHelp();
  });

  table.focus();
  refresh();
  setInterval(() => refresh(), 2000);
  screen.render();
}
