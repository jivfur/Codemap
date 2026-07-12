const path = require("node:path");
const { runGraphCommand } = require("./bridge");
const {
  SqliteBridgeError,
  findSymbolLocation,
  getImpactForSymbol,
  getNeighborsForSymbol,
  listSymbolsForFile,
  loadSymbolBody,
  searchSymbols,
} = require("./sqliteBridge");
const { createCodemapTreeProvider } = require("./treeView");

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

function activateWithApi(vscodeApi, context, deps = {}) {
  const runCommand = deps.runGraphCommand || runGraphCommand;
  const searchWithSqlite = deps.searchSymbols || searchSymbols;
  const loadBodyWithSqlite = deps.loadSymbolBody || loadSymbolBody;
  const findLocationWithSqlite = deps.findSymbolLocation || findSymbolLocation;
  const impactWithSqlite = deps.getImpactForSymbol || getImpactForSymbol;
  const listSymbols = deps.listSymbolsForFile || listSymbolsForFile;
  const getNeighbors = deps.getNeighborsForSymbol || getNeighborsForSymbol;

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
};
