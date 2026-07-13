# Codemap VS Code Extension Scaffold

This folder contains the initial scaffold for a VS Code extension that bridges to the existing `graph.py` CLI.

## Commands

- `Codemap: Index Workspace` runs `python3 graph.py index` in the workspace root.
- `Codemap: Search Symbol` reads the SQLite index directly and shows results in a quick pick.
- `Codemap: Show Symbol Body` resolves symbol location from SQLite and opens the extracted body in a preview editor.
- `Codemap Neighbors` view in Explorer shows symbols for the active file and expandable caller/callee groups.
- `Repo Graph: Find Symbol` runs an interactive symbol search and jumps to the selected result.
- `Repo Graph: Show Impact` renders a structured reverse-dependency report for a symbol.
- `Repo Graph: Reindex Workspace` runs a changed-only index refresh from the command palette.
- `Repo Graph: Open Impact Webview` opens a lightweight SVG impact graph with clickable nodes.
- `Repo Graph: Open Repo Overview` opens a bounded repository-wide overview slice for the top-ranked symbols.
- Repo Overview prompts for symbol kind and top-N size so you can tune breadth before rendering.
- Repo Overview also prompts for edge scope (`resolved` or `all`) to balance confidence vs exploration.
- Repo Overview now supports edge types (`calls` or `calls+inherits`) to include class hierarchy relationships in overview graphs.
- Repo Overview includes ranking balance controls (`inbound`, `balanced`, `outbound`) to prioritize hub style in top-symbol selection.
- Re-running impact webview commands reuses the same panel and refreshes its graph.
- The webview supports max-depth filtering to focus exploration on near callers first.
- The graph supports pan/zoom and node dragging for denser impact maps.

## On-Save Reindex

- Saving supported source files (`.py`, `.js`, `.jsx`, `.ts`, `.tsx`) triggers a debounced background `index --changed-only` run.
- Reindex notifications are surfaced as lightweight status bar messages.
- Non-supported files are ignored to avoid unnecessary indexing work.

## Sidebar TreeView

- The tree refreshes when the active editor changes.
- Clicking a resolved symbol opens the source file and reveals the symbol range.
- Use `Codemap: Refresh Neighbors` to force a manual refresh.

## CodeLens Caller Counts

- Functions and methods in supported files show a `Called from N places` CodeLens.
- Clicking the lens opens the impact webview centered on that symbol.
- Clicking a node in the webview jumps to its source location.

## SQLite Read Bridge

- Read commands use `sqlite3` against `index.db` in the workspace root.
- Queries are restricted to read-only `SELECT`/`WITH` statements.
- Missing or corrupt index files surface explicit user-facing errors.

## Local Development

From this folder:

```bash
npm test
```

The test suite validates command wiring and CLI bridge behavior.
