# Repo Graph Indexer — Design Spec

## Goal

Turn a codebase into a queryable index (symbols + relationships) stored in
SQLite, so an LLM (or a human) can find and reason about relevant code
without loading the whole repo into context. Read structure first, pull in
actual source lines only for the handful of symbols that matter.

Product requirements and delivery status are tracked in `docs/prd.md`.

## Deterministic vs AI-assisted

The graph itself is built entirely with **deterministic static analysis** —
tree-sitter parsing, name/import-based resolution, PageRank. No LLM calls
in the core pipeline. This is a deliberate choice:

- **Reproducibility**: the same repo state always produces the same graph.
  No hallucinated edges or invented symbols.
- **Speed/cost**: parsing thousands of files with tree-sitter takes
  seconds; running each one through an LLM would be far slower and cost
  real money per index run.
- **Trustworthiness**: `impact` queries are used to judge what a change
  might break — that has to reflect actual call resolution, not a model's
  guess at what "looks related."

AI is an optional *layer on top*, never a replacement for the graph:
- Better `doc_summary` for undocumented functions (fallback when there's
  no docstring to extract).
- Semantic/embedding-based search alongside the deterministic name search
  — e.g. `search --semantic "code that handles retries"` matching even
  when the word "retry" never appears.
- Natural-language explanation of a retrieved subgraph.

The nodes and edges — what calls what, what imports what — stay
deterministic. That's the part that has to be trustworthy.

## Why not JSON / a graph file

A flat JSON blob or `.graphml` file has to be loaded in full to query it —
that defeats the purpose. SQLite lets a small CLI run targeted queries
(`WHERE`, `JOIN`) and return just a few rows. It's also trivially
incremental: update rows for one file without touching the rest.

## 1. Parse layer — tree-sitter

Tree-sitter gives multi-language parsing without executing code, and has
mature grammars for Python, JS/TS, Go, Rust, Java, C/C++, Ruby, etc.
Use `tree-sitter-languages` (Python bindings) to avoid compiling grammars
per-language by hand.

