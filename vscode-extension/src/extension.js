const path = require("node:path");
const { resolveGitHead, resolveGitWorkingTreeClean, runGraphCommand } = require("./bridge");
const {
  SqliteBridgeError,
  findSymbolLocation,
  getImpactForSymbol,
  getNeighborsForSymbol,
  getRepoOverviewGraph,
  listSymbolsForFile,
  loadSymbolBody,
  searchSymbols,
} = require("./sqliteBridge");
const { createCallerCodeLensProvider } = require("./codelens");
const { buildImpactGraphData, openImpactWebviewPanel } = require("./impactWebview");
const { getGitSnapshotCacheStats, restoreGitSnapshotCache, saveGitSnapshotCache } = require("./gitSnapshotCache");
const { createCodemapTreeProvider } = require("./treeView");

const SUPPORTED_EXTENSIONS = new Set([".py", ".js", ".jsx", ".ts", ".tsx"]);

function getWorkspaceRoot(vscodeApi) {
  const folders = vscodeApi.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return null;
  }
  return folders[0].uri.fsPath;
}

function register(disposables, disposable) {
  disposables.push(disposable);
}

function sqliteErrorMessage(error, context) {
  if (error instanceof SqliteBridgeError) {
    return `Codemap ${context} failed: ${error.message}`;
  }
  return `Codemap ${context} failed: ${error.message}`;
}

function formatImpactMarkdown(result) {
  const lines = [`# Impact for ${result.target}`];
  if (!Array.isArray(result.impacted) || result.impacted.length === 0) {
    lines.push("No callers found.");
    return lines;
  }
  lines.push("| Depth | Symbol | Resolution |");
  lines.push("|---|---|---|");
  for (const row of result.impacted) {
    lines.push(`| ${row.depth} | ${row.symbol} | ${row.resolved ? "resolved" : "unresolved"} |`);
  }
  return lines;
}

function formatByteCount(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes || 0);
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatGitSnapshotCacheStatsMarkdown(stats) {
  const lines = ["# Git Snapshot Cache Stats"];
  lines.push(`- Retention limit: ${stats.retentionLimit}`);
  lines.push(`- Snapshot count: ${stats.entryCount}`);
  lines.push(`- Total size: ${formatByteCount(stats.totalBytes)}`);

  if (stats.newest) {
    lines.push(`- Newest snapshot: ${stats.newest.headSha}`);
  }

  if (stats.oldest) {
    lines.push(`- Oldest snapshot: ${stats.oldest.headSha}`);
  }

  lines.push("");
  lines.push("| Commit | Size | Modified |");
  lines.push("|---|---|---|");

  if (stats.entries.length === 0) {
    lines.push("| _none_ | - | - |");
    return lines;
  }

  for (const entry of stats.entries) {
    const modified = new Date(entry.mtimeMs).toISOString();
    lines.push(`| ${entry.headSha} | ${formatByteCount(entry.size)} | ${modified} |`);
  }

  return lines;
}

function isSupportedSavedDocument(workspaceRoot, document) {
  if (!workspaceRoot || !document?.uri?.fsPath) {
    return false;
  }

  const fsPath = String(document.uri.fsPath);
  const relPath = path.relative(workspaceRoot, fsPath);
  if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
    return false;
  }

  const ext = path.extname(fsPath).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

