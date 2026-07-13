let impactPanel = null;

function __resetImpactWebviewPanelForTests() {
  impactPanel = null;
}

function buildImpactGraphData(impactResult) {
  const target = String(impactResult?.target || "");
  const impacted = Array.isArray(impactResult?.impacted) ? impactResult.impacted : [];

  const nodes = [{ id: target, label: target, fullLabel: target, depth: 0, resolution: "target" }];
  const edges = [];

  for (const row of impacted) {
    const symbol = String(row.symbol || "");
    if (!symbol) {
      continue;
    }
    nodes.push({
      id: symbol,
      label: symbol,
      fullLabel: symbol,
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
      .controls button { padding: 3px 8px; border-radius: 6px; border: 1px solid #d0d7de; background: #fff; cursor: pointer; }
      .controls button:hover { background: #f3f4f6; }
    </style>
  </head>
  <body>
    <h2>Impact Graph</h2>
    <p class="meta">Focus: <strong id="target"></strong></p>
    <div class="controls">
      <label for="maxDepthFilter">Max depth</label>
      <select id="maxDepthFilter"></select>
      <button id="resetViewButton" type="button">Reset View</button>
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
      const resetViewButton = document.getElementById('resetViewButton');

      const view = { scale: 1, tx: 0, ty: 0 };
      let currentNodes = [];
      let currentEdges = [];
      let currentPositions = new Map();
      let isPanning = false;
      let panLastX = 0;
      let panLastY = 0;
      let draggingNodeId = null;
      let suppressNodeClick = false;

      const graphRoot = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      svg.appendChild(graphRoot);

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

      function resolveNodeRadius(node) {
        if (node.resolution === 'target') {
          return 14;
        }
        const size = Number(node.size);
        if (!Number.isFinite(size)) {
          return 11;
        }
        return clamp(size, 8, 24);
      }

      function buildNodeTooltip(node) {
        const lines = [String(node.fullLabel || node.id || '')];
        if (node.kind) {
          lines.push('kind: ' + String(node.kind));
        }
        const inbound = Number(node.inboundCalls);
        const outbound = Number(node.outboundCalls);
        if (Number.isFinite(inbound) || Number.isFinite(outbound)) {
          lines.push(
            'calls: in ' + (Number.isFinite(inbound) ? String(inbound) : '?') +
            ', out ' + (Number.isFinite(outbound) ? String(outbound) : '?')
          );
        }
        return lines.join('\n');
      }

      function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
      }

      function hashString(value) {
        let h = 0;
        for (let i = 0; i < value.length; i += 1) {
          h = ((h << 5) - h + value.charCodeAt(i)) | 0;
        }
        return Math.abs(h);
      }

      function toWorld(clientX, clientY) {
        const rect = svg.getBoundingClientRect();
        return {
          x: (clientX - rect.left - view.tx) / view.scale,
          y: (clientY - rect.top - view.ty) / view.scale,
        };
      }

      function applyViewTransform() {
        graphRoot.setAttribute('transform', 'translate(' + view.tx + ' ' + view.ty + ') scale(' + view.scale + ')');
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

      function seedPositions(nodes) {
        const seeded = new Map();
        const layout = computeLayout(nodes);
        for (const [nodeId, entry] of layout.entries()) {
          const n = hashString(nodeId);
          const jitterX = ((n % 23) - 11) * 2;
          const jitterY = ((n % 19) - 9) * 2;
          seeded.set(nodeId, {
            x: entry.x + jitterX,
            y: entry.y + jitterY,
          });
        }
        return seeded;
      }

      function runForceLayout(nodes, edges, seededPositions) {
        const byId = new Map();
        for (const node of nodes) {
          const seeded = seededPositions.get(node.id) || { x: width / 2, y: height / 2 };
          byId.set(node.id, {
            x: seeded.x,
            y: seeded.y,
            vx: 0,
            vy: 0,
            node,
          });
        }

        const nodeEntries = Array.from(byId.values());
        const iterations = 140;
        const repulsion = 9000;
        const springK = 0.01;
        const springLength = 145;
        const damping = 0.86;

        for (let step = 0; step < iterations; step += 1) {
          for (let i = 0; i < nodeEntries.length; i += 1) {
            for (let j = i + 1; j < nodeEntries.length; j += 1) {
              const a = nodeEntries[i];
              const b = nodeEntries[j];
              let dx = b.x - a.x;
              let dy = b.y - a.y;
              const distSq = dx * dx + dy * dy + 0.01;
              const dist = Math.sqrt(distSq);
              dx /= dist;
              dy /= dist;
              const force = repulsion / distSq;

              a.vx -= dx * force;
              a.vy -= dy * force;
              b.vx += dx * force;
              b.vy += dy * force;
            }
          }

          for (const edge of edges) {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from || !to) {
              continue;
            }
            let dx = to.x - from.x;
            let dy = to.y - from.y;
            const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
            dx /= dist;
            dy /= dist;
            const force = (dist - springLength) * springK;

            from.vx += dx * force;
            from.vy += dy * force;
            to.vx -= dx * force;
            to.vy -= dy * force;
          }

          for (const entry of nodeEntries) {
            const fixed = entry.node.resolution === 'target';
            if (fixed) {
              entry.vx = 0;
              entry.vy = 0;
              continue;
            }
            entry.vx *= damping;
            entry.vy *= damping;
            entry.x = clamp(entry.x + entry.vx, marginX, width - marginX);
            entry.y = clamp(entry.y + entry.vy, marginY, height - marginY);
          }
        }

        const positions = new Map();
        for (const entry of nodeEntries) {
          positions.set(entry.node.id, { x: entry.x, y: entry.y, node: entry.node });
        }
        return positions;
      }

      function drawGraph() {
        while (graphRoot.firstChild) {
          graphRoot.removeChild(graphRoot.firstChild);
        }

        for (const edge of currentEdges) {
          const from = currentPositions.get(edge.from);
          const to = currentPositions.get(edge.to);
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
          graphRoot.appendChild(line);
        }

        for (const node of currentNodes) {
          const position = currentPositions.get(node.id);
          if (!position) {
            continue;
          }

          const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

          const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          circle.setAttribute('cx', String(position.x));
          circle.setAttribute('cy', String(position.y));
          circle.setAttribute('r', String(resolveNodeRadius(node)));
          circle.setAttribute('class', 'node-circle ' + nodeClass(node));
          circle.setAttribute('data-symbol', esc(node.id));

          const tooltip = document.createElementNS('http://www.w3.org/2000/svg', 'title');
          tooltip.textContent = buildNodeTooltip(node);
          circle.appendChild(tooltip);

          circle.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
            draggingNodeId = node.id;
            suppressNodeClick = false;
          });
          circle.addEventListener('click', () => {
            if (suppressNodeClick) {
              return;
            }
            vscode.postMessage({ command: 'openSymbol', symbol: node.id });
          });

          const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          label.setAttribute('x', String(position.x + labelOffset));
          label.setAttribute('y', String(position.y + 4));
          label.setAttribute('class', 'node-label');
          label.textContent = node.label;

          g.appendChild(circle);
          g.appendChild(label);
          graphRoot.appendChild(g);
        }
      }

      function renderGraph(activeMaxDepth) {
        const allNodes = Array.isArray(data.nodes) ? data.nodes : [];
        currentNodes = allNodes.filter((node) => Number(node.depth || 0) <= activeMaxDepth);
        const allowed = new Set(currentNodes.map((node) => node.id));
        currentEdges = (Array.isArray(data.edges) ? data.edges : []).filter(
          (edge) => allowed.has(edge.from) && allowed.has(edge.to)
        );

        const seeded = seedPositions(currentNodes);
        currentPositions = runForceLayout(currentNodes, currentEdges, seeded);
        drawGraph();
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

      resetViewButton.addEventListener('click', () => {
        view.scale = 1;
        view.tx = 0;
        view.ty = 0;
        applyViewTransform();
      });

      svg.addEventListener('wheel', (event) => {
        event.preventDefault();
        const before = toWorld(event.clientX, event.clientY);
        const zoom = event.deltaY < 0 ? 1.12 : 0.9;
        view.scale = clamp(view.scale * zoom, 0.45, 3.2);

        const rect = svg.getBoundingClientRect();
        view.tx = event.clientX - rect.left - before.x * view.scale;
        view.ty = event.clientY - rect.top - before.y * view.scale;
        applyViewTransform();
      }, { passive: false });

      svg.addEventListener('pointerdown', (event) => {
        if (draggingNodeId) {
          return;
        }
        isPanning = true;
        panLastX = event.clientX;
        panLastY = event.clientY;
      });

      svg.addEventListener('pointermove', (event) => {
        if (draggingNodeId) {
          const world = toWorld(event.clientX, event.clientY);
          const entry = currentPositions.get(draggingNodeId);
          if (entry) {
            entry.x = clamp(world.x, marginX, width - marginX);
            entry.y = clamp(world.y, marginY, height - marginY);
            suppressNodeClick = true;
            drawGraph();
          }
          return;
        }

        if (!isPanning) {
          return;
        }

        view.tx += event.clientX - panLastX;
        view.ty += event.clientY - panLastY;
        panLastX = event.clientX;
        panLastY = event.clientY;
        applyViewTransform();
      });

      svg.addEventListener('pointerup', () => {
        isPanning = false;
        draggingNodeId = null;
      });

      svg.addEventListener('pointerleave', () => {
        isPanning = false;
        draggingNodeId = null;
      });

      const initialDepth = Number(maxDepthFilter.value || graphMaxDepth);
      renderGraph(Number.isFinite(initialDepth) ? initialDepth : graphMaxDepth);
      applyViewTransform();
    </script>
  </body>
</html>`;
}

function openImpactWebviewPanel(vscodeApi, graphData, onOpenSymbol, options = {}) {
  if (!impactPanel) {
    impactPanel = vscodeApi.window.createWebviewPanel(
      'codemapImpact',
      options.panelTitle || `Codemap Impact: ${graphData.target}`,
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

  impactPanel.title = options.panelTitle || `Codemap Impact: ${graphData.target}`;
  impactPanel.webview.html = renderImpactWebviewHtml(graphData);
  return impactPanel;
}

module.exports = {
  __resetImpactWebviewPanelForTests,
  buildImpactGraphData,
  renderImpactWebviewHtml,
  openImpactWebviewPanel,
};
