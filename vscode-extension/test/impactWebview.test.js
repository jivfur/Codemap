const test = require("node:test");
const assert = require("node:assert/strict");

const {
  __resetImpactWebviewPanelForTests,
  buildImpactGraphData,
  openImpactWebviewPanel,
  renderImpactWebviewHtml,
} = require("../src/impactWebview");

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
  assert.equal(graph.nodes[0].fullLabel, "pkg.mod.target");
});

test("renderImpactWebviewHtml embeds target and script payload", () => {
  const html = renderImpactWebviewHtml({
    target: "pkg.mod.t",
    nodes: [{ id: "pkg.mod.t", label: "pkg.mod.t", depth: 0, resolution: "target" }],
    edges: [],
  });

  assert.ok(html.includes("Impact Graph"));
  assert.ok(html.includes("pkg.mod.t"));
  assert.ok(html.includes("impactGraph"));
  assert.ok(html.includes("maxDepthFilter"));
  assert.ok(html.includes("resetViewButton"));
  assert.ok(html.includes("renderGraph("));
  assert.ok(html.includes("runForceLayout("));
  assert.ok(html.includes("resolveNodeRadius("));
  assert.ok(html.includes("node.fullLabel || node.id"));
  assert.ok(html.includes("createElementNS('http://www.w3.org/2000/svg', 'title')"));
  assert.ok(html.includes("pointermove"));
  assert.ok(html.includes("node-circle"));
  assert.ok(html.includes("openSymbol"));
});

test("openImpactWebviewPanel handles openSymbol messages", async () => {
  __resetImpactWebviewPanelForTests();
  let messageHandler = null;
  let disposeHandler = null;
  const opens = [];
  let createCount = 0;
  let revealCount = 0;

  const panel = {
    title: "",
    reveal: () => {
      revealCount += 1;
    },
    onDidDispose: (handler) => {
      disposeHandler = handler;
    },
    webview: {
      html: "",
      onDidReceiveMessage: (handler) => {
        messageHandler = handler;
      },
    },
  };

  const fakeVscode = {
    ViewColumn: { Beside: 2 },
    window: {
      createWebviewPanel: () => {
        createCount += 1;
        return panel;
      },
    },
  };

  const first = openImpactWebviewPanel(
    fakeVscode,
    { target: "pkg.mod.t", nodes: [], edges: [] },
    async (symbol) => {
      opens.push(symbol);
    }
  );

  const second = openImpactWebviewPanel(
    fakeVscode,
    { target: "pkg.mod.u", nodes: [], edges: [] },
    async (symbol) => {
      opens.push(symbol);
    }
  );

  await messageHandler({ command: "openSymbol", symbol: "pkg.mod.a" });
  await messageHandler({ command: "noop" });

  assert.equal(first, second);
  assert.equal(createCount, 1);
  assert.equal(revealCount, 1);
  assert.equal(panel.title, "Codemap Impact: pkg.mod.u");
  assert.deepEqual(opens, ["pkg.mod.a"]);

  disposeHandler();

  openImpactWebviewPanel(
    fakeVscode,
    { target: "pkg.mod.v", nodes: [], edges: [] },
    async () => { }
  );
  assert.equal(createCount, 2);
});
