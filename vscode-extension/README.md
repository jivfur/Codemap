# Codemap VS Code Extension Scaffold

This folder contains the initial scaffold for a VS Code extension that bridges to the existing `graph.py` CLI.

## Commands

- `Codemap: Index Workspace` runs `python3 graph.py index` in the workspace root.
- `Codemap: Search Symbol` reads the SQLite index directly and shows results in a quick pick.
- `Codemap: Show Symbol Body` resolves symbol location from SQLite and opens the extracted body in a preview editor.

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
