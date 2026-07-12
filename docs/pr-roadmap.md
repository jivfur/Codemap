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
| 5 | JavaScript and TypeScript Parsing | feat/js-ts-parser-support | In Progress | Add JS/TS language detection and tree-sitter queries. Include symbols/imports/calls extraction for JS/TS files. | Unit tests using JS and TS fixture files for indexing and command queries. | All tests pass. Mixed-language indexing works without breaking Python behavior. | Branch started |
| 6 | Incremental Dependent Re-resolution | feat/incremental-reresolution | Planned | Improve `index --changed-only` to re-resolve impacted cross-file edges in importers of changed files. | Unit tests proving importer edges are refreshed when a dependency changes. | All tests pass. Changed-only flow updates related edges correctly. | |
| 7 | Inheritance Edges | feat/inherits-edges | Planned | Add extraction and storage of `inherits` edges for class hierarchies. | Unit tests for single and multi-level inheritance mapping. | All tests pass. Existing commands continue to behave correctly. | |
| 8 | Test and CI Baseline | chore/test-ci-baseline | Planned | Add test runner config, baseline fixtures, and CI workflow to run tests on PRs. | CI runs full suite on push and PR. | CI green on default branch. Local instructions documented. | |
| 9 | VS Code Extension Scaffold | feat/vscode-extension-scaffold | Planned | Scaffold extension package with commands and basic integration points to query SQLite index. | Unit tests for extension command wiring where practical. | Extension activates, commands execute, and index query bridge is functional. | |

## Suggested Working Rules Per PR

- One branch per PR.
- Prefer one feature per commit when practical.
- Include unit tests in the same PR as the feature.
- Leave the repository in a stable state.
- Merge only when all tests pass.

## Next PR to Start

- PR 5: JavaScript and TypeScript Parsing
- Branch: feat/js-ts-parser-support
