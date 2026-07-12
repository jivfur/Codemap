const test = require("node:test");
const assert = require("node:assert/strict");

const { buildImpactGraphData, openImpactWebviewPanel, renderImpactWebviewHtml } = require("../src/impactWebview");

test("buildImpactGraphData creates nodes and edges", () => {
  const graph = buildImpactGraphData({
    target: "pkg.mod.target",
    impacted: [
      { symbol: "pkg.mod.a", depth: 1, resolved: true },
      { symbol: "pkg.mod.b", depth: 2, resolved: false },
    ],
  });

  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.nodes[0].id, "pkg.mod.target");
});

test("renderImpactWebviewHtml embeds target and script payload", () => {
  const html = renderImpactWebviewHtml({
    target: "pkg.mod.t",
    nodes: [{ id: "pkg.mod.t", label: "pkg.mod.t", depth: 0, resolution: "target" }],
    edges: [],
  });

  assert.ok(html.includes("Impact Graph"));
  assert.ok(html.includes("pkg.mod.t"));
  assert.ok(html.includes("openSymbol"));
});

test("openImpactWebviewPanel handles openSymbol messages", async () => {
  let messageHandler = null;
  const opens = [];

  const fakeVscode = {
    ViewColumn: { Beside: 2 },
    window: {
      createWebviewPanel: () => ({
        webview: {
          html: "",
          onDidReceiveMessage: (handler) => {
            messageHandler = handler;
          },
        },
      }),
    },
  };

  openImpactWebviewPanel(
    fakeVscode,
    { target: "pkg.mod.t", nodes: [], edges: [] },
    async (symbol) => {
      opens.push(symbol);
    }
  );

  await messageHandler({ command: "openSymbol", symbol: "pkg.mod.a" });
  await messageHandler({ command: "noop" });

  assert.deepEqual(opens, ["pkg.mod.a"]);
});
