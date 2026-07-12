const test = require("node:test");
const assert = require("node:assert/strict");

const { activateWithApi, isSupportedSavedDocument } = require("../src/extension");
const { __resetImpactWebviewPanelForTests } = require("../src/impactWebview");

function makeFakeVscode() {
  const registered = new Map();
  const infoMessages = [];
  const warningMessages = [];
  const errorMessages = [];
  const documents = [];
  const activeEditorListeners = [];
  const treeViews = [];
  const saveDocumentListeners = [];
  const statusMessages = [];
  const codeLensRegistrations = [];
  const webviewPanels = [];

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
    CodeLens: class {
      constructor(range, command) {
        this.range = range;
        this.command = command;
      }
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
      onDidSaveTextDocument: (listener) => {
        saveDocumentListeners.push(listener);
        return { dispose: () => {} };
      },
    },
    commands: {
      registerCommand: (id, fn) => {
        registered.set(id, fn);
        return { dispose: () => {} };
      },
    },
    languages: {
      registerCodeLensProvider: (selector, provider) => {
        codeLensRegistrations.push({ selector, provider });
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
      setStatusBarMessage: (text) => {
        statusMessages.push(text);
        return { dispose: () => {} };
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
      createWebviewPanel: (viewType, title, viewColumn, options) => {
        const panel = {
          viewType,
          title,
          viewColumn,
          options,
          reveal: () => {},
          onDidDispose: () => {},
          webview: {
            html: "",
            onDidReceiveMessage: (handler) => {
              panel.onDidReceiveMessage = handler;
            },
          },
        };
        webviewPanels.push(panel);
        return panel;
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
    saveDocumentListeners,
    statusMessages,
    codeLensRegistrations,
    webviewPanels,
  };
}

test("isSupportedSavedDocument validates extension and workspace boundary", () => {
  assert.equal(isSupportedSavedDocument("/tmp/repo", { uri: { fsPath: "/tmp/repo/src/a.py" } }), true);
  assert.equal(isSupportedSavedDocument("/tmp/repo", { uri: { fsPath: "/tmp/repo/src/a.txt" } }), false);
  assert.equal(isSupportedSavedDocument("/tmp/repo", { uri: { fsPath: "/tmp/other/a.py" } }), false);
});

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
  assert.ok(fake.registered.has("codemap.findSymbol"));
  assert.ok(fake.registered.has("codemap.showImpact"));
  assert.ok(fake.registered.has("codemap.reindexWorkspace"));
  assert.ok(fake.registered.has("codemap.showCallersForSymbol"));
  assert.ok(fake.registered.has("codemap.openImpactWebview"));
  assert.equal(fake.treeViews.length, 1);
  assert.equal(fake.codeLensRegistrations.length, 1);
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
  fake.api.window.showTextDocument = async () => ({ revealRange: () => {} });
  const context = { subscriptions: [] };

  activateWithApi(fake.api, context, {
    runGraphCommand: async () => ({ lines: [] }),
    searchSymbols: async () => [{ kind: "function", qualifiedName: "pkg.mod.run", path: "pkg/mod.py" }],
    findSymbolLocation: async () => ({ path: "pkg/mod.py", start: 1, end: 1 }),
  });

  const cmd = fake.registered.get("codemap.searchSymbol");
  await cmd();

  assert.equal(fake.documents.length, 1);
  assert.equal(fake.documents[0].uri.fsPath, "/tmp/repo/pkg/mod.py");
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

test("find symbol command prompts and opens selection", async () => {
  const fake = makeFakeVscode();
  const context = { subscriptions: [] };
  fake.api.window.showQuickPick = async (items) => items[0] || null;
  fake.api.window.showTextDocument = async () => ({ revealRange: () => {} });

  activateWithApi(fake.api, context, {
    runGraphCommand: async () => ({ lines: [] }),
    searchSymbols: async () => [{ kind: "function", qualifiedName: "pkg.mod.findme", path: "pkg/mod.py" }],
    findSymbolLocation: async () => ({ path: "pkg/mod.py", start: 3, end: 5 }),
  });

  await fake.registered.get("codemap.findSymbol")();
  assert.equal(fake.documents[0].uri.fsPath, "/tmp/repo/pkg/mod.py");
});

test("show impact command renders markdown output", async () => {
  const fake = makeFakeVscode();
  const context = { subscriptions: [] };

  activateWithApi(fake.api, context, {
    runGraphCommand: async () => ({ lines: [] }),
    getImpactForSymbol: async () => ({
      target: "pkg.mod.run",
      impacted: [
        { symbol: "pkg.mod.caller", depth: 1, resolved: true },
        { symbol: "pkg.mod.indirect", depth: 2, resolved: false },
      ],
    }),
  });

  await fake.registered.get("codemap.showImpact")();
  assert.equal(fake.documents.length, 1);
  assert.ok(fake.documents[0].content.includes("Impact for pkg.mod.run"));
  assert.ok(fake.documents[0].content.includes("pkg.mod.caller"));
});

test("reindex workspace command uses changed-only mode", async () => {
  const fake = makeFakeVscode();
  const context = { subscriptions: [] };
  const calls = [];

  activateWithApi(fake.api, context, {
    runGraphCommand: async (cwd, args) => {
      calls.push({ cwd, args });
      return { lines: ["Indexed: 1 | Skipped: 0 | Total supported: 1"] };
    },
  });

  await fake.registered.get("codemap.reindexWorkspace")();
  assert.deepEqual(calls[0], { cwd: "/tmp/repo", args: ["index", "--changed-only"] });
});

test("on-save listener debounces and invokes changed-only index", async () => {
  const fake = makeFakeVscode();
  const context = { subscriptions: [] };
  const runCalls = [];
  const scheduled = [];

  const schedule = (fn, delayMs) => {
    const handle = { fn, delayMs, cancelled: false };
    scheduled.push(handle);
    return handle;
  };

  const cancelSchedule = (handle) => {
    handle.cancelled = true;
  };

  activateWithApi(fake.api, context, {
    runGraphCommand: async (cwd, args) => {
      runCalls.push({ cwd, args });
      return { lines: ["Indexed: 1 | Skipped: 0 | Total supported: 1"] };
    },
    schedule,
    cancelSchedule,
    saveDebounceMs: 300,
  });

  assert.equal(fake.saveDocumentListeners.length, 1);
  const onSave = fake.saveDocumentListeners[0];

  onSave({ uri: { fsPath: "/tmp/repo/src/main.py" } });
  onSave({ uri: { fsPath: "/tmp/repo/src/main.py" } });
  onSave({ uri: { fsPath: "/tmp/repo/src/ignore.txt" } });

  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[0].cancelled, true);
  assert.equal(runCalls.length, 0);

  await scheduled[1].fn();
  assert.equal(runCalls.length, 1);
  assert.deepEqual(runCalls[0], { cwd: "/tmp/repo", args: ["index", "--changed-only"] });
  assert.equal(fake.statusMessages.length, 1);
});

test("showCallersForSymbol command opens resolved selection", async () => {
  const fake = makeFakeVscode();
  const context = { subscriptions: [] };
  fake.api.window.showQuickPick = async (items) => items[0] || null;
  fake.api.window.showTextDocument = async () => ({ revealRange: () => {} });

  activateWithApi(fake.api, context, {
    runGraphCommand: async () => ({ lines: [] }),
    findSymbolLocation: async () => ({ path: "pkg/mod.py", start: 2, end: 2 }),
  });

  const cmd = fake.registered.get("codemap.showCallersForSymbol");
  await cmd("pkg.mod.target", [{ symbol: "pkg.mod.caller", resolved: true }]);
  assert.equal(fake.documents[0].uri.fsPath, "/tmp/repo/pkg/mod.py");
});

test("showCallersForSymbol reports unresolved selection", async () => {
  const fake = makeFakeVscode();
  const context = { subscriptions: [] };
  fake.api.window.showQuickPick = async (items) => items[0] || null;

  activateWithApi(fake.api, context, {
    runGraphCommand: async () => ({ lines: [] }),
  });

  const cmd = fake.registered.get("codemap.showCallersForSymbol");
  await cmd("pkg.mod.target", [{ symbol: "pkg.mod.unknown", resolved: false }]);
  assert.equal(fake.infoMessages[0], "Caller pkg.mod.unknown is unresolved.");
});

test("openImpactWebview creates panel and opens message symbol", async () => {
  __resetImpactWebviewPanelForTests();
  const fake = makeFakeVscode();
  const context = { subscriptions: [] };
  fake.api.window.showTextDocument = async () => ({ revealRange: () => {} });

  activateWithApi(fake.api, context, {
    runGraphCommand: async () => ({ lines: [] }),
    getImpactForSymbol: async () => ({
      target: "pkg.mod.target",
      impacted: [{ symbol: "pkg.mod.a", depth: 1, resolved: true }],
    }),
    findSymbolLocation: async () => ({ path: "pkg/mod.py", start: 1, end: 1 }),
  });

  await fake.registered.get("codemap.openImpactWebview")();
  assert.equal(fake.webviewPanels.length, 1);
  assert.ok(fake.webviewPanels[0].webview.html.includes("pkg.mod.target"));

  await fake.webviewPanels[0].onDidReceiveMessage({ command: "openSymbol", symbol: "pkg.mod.a" });
  assert.equal(fake.documents[0].uri.fsPath, "/tmp/repo/pkg/mod.py");
});

test("openImpactWebview accepts direct symbol argument", async () => {
  __resetImpactWebviewPanelForTests();
  const fake = makeFakeVscode();
  const context = { subscriptions: [] };
  fake.api.window.showInputBox = async () => {
    throw new Error("showInputBox should not be called");
  };

  let requestedSymbol = null;
  activateWithApi(fake.api, context, {
    runGraphCommand: async () => ({ lines: [] }),
    getImpactForSymbol: async (_root, symbol) => {
      requestedSymbol = symbol;
      return {
        target: symbol,
        impacted: [{ symbol: "pkg.mod.caller", depth: 1, resolved: true }],
      };
    },
  });

  await fake.registered.get("codemap.openImpactWebview")("pkg.mod.from.codelens");
  assert.equal(requestedSymbol, "pkg.mod.from.codelens");
  assert.equal(fake.webviewPanels.length, 1);
});
