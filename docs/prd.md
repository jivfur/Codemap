# Codemap Product Requirements Document (PRD)

## 1. Product Goal

Codemap helps developers and coding agents understand and safely modify large codebases by building a deterministic, queryable code graph and surfacing it through CLI and VS Code workflows.

## 2. Problem Statement

Developers and AI coding tools often need to answer questions like:
- Where is this symbol defined?
- What breaks if I change this function?
- How do I navigate callers/callees without loading the full repo?

Traditional full-text search is noisy, and loading whole repositories into context is slow and expensive.

## 3. Target Users

- Individual developers working in medium-to-large repos
- Teams that need fast impact analysis during refactors
- AI-assisted coding workflows that need deterministic retrieval before edits

## 4. Product Scope

### 4.1 In Scope

- Deterministic static indexing into SQLite
- Graph queries over symbols/files/edges
- Multi-language parsing support (Python and JS/TS baseline)
- VS Code extension for in-editor graph exploration
- Incremental indexing and changed-only refresh workflows

### 4.2 Out of Scope (Current)

- Full type-checked semantic analysis
- Runtime tracing/profiling integration
- Cross-language call resolution guarantees
- LLM-generated graph edges

## 5. Functional Requirements

### 5.1 Indexing and Queries

- Build and update index via CLI.
- Support deterministic queries: search, show, neighbors, impact, path, body, rank.
- Preserve unresolved edge visibility for transparency.

### 5.2 VS Code Extension

- Command palette flows for find/impact/reindex.
- Sidebar TreeView for symbols + direct neighbors.
- CodeLens caller counts over callable symbols.
- Impact webview with clickable navigation to symbol locations.
- On-save changed-only reindex with lightweight notifications.

### 5.3 Impact Webview UX

- Open from command palette and CodeLens.
- Reuse a single panel instead of spawning duplicates.
- Render graph visually (SVG-based).
- Provide max-depth filtering to reduce visual noise.

### 5.4 Repo-Wide Overview UX

- Open a repository-wide graph overview from the command palette.
- Summarize the repo as a bounded slice of the call graph instead of a single-symbol impact closure.
- Reuse the same visual language and navigation interactions as the impact webview.
- Support focus controls so users can narrow the overview to top-ranked symbols.

## 6. Non-Functional Requirements

- Deterministic outputs for the same repo state.
- Fast local query performance (SQLite, no server process).
- Incremental updates should scale with changed files.
- Safe failure behavior for missing/corrupt index.

## 7. Delivery Plan Status (As Implemented)

Completed PR sequence through PR #27:
- CLI graph query capabilities and incremental indexing improvements
- Core test/CI baseline
- VS Code extension scaffold + SQLite read bridge
- TreeView, command UX, on-save reindex, CodeLens caller counts
- Impact webview evolution:
  - PR #18: MVP impact webview
  - PR #19: CodeLens-to-webview flow
  - PR #20: panel reuse
  - PR #21: SVG graph rendering
  - PR #22: depth filtering
  - PR #24: force-layout interactions
  - PR #25: repository overview mode
  - PR #26: repository overview kind/top-N controls
  - PR #27: repository overview edge scope controls

Current candidate feature:
- Repository overview edge type controls (calls-only vs calls+inherits) to include hierarchy context in bounded overviews.

See `docs/pr-roadmap.md` for detailed PR-by-PR history and links.

## 8. Success Criteria

- Developers can find symbols and dependencies quickly from CLI or VS Code.
- Impact analysis is usable for refactor safety checks.
- Extension UX supports iterative exploration without context overload.
- Test suite remains green for backend and extension changes.

## 9. Risks and Constraints

- Static name/import resolution can miss dynamic behavior.
- Cross-language relationships are partial.
- Graph freshness depends on indexing cadence (manual or on-save).

## 10. Next Planning Rule

No new implementation PR should start until a new roadmap item is explicitly added to `docs/pr-roadmap.md` and linked back to this PRD scope.
