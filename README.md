# servmon

A terminal UI to discover, monitor, and control local Node/Rails dev servers running in tmux.

`servmon` scans a directory tree for Node.js and Rails projects, guesses each project's start command and port, and gives you a live table to start, stop, restart, or kill whatever's running on those ports — all backed by tmux sessions so servers keep running after you close the TUI.

## Requirements

- Node.js
- [tmux](https://github.com/tmux/tmux) on `PATH` (`sudo apt install tmux`)

## Install

```sh
npm install
npm link
```

This makes the `servmon` command available globally.

## Usage

```sh
servmon [scan-root]
```

- `scan-root` — directory to scan for projects (default: `~/Development`); must exist
- `servmon --help` — print usage

On first run, servmon scans `scan-root` for Node (`package.json`) and Rails (`Gemfile`) projects up to 2 directories deep. Every other top-level folder is also listed below the web projects, without ports or server controls; `*-wt-*` scratch copies and cache folders (`*_cache`, `*-cache`, `__pycache__`) are skipped. For each project it picks a start command and reads the port from config, and it writes the result to a registry file at `~/.config/servmon/servers.yaml`.

You can hand-edit this file and press `R` to reload it. Pressing `f` twice rescans: projects already in the file keep their name, `cmd` and `port`, new ones are added, entries whose folder is gone are dropped, and hand-added entries whose folder still exists are kept. The previous file is saved as `servers.yaml.bak`.

Ports are never guessed. If no port is found in config, the Port column shows `-` until the server runs, and then shows the port it actually listens on. A `port:` you set by hand is used as is. Ports that older versions guessed (stored with `portDetected: false`) are ignored.

Project names must be unique, since they double as tmux session names. If two projects have the same folder name (e.g. two `client` folders), the newer one is named by its path relative to the scan root (`Analytics/client`).

A backend/frontend pair is shown as a group row with a `be` row and a `fe` row under it. Actions on the group row apply to both; actions on a `be`/`fe` row apply only to that one.

### Keyboard commands

| Key | Action |
| --- | --- |
| `Up` / `Down` | Move selection |
| `PgUp` / `PgDn` | Move one page |
| `Home` / `g`, `End` / `G` | First / last row |
| `s` | Start selected server (asks for a second press before killing a process of unknown origin on its port) |
| `x` | Stop selected server, or clear a crashed one |
| `r` | Restart selected server |
| `k` | Kill the process listening for the selected server (press twice if it belongs to another project) |
| `l` | Show the server's output (scrollable; `l`/`Esc` closes) |
| `f` | Rescan projects, merging with the registry (press twice to confirm) |
| `R` | Reload `servers.yaml` after editing it |
| `c` | Open `http://localhost:<port>` in the browser; starts the server first if needed and opens once it listens |
| `o` | Open project folder in the file manager |
| `v` | Open project folder in VS Code |
| `b` | Open a zsh terminal (loads ~/.zshrc) in the project folder |
| `C` | Start Claude Code in the project folder (new terminal) |
| `/` | Search projects by name or path (Enter keeps the filter, Esc clears it) |
| `Esc` | Clear the active filter |
| `F1` | Toggle help screen |
| `q` / `Ctrl-C` | Quit (servers keep running) |

The header counts running, starting, crashed, ROGUE and busy servers and shows the selected row's position. The footer shows the selected project's folder, start command and the full command line of whatever is listening for it (or, for a busy port, which project holds it). Port shows every port the server really listens on, plus `(cfg N)` when that differs from the configured port. PID is the listening process (what `k` kills). Columns are hidden (Uptime, then Type, then PID) or truncated when the terminal is narrow.

### Status colors

- **running** (green) — servmon started the session and something is listening on its port
- **starting** (yellow) — servmon started the session, but nothing is listening yet
- **crashed** / **exited** (red) — the server's process exited; its output is kept, so press `l` to see why, and `s`/`r` to start it again (`x` clears it)
- **partial** (yellow, group rows) — one half of a pair is running, the other is stopped
- **ROGUE** (magenta) — the project is running, but not from a servmon session (a process started in its folder, or an unknown process on its configured port); `s` replaces it with a managed one, asking first when the process isn't from this project's folder
- **busy** (cyan) — the port is held by a process from *another* project; `s` refuses to start, and the Port Owner column names that project
- **stopped** (red) — no session, nothing listening

## How it works

- **Discovery**: walks `scan-root`, skipping `node_modules`, `.git`, `vendor`, `tmp`, `log`, `coverage`, `dist`, `build`, `.bundle`, `public`, dotfiles, and `*.worktrees` directories.
- **Command guessing**: uses `npm run dev`/`npm start` (or the equivalent for `pnpm`/`yarn`) for Node projects, `bin/rails s` for Rails projects.
- **Port detection**: checks `.env`/`.env.local`/`.env.development`, the start command, `config/puma.rb` (Rails) and common source files (Node). Nothing else is guessed; otherwise the port is read from the running process.
- **Process ownership**: each listening process is credited to the project whose folder contains its working directory (`/proc/<pid>/cwd`), so a server on a shared or guessed port is shown under the project that actually runs it.
- **Process management**: each server runs in its own tmux session so it survives the TUI closing. Sessions are named with a `servermon-` prefix (`.`, `:` and `/` in names become `_`, as tmux requires) and use `remain-on-exit`, so a crashed server's output and exit code stay available to `l`.

## License

Unlicensed / private project.
