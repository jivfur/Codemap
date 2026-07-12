const test = require("node:test");
const assert = require("node:assert/strict");

const { activateWithApi } = require("../src/extension");

function makeFakeVscode() {
  const registered = new Map();
  const infoMessages = [];
  const warningMessages = [];
  const errorMessages = [];

  const api = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: "/tmp/repo" } }],
      openTextDocument: async ({ content }) => ({ content }),
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

  return { api, registered, infoMessages, warningMessages, errorMessages };
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
