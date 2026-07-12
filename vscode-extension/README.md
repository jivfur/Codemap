# Codemap VS Code Extension Scaffold

This folder contains the initial scaffold for a VS Code extension that bridges to the existing `graph.py` CLI.

## Commands

- `Codemap: Index Workspace` runs `python3 graph.py index` in the workspace root.
- `Codemap: Search Symbol` runs `python3 graph.py search <term>` and shows results in a quick pick.
- `Codemap: Show Symbol Body` runs `python3 graph.py body <symbol>` and opens output in a preview editor.

## Local Development

From this folder:

```bash
npm test
```

The test suite validates command wiring and CLI bridge behavior.
