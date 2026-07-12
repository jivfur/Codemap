const path = require("node:path");
const { runGraphCommand } = require("./bridge");
const { SqliteBridgeError, loadSymbolBody, searchSymbols } = require("./sqliteBridge");

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

function activateWithApi(vscodeApi, context, deps = {}) {
  const runCommand = deps.runGraphCommand || runGraphCommand;
  const searchWithSqlite = deps.searchSymbols || searchSymbols;
  const loadBodyWithSqlite = deps.loadSymbolBody || loadSymbolBody;

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.indexWorkspace", async () => {
      const root = getWorkspaceRoot(vscodeApi);
      if (!root) {
        vscodeApi.window.showWarningMessage("Codemap: open a workspace folder first.");
        return;
      }

      try {
        const result = await runCommand(root, ["index"]);
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
      const root = getWorkspaceRoot(vscodeApi);
      if (!root) {
        vscodeApi.window.showWarningMessage("Codemap: open a workspace folder first.");
        return;
      }

      const query = await vscodeApi.window.showInputBox({
        title: "Codemap Search",
        prompt: "Enter symbol or text to search in index",
        ignoreFocusOut: true,
      });

      if (!query) {
        return;
      }

      try {
        const rows = await searchWithSqlite(root, query);
        if (rows.length === 0) {
          vscodeApi.window.showInformationMessage("No symbol matches.");
          return;
        }

        const selection = await vscodeApi.window.showQuickPick(
          rows.map((row) => ({
            label: `${row.qualifiedName} (${row.path})`,
            description: row.kind,
          })),
          { title: "Codemap Results" }
        );

        if (selection) {
          vscodeApi.window.showInformationMessage(`Selected: ${selection.label}`);
        }
      } catch (error) {
        vscodeApi.window.showErrorMessage(sqliteErrorMessage(error, "search"));
      }
    })
  );

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.showSymbolBody", async () => {
      const root = getWorkspaceRoot(vscodeApi);
      if (!root) {
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
        const result = await loadBodyWithSqlite(root, symbol);
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
