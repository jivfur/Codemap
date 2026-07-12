const path = require("node:path");

const ITEM_KIND = {
  SYMBOL: "symbol",
  GROUP: "group",
  NEIGHBOR: "neighbor",
};

function toWorkspaceRelativePath(workspaceRoot, filePath) {
  const rel = path.relative(workspaceRoot, filePath);
  return rel.split(path.sep).join("/");
}

class CodemapTreeProvider {
  constructor(vscodeApi, workspaceRoot, deps = {}) {
    this.vscode = vscodeApi;
    this.workspaceRoot = workspaceRoot;
    this.listSymbolsForFile = deps.listSymbolsForFile;
    this.getNeighborsForSymbol = deps.getNeighborsForSymbol;

    this._onDidChangeTreeData = new vscodeApi.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  async getChildren(element) {
    if (!element) {
      return this._rootItems();
    }
    if (element.itemKind === ITEM_KIND.SYMBOL) {
      return this._groupItems(element.qualifiedName);
    }
    if (element.itemKind === ITEM_KIND.GROUP) {
      return this._neighborItems(element.symbol, element.groupName);
    }
    return [];
  }

  getTreeItem(element) {
    return element;
  }

  async _rootItems() {
    const editor = this.vscode.window.activeTextEditor;
    if (!editor || !editor.document) {
      return [];
    }

    const relPath = toWorkspaceRelativePath(this.workspaceRoot, editor.document.uri.fsPath);
    const symbols = await this.listSymbolsForFile(this.workspaceRoot, relPath);

    return symbols.map((symbol) => {
      const item = new this.vscode.TreeItem(
        symbol.qualifiedName,
        this.vscode.TreeItemCollapsibleState.Collapsed
      );
      item.itemKind = ITEM_KIND.SYMBOL;
      item.qualifiedName = symbol.qualifiedName;
      item.description = symbol.kind;
      item.contextValue = "codemapSymbol";
      item.command = {
        command: "codemap.openSymbolLocation",
        title: "Open Symbol",
        arguments: [symbol.qualifiedName],
      };
      return item;
    });
  }

  async _groupItems(symbol) {
    const neighbors = await this.getNeighborsForSymbol(this.workspaceRoot, symbol);

    const callers = new this.vscode.TreeItem(
      `Callers (${neighbors.callers.length})`,
      this.vscode.TreeItemCollapsibleState.Collapsed
    );
    callers.itemKind = ITEM_KIND.GROUP;
    callers.groupName = "callers";
    callers.symbol = symbol;

    const callees = new this.vscode.TreeItem(
      `Callees (${neighbors.callees.length})`,
      this.vscode.TreeItemCollapsibleState.Collapsed
    );
    callees.itemKind = ITEM_KIND.GROUP;
    callees.groupName = "callees";
    callees.symbol = symbol;

    return [callers, callees];
  }

  async _neighborItems(symbol, groupName) {
    const neighbors = await this.getNeighborsForSymbol(this.workspaceRoot, symbol);
    const rows = groupName === "callers" ? neighbors.callers : neighbors.callees;

    return rows.map((row) => {
      const item = new this.vscode.TreeItem(
        row.symbol,
        this.vscode.TreeItemCollapsibleState.None
      );
      item.itemKind = ITEM_KIND.NEIGHBOR;
      item.description = row.resolved ? "resolved" : "unresolved";
      item.contextValue = "codemapNeighbor";
      if (row.resolved) {
        item.command = {
          command: "codemap.openSymbolLocation",
          title: "Open Symbol",
          arguments: [row.symbol],
        };
      }
      return item;
    });
  }
}

function createCodemapTreeProvider(vscodeApi, workspaceRoot, deps) {
  return new CodemapTreeProvider(vscodeApi, workspaceRoot, deps);
}

module.exports = {
  ITEM_KIND,
  createCodemapTreeProvider,
  toWorkspaceRelativePath,
};
