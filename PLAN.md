# Plan: show all projects, ports/URLs only for web projects

- [x] Decisions: every top-level folder under scan root is a project; non-web projects get folder actions only (o/v/C)
- [x] registry.js: add non-web entries (type "other", no cmd/port) for top-level folders containing no web project
- [x] tui.js: render non-web rows with "-" for status/ports/owner; guard s/x/r/k/c with "not a web project" message
- [x] README: mention non-web projects
- [x] Verify by rescanning and rendering
