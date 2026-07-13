const path = require("node:path");
const { runGraphCommand } = require("./bridge");
const {
  SqliteBridgeError,
  findSymbolLocation,
  getImpactForSymbol,
  getNeighborsForSymbol,
  getRepoOverviewGraph,
  listSymbolsForFile,
  loadSymbolBody,
  searchSymbols,
} = require("./sqliteBridge");
const { createCallerCodeLensProvider } = require("./codelens");
const { buildImpactGraphData, openImpactWebviewPanel } = require("./impactWebview");
const { createCodemapTreeProvider } = require("./treeView");

const SUPPORTED_EXTENSIONS = new Set([".py", ".js", ".jsx", ".ts", ".tsx"]);

function getWorkspaceRoot(vscodeApi) {
  const folders = vscodeApi.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return null;
  }
  return folders[0].uri.fsPath;
}

function register(disposables, disposable) {
  disposables.push(disposable);
}

function sqliteErrorMessage(error, context) {
  if (error instanceof SqliteBridgeError) {
    return `Codemap ${context} failed: ${error.message}`;
  }
  return `Codemap ${context} failed: ${error.message}`;
}

function formatImpactMarkdown(result) {
  const lines = [`# Impact for ${result.target}`];
  if (!Array.isArray(result.impacted) || result.impacted.length === 0) {
    lines.push("No callers found.");
    return lines;
  }
  lines.push("| Depth | Symbol | Resolution |");
  lines.push("|---|---|---|");
  for (const row of result.impacted) {
    lines.push(`| ${row.depth} | ${row.symbol} | ${row.resolved ? "resolved" : "unresolved"} |`);
  }
  return lines;
}

function isSupportedSavedDocument(workspaceRoot, document) {
  if (!workspaceRoot || !document?.uri?.fsPath) {
    return false;
  }

  const fsPath = String(document.uri.fsPath);
  const relPath = path.relative(workspaceRoot, fsPath);
  if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
    return false;
  }

  const ext = path.extname(fsPath).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

