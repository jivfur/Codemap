const path = require("node:path");

const CODELENS_EXTENSIONS = new Set([".py", ".js", ".jsx", ".ts", ".tsx"]);

function isCodeLensDocumentInWorkspace(workspaceRoot, document) {
  if (!workspaceRoot || !document?.uri?.fsPath) {
    return false;
  }

  const fsPath = String(document.uri.fsPath);
  const relPath = path.relative(workspaceRoot, fsPath);
  if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
    return false;
  }

  return CODELENS_EXTENSIONS.has(path.extname(fsPath).toLowerCase());
}

function createCallerCodeLensProvider(vscodeApi, workspaceRoot, deps = {}) {
  const listSymbolsForFile = deps.listSymbolsForFile;
  const getNeighborsForSymbol = deps.getNeighborsForSymbol;

  return {
    async provideCodeLenses(document) {
      if (!isCodeLensDocumentInWorkspace(workspaceRoot, document)) {
        return [];
      }

      const relPath = path.relative(workspaceRoot, document.uri.fsPath).split(path.sep).join("/");
      const symbols = await listSymbolsForFile(workspaceRoot, relPath);
      const callableSymbols = symbols.filter((symbol) => symbol.kind === "function" || symbol.kind === "method");

      const lenses = [];
      for (const symbol of callableSymbols) {
        const neighbors = await getNeighborsForSymbol(workspaceRoot, symbol.qualifiedName);
        const callers = Array.isArray(neighbors?.callers) ? neighbors.callers : [];
        const count = callers.length;
        const line = Math.max(0, Number(symbol.start || 1) - 1);
        const range = new vscodeApi.Range(new vscodeApi.Position(line, 0), new vscodeApi.Position(line, 0));
        lenses.push(
          new vscodeApi.CodeLens(range, {
            command: "codemap.showCallersForSymbol",
            title: `Called from ${count} ${count === 1 ? "place" : "places"}`,
            arguments: [symbol.qualifiedName, callers],
          })
        );
      }

      return lenses;
    },
  };
}

module.exports = {
  createCallerCodeLensProvider,
  isCodeLensDocumentInWorkspace,
};
