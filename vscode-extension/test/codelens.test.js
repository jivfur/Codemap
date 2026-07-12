const test = require("node:test");
const assert = require("node:assert/strict");

const { createCallerCodeLensProvider, isCodeLensDocumentInWorkspace } = require("../src/codelens");

function makeFakeVscode() {
  return {
    Position: class {
      constructor(line, character) {
        this.line = line;
        this.character = character;
      }
    },
    Range: class {
      constructor(start, end) {
        this.start = start;
        this.end = end;
      }
    },
    CodeLens: class {
      constructor(range, command) {
        this.range = range;
        this.command = command;
      }
    },
  };
}

test("isCodeLensDocumentInWorkspace filters path and extension", () => {
  assert.equal(isCodeLensDocumentInWorkspace("/tmp/repo", { uri: { fsPath: "/tmp/repo/a.py" } }), true);
  assert.equal(isCodeLensDocumentInWorkspace("/tmp/repo", { uri: { fsPath: "/tmp/repo/a.md" } }), false);
  assert.equal(isCodeLensDocumentInWorkspace("/tmp/repo", { uri: { fsPath: "/tmp/other/a.py" } }), false);
});

test("provideCodeLenses builds caller count lenses for callable symbols", async () => {
  const vscode = makeFakeVscode();
  const provider = createCallerCodeLensProvider(vscode, "/tmp/repo", {
    listSymbolsForFile: async () => [
      { kind: "class", qualifiedName: "pkg.mod.C", start: 1 },
      { kind: "function", qualifiedName: "pkg.mod.f", start: 3 },
      { kind: "method", qualifiedName: "pkg.mod.C.m", start: 8 },
    ],
    getNeighborsForSymbol: async (root, symbol) => {
      if (symbol === "pkg.mod.f") {
        return { callers: [{ symbol: "pkg.mod.a", resolved: true }] };
      }
      return { callers: [{ symbol: "pkg.mod.b", resolved: false }, { symbol: "pkg.mod.c", resolved: true }] };
    },
  });

  const lenses = await provider.provideCodeLenses({ uri: { fsPath: "/tmp/repo/pkg/mod.py" } });
  assert.equal(lenses.length, 2);
  assert.equal(lenses[0].command.command, "codemap.openImpactWebview");
  assert.equal(lenses[0].command.title, "Called from 1 place");
  assert.equal(lenses[1].command.title, "Called from 2 places");
  assert.deepEqual(lenses[0].command.arguments, ["pkg.mod.f"]);
});
