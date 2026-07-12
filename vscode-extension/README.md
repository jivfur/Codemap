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

## Sidebar TreeView

- The tree refreshes when the active editor changes.
- Clicking a resolved symbol opens the source file and reveals the symbol range.
- Use `Codemap: Refresh Neighbors` to force a manual refresh.

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