function activateWithApi(vscodeApi, context, deps = {}) {
  const runCommand = deps.runGraphCommand || runGraphCommand;
  const searchWithSqlite = deps.searchSymbols || searchSymbols;
  const loadBodyWithSqlite = deps.loadSymbolBody || loadSymbolBody;
  const findLocationWithSqlite = deps.findSymbolLocation || findSymbolLocation;
  const impactWithSqlite = deps.getImpactForSymbol || getImpactForSymbol;
  const repoOverviewWithSqlite = deps.getRepoOverviewGraph || getRepoOverviewGraph;
  const listSymbols = deps.listSymbolsForFile || listSymbolsForFile;
  const getNeighbors = deps.getNeighborsForSymbol || getNeighborsForSymbol;
  const schedule = deps.schedule || ((fn, delayMs) => setTimeout(fn, delayMs));
  const cancelSchedule = deps.cancelSchedule || ((handle) => clearTimeout(handle));
  const saveDebounceMs = Number(deps.saveDebounceMs || 500);
  const pendingSaveReindex = new Map();

  async function openSymbolLocationByName(symbol) {
    const currentRoot = getWorkspaceRoot(vscodeApi);
    if (!currentRoot) {
      vscodeApi.window.showWarningMessage("Codemap: open a workspace folder first.");
      return;
    }
    if (!symbol) {
      return;
    }

    const location = await findLocationWithSqlite(currentRoot, symbol);
    if (!location) {
      vscodeApi.window.showInformationMessage("Symbol not found.");
      return;
    }

    const uri = vscodeApi.Uri.file(path.join(currentRoot, location.path));
    const document = await vscodeApi.workspace.openTextDocument(uri);
    const editor = await vscodeApi.window.showTextDocument(document, {
      preview: true,
    });

    const startLine = Math.max(0, Number(location.start || 1) - 1);
    const endLine = Math.max(startLine, Number(location.end || location.start || 1) - 1);
    const startPos = new vscodeApi.Position(startLine, 0);
    const endPos = new vscodeApi.Position(endLine, Number.MAX_SAFE_INTEGER);
    const range = new vscodeApi.Range(startPos, endPos);
    editor.selection = new vscodeApi.Selection(startPos, startPos);
    editor.revealRange(range, vscodeApi.TextEditorRevealType.InCenter);
  }

  async function runFindSymbolFlow(queryTitle, queryPrompt) {
    const currentRoot = getWorkspaceRoot(vscodeApi);
    if (!currentRoot) {
      vscodeApi.window.showWarningMessage("Codemap: open a workspace folder first.");
      return;
    }

    const query = await vscodeApi.window.showInputBox({
      title: queryTitle,
      prompt: queryPrompt,
      ignoreFocusOut: true,
    });

    if (!query) {
      return;
    }

    const rows = await searchWithSqlite(currentRoot, query);
    if (rows.length === 0) {
      vscodeApi.window.showInformationMessage("No symbol matches.");
      return;
    }

    const selection = await vscodeApi.window.showQuickPick(
      rows.map((row) => ({
        label: `${row.qualifiedName} (${row.path})`,
        description: row.kind,
        symbol: row.qualifiedName,
      })),
      { title: "Codemap Results" }
    );

    if (selection?.symbol) {
      await openSymbolLocationByName(selection.symbol);
    }
  }

  const root = getWorkspaceRoot(vscodeApi);
  if (root) {
    const provider = createCodemapTreeProvider(vscodeApi, root, {
      listSymbolsForFile: listSymbols,
      getNeighborsForSymbol: getNeighbors,
    });
    const treeView = vscodeApi.window.createTreeView("codemap.neighborsView", {
      treeDataProvider: provider,
      showCollapseAll: true,
    });
    register(context.subscriptions, treeView);
    register(
      context.subscriptions,
      vscodeApi.window.onDidChangeActiveTextEditor(() => {
        provider.refresh();
      })
    );
    register(
      context.subscriptions,
      vscodeApi.commands.registerCommand("codemap.refreshNeighbors", () => {
        provider.refresh();
      })
    );

    register(
      context.subscriptions,
      vscodeApi.workspace.onDidSaveTextDocument((document) => {
        if (!isSupportedSavedDocument(root, document)) {
          return;
        }

        const filePath = String(document.uri.fsPath);
        const existing = pendingSaveReindex.get(filePath);
        if (existing) {
          cancelSchedule(existing);
        }

        const handle = schedule(async () => {
          pendingSaveReindex.delete(filePath);
          try {
            const result = await runCommand(root, ["index", "--changed-only"]);
            const message = result.lines[0] || "Codemap on-save reindex complete.";
            if (typeof vscodeApi.window.setStatusBarMessage === "function") {
              vscodeApi.window.setStatusBarMessage(message, 2500);
            }
          } catch (error) {
            vscodeApi.window.showWarningMessage(`Codemap on-save reindex failed: ${error.message}`);
          }
        }, saveDebounceMs);

        pendingSaveReindex.set(filePath, handle);
      })
    );

    const codeLensProvider = createCallerCodeLensProvider(vscodeApi, root, {
      listSymbolsForFile: listSymbols,
      getNeighborsForSymbol: getNeighbors,
    });
    register(
      context.subscriptions,
      vscodeApi.languages.registerCodeLensProvider(
        [
          { language: "python", scheme: "file" },
          { language: "javascript", scheme: "file" },
          { language: "typescript", scheme: "file" },
        ],
        codeLensProvider
      )
    );
  }

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.indexWorkspace", async () => {
      const currentRoot = getWorkspaceRoot(vscodeApi);
      if (!currentRoot) {
        vscodeApi.window.showWarningMessage("Codemap: open a workspace folder first.");
        return;
      }

      try {
        const result = await runCommand(currentRoot, ["index"]);
        const message = result.lines[0] || "Codemap index updated.";
        vscodeApi.window.showInformationMessage(message);
      } catch (error) {
        vscodeApi.window.showErrorMessage(`Codemap index failed: ${error.message}`);
      }
    })
  );

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.searchSymbol", async () => {
      try {
        await runFindSymbolFlow("Codemap Search", "Enter symbol or text to search in index");
      } catch (error) {
        vscodeApi.window.showErrorMessage(sqliteErrorMessage(error, "search"));
      }
    })
  );

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.findSymbol", async () => {
      try {
        await runFindSymbolFlow("Repo Graph: Find Symbol", "Search by name, qualified name, or docs");
      } catch (error) {
        vscodeApi.window.showErrorMessage(sqliteErrorMessage(error, "find symbol"));
      }
    })
  );

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.showSymbolBody", async () => {
      const currentRoot = getWorkspaceRoot(vscodeApi);
      if (!currentRoot) {
        vscodeApi.window.showWarningMessage("Codemap: open a workspace folder first.");
        return;
      }

      const symbol = await vscodeApi.window.showInputBox({
        title: "Codemap Body",
        prompt: "Enter qualified or short symbol name",
        ignoreFocusOut: true,
      });

      if (!symbol) {
        return;
      }

      try {
        const result = await loadBodyWithSqlite(currentRoot, symbol);
        if (!result) {
          vscodeApi.window.showInformationMessage("Symbol not found.");
          return;
        }
        const doc = await vscodeApi.workspace.openTextDocument({
          language: "markdown",
          content: result.lines.join("\n"),
        });
        await vscodeApi.window.showTextDocument(doc, {
          preview: true,
          viewColumn: vscodeApi.ViewColumn.Beside,
        });
      } catch (error) {
        vscodeApi.window.showErrorMessage(sqliteErrorMessage(error, "body"));
      }
    })
  );

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.openSymbolLocation", async (symbol) => {
      try {
        await openSymbolLocationByName(symbol);
      } catch (error) {
        vscodeApi.window.showErrorMessage(sqliteErrorMessage(error, "open symbol"));
      }
    })
  );

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.showImpact", async () => {
      const currentRoot = getWorkspaceRoot(vscodeApi);
      if (!currentRoot) {
        vscodeApi.window.showWarningMessage("Codemap: open a workspace folder first.");
        return;
      }

      const symbol = await vscodeApi.window.showInputBox({
        title: "Repo Graph: Show Impact",
        prompt: "Enter qualified or short symbol name",
        ignoreFocusOut: true,
      });

      if (!symbol) {
        return;
      }

      try {
        const impact = await impactWithSqlite(currentRoot, symbol);
        if (!impact) {
          vscodeApi.window.showInformationMessage("Symbol not found.");
          return;
        }

        const doc = await vscodeApi.workspace.openTextDocument({
          language: "markdown",
          content: formatImpactMarkdown(impact).join("\n"),
        });
        await vscodeApi.window.showTextDocument(doc, {
          preview: true,
          viewColumn: vscodeApi.ViewColumn.Beside,
        });
      } catch (error) {
        vscodeApi.window.showErrorMessage(sqliteErrorMessage(error, "impact"));
      }
    })
  );

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.openImpactWebview", async (initialSymbol) => {
      const currentRoot = getWorkspaceRoot(vscodeApi);
      if (!currentRoot) {
        vscodeApi.window.showWarningMessage("Codemap: open a workspace folder first.");
        return;
      }

      const symbol = initialSymbol
        ? String(initialSymbol)
        : await vscodeApi.window.showInputBox({
            title: "Repo Graph: Open Impact Webview",
            prompt: "Enter qualified or short symbol name",
            ignoreFocusOut: true,
          });

      if (!symbol) {
        return;
      }

      try {
        const impact = await impactWithSqlite(currentRoot, symbol);
        if (!impact) {
          vscodeApi.window.showInformationMessage("Symbol not found.");
          return;
        }

        const graphData = buildImpactGraphData(impact);
        openImpactWebviewPanel(vscodeApi, graphData, async (selectedSymbol) => {
          await openSymbolLocationByName(selectedSymbol);
        });
      } catch (error) {
        vscodeApi.window.showErrorMessage(sqliteErrorMessage(error, "impact webview"));
      }
    })
  );

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.openRepoOverview", async () => {
      const currentRoot = getWorkspaceRoot(vscodeApi);
      if (!currentRoot) {
        vscodeApi.window.showWarningMessage("Codemap: open a workspace folder first.");
        return;
      }

      const kindPick = await vscodeApi.window.showQuickPick(
        [
          { label: "All symbol kinds", kind: "all" },
          { label: "Functions", kind: "function" },
          { label: "Methods", kind: "method" },
          { label: "Classes", kind: "class" },
        ],
        { title: "Repo Graph: Overview Symbol Kind" }
      );
      const selectedKind = kindPick?.kind || "all";

      const edgeScopePick = await vscodeApi.window.showQuickPick(
        [
          { label: "Resolved edges only", edgeScope: "resolved" },
          { label: "All edges (including unresolved)", edgeScope: "all" },
        ],
        { title: "Repo Graph: Overview Edge Scope" }
      );
      const selectedEdgeScope = edgeScopePick?.edgeScope || "resolved";

      const topInput = await vscodeApi.window.showInputBox({
        title: "Repo Graph: Overview Size",
        prompt: "How many top symbols to include?",
        value: "40",
        ignoreFocusOut: true,
      });
      const parsedTop = Number(topInput);
      const limit = Number.isFinite(parsedTop) ? Math.max(5, Math.min(200, Math.floor(parsedTop))) : 40;
      const bucketSize = Math.max(1, Math.floor(limit / 4));

      try {
        const overview = await repoOverviewWithSqlite(currentRoot, {
          limit,
          bucketSize,
          kind: selectedKind,
          edgeScope: selectedEdgeScope,
        });
        if (!overview || overview.nodes.length === 0) {
          vscodeApi.window.showInformationMessage("No symbols found for repository overview.");
          return;
        }

        openImpactWebviewPanel(
          vscodeApi,
          overview,
          async (selectedSymbol) => {
            await openSymbolLocationByName(selectedSymbol);
          },
          { panelTitle: `Codemap Repository Overview (${selectedKind}, ${selectedEdgeScope} edges, top ${limit})` }
        );
      } catch (error) {
        vscodeApi.window.showErrorMessage(sqliteErrorMessage(error, "repo overview"));
      }
    })
  );

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.reindexWorkspace", async () => {
      const currentRoot = getWorkspaceRoot(vscodeApi);
      if (!currentRoot) {
        vscodeApi.window.showWarningMessage("Codemap: open a workspace folder first.");
        return;
      }

      try {
        const result = await runCommand(currentRoot, ["index", "--changed-only"]);
        const message = result.lines[0] || "Codemap reindex complete.";
        vscodeApi.window.showInformationMessage(message);
      } catch (error) {
        vscodeApi.window.showErrorMessage(`Codemap reindex failed: ${error.message}`);
      }
    })
  );

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.showCallersForSymbol", async (symbol, callers) => {
      const entries = Array.isArray(callers) ? callers : [];
      if (entries.length === 0) {
        vscodeApi.window.showInformationMessage(`No callers found for ${symbol}.`);
        return;
      }

      const selection = await vscodeApi.window.showQuickPick(
        entries.map((row) => ({
          label: row.symbol,
          description: row.resolved ? "resolved" : "unresolved",
          symbol: row.symbol,
          resolved: Boolean(row.resolved),
        })),
        { title: `Callers for ${symbol}` }
      );

      if (!selection) {
        return;
      }

      if (!selection.resolved) {
        vscodeApi.window.showInformationMessage(`Caller ${selection.symbol} is unresolved.`);
        return;
      }

      try {
        await openSymbolLocationByName(selection.symbol);
      } catch (error) {
        vscodeApi.window.showErrorMessage(sqliteErrorMessage(error, "show callers"));
      }
    })
  );

  return {
    rootPathHint: path.basename(getWorkspaceRoot(vscodeApi) || ""),
  };
}

function activate(context) {
  const vscode = require("vscode");
  return activateWithApi(vscode, context);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  activateWithApi,
  isSupportedSavedDocument,
  formatImpactMarkdown,
};
