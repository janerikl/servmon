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

- `scan-root` — directory to scan for projects (default: `~/Development`)

On first run, servmon scans `scan-root` for Node (`package.json`) and Rails (`Gemfile`) projects up to 2 directories deep, guesses a start command and port for each, and writes the result to a registry file at `~/.config/servmon/servers.yaml`. You can hand-edit this file, or press `R` in the TUI to rescan.

### Keyboard commands

| Key | Action |
| --- | --- |
| `Up` / `Down` | Move selection |
| `s` | Start selected server |
| `x` | Stop selected server |
| `r` | Restart selected server |
| `R` | Rescan projects, refresh registry |
| `k` | Kill the process occupying the selected port |
| `c` | Open project URL (`http://localhost:<port>`) in Chrome (requires a detected port) |
| `o` | Open project folder in the file manager |
| `v` | Open project folder in VS Code |
| `F1` | Toggle help screen |
| `q` / `Ctrl-C` | Quit |

A port shown with a `?` suffix means it was guessed rather than detected from config.

### Status colors

- **running** (green) — servmon started the session and something is listening on its port
- **starting** (yellow) — servmon started the session, but nothing is listening yet
- **ROGUE** (magenta) — something is listening on the port that servmon didn't start; it will block the next `s`
- **stopped** (red) — no session, nothing listening

## How it works

- **Discovery**: walks `scan-root`, skipping `node_modules`, `.git`, `vendor`, `tmp`, `log`, `coverage`, `dist`, `build`, `.bundle`, `public`, dotfiles, and `*.worktrees` directories.
- **Command guessing**: uses `npm run dev`/`npm start` (or the equivalent for `pnpm`/`yarn`) for Node projects, `bin/rails s` for Rails projects.
- **Port detection**: checks `.env`/`.env.local`/`.env.development`, the guessed start command, `config/puma.rb` (Rails), common source files (Node), and falls back to framework defaults (Next.js, Vite, CRA) or a sequential guess.
- **Process management**: each server runs in its own tmux session so it survives the TUI closing; sessions are named with a `servermon-` prefix.

## License

Unlicensed / private project.
