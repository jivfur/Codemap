function buildImpactGraphData(impactResult) {
  const target = String(impactResult?.target || "");
  const impacted = Array.isArray(impactResult?.impacted) ? impactResult.impacted : [];

  const nodes = [{ id: target, label: target, depth: 0, resolution: "target" }];
  const edges = [];

  for (const row of impacted) {
    const symbol = String(row.symbol || "");
    if (!symbol) {
      continue;
    }
    nodes.push({
      id: symbol,
      label: symbol,
      depth: Number(row.depth || 1),
      resolution: row.resolved ? "resolved" : "unresolved",
    });
    edges.push({ from: symbol, to: target, resolution: row.resolved ? "resolved" : "unresolved" });
  }

  return { target, nodes, edges };
}

function renderImpactWebviewHtml(graphData) {
  const payload = JSON.stringify(graphData).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Codemap Impact</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; padding: 12px; }
      .meta { color: #666; margin-bottom: 12px; }
      .grid { display: grid; gap: 8px; }
      .node { border: 1px solid #ddd; border-radius: 8px; padding: 8px; }
      .node button { border: none; background: #0366d6; color: white; border-radius: 6px; padding: 6px 8px; cursor: pointer; }
      .edge { font-size: 12px; color: #444; }
      .tag { font-size: 11px; padding: 2px 6px; border-radius: 999px; border: 1px solid #ccc; }
      .resolved { border-color: #2da44e; color: #2da44e; }
      .unresolved { border-color: #cf222e; color: #cf222e; }
    </style>
  </head>
  <body>
    <h2>Impact Graph</h2>
    <p class="meta">Target symbol: <strong id="target"></strong></p>
    <div id="nodes" class="grid"></div>
    <h3>Edges</h3>
    <div id="edges" class="grid"></div>
    <script>
      const vscode = acquireVsCodeApi();
      const data = ${payload};
      document.getElementById('target').textContent = data.target;

      const nodesEl = document.getElementById('nodes');
      for (const node of data.nodes) {
        const item = document.createElement('div');
        item.className = 'node';
        const tagClass = node.resolution === 'resolved' ? 'resolved' : node.resolution === 'unresolved' ? 'unresolved' : '';
        item.innerHTML = '<div><strong>' + node.label + '</strong></div>' +
          '<div>Depth: ' + node.depth + ' <span class="tag ' + tagClass + '">' + node.resolution + '</span></div>';
        const btn = document.createElement('button');
        btn.textContent = 'Open Symbol';
        btn.addEventListener('click', () => {
          vscode.postMessage({ command: 'openSymbol', symbol: node.id });
        });
        item.appendChild(btn);
        nodesEl.appendChild(item);
      }

      const edgesEl = document.getElementById('edges');
      for (const edge of data.edges) {
        const row = document.createElement('div');
        row.className = 'edge';
        row.textContent = edge.from + ' -> ' + edge.to + ' (' + edge.resolution + ')';
        edgesEl.appendChild(row);
      }
    </script>
  </body>
</html>`;
}

function openImpactWebviewPanel(vscodeApi, graphData, onOpenSymbol) {
  const panel = vscodeApi.window.createWebviewPanel(
    'codemapImpact',
    `Codemap Impact: ${graphData.target}`,
    vscodeApi.ViewColumn.Beside,
    { enableScripts: true }
  );

  panel.webview.html = renderImpactWebviewHtml(graphData);
  panel.webview.onDidReceiveMessage(async (message) => {
    if (!message || message.command !== 'openSymbol' || typeof message.symbol !== 'string') {
      return;
    }
    await onOpenSymbol(message.symbol);
  });

  return panel;
}

module.exports = {
  buildImpactGraphData,
  renderImpactWebviewHtml,
  openImpactWebviewPanel,
};
