const test = require("node:test");
const assert = require("node:assert/strict");

const { createCodemapTreeProvider, toWorkspaceRelativePath } = require("../src/treeView");

function makeFakeVscode() {
  class TreeItem {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }

  return {
    TreeItem,
    TreeItemCollapsibleState: {
      None: 0,
      Collapsed: 1,
      Expanded: 2,
    },
    EventEmitter: class {
      constructor() {
        this.listeners = [];
        this.event = (listener) => {
          this.listeners.push(listener);
          return { dispose: () => {} };
        };
      }
      fire(value) {
        this.listeners.forEach((listener) => listener(value));
      }
    },
    window: {
      activeTextEditor: {
        document: {
          uri: {
            fsPath: "/tmp/repo/pkg/mod.py",
          },
        },
      },
    },
  };
}

test("toWorkspaceRelativePath normalizes separators", () => {
  const rel = toWorkspaceRelativePath("/tmp/repo", "/tmp/repo/pkg/mod.py");
  assert.equal(rel, "pkg/mod.py");
});

test("provider root maps symbols for active file", async () => {
  const vscode = makeFakeVscode();
  const provider = createCodemapTreeProvider(vscode, "/tmp/repo", {
    listSymbolsForFile: async (root, rel) => {
      assert.equal(root, "/tmp/repo");
      assert.equal(rel, "pkg/mod.py");
      return [
        { kind: "function", qualifiedName: "pkg.mod.run" },
        { kind: "class", qualifiedName: "pkg.mod.Service" },
      ];
    },
    getNeighborsForSymbol: async () => ({ callers: [], callees: [] }),
  });

  const roots = await provider.getChildren();
  assert.equal(roots.length, 2);
  assert.equal(roots[0].label, "pkg.mod.run");
  assert.equal(roots[1].label, "pkg.mod.Service");
});

test("provider symbol expansion returns caller/callee groups", async () => {
  const vscode = makeFakeVscode();
  const provider = createCodemapTreeProvider(vscode, "/tmp/repo", {
    listSymbolsForFile: async () => [],
    getNeighborsForSymbol: async () => ({
      callers: [{ symbol: "pkg.mod.a", resolved: true }],
      callees: [{ symbol: "pkg.mod.b", resolved: false }],
    }),
  });

  const groups = await provider.getChildren({ itemKind: "symbol", qualifiedName: "pkg.mod.run" });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].label, "Callers (1)");
  assert.equal(groups[1].label, "Callees (1)");

  const callerItems = await provider.getChildren({ itemKind: "group", groupName: "callers", symbol: "pkg.mod.run" });
  assert.equal(callerItems.length, 1);
  assert.equal(callerItems[0].label, "pkg.mod.a");
});

test("refresh emits tree change event", async () => {
  const vscode = makeFakeVscode();
  const provider = createCodemapTreeProvider(vscode, "/tmp/repo", {
    listSymbolsForFile: async () => [],
    getNeighborsForSymbol: async () => ({ callers: [], callees: [] }),
  });

  let fired = 0;
  provider.onDidChangeTreeData(() => {
    fired += 1;
  });

  provider.refresh();
  assert.equal(fired, 1);
});
