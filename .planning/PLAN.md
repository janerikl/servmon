# Plan: New keyboard shortcuts

## Goal
Add three TUI keyboard shortcuts to `lib/tui.js`:
- `c` — open `http://localhost:<port>` in Chrome via `xdg-open`. Only works if `s.portDetected` is true; otherwise show footer error ("port not detected for <name>").
- `o` — open the selected project's `s.dir` in the system file manager via `xdg-open`.
- `v` — open the selected project's `s.dir` in VS Code via `code <dir>`.

All three spawn detached, non-blocking child processes (don't hang the TUI).

## Steps
- [ ] Add `table.key(["c"], ...)`, `table.key(["o"], ...)`, `table.key(["v"], ...)` handlers in `lib/tui.js`
- [ ] Update footer status line and `helpBox` content to list new shortcuts
- [ ] Update README.md keyboard commands table
- [ ] Manual verification: run `servmon`, select a row with a detected port, press `c`/`o`/`v`, confirm Chrome/file manager/VS Code launch; press `c` on a row with a guessed/undetected port and confirm footer error

## Verification
Manual: launch servmon in a terminal, exercise all three keys as above.
