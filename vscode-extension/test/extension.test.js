const test = require("node:test");
const assert = require("node:assert/strict");

const { activateWithApi } = require("../src/extension");

function makeFakeVscode() {
  const registered = new Map();
  const infoMessages = [];
  const warningMessages = [];
  const errorMessages = [];
  const documents = [];

  const api = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: "/tmp/repo" } }],
      openTextDocument: async ({ content }) => {
        const doc = { content };
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
    },
    ViewColumn: {
      Beside: 2,
    },
  };

  return { api, registered, infoMessages, warningMessages, errorMessages, documents };
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
  assert.equal(context.subscriptions.length, 3);
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
