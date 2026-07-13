# Codemap VS Code Extension

Codemap helps you explore a repository as a graph of symbols and relationships directly in VS Code.

It is built for two workflows:

1. Human-first navigation (find symbols, inspect impact, open graph views).
2. AI-assisted navigation (have an assistant ask Codemap-focused questions and work from graph results instead of scanning entire files).

## What You Get

- Command palette actions for indexing, search, impact analysis, and repository overview graphs.
- A `Codemap Neighbors` explorer tree for the active file's symbols and their callers/callees.
- Impact and overview webviews with pan/zoom/drag and clickable nodes.
- On-save incremental reindex for supported source files.

## Prerequisites

- VS Code 1.90+
- Python 3 available in your shell as `python3`
- A workspace folder open in VS Code (single-root is recommended)
- `graph.py` and `index.db` expected at the workspace root

## Install

If you already have a VSIX build:

1. Open VS Code.
2. Open Extensions view.
3. Click `...` (top-right in Extensions).
4. Choose `Install from VSIX...`.
5. Select the extension VSIX file.

## Quick Start

1. Run `Codemap: Index Workspace`.
2. Open `Repo Graph: Find Symbol` and search for a target symbol.
3. Run `Repo Graph: Show Impact` to see reverse dependencies as a table.
4. Run `Repo Graph: Open Impact Webview` for an interactive graph.
5. Run `Repo Graph: Open Repo Overview` to get a repo-wide top-symbol map.

## Command Guide

- `Codemap: Index Workspace`
	- Full index of the workspace.
- `Repo Graph: Reindex Workspace`
	- Incremental reindex (`index --changed-only`).
- `Codemap: Search Symbol`
	- Search symbols from SQLite and jump to source.
- `Repo Graph: Find Symbol`
	- Similar to search, tuned for repo-graph workflows.
- `Codemap: Show Symbol Body`
	- Opens extracted symbol body in a preview editor.
- `Repo Graph: Show Impact`
	- Markdown report of callers by depth.
- `Repo Graph: Open Impact Webview`
	- Interactive graph for one symbol.
- `Repo Graph: Open Repo Overview`
	- Interactive top-N repository overview with tunable ranking and filtering.
- `Codemap: Refresh Neighbors`
	- Refreshes the `Codemap Neighbors` side view.

## Repo Overview Options (What They Mean)

When you run `Repo Graph: Open Repo Overview`, Codemap asks a sequence of prompts:

- Symbol kind: `all`, `function`, `method`, `class`
- Edge scope: `resolved` only or `all` (includes unresolved)
- Edge types: `calls` or `calls+inherits`
- Ranking balance: `inbound`, `balanced`, `outbound`
- Label mode: `qualified` or `short-kind`
- Node size mode: `degree` or `fixed`
- Fixed node size value (when fixed mode is selected)
- Min/max node sizes (for degree mode)
- Max label length
- Minimum degree, inbound calls, outbound calls filters
- Top-N limit
- Depth buckets

These controls let you tune the graph for signal density and readability.

## Sidebar + CodeLens

- `Codemap Neighbors` (Explorer view):
	- Updates with active editor changes.
	- Lets you expand symbol relationships quickly.
- Caller CodeLens:
	- Supported languages: Python, JavaScript, TypeScript.
	- Shows `Called from N places` above functions/methods.
	- Click to open graph context for that symbol.

## On-Save Reindex

Saving these file types triggers debounced background reindex:

- `.py`
- `.js`
- `.jsx`
- `.ts`
- `.tsx`

Codemap surfaces lightweight status updates in the status bar.

## How To Tell An AI To Use Codemap

Use direct, command-oriented prompts. Ask the AI to start from Codemap graph queries before raw file scanning.

### Prompt Template

Copy/paste and fill in values:

```text
Use the Codemap extension for this task.

Goal: <your goal>
Starting symbol(s): <symbol names>

Do this workflow:
1) Run "Repo Graph: Find Symbol" for each starting symbol.
2) Run "Repo Graph: Show Impact" and summarize the highest-impact callers.
3) Open "Repo Graph: Open Impact Webview" and identify 3 key hubs and 3 leaf nodes.
4) If needed, run "Repo Graph: Open Repo Overview" with:
	 - kind: all
	 - edge scope: resolved
	 - edge types: calls+inherits
	 - rank balance: inbound
	 - top N: 40
5) Only then open source files for the top relevant symbols.
6) Return:
	 - symbols examined
	 - dependency findings
	 - proposed change points
	 - risk notes
```

### Example: Change Impact Analysis

```text
Use Codemap first. I need impact analysis for symbol "payments.charge_customer".
Run "Repo Graph: Show Impact" and "Repo Graph: Open Impact Webview".
Summarize direct callers vs transitive callers, then list the first files I should modify.
```

### Example: Refactor Planning

```text
Use Codemap commands to plan a safe refactor of "AuthService".
Start with "Repo Graph: Find Symbol", then "Repo Graph: Open Repo Overview".
Identify central dependencies, suggest refactor order, and call out breakage risk.
```

### Good AI Instruction Patterns

- "Use Codemap before searching file text."
- "Show me graph evidence for each recommendation."
- "List symbols and caller depth used to reach your conclusion."
- "Limit code reads to files linked from Codemap results."

## Troubleshooting

- "Open a workspace folder first"
	- Open the project root in VS Code.
- "Symbol not found"
	- Run `Codemap: Index Workspace` (or reindex), then retry.
- SQLite/index errors
	- Confirm `index.db` exists at workspace root and is up to date.
- No on-save updates
	- Confirm file extension is in the supported list above.

## Development

From this folder:

```bash
npm test
```

The test suite validates command wiring and SQLite bridge behavior.
