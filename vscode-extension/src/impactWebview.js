let impactPanel = null;

function __resetImpactWebviewPanelForTests() {
  impactPanel = null;
}

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
      body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; margin: 0; padding: 12px; color: #1f2328; }
      h2 { margin: 0 0 8px; }
      .meta { color: #57606a; margin-bottom: 12px; }
      .legend { display: flex; gap: 12px; margin-bottom: 8px; font-size: 12px; color: #57606a; }
      .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 999px; margin-right: 6px; }
      .swatch-target { background: #1f6feb; }
      .swatch-resolved { background: #1a7f37; }
      .swatch-unresolved { background: #cf222e; }
      .canvas-wrap { border: 1px solid #d0d7de; border-radius: 10px; background: #f6f8fa; overflow: auto; }
      svg { display: block; min-width: 720px; }
      .edge-line { stroke: #8c959f; stroke-width: 1.5; fill: none; }
      .edge-unresolved { stroke: #cf222e; stroke-dasharray: 5 4; }
      .node-circle { cursor: pointer; stroke-width: 2; }
      .node-target { fill: #dbeafe; stroke: #1f6feb; }
      .node-resolved { fill: #dcfce7; stroke: #1a7f37; }
      .node-unresolved { fill: #fee2e2; stroke: #cf222e; }
      .node-label { font-size: 12px; fill: #1f2328; }
      .hint { margin-top: 8px; font-size: 12px; color: #57606a; }
      .controls { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-size: 12px; color: #57606a; }
      .controls select { padding: 2px 6px; border-radius: 6px; border: 1px solid #d0d7de; background: #fff; }
    </style>
  </head>
  <body>
    <h2>Impact Graph</h2>
    <p class="meta">Target symbol: <strong id="target"></strong></p>
    <div class="controls">
      <label for="maxDepthFilter">Max depth</label>
      <select id="maxDepthFilter"></select>
    </div>
    <div class="legend">
      <span><span class="swatch swatch-target"></span>Target</span>
      <span><span class="swatch swatch-resolved"></span>Resolved caller</span>
      <span><span class="swatch swatch-unresolved"></span>Unresolved caller</span>
    </div>
    <div class="canvas-wrap">
      <svg id="impactGraph" width="960" height="520" viewBox="0 0 960 520"></svg>
    </div>
    <p class="hint">Click a node to open symbol location.</p>
    <script>
      const vscode = acquireVsCodeApi();
      const data = ${payload};
      document.getElementById('target').textContent = data.target;

      const svg = document.getElementById('impactGraph');
      const width = 960;
      const height = 520;
      const marginX = 90;
      const marginY = 56;
      const labelOffset = 30;
      const maxDepthFilter = document.getElementById('maxDepthFilter');

      function esc(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      function groupNodesByDepth(nodes) {
        const depths = new Map();
        for (const node of nodes) {
          const depth = Number.isFinite(node.depth) ? Number(node.depth) : 0;
          if (!depths.has(depth)) {
            depths.set(depth, []);
          }
          depths.get(depth).push(node);
        }
        return Array.from(depths.entries()).sort((a, b) => a[0] - b[0]);
      }

      function computeLayout(nodes) {
        const grouped = groupNodesByDepth(nodes);
        const maxDepth = grouped.length > 0 ? grouped[grouped.length - 1][0] : 0;
        const depthSpan = Math.max(1, maxDepth);
        const byId = new Map();

        for (const [depth, depthNodes] of grouped) {
          const x = marginX + ((width - marginX * 2) * depth) / depthSpan;
          const count = depthNodes.length;
          for (let i = 0; i < count; i += 1) {
            const y = count === 1
              ? height / 2
              : marginY + ((height - marginY * 2) * i) / (count - 1);
            byId.set(depthNodes[i].id, { x, y, node: depthNodes[i] });
          }
        }

        return byId;
      }

      function nodeClass(node) {
        if (node.resolution === 'target') {
          return 'node-target';
        }
        if (node.resolution === 'resolved') {
          return 'node-resolved';
        }
        return 'node-unresolved';
      }

      function getMaxDepth(nodes) {
        let maxDepth = 0;
        for (const node of nodes) {
          const depth = Number(node.depth || 0);
          if (Number.isFinite(depth) && depth > maxDepth) {
            maxDepth = depth;
          }
        }
        return maxDepth;
      }

      function renderGraph(activeMaxDepth) {
        const allNodes = Array.isArray(data.nodes) ? data.nodes : [];
        const filteredNodes = allNodes.filter((node) => Number(node.depth || 0) <= activeMaxDepth);
        const allowed = new Set(filteredNodes.map((node) => node.id));
        const filteredEdges = (Array.isArray(data.edges) ? data.edges : []).filter(
          (edge) => allowed.has(edge.from) && allowed.has(edge.to)
        );

        while (svg.firstChild) {
          svg.removeChild(svg.firstChild);
        }

        const layout = computeLayout(filteredNodes);

        for (const edge of filteredEdges) {
          const from = layout.get(edge.from);
          const to = layout.get(edge.to);
          if (!from || !to) {
            continue;
          }
          const edgeClass = edge.resolution === 'unresolved' ? 'edge-line edge-unresolved' : 'edge-line';
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', String(from.x));
          line.setAttribute('y1', String(from.y));
          line.setAttribute('x2', String(to.x));
          line.setAttribute('y2', String(to.y));
          line.setAttribute('class', edgeClass);
          svg.appendChild(line);
        }

        for (const layoutNode of layout.values()) {
          const { x, y, node } = layoutNode;
          const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

          const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          circle.setAttribute('cx', String(x));
          circle.setAttribute('cy', String(y));
          circle.setAttribute('r', node.resolution === 'target' ? '14' : '11');
          circle.setAttribute('class', 'node-circle ' + nodeClass(node));
          circle.setAttribute('data-symbol', esc(node.id));
          circle.addEventListener('click', () => {
            vscode.postMessage({ command: 'openSymbol', symbol: node.id });
          });

          const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          label.setAttribute('x', String(x + labelOffset));
          label.setAttribute('y', String(y + 4));
          label.setAttribute('class', 'node-label');
          label.textContent = node.label;

          g.appendChild(circle);
          g.appendChild(label);
          svg.appendChild(g);
        }
      }

      const graphMaxDepth = getMaxDepth(Array.isArray(data.nodes) ? data.nodes : []);
      maxDepthFilter.innerHTML = '';
      for (let depth = 1; depth <= graphMaxDepth; depth += 1) {
        const option = document.createElement('option');
        option.value = String(depth);
        option.textContent = String(depth);
        maxDepthFilter.appendChild(option);
      }
      if (graphMaxDepth > 1) {
        const allOption = document.createElement('option');
        allOption.value = String(graphMaxDepth);
        allOption.textContent = 'All';
        allOption.selected = true;
        maxDepthFilter.appendChild(allOption);
      } else if (graphMaxDepth === 1 && maxDepthFilter.options.length > 0) {
        maxDepthFilter.options[0].selected = true;
      }

      if (maxDepthFilter.options.length === 0) {
        const option = document.createElement('option');
        option.value = '0';
        option.textContent = 'Target only';
        option.selected = true;
        maxDepthFilter.appendChild(option);
      }

      maxDepthFilter.addEventListener('change', () => {
        const depth = Number(maxDepthFilter.value || 0);
        renderGraph(Number.isFinite(depth) ? depth : graphMaxDepth);
      });

      const initialDepth = Number(maxDepthFilter.value || graphMaxDepth);
      renderGraph(Number.isFinite(initialDepth) ? initialDepth : graphMaxDepth);
    </script>
  </body>
</html>`;
}

function openImpactWebviewPanel(vscodeApi, graphData, onOpenSymbol) {
  if (!impactPanel) {
    impactPanel = vscodeApi.window.createWebviewPanel(
      'codemapImpact',
      `Codemap Impact: ${graphData.target}`,
      vscodeApi.ViewColumn.Beside,
      { enableScripts: true }
    );

    impactPanel.onDidDispose(() => {
      impactPanel = null;
    });

    impactPanel.webview.onDidReceiveMessage(async (message) => {
      if (!message || message.command !== 'openSymbol' || typeof message.symbol !== 'string') {
        return;
      }
      await onOpenSymbol(message.symbol);
    });
  } else {
    impactPanel.reveal(vscodeApi.ViewColumn.Beside, true);
  }

  impactPanel.title = `Codemap Impact: ${graphData.target}`;
  impactPanel.webview.html = renderImpactWebviewHtml(graphData);
  return impactPanel;
}

module.exports = {
  __resetImpactWebviewPanelForTests,
  buildImpactGraphData,
  renderImpactWebviewHtml,
  openImpactWebviewPanel,
};
