# Codemap PR Roadmap

This document tracks the implementation plan as a sequence of small, reviewable pull requests.

How to use this file:
- Update Status as work progresses.
- Keep PRs focused and independently stable.
- Link merged PRs in the Notes column.

## Status Legend

- Planned
- In Progress
- Blocked
- Merged

## PR Plan

| Order | PR Title | Branch Name | Status | Scope | Required Tests | Merge Criteria | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Neighbors and Impact Commands | feat/neighbors-impact-cli | Merged | Add `neighbors <symbol>` and `impact <symbol>` commands using SQLite graph traversal. Add query helpers for direct callers/callees and reverse dependency closure. | Unit tests for direct neighbors and impact closure on fixture graph. | All tests pass. CLI output is deterministic. No regressions in `index`, `show`, `search`, `body`. | [PR #2](https://github.com/jivfur/Codemap/pull/2) |
| 2 | Dependency Path Command | feat/dependency-path-cli | Merged | Add `path <A> <B>` command for shortest dependency path between symbols. | Unit tests for path found and no-path cases. | All tests pass. Command handles unresolved edges safely. | [PR #3](https://github.com/jivfur/Codemap/pull/3) |
| 3 | Ranking Command | feat/pagerank-command | Merged | Add `rank [--top N]` command over call graph. Use optional `networkx` if available. | Unit tests with fixture graph to validate stable ordering. | All tests pass. Command degrades gracefully if ranking dependency is absent. | [PR #4](https://github.com/jivfur/Codemap/pull/4) |
| 4 | Python Tree-sitter Parser | feat/python-tree-sitter-parser | Merged | Replace Python AST-based extraction with tree-sitter query-based extraction. Add query file for Python under `indexer/queries/`. | Unit tests for symbol, import, call extraction parity with current behavior. | All tests pass. Index output remains deterministic for fixture repo. | [PR #5](https://github.com/jivfur/Codemap/pull/5) |
| 5 | JavaScript and TypeScript Parsing | feat/js-ts-parser-support | Merged | Add JS/TS language detection and tree-sitter queries. Include symbols/imports/calls extraction for JS/TS files. | Unit tests using JS and TS fixture files for indexing and command queries. | All tests pass. Mixed-language indexing works without breaking Python behavior. | [PR #6](https://github.com/jivfur/Codemap/pull/6) |
| 6 | Incremental Dependent Re-resolution | feat/incremental-reresolution | Merged | Improve `index --changed-only` to re-resolve impacted cross-file edges in importers of changed files. | Unit tests proving importer edges are refreshed when a dependency changes. | All tests pass. Changed-only flow updates related edges correctly. | [PR #7](https://github.com/jivfur/Codemap/pull/7) |
| 7 | Inheritance Edges | feat/inherits-edges | Merged | Add extraction and storage of `inherits` edges for class hierarchies. | Unit tests for single and multi-level inheritance mapping. | All tests pass. Existing commands continue to behave correctly. | [PR #8](https://github.com/jivfur/Codemap/pull/8) |
| 8 | Test and CI Baseline | chore/test-ci-baseline | Merged | Add test runner config, baseline fixtures, and CI workflow to run tests on PRs. | CI runs full suite on push and PR. | CI green on default branch. Local instructions documented. | [PR #9](https://github.com/jivfur/Codemap/pull/9) |
| 9 | VS Code Extension Scaffold | feat/vscode-extension-scaffold | Merged | Scaffold extension package with commands and basic integration points to query SQLite index. | Unit tests for extension command wiring where practical. | Extension activates, commands execute, and index query bridge is functional. | [PR #10](https://github.com/jivfur/Codemap/pull/10) |
| 10 | VS Code SQLite Query Bridge | feat/vscode-sqlite-query-bridge | Merged | Add a direct SQLite adapter in the extension (with safe read-only query helpers) as an alternative to shelling out for read paths. | Unit tests for query helpers and error handling when DB is missing/corrupt. | Extension commands can read graph data without relying on CLI text parsing. | [PR #13](https://github.com/jivfur/Codemap/pull/13) |
| 11 | Sidebar TreeView (Symbols + Neighbors) | feat/vscode-treeview-neighbors | Merged | Add a contributed TreeView showing current-file symbols and direct callers/callees for selected symbol. | Unit tests for provider mapping and refresh behavior on selection changes. | TreeView renders stable items and opens source locations correctly. | [PR #14](https://github.com/jivfur/Codemap/pull/14) |
| 12 | Command Palette UX Completion | feat/vscode-command-ux | Merged | Add `Repo Graph: Show Impact`, `Repo Graph: Find Symbol`, and `Repo Graph: Reindex Workspace` with structured outputs and improved quick-pick flows. | Unit tests for command handlers and argument prompts. | Commands run end-to-end and handle empty/error states cleanly. | [PR #15](https://github.com/jivfur/Codemap/pull/15) |
| 13 | On-Save Changed-Only Reindex | feat/vscode-onsave-reindex | Merged | Hook `workspace.onDidSaveTextDocument` to trigger background `index --changed-only` refresh and lightweight status notifications. | Unit tests for save event filtering/debouncing and invocation arguments. | Reindex triggers only for supported files and does not block editor UX. | [PR #16](https://github.com/jivfur/Codemap/pull/16) |
| 14 | CodeLens Caller Counts | feat/vscode-codelens-callers | Merged | Add CodeLens annotations (`Called from N places`) above function/method symbols backed by graph queries. | Unit tests for lens provider counts and command payloads. | CodeLens appears deterministically and navigates to callers list. | [PR #17](https://github.com/jivfur/Codemap/pull/17) |
| 15 | Impact Webview MVP | feat/vscode-impact-webview | Merged | Add a simple webview subgraph explorer centered on a symbol impact query (nodes + edges + click-to-open). | Unit tests for webview message contracts and command plumbing. | Webview launches from command and renders consistent impact graph data. | [PR #18](https://github.com/jivfur/Codemap/pull/18) |
| 16 | CodeLens to Impact Webview Flow | feat/vscode-codelens-impact-webview | Merged | Route CodeLens click actions to open the impact webview directly for the selected symbol, preserving click-to-open navigation from the webview. | Unit tests for CodeLens command payloads and openImpactWebview symbol-argument plumbing. | Clicking a CodeLens opens the webview for that symbol without extra prompt friction. | [PR #19](https://github.com/jivfur/Codemap/pull/19) |
| 17 | Reuse Impact Webview Panel | feat/vscode-impact-webview-reuse | In Progress | Reuse a single impact webview panel across repeated command invocations, refreshing title and payload instead of creating duplicates. | Unit tests for panel lifecycle (create once, reveal on reuse, recreate after dispose). | Re-running impact view commands updates one existing panel and preserves open-symbol behavior. | Branch started |

## Suggested Working Rules Per PR

- One branch per PR.
- Prefer one feature per commit when practical.
- Include unit tests in the same PR as the feature.
- Leave the repository in a stable state.
- Merge only when all tests pass.

## Next PR to Start

- PR 17: Reuse Impact Webview Panel
- Branch: feat/vscode-impact-webview-reuse