function activateWithApi(vscodeApi, context, deps = {}) {
  const runCommand = deps.runGraphCommand || runGraphCommand;
  const resolveHead = deps.resolveGitHead || resolveGitHead;
  const resolveWorkingTreeClean = deps.resolveGitWorkingTreeClean || resolveGitWorkingTreeClean;
  const restoreSnapshotCache = deps.restoreGitSnapshotCache || restoreGitSnapshotCache;
  const saveSnapshotCache = deps.saveGitSnapshotCache || saveGitSnapshotCache;
  const searchWithSqlite = deps.searchSymbols || searchSymbols;
  const loadBodyWithSqlite = deps.loadSymbolBody || loadSymbolBody;
  const findLocationWithSqlite = deps.findSymbolLocation || findSymbolLocation;
  const impactWithSqlite = deps.getImpactForSymbol || getImpactForSymbol;
  const getSnapshotCacheStats = deps.getGitSnapshotCacheStats || getGitSnapshotCacheStats;
  const repoOverviewWithSqlite = deps.getRepoOverviewGraph || getRepoOverviewGraph;
  const listSymbols = deps.listSymbolsForFile || listSymbolsForFile;
  const getNeighbors = deps.getNeighborsForSymbol || getNeighborsForSymbol;
  const schedule = deps.schedule || ((fn, delayMs) => setTimeout(fn, delayMs));
  const cancelSchedule = deps.cancelSchedule || ((handle) => clearTimeout(handle));
  const saveDebounceMs = Number(deps.saveDebounceMs || 500);
  const gitHeadPollMs = Math.max(1000, Number(deps.gitHeadPollMs || 5000));
  const enableGitHeadPolling = deps.enableGitHeadPolling !== false;
  const pendingSaveReindex = new Map();
  let lastSyncedGitHead = null;
  let pendingGitHeadPoll = null;
  let gitHeadPollInFlight = false;

  async function openSymbolLocationByName(symbol) {
    const currentRoot = getWorkspaceRoot(vscodeApi);
    if (!currentRoot) {
      vscodeApi.window.showWarningMessage("Codemap: open a workspace folder first.");
      return;
    }
    if (!symbol) {
      return;
    }

    const location = await findLocationWithSqlite(currentRoot, symbol);
    if (!location) {
      vscodeApi.window.showInformationMessage("Symbol not found.");
      return;
    }

    const uri = vscodeApi.Uri.file(path.join(currentRoot, location.path));
    const document = await vscodeApi.workspace.openTextDocument(uri);
    const editor = await vscodeApi.window.showTextDocument(document, {
      preview: true,
    });

    const startLine = Math.max(0, Number(location.start || 1) - 1);
    const endLine = Math.max(startLine, Number(location.end || location.start || 1) - 1);
    const startPos = new vscodeApi.Position(startLine, 0);
    const endPos = new vscodeApi.Position(endLine, Number.MAX_SAFE_INTEGER);
    const range = new vscodeApi.Range(startPos, endPos);
    editor.selection = new vscodeApi.Selection(startPos, startPos);
    editor.revealRange(range, vscodeApi.TextEditorRevealType.InCenter);
  }

  async function runFindSymbolFlow(queryTitle, queryPrompt) {
    const currentRoot = getWorkspaceRoot(vscodeApi);
    if (!currentRoot) {
      vscodeApi.window.showWarningMessage("Codemap: open a workspace folder first.");
      return;
    }

    const query = await vscodeApi.window.showInputBox({
      title: queryTitle,
      prompt: queryPrompt,
      ignoreFocusOut: true,
    });

    if (!query) {
      return;
    }

    const rows = await searchWithSqlite(currentRoot, query);
    if (rows.length === 0) {
      vscodeApi.window.showInformationMessage("No symbol matches.");
      return;
    }

    const selection = await vscodeApi.window.showQuickPick(
      rows.map((row) => ({
        label: `${row.qualifiedName} (${row.path})`,
        description: row.kind,
        symbol: row.qualifiedName,
      })),
      { title: "Codemap Results" }
    );

    if (selection?.symbol) {
      await openSymbolLocationByName(selection.symbol);
    }
  }

  const root = getWorkspaceRoot(vscodeApi);
  if (root) {
    const indexDbPath = path.join(root, "index.db");
    const lastSyncedGitHeadKey = "codemap.lastSyncedGitHead";
    const workspaceState = context.workspaceState || {
      get: () => null,
      update: async () => { },
    };

    lastSyncedGitHead = workspaceState.get(lastSyncedGitHeadKey, null);

    async function runChangedOnlyReindex(reasonLabel) {
      try {
        const result = await runCommand(root, ["index", "--changed-only"]);
        const fallbackMessage = `Codemap ${reasonLabel} reindex complete.`;
        const message = result.lines[0] || fallbackMessage;
        if (typeof vscodeApi.window.setStatusBarMessage === "function") {
          vscodeApi.window.setStatusBarMessage(message, 2500);
        }
      } catch (error) {
        vscodeApi.window.showWarningMessage(`Codemap ${reasonLabel} reindex failed: ${error.message}`);
      }
    }

    async function syncGitSnapshot(reasonLabel) {
      if (gitHeadPollInFlight) {
        return "in-flight";
      }

      gitHeadPollInFlight = true;
      try {
        const currentHead = await resolveHead(root);
        if (!currentHead) {
          return "unavailable";
        }

        const workingTreeClean = await resolveWorkingTreeClean(root);
        if (workingTreeClean === null) {
          return "unavailable";
        }

        if (lastSyncedGitHead === null) {
          if (workingTreeClean) {
            const restored = await restoreSnapshotCache(root, currentHead, indexDbPath);
            if (restored) {
              lastSyncedGitHead = currentHead;
              await workspaceState.update(lastSyncedGitHeadKey, currentHead);
              return "restored";
            }
          }

          lastSyncedGitHead = currentHead;
          await workspaceState.update(lastSyncedGitHeadKey, currentHead);
          return "baseline";
        }

        if (currentHead === lastSyncedGitHead) {
          return "unchanged";
        }

        if (workingTreeClean) {
          const restored = await restoreSnapshotCache(root, currentHead, indexDbPath);
          if (restored) {
            lastSyncedGitHead = currentHead;
            await workspaceState.update(lastSyncedGitHeadKey, currentHead);
            return "restored";
          }
        }

        await runChangedOnlyReindex(reasonLabel);
        if (workingTreeClean) {
          await saveSnapshotCache(root, currentHead, indexDbPath);
        }
        lastSyncedGitHead = currentHead;
        await workspaceState.update(lastSyncedGitHeadKey, currentHead);
        return workingTreeClean ? "rebuilt-and-cached" : "rebuilt";
      } finally {
        gitHeadPollInFlight = false;
      }
    }

    async function pollGitHeadAndMaybeReindex() {
      return syncGitSnapshot("git update");
    }

    function scheduleGitHeadPoll() {
      pendingGitHeadPoll = schedule(async () => {
        pendingGitHeadPoll = null;
        await pollGitHeadAndMaybeReindex();
        scheduleGitHeadPoll();
      }, gitHeadPollMs);
    }

    if (enableGitHeadPolling) {
      void syncGitSnapshot("git startup");
      scheduleGitHeadPoll();
      register(context.subscriptions, {
        dispose: () => {
          if (pendingGitHeadPoll) {
            cancelSchedule(pendingGitHeadPoll);
            pendingGitHeadPoll = null;
          }
        },
      });
    }

    const provider = createCodemapTreeProvider(vscodeApi, root, {
      listSymbolsForFile: listSymbols,
      getNeighborsForSymbol: getNeighbors,
    });
    const treeView = vscodeApi.window.createTreeView("codemap.neighborsView", {
      treeDataProvider: provider,
      showCollapseAll: true,
    });
    register(context.subscriptions, treeView);
    register(
      context.subscriptions,
      vscodeApi.window.onDidChangeActiveTextEditor(() => {
        provider.refresh();
      })
    );
    register(
      context.subscriptions,
      vscodeApi.commands.registerCommand("codemap.refreshNeighbors", () => {
        provider.refresh();
      })
    );

    register(
      context.subscriptions,
      vscodeApi.commands.registerCommand("codemap.checkGitUpdates", async () => {
        const result = await syncGitSnapshot("git update");
        if (result === "unchanged" && typeof vscodeApi.window.setStatusBarMessage === "function") {
          vscodeApi.window.setStatusBarMessage("Codemap git state unchanged.", 2500);
        } else if (result === "restored" && typeof vscodeApi.window.setStatusBarMessage === "function") {
          vscodeApi.window.setStatusBarMessage("Codemap git snapshot restored.", 2500);
        } else if (result === "rebuilt-and-cached" && typeof vscodeApi.window.setStatusBarMessage === "function") {
          vscodeApi.window.setStatusBarMessage("Codemap git snapshot rebuilt and cached.", 2500);
        } else if (result === "rebuilt" && typeof vscodeApi.window.setStatusBarMessage === "function") {
          vscodeApi.window.setStatusBarMessage("Codemap git snapshot rebuilt.", 2500);
        } else if (result === "unavailable") {
          vscodeApi.window.showWarningMessage("Codemap git check failed: unable to resolve HEAD.");
        }
      })
    );

    register(
      context.subscriptions,
      vscodeApi.commands.registerCommand("codemap.showGitSnapshotCacheStats", async () => {
        const stats = await getSnapshotCacheStats(root);
        const doc = await vscodeApi.workspace.openTextDocument({
          language: "markdown",
          content: formatGitSnapshotCacheStatsMarkdown(stats).join("\n"),
        });
        await vscodeApi.window.showTextDocument(doc, {
          preview: true,
          viewColumn: vscodeApi.ViewColumn.Beside,
        });
      })
    );

    register(
      context.subscriptions,
      vscodeApi.workspace.onDidSaveTextDocument((document) => {
        if (!isSupportedSavedDocument(root, document)) {
          return;
        }

        const filePath = String(document.uri.fsPath);
        const existing = pendingSaveReindex.get(filePath);
        if (existing) {
          cancelSchedule(existing);
        }

        const handle = schedule(async () => {
          pendingSaveReindex.delete(filePath);
          await runChangedOnlyReindex("on-save");
        }, saveDebounceMs);

        pendingSaveReindex.set(filePath, handle);
      })
    );

    const codeLensProvider = createCallerCodeLensProvider(vscodeApi, root, {
      listSymbolsForFile: listSymbols,
      getNeighborsForSymbol: getNeighbors,
    });
    register(
      context.subscriptions,
      vscodeApi.languages.registerCodeLensProvider(
        [
          { language: "python", scheme: "file" },
          { language: "javascript", scheme: "file" },
          { language: "typescript", scheme: "file" },
        ],
        codeLensProvider
      )
    );
  }

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.indexWorkspace", async () => {
      const currentRoot = getWorkspaceRoot(vscodeApi);
      if (!currentRoot) {
        vscodeApi.window.showWarningMessage("Codemap: open a workspace folder first.");
        return;
      }

      try {
        const result = await runCommand(currentRoot, ["index"]);
        const message = result.lines[0] || "Codemap index updated.";
        vscodeApi.window.showInformationMessage(message);
      } catch (error) {
        vscodeApi.window.showErrorMessage(`Codemap index failed: ${error.message}`);
      }
    })
  );

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.searchSymbol", async () => {
      try {
        await runFindSymbolFlow("Codemap Search", "Enter symbol or text to search in index");
      } catch (error) {
        vscodeApi.window.showErrorMessage(sqliteErrorMessage(error, "search"));
      }
    })
  );

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.findSymbol", async () => {
      try {
        await runFindSymbolFlow("Repo Graph: Find Symbol", "Search by name, qualified name, or docs");
      } catch (error) {
        vscodeApi.window.showErrorMessage(sqliteErrorMessage(error, "find symbol"));
      }
    })
  );

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.showSymbolBody", async () => {
      const currentRoot = getWorkspaceRoot(vscodeApi);
      if (!currentRoot) {
        vscodeApi.window.showWarningMessage("Codemap: open a workspace folder first.");
        return;
      }

      const symbol = await vscodeApi.window.showInputBox({
        title: "Codemap Body",
        prompt: "Enter qualified or short symbol name",
        ignoreFocusOut: true,
      });

      if (!symbol) {
        return;
      }

      try {
        const result = await loadBodyWithSqlite(currentRoot, symbol);
        if (!result) {
          vscodeApi.window.showInformationMessage("Symbol not found.");
          return;
        }
        const doc = await vscodeApi.workspace.openTextDocument({
          language: "markdown",
          content: result.lines.join("\n"),
        });
        await vscodeApi.window.showTextDocument(doc, {
          preview: true,
          viewColumn: vscodeApi.ViewColumn.Beside,
        });
      } catch (error) {
        vscodeApi.window.showErrorMessage(sqliteErrorMessage(error, "body"));
      }
    })
  );

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.openSymbolLocation", async (symbol) => {
      try {
        await openSymbolLocationByName(symbol);
      } catch (error) {
        vscodeApi.window.showErrorMessage(sqliteErrorMessage(error, "open symbol"));
      }
    })
  );

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.showImpact", async () => {
      const currentRoot = getWorkspaceRoot(vscodeApi);
      if (!currentRoot) {
        vscodeApi.window.showWarningMessage("Codemap: open a workspace folder first.");
        return;
      }

      const symbol = await vscodeApi.window.showInputBox({
        title: "Repo Graph: Show Impact",
        prompt: "Enter qualified or short symbol name",
        ignoreFocusOut: true,
      });

      if (!symbol) {
        return;
      }

      try {
        const impact = await impactWithSqlite(currentRoot, symbol);
        if (!impact) {
          vscodeApi.window.showInformationMessage("Symbol not found.");
          return;
        }

        const doc = await vscodeApi.workspace.openTextDocument({
          language: "markdown",
          content: formatImpactMarkdown(impact).join("\n"),
        });
        await vscodeApi.window.showTextDocument(doc, {
          preview: true,
          viewColumn: vscodeApi.ViewColumn.Beside,
        });
      } catch (error) {
        vscodeApi.window.showErrorMessage(sqliteErrorMessage(error, "impact"));
      }
    })
  );

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.openImpactWebview", async (initialSymbol) => {
      const currentRoot = getWorkspaceRoot(vscodeApi);
      if (!currentRoot) {
        vscodeApi.window.showWarningMessage("Codemap: open a workspace folder first.");
        return;
      }

      const symbol = initialSymbol
        ? String(initialSymbol)
        : await vscodeApi.window.showInputBox({
          title: "Repo Graph: Open Impact Webview",
          prompt: "Enter qualified or short symbol name",
          ignoreFocusOut: true,
        });

      if (!symbol) {
        return;
      }

      try {
        const impact = await impactWithSqlite(currentRoot, symbol);
        if (!impact) {
          vscodeApi.window.showInformationMessage("Symbol not found.");
          return;
        }

        const graphData = buildImpactGraphData(impact);
        openImpactWebviewPanel(vscodeApi, graphData, async (selectedSymbol) => {
          await openSymbolLocationByName(selectedSymbol);
        });
      } catch (error) {
        vscodeApi.window.showErrorMessage(sqliteErrorMessage(error, "impact webview"));
      }
    })
  );

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.openRepoOverview", async () => {
      const currentRoot = getWorkspaceRoot(vscodeApi);
      if (!currentRoot) {
        vscodeApi.window.showWarningMessage("Codemap: open a workspace folder first.");
        return;
      }

      const kindPick = await vscodeApi.window.showQuickPick(
        [
          { label: "All symbol kinds", kind: "all" },
          { label: "Functions", kind: "function" },
          { label: "Methods", kind: "method" },
          { label: "Classes", kind: "class" },
        ],
        { title: "Repo Graph: Overview Symbol Kind" }
      );
      if (!kindPick) {
        return;
      }
      const selectedKind = kindPick?.kind || "all";

      const edgeScopePick = await vscodeApi.window.showQuickPick(
        [
          { label: "Resolved edges only", edgeScope: "resolved" },
          { label: "All edges (including unresolved)", edgeScope: "all" },
        ],
        { title: "Repo Graph: Overview Edge Scope" }
      );
      if (!edgeScopePick) {
        return;
      }
      const selectedEdgeScope = edgeScopePick?.edgeScope || "resolved";

      const edgeTypesPick = await vscodeApi.window.showQuickPick(
        [
          { label: "Calls only", edgeTypes: "calls" },
          { label: "Calls + Inheritance", edgeTypes: "calls+inherits" },
        ],
        { title: "Repo Graph: Overview Edge Types" }
      );
      if (!edgeTypesPick) {
        return;
      }
      const selectedEdgeTypes = edgeTypesPick?.edgeTypes || "calls";

      const rankBalancePick = await vscodeApi.window.showQuickPick(
        [
          { label: "Inbound-heavy ranking", rankBalance: "inbound" },
          { label: "Balanced ranking", rankBalance: "balanced" },
          { label: "Outbound-heavy ranking", rankBalance: "outbound" },
        ],
        { title: "Repo Graph: Overview Ranking Balance" }
      );
      if (!rankBalancePick) {
        return;
      }
      const selectedRankBalance = rankBalancePick?.rankBalance || "inbound";

      const labelModePick = await vscodeApi.window.showQuickPick(
        [
          { label: "Qualified symbol labels", labelMode: "qualified" },
          { label: "Short labels with kind", labelMode: "short-kind" },
        ],
        { title: "Repo Graph: Overview Node Labels" }
      );
      if (!labelModePick) {
        return;
      }
      const selectedLabelMode = labelModePick?.labelMode || "short-kind";

      const nodeSizeModePick = await vscodeApi.window.showQuickPick(
        [
          { label: "Degree-weighted node sizes", nodeSizeMode: "degree" },
          { label: "Fixed node sizes", nodeSizeMode: "fixed" },
        ],
        { title: "Repo Graph: Overview Node Sizes" }
      );
      if (!nodeSizeModePick) {
        return;
      }
      const selectedNodeSizeMode = nodeSizeModePick?.nodeSizeMode || "degree";

      let fixedNodeSize = 11;
      let minNodeSize = 9;
      let maxNodeSize = 22;

      if (selectedNodeSizeMode === "fixed") {
        const fixedNodeSizeInput = await vscodeApi.window.showInputBox({
          title: "Repo Graph: Overview Fixed Node Size",
          prompt: "Node radius to use when node size mode is fixed",
          value: "11",
          ignoreFocusOut: true,
        });
        if (fixedNodeSizeInput === undefined) {
          return;
        }
        const parsedFixedNodeSize = Number(fixedNodeSizeInput);
        fixedNodeSize = Number.isFinite(parsedFixedNodeSize)
          ? Math.max(6, Math.min(40, Math.floor(parsedFixedNodeSize)))
          : 11;
      } else {
        const maxNodeSizeInput = await vscodeApi.window.showInputBox({
          title: "Repo Graph: Overview Maximum Node Size",
          prompt: "Maximum node radius for degree-weighted sizing",
          value: "22",
          ignoreFocusOut: true,
        });
        if (maxNodeSizeInput === undefined) {
          return;
        }
        const parsedMaxNodeSize = Number(maxNodeSizeInput);
        maxNodeSize = Number.isFinite(parsedMaxNodeSize)
          ? Math.max(9, Math.min(60, Math.floor(parsedMaxNodeSize)))
          : 22;

        const minNodeSizeInput = await vscodeApi.window.showInputBox({
          title: "Repo Graph: Overview Minimum Node Size",
          prompt: "Minimum node radius for degree-weighted sizing",
          value: "9",
          ignoreFocusOut: true,
        });
        if (minNodeSizeInput === undefined) {
          return;
        }
        const parsedMinNodeSize = Number(minNodeSizeInput);
        const minNodeSizeBase = Number.isFinite(parsedMinNodeSize)
          ? Math.max(9, Math.min(60, Math.floor(parsedMinNodeSize)))
          : 9;
        minNodeSize = Math.min(minNodeSizeBase, maxNodeSize);
      }

      const labelLengthInput = await vscodeApi.window.showInputBox({
        title: "Repo Graph: Overview Label Length",
        prompt: "Maximum node label length (characters)",
        value: "28",
        ignoreFocusOut: true,
      });
      if (labelLengthInput === undefined) {
        return;
      }
      const parsedLabelLength = Number(labelLengthInput);
      const maxLabelLength = Number.isFinite(parsedLabelLength)
        ? Math.max(8, Math.min(120, Math.floor(parsedLabelLength)))
        : 28;

      const minDegreeInput = await vscodeApi.window.showInputBox({
        title: "Repo Graph: Overview Minimum Degree",
        prompt: "Minimum total calls (inbound + outbound) for included nodes",
        value: "0",
        ignoreFocusOut: true,
      });
      if (minDegreeInput === undefined) {
        return;
      }
      const parsedMinDegree = Number(minDegreeInput);
      const minDegree = Number.isFinite(parsedMinDegree)
        ? Math.max(0, Math.min(10000, Math.floor(parsedMinDegree)))
        : 0;

      const minInboundInput = await vscodeApi.window.showInputBox({
        title: "Repo Graph: Overview Minimum Inbound Calls",
        prompt: "Minimum inbound call count for included nodes",
        value: "0",
        ignoreFocusOut: true,
      });
      if (minInboundInput === undefined) {
        return;
      }
      const parsedMinInbound = Number(minInboundInput);
      const minInboundCalls = Number.isFinite(parsedMinInbound)
        ? Math.max(0, Math.min(10000, Math.floor(parsedMinInbound)))
        : 0;

      const minOutboundInput = await vscodeApi.window.showInputBox({
        title: "Repo Graph: Overview Minimum Outbound Calls",
        prompt: "Minimum outbound call count for included nodes",
        value: "0",
        ignoreFocusOut: true,
      });
      if (minOutboundInput === undefined) {
        return;
      }
      const parsedMinOutbound = Number(minOutboundInput);
      const minOutboundCalls = Number.isFinite(parsedMinOutbound)
        ? Math.max(0, Math.min(10000, Math.floor(parsedMinOutbound)))
        : 0;

      const topInput = await vscodeApi.window.showInputBox({
        title: "Repo Graph: Overview Size",
        prompt: "How many top symbols to include?",
        value: "40",
        ignoreFocusOut: true,
      });
      if (topInput === undefined) {
        return;
      }
      const parsedTop = Number(topInput);
      const limit = Number.isFinite(parsedTop) ? Math.max(5, Math.min(200, Math.floor(parsedTop))) : 40;

      const depthBucketsInput = await vscodeApi.window.showInputBox({
        title: "Repo Graph: Overview Depth Buckets",
        prompt: "How many ranking buckets to map into visual depth bands?",
        value: "4",
        ignoreFocusOut: true,
      });
      if (depthBucketsInput === undefined) {
        return;
      }
      const parsedDepthBuckets = Number(depthBucketsInput);
      const depthBuckets = Number.isFinite(parsedDepthBuckets)
        ? Math.max(2, Math.min(24, Math.floor(parsedDepthBuckets)))
        : 4;
      const bucketSize = Math.max(1, Math.floor(limit / depthBuckets));

      try {
        const overview = await repoOverviewWithSqlite(currentRoot, {
          limit,
          bucketSize,
          depthBuckets,
          kind: selectedKind,
          edgeScope: selectedEdgeScope,
          edgeTypes: selectedEdgeTypes,
          rankBalance: selectedRankBalance,
          labelMode: selectedLabelMode,
          nodeSizeMode: selectedNodeSizeMode,
          fixedNodeSize,
          minNodeSize,
          maxNodeSize,
          maxLabelLength,
          minDegree,
          minInboundCalls,
          minOutboundCalls,
        });
        if (!overview || overview.nodes.length === 0) {
          vscodeApi.window.showInformationMessage("No symbols found for repository overview.");
          return;
        }

        openImpactWebviewPanel(
          vscodeApi,
          overview,
          async (selectedSymbol) => {
            await openSymbolLocationByName(selectedSymbol);
          },
          {
            panelTitle: `Codemap Repository Overview (${selectedKind}, ${selectedEdgeScope} edges, ${selectedEdgeTypes}, ${selectedRankBalance} rank, ${selectedLabelMode} labels<=${maxLabelLength}, ${selectedNodeSizeMode === "fixed" ? `fixed size=${fixedNodeSize}` : `size=${minNodeSize}-${maxNodeSize}`}, min degree>=${minDegree}, min inbound>=${minInboundCalls}, min outbound>=${minOutboundCalls}, depth buckets=${depthBuckets}, top ${limit})`,
          }
        );
      } catch (error) {
        vscodeApi.window.showErrorMessage(sqliteErrorMessage(error, "repo overview"));
      }
    })
  );

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.reindexWorkspace", async () => {
      const currentRoot = getWorkspaceRoot(vscodeApi);
      if (!currentRoot) {
        vscodeApi.window.showWarningMessage("Codemap: open a workspace folder first.");
        return;
      }

      try {
        const result = await runCommand(currentRoot, ["index", "--changed-only"]);
        const message = result.lines[0] || "Codemap reindex complete.";
        vscodeApi.window.showInformationMessage(message);
      } catch (error) {
        vscodeApi.window.showErrorMessage(`Codemap reindex failed: ${error.message}`);
      }
    })
  );

  register(
    context.subscriptions,
    vscodeApi.commands.registerCommand("codemap.showCallersForSymbol", async (symbol, callers) => {
      const entries = Array.isArray(callers) ? callers : [];
      if (entries.length === 0) {
        vscodeApi.window.showInformationMessage(`No callers found for ${symbol}.`);
        return;
      }

      const selection = await vscodeApi.window.showQuickPick(
        entries.map((row) => ({
          label: row.symbol,
          description: row.resolved ? "resolved" : "unresolved",
          symbol: row.symbol,
          resolved: Boolean(row.resolved),
        })),
        { title: `Callers for ${symbol}` }
      );

      if (!selection) {
        return;
      }

      if (!selection.resolved) {
        vscodeApi.window.showInformationMessage(`Caller ${selection.symbol} is unresolved.`);
        return;
      }

      try {
        await openSymbolLocationByName(selection.symbol);
      } catch (error) {
        vscodeApi.window.showErrorMessage(sqliteErrorMessage(error, "show callers"));
      }
    })
  );

  return {
    rootPathHint: path.basename(getWorkspaceRoot(vscodeApi) || ""),
  };
}

function activate(context) {
  const vscode = require("vscode");
  return activateWithApi(vscode, context);
}

function deactivate() { }

module.exports = {
  activate,
  deactivate,
  activateWithApi,
  isSupportedSavedDocument,
  formatImpactMarkdown,
  formatByteCount,
  formatGitSnapshotCacheStatsMarkdown,
};