Per file:
1. Detect language from extension (map is explicit and overridable).
2. Parse to AST.
3. Walk the tree with a small per-language query file (`.scm` queries,
   tree-sitter's native query format) that extracts:
   - function/method definitions (name, params, return type if typed, line range)
   - class/struct/interface definitions (name, line range, base classes)
   - imports/requires (module, imported names)
   - call expressions (caller context, callee name)
   - leading docstring/comment for each definition

This means adding a language = adding one `.scm` query file, not new parsing
code. Start with Python, JS/TS, Go — cover most repos; add more on demand.

## 2. Graph schema

Two node types, four edge types, kept deliberately simple:

**Nodes**
- `file`: path, language, hash, loc
- `symbol`: id, file_id, kind (function/class/method/const), name,
  qualified_name (e.g. `module.Class.method`), signature, docstring_summary
  (first line only), start_line, end_line

**Edges**
- `defines` (file → symbol)
- `imports` (file → file, or file → external module name if unresolved)
- `calls` (symbol → symbol, best-effort resolved; unresolved calls kept
  with a `resolved=0` flag and just the callee name)
- `inherits` (symbol → symbol, for class hierarchies)

Deliberately no attempt at full type inference or cross-language resolution
— best-effort static matching by name + import scope. Good enough for
navigation; not a compiler.

## 3. Storage — SQLite

```sql
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE,
  language TEXT,
  content_hash TEXT,
  loc INTEGER
);

CREATE TABLE symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER REFERENCES files(id),
  kind TEXT,              -- function | method | class | const
  name TEXT,
  qualified_name TEXT,
  signature TEXT,
  doc_summary TEXT,
  start_line INTEGER,
  end_line INTEGER
);

CREATE TABLE edges (
  id INTEGER PRIMARY KEY,
  src_id INTEGER,          -- symbol.id or file.id
  src_type TEXT,           -- 'file' | 'symbol'
  dst_id INTEGER,
  dst_type TEXT,
  dst_name TEXT,           -- fallback label if unresolved
  edge_type TEXT,          -- defines | imports | calls | inherits
  resolved INTEGER DEFAULT 1
);

CREATE INDEX idx_symbols_name ON symbols(name);
CREATE INDEX idx_edges_src ON edges(src_id, edge_type);
CREATE INDEX idx_edges_dst ON edges(dst_id, edge_type);
```

Bodies are **not** stored in the DB — only line ranges. Source stays the
single source of truth; the DB is just an index pointing back into it.

## 4. CLI interface

A small `graph.py` (or `graph` binary) wrapping the DB:

| Command | Purpose |
|---|---|
| `index [--changed-only]` | Build/update the index. Hash each file; skip unchanged. |
| `show <file>` | List symbols in a file with signatures — no bodies. |
| `search <term>` | Fuzzy match over names + doc summaries. |
| `neighbors <symbol>` | Direct callers and callees. |
| `impact <symbol>` | Full reverse-dependency closure (who breaks if this changes). |
| `path <A> <B>` | Shortest dependency path between two symbols, if any. |
| `body <symbol>` | Only now read the actual source lines for that range. |
| `rank [--top N]` | PageRank over the call graph — most "central" symbols. |

Typical usage pattern for a change request:
1. `search` / `show` to locate the relevant area.
2. `impact` on the symbol being changed, to see blast radius.
3. `body` on just the 2–4 symbols actually needed.
4. Make the edit directly in the source file.
5. `index --changed-only` to refresh just that file's rows.

This keeps context spend proportional to the change, not the repo size.

## 5. Ranking for large repos

When even the graph is too big to reason about all at once (e.g. "where
should this new feature go?"), run PageRank over the `calls` edge graph.
High-rank symbols are structurally central (heavily called / hub modules) —
this is the same trick aider's repo-map uses to decide what to surface
first. Combine with a text-similarity score against the user's request to
rank candidate entry points.

## 6. Incremental updates

The update cycle, end to end:

1. A file is edited on disk.
2. `index` runs and compares each file's current hash to the stored one.
3. Unchanged files are skipped entirely — no reparsing, no DB writes.
4. Changed files are reparsed with tree-sitter; their `symbols` and
   `edges` rows are deleted and re-inserted.
5. Any *other* file that imports the changed file gets its cross-file
   `calls`/`imports` edges re-resolved too (a renamed function could
   break their edges even though their own source didn't change).
6. Index is now current; unchanged files never touched.

This makes re-indexing a huge repo after a one-file edit nearly instant —
cost scales with what changed, not with repo size.

**Ways to trigger it:**
- **Manual**: run `index` before starting a task — cheap enough to do
  every time.
- **Git hook**: `post-commit` / `post-checkout` keeps the index from
  drifting off the working tree automatically.
- **Watch mode**: a filesystem watcher (e.g. Python's `watchdog`) re-indexes
  a file the moment it's saved, for a live-updating index during active
  development. This is what the VS Code extension (below) uses.

**Staleness caveat**: the index reflects *last indexed state*, not the
literal filesystem at every instant. If a symbol is renamed and `index`
hasn't run yet, `impact` queries against the old name will be stale.
Fine as long as indexing stays cheap and habitual — but worth knowing
the graph is a snapshot, not a live view, between runs.

## 7. Tech stack

- Python 3 + `tree-sitter` + `tree-sitter-languages`
- Standard library `sqlite3` (no external DB dependency)
- Optional: `networkx` just for the PageRank step (build the graph
  in-memory from the `edges` table on demand, don't persist it)

## 8. Suggested repo layout

```
repo-graph/
  graph.py              # CLI entrypoint
  indexer/
    parser.py           # tree-sitter setup + per-language query loading
    queries/
      python.scm
      javascript.scm
      go.scm
    schema.sql
    resolve.py           # best-effort cross-file symbol resolution
    rank.py              # PageRank helper
  index.db               # generated, gitignored
```

## 9. VS Code extension

VS Code has good native primitives for surfacing this graph directly in
the editor, no separate app needed.

Implementation status (as of 2026-07-12):
- Implemented: Sidebar TreeView, Command Palette flows, on-save changed-only
  reindex, CodeLens caller counts, impact webview, and SQLite-backed read
  queries.
- Implemented: CodeLens to impact-webview flow, single webview panel reuse,
  SVG graph rendering, and max-depth filtering in the webview.
- Not yet implemented: a full force-directed graph library (the current
  implementation uses deterministic, dependency-free SVG rendering).

**UI surfaces:**
- **Webview panel** — the main interactive graph view. Render a subgraph
  centered on the current file/symbol; click a node to jump straight to
  that file and line; filter by max impact depth.
- **Sidebar TreeView** — a lighter always-visible panel: symbols in the
  current file plus their direct callers/callees, similar to VS Code's
  built-in Outline view but backed by the graph instead of just the AST
  of the open file.
- **Inline CodeLens** — a "Called from 12 places" annotation above each
  function definition; clicking opens the impact view for that symbol.
- **Command palette** — `Repo Graph: Show Impact`, `Repo Graph: Find
  Symbol`, `Repo Graph: Reindex Workspace`.

**Backend:**
- The extension shells out to the same indexer (Python subprocess, or a
  TypeScript port of the tree-sitter query layer using
  `tree-sitter` npm bindings — VS Code already ships tree-sitter grammars
  internally for syntax highlighting, so a TS port avoids a Python
  dependency for end users).
- Queries hit the SQLite file directly (e.g. via `better-sqlite3` in
  Node) — no server process, near-instant reads.

**Live sync:**
- Hook `workspace.onDidSaveTextDocument` to re-run `index --changed-only`
  on just the saved file in the background, so the sidebar/CodeLens
  never drifts far from the current state (same staleness caveat as
  above — bounded by save frequency, not by walltime).

**Likely best combo**: CodeLens for the at-a-glance signal ("12 callers")
plus the webview for deliberate exploration when you click through — no
need to keep a graph panel open at all times.

Current repository-level extension status includes a bounded repo overview mode
with symbol kind, top-N size, edge scope, edge-type controls, configurable
fixed node size, and node-size-mode-aware prompts. The next increment makes the
multi-step overview prompt flow cancel-safe so `Esc` aborts cleanly without
opening a graph with defaulted values. The following increment adds git-aware
changed-only reindexing so index freshness tracks checked-out commit changes. The next increment adds cached
git snapshot restore so clean branch switches can reuse an index snapshot keyed
by commit SHA instead of rebuilding every time.
The next increment adds a manual command-palette git update check to trigger an
immediate reindex after explicit git workflows.
The next increment after that prunes older snapshots to keep the cache bounded.

## Known limitations (by design, not oversights)

- Call resolution is name/import based, not type-checked — dynamic
  dispatch, reflection, and duck typing will produce some unresolved or
  wrong edges. That's fine for navigation; flag `resolved=0` edges so
  consumers know to double check.
- No macro/codegen expansion (e.g. Rust macros, decorators that rewrite
  behavior) — those symbols appear as-authored, not as-expanded.
- Multi-language repos: cross-language calls (e.g. Python calling into a
  Rust extension via FFI) won't be linked automatically; would need a
  manual edge or a naming convention to bridge them.
