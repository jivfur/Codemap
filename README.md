# Codemap

Codemap is a deterministic repo graph indexer that turns source code into a queryable SQLite graph of files, symbols, and relationships.

The goal is to help engineers and LLM-based tools navigate large codebases with precision: inspect structure first, then load only the source lines needed for a task.

## What it builds

- File nodes: path, language, hash, and LOC
- Symbol nodes: function/class/method metadata and line ranges
- Relationship edges: defines, imports, calls, and inherits

## Why this exists

- Reproducible indexing: same code state, same graph
- Low-cost navigation: targeted SQL queries instead of loading entire repos
- Safe impact analysis: dependency-aware workflows for changes

## Status

This repository currently contains the first CLI scaffold and Python-based indexing core. The full roadmap is in [docs/repo-graph-spec.md](docs/repo-graph-spec.md).

## Testing

- Run the test suite locally with:

```bash
python3 -m unittest discover -s tests -v
```

- CI runs the same command for every pull request and on pushes to `main`.

## VS Code Extension Scaffold

- The initial extension scaffold is in `vscode-extension/`.
- It provides command wiring and a bridge that executes `graph.py` commands from VS Code.
