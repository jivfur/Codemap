const test = require("node:test");
const assert = require("node:assert/strict");

const { activateWithApi } = require("../src/extension");

function makeFakeVscode() {
  const registered = new Map();
  const infoMessages = [];
  const warningMessages = [];
  const errorMessages = [];
  const documents = [];
  const activeEditorListeners = [];
  const treeViews = [];

  const api = {
    Uri: {
      file: (fsPath) => ({ fsPath }),
    },
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
    Selection: class {
      constructor(start, end) {
        this.start = start;
        this.end = end;
      }
    },
    TextEditorRevealType: {
      InCenter: 0,
    },
    TreeItem: class {
      constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
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
    workspace: {
      workspaceFolders: [{ uri: { fsPath: "/tmp/repo" } }],
      openTextDocument: async (arg) => {
        const doc = arg && arg.content ? { content: arg.content } : { uri: arg };
        documents.push(doc);
        return doc;
      },
    },
    commands: {
      registerCommand: (id, fn) => {
        registered.set(id, fn);
        return { dispose: () => {} };
      },
    },
    window: {
      showInputBox: async () => "run",
      showQuickPick: async () => null,
      showTextDocument: async () => {},
      showInformationMessage: async (m) => {
        infoMessages.push(m);
      },
      showWarningMessage: async (m) => {
        warningMessages.push(m);
      },
      showErrorMessage: async (m) => {
        errorMessages.push(m);
      },
      createTreeView: (id, options) => {
        const tree = { id, options, dispose: () => {} };
        treeViews.push(tree);
        return tree;
      },
      onDidChangeActiveTextEditor: (listener) => {
        activeEditorListeners.push(listener);
        return { dispose: () => {} };
      },
    },
    ViewColumn: {
      Beside: 2,
    },
  };

  return {
    api,
    registered,
    infoMessages,
    warningMessages,
    errorMessages,
    documents,
    activeEditorListeners,
    treeViews,
  };
}

test("activateWithApi registers expected commands", () => {
  const fake = makeFakeVscode();
  const context = { subscriptions: [] };

  activateWithApi(fake.api, context, {
    runGraphCommand: async () => ({ lines: [] }),
  });

  assert.ok(fake.registered.has("codemap.indexWorkspace"));
  assert.ok(fake.registered.has("codemap.searchSymbol"));
  assert.ok(fake.registered.has("codemap.showSymbolBody"));
  assert.ok(fake.registered.has("codemap.openSymbolLocation"));
  assert.ok(fake.registered.has("codemap.refreshNeighbors"));
  assert.equal(fake.treeViews.length, 1);
  assert.ok(context.subscriptions.length >= 5);
});

test("index command reports first output line", async () => {
  const fake = makeFakeVscode();
  const context = { subscriptions: [] };

  activateWithApi(fake.api, context, {
    runGraphCommand: async () => ({ lines: ["Indexed: 2 | Skipped: 0 | Total supported: 2"] }),
  });

  const cmd = fake.registered.get("codemap.indexWorkspace");
  await cmd();

  assert.equal(fake.infoMessages[0], "Indexed: 2 | Skipped: 0 | Total supported: 2");
});

test("search command uses sqlite rows", async () => {
  const fake = makeFakeVscode();
  fake.api.window.showQuickPick = async (items) => items[0] || null;
  const context = { subscriptions: [] };

  activateWithApi(fake.api, context, {
    runGraphCommand: async () => ({ lines: [] }),
    searchSymbols: async () => [{ kind: "function", qualifiedName: "pkg.mod.run", path: "pkg/mod.py" }],
  });

  const cmd = fake.registered.get("codemap.searchSymbol");
  await cmd();

  assert.equal(fake.infoMessages[0], "Selected: pkg.mod.run (pkg/mod.py)");
});

test("showSymbolBody renders sqlite-backed body", async () => {
  const fake = makeFakeVscode();
  const context = { subscriptions: [] };

  activateWithApi(fake.api, context, {
    runGraphCommand: async () => ({ lines: [] }),
    loadSymbolBody: async () => ({
      lines: ["# pkg.mod.run (pkg/mod.py:1-1)", "   1 | def run():"],
    }),
  });

  const cmd = fake.registered.get("codemap.showSymbolBody");
  await cmd();

  assert.equal(fake.documents.length, 1);
  assert.ok(fake.documents[0].content.includes("pkg.mod.run"));
});

test("search command reports sqlite errors", async () => {
  const fake = makeFakeVscode();
  const context = { subscriptions: [] };

  activateWithApi(fake.api, context, {
    runGraphCommand: async () => ({ lines: [] }),
    searchSymbols: async () => {
      throw new Error("boom");
    },
  });

  const cmd = fake.registered.get("codemap.searchSymbol");
  await cmd();

  assert.equal(fake.errorMessages[0], "Codemap search failed: boom");
});

test("active editor change triggers tree refresh", async () => {
  const fake = makeFakeVscode();
  const context = { subscriptions: [] };

  activateWithApi(fake.api, context, {
    runGraphCommand: async () => ({ lines: [] }),
    listSymbolsForFile: async () => [],
    getNeighborsForSymbol: async () => ({ callers: [], callees: [] }),
  });

  assert.equal(fake.activeEditorListeners.length, 1);

  const provider = fake.treeViews[0].options.treeDataProvider;
  let refreshCount = 0;
  provider.onDidChangeTreeData(() => {
    refreshCount += 1;
  });

  fake.activeEditorListeners[0]();
  assert.equal(refreshCount, 1);
});
