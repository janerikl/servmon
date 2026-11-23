# Plan: usability scan #2 fixes (2026-11-23)

Decisions: ports detected only (no guesses); in-TUI log viewer + keep crashed sessions;
FE/BE pairs as group row + member rows; rescan merges + `R` reloads from disk.

## Critical
- [x] #1 `s` never kills an unknown-owner process without a 2nd press (own-folder rogues still auto-cleared)
- [x] #2 No port guessing: drop framework defaults, Rails 3000 and sequential guesses; old `portDetected: false`
      ports ignored on load; port learned from the running process; `c` starts if needed and opens once listening

## High
- [x] #3 remain-on-exit sessions -> "crashed"/"exited" status with exit code; `l` scrollable in-TUI log viewer
      (live, sticks to bottom); `s`/`r`/`x` clear dead sessions
- [x] #4 Columns fitted to width (drop Uptime, Type, PID in that order, then truncate Owner/Name); own resize
      handling (listtable drops its width when content overflows)
- [x] #5 Pairs: group row + indented be/fe member rows (actions on member row = that member only);
      single Port column; readable process labels from cmdline (vite, next-server, puma, rails); every listener port shown

## Medium
- [x] #6 Detail line: busy -> "port N used by <project>", crashed -> exit code + `l` hint, member row -> only that member
- [x] #7 Rescan merges (keeps name/cmd/port of known folders, keeps hand-added entries whose dir exists, reports
      added/removed); `R` reloads servers.yaml
- [x] #8 Unique registry names (duplicates -> path relative to scan root); "/" sanitized in session keys
- [x] #9 PID column = listening process (what `k` kills); pane pid only while starting

## Low
- [x] #10 Keys typed in the same burst as `/` go into the search box
- [x] #11 Help box shows a scroll hint when clipped; help/README updated for l, R, crashed, no "?"
- [x] #12 Stable column widths (sticky until resize/filter change); selected row keeps status colours if possible
- [x] #13 Header summary (running/starting/crashed/ROGUE/busy counts) + row position
- [x] #14 Skip cache folders (`*_cache`, `*-cache`, `__pycache__`) in the plain folder list

## Verify
- [x] Sandbox walkthrough (fake HOME + isolated tmux) at 120x20 and 80x24; real data read-only at 160x40 and 80x24

## Found while fixing
- [x] ListTable also dropped its width on every terminal shrink (blessed redraws old rows before the resize
      handler) -> width kept across overflow
- [x] Rows that exactly fill the line and end in a truncated cell wrapped, hiding the last word -> 1 col slack
- [x] Selected row lost status colours (blessed invertSelected) -> disabled
- [x] tmux fills pane_dead_status a moment after death; trim() also ate the last empty field (NaN) -> "exited"
      without code until known
- [x] `s`/`x` on a half-running pair errored -> act only on the half that needs it; group shows "partial 1/2"
- [x] Same-folder Rails + Node entries claimed each other's processes once guessed ports were gone -> matched by runtime

---

# Plan: usability-test fixes (2026-11-23)

Findings from a hands-on walkthrough against ~/Development (67 projects, 160x40 and 80x24).

## Critical
- [x] #1 Attribute port listeners to projects by process cwd (/proc/<pid>/cwd, longest dir match).
      Port held by another known project -> status "busy", owner "busy: <project>"; `s` refuses, `k` needs a 2nd press.
      Own process running outside servmon (any non-ephemeral port) -> ROGUE with actual port. Unknown owner -> ROGUE as before.
- [x] #2 Sanitize tmux session names (tmux rewrites "." and ":" to "_") consistently in tmux.js + tui lookups
- [x] #3 Ignore table actions while help is open

## High
- [x] #4 Esc in search clears the filter (blessed keeps value on cancel; deferred keypress re-read it)
- [x] #5 Status messages stay ~6s instead of being wiped by the 2s poll
- [x] #6 Footer: compact key bar that fits the width; status line always visible
- [x] #7 Help box sized to its content (no wrapping/clipping)
- [x] #8 Docs: README `f` (not `R`), add `C`, new keys; header "servmon"
- [x] #9 bin: --help/-h usage, error on missing scan root; `f` needs a 2nd press and backs up servers.yaml.bak

## Medium
- [x] #10 Home/End/g/G/PgUp/PgDn navigation
- [x] #11 Web projects first, plain folders below, dimmed with blank cells
- [x] #12 Drop Dir column; footer detail line for selection (dir, cmd, full process cmdline)
- [x] #13 Nested solo projects shown by path relative to scan root (valueinvestor/app)
- [x] #14 Empty-state row for no search matches; Esc on table clears filter; Ctrl-U clears search input
- [x] #15 Skip `*-wt-*` plain folders (real git worktrees stay listed)

## Verify
- [x] Re-run walkthrough in isolated tmux (safe keys only), 160x40 and 80x24

## Found while fixing
- [x] tmux list formats split on " ", breaking session names with spaces ("x (backend)") -> tab separator
- [x] Claude Code/editor helpers listening on ephemeral ports in a project folder were credited as that project's server -> ignore ephemeral range
- [x] Help box scrolls when the terminal is shorter than the list
