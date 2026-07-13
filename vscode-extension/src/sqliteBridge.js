const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

class SqliteBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SqliteBridgeError";
    this.code = code;
  }
}

function quoteSqlValue(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SqliteBridgeError("INVALID_PARAM", "Numeric SQL parameters must be finite.");
    }
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  const text = String(value).replace(/'/g, "''");
  return `'${text}'`;
}

function bindParams(sql, params = []) {
  let i = 0;
  const bound = sql.replace(/\?/g, () => {
    if (i >= params.length) {
      throw new SqliteBridgeError("PARAM_MISMATCH", "SQL parameter count does not match placeholders.");
    }
    const rendered = quoteSqlValue(params[i]);
    i += 1;
    return rendered;
  });
  if (i !== params.length) {
    throw new SqliteBridgeError("PARAM_MISMATCH", "SQL parameter count does not match placeholders.");
  }
  return bound;
}

function buildPlaceholders(count) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function assertReadonlyQuery(sql) {
  const trimmed = sql.trim();
  if (!/^with\b/i.test(trimmed) && !/^select\b/i.test(trimmed)) {
    throw new SqliteBridgeError("READONLY_ONLY", "Only SELECT/WITH read queries are allowed.");
  }
}

function normalizeSqliteError(error, dbPath) {
  const stderr = `${error?.stderr || ""} ${error?.message || ""}`.toLowerCase();
  if (error?.code === "ENOENT") {
    return new SqliteBridgeError("SQLITE_BINARY_MISSING", "sqlite3 command is not available in PATH.");
  }
  if (stderr.includes("unable to open database file") || stderr.includes("no such file")) {
    return new SqliteBridgeError("DB_MISSING", `Index database not found at ${dbPath}. Run Codemap index first.`);
  }
  if (stderr.includes("file is not a database") || stderr.includes("database disk image is malformed")) {
    return new SqliteBridgeError("DB_CORRUPT", `Index database at ${dbPath} is corrupted.`);
  }
  return new SqliteBridgeError("QUERY_FAILED", `SQLite query failed: ${error?.message || "unknown error"}`);
}

async function queryRows(workspaceRoot, sql, params = [], options = {}) {
  const sqliteCommand = options.sqliteCommand || "sqlite3";
  const runner = options.runner || execFileAsync;
  const dbPath = options.dbPath || path.join(workspaceRoot, "index.db");

  assertReadonlyQuery(sql);
  if (!fs.existsSync(dbPath)) {
    throw new SqliteBridgeError("DB_MISSING", `Index database not found at ${dbPath}. Run Codemap index first.`);
  }

  const finalSql = bindParams(sql, params);

  try {
    const result = await runner(sqliteCommand, ["-json", dbPath, finalSql], {
      cwd: workspaceRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
    if (!stdout) {
      return [];
    }
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    throw normalizeSqliteError(error, dbPath);
  }
}

async function searchSymbols(workspaceRoot, term, options = {}) {
  const like = `%${term}%`;
  const rows = await queryRows(
    workspaceRoot,
    `
    SELECT s.kind AS kind, s.qualified_name AS qualified_name, f.path AS path
    FROM symbols s
    JOIN files f ON f.id = s.file_id
    WHERE s.name LIKE ? OR s.qualified_name LIKE ? OR COALESCE(s.doc_summary, '') LIKE ?
    ORDER BY s.qualified_name
    LIMIT 50
    `,
    [like, like, like],
    options
  );

  return rows.map((row) => ({
    kind: row.kind || "symbol",
    qualifiedName: row.qualified_name || "",
    path: row.path || "",
  }));
}

async function loadSymbolBody(workspaceRoot, symbol, options = {}) {
  const rows = await queryRows(
    workspaceRoot,
    `
    SELECT s.qualified_name AS qualified_name, s.start_line AS start_line, s.end_line AS end_line, f.path AS path
    FROM symbols s
    JOIN files f ON f.id = s.file_id
    WHERE s.qualified_name = ? OR s.name = ?
    ORDER BY CASE WHEN s.qualified_name = ? THEN 0 ELSE 1 END, s.id
    LIMIT 1
    `,
    [symbol, symbol, symbol],
    options
  );

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  const relPath = String(row.path || "");
  const filePath = path.join(workspaceRoot, relPath);
  if (!fs.existsSync(filePath)) {
    throw new SqliteBridgeError("SOURCE_MISSING", `Source file not found for symbol at ${relPath}.`);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, Number(row.start_line || 1));
  const end = Math.min(lines.length, Number(row.end_line || start));

  const body = [`# ${row.qualified_name} (${relPath}:${start}-${end})`];
  for (let lineNo = start; lineNo <= end; lineNo += 1) {
    body.push(`${String(lineNo).padStart(4, " ")} | ${lines[lineNo - 1] || ""}`);
  }

  return {
    qualifiedName: row.qualified_name,
    path: relPath,
    start,
    end,
    lines: body,
  };
}

async function findSymbolLocation(workspaceRoot, symbol, options = {}) {
  const rows = await queryRows(
    workspaceRoot,
    `
    SELECT s.qualified_name AS qualified_name, s.start_line AS start_line, s.end_line AS end_line, f.path AS path
    FROM symbols s
    JOIN files f ON f.id = s.file_id
    WHERE s.qualified_name = ? OR s.name = ?
    ORDER BY CASE WHEN s.qualified_name = ? THEN 0 ELSE 1 END, s.id
    LIMIT 1
    `,
    [symbol, symbol, symbol],
    options
  );

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  return {
    qualifiedName: row.qualified_name,
    path: String(row.path || ""),
    start: Number(row.start_line || 1),
    end: Number(row.end_line || row.start_line || 1),
  };
}

async function listSymbolsForFile(workspaceRoot, relativePath, options = {}) {
  const rows = await queryRows(
    workspaceRoot,
    `
    SELECT s.kind AS kind, s.qualified_name AS qualified_name, s.start_line AS start_line
    FROM symbols s
    JOIN files f ON f.id = s.file_id
    WHERE f.path = ?
    ORDER BY s.start_line, s.id
    `,
    [relativePath],
    options
  );

  return rows.map((row) => ({
    kind: row.kind || "symbol",
    qualifiedName: row.qualified_name || "",
    start: Number(row.start_line || 1),
  }));
}

async function getNeighborsForSymbol(workspaceRoot, symbol, options = {}) {
  const target = await findSymbolLocation(workspaceRoot, symbol, options);
  if (!target) {
    return { callers: [], callees: [] };
  }

  const callers = await queryRows(
    workspaceRoot,
    `
    SELECT COALESCE(src.qualified_name, e.dst_name, e.src_id) AS symbol, e.resolved AS resolved
    FROM edges e
    LEFT JOIN symbols src ON src.id = e.src_id
    LEFT JOIN symbols dst ON dst.id = e.dst_id
    WHERE e.edge_type = 'calls'
      AND (
        (e.resolved = 1 AND dst.qualified_name = ?)
        OR (e.resolved = 0 AND e.dst_name = ?)
      )
    ORDER BY symbol
    `,
    [target.qualifiedName, target.qualifiedName],
    options
  );

  const callees = await queryRows(
    workspaceRoot,
    `
    SELECT COALESCE(dst.qualified_name, e.dst_name) AS symbol, e.resolved AS resolved
    FROM edges e
    JOIN symbols src ON src.id = e.src_id
    LEFT JOIN symbols dst ON dst.id = e.dst_id
    WHERE e.edge_type = 'calls'
      AND src.qualified_name = ?
    ORDER BY symbol
    `,
    [target.qualifiedName],
    options
  );

  return {
    callers: callers.map((row) => ({ symbol: row.symbol || "", resolved: Number(row.resolved || 0) === 1 })),
    callees: callees.map((row) => ({ symbol: row.symbol || "", resolved: Number(row.resolved || 0) === 1 })),
  };
}

async function getImpactForSymbol(workspaceRoot, symbol, options = {}) {
  const targetResolver =
    options.targetResolver ||
    (async (name) => {
      return findSymbolLocation(workspaceRoot, name, options);
    });
  const neighborsResolver =
    options.neighborsResolver ||
    (async (name) => {
      return getNeighborsForSymbol(workspaceRoot, name, options);
    });

  const target = await targetResolver(symbol);
  if (!target) {
    return null;
  }

  const maxDepth = Number(options.maxDepth || 20);
  const queue = [{ symbol: target.qualifiedName, depth: 0 }];
  const expanded = new Set();
  const impacted = new Map();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= maxDepth || expanded.has(current.symbol)) {
      continue;
    }

    expanded.add(current.symbol);
    const neighbors = await neighborsResolver(current.symbol);
    const callers = Array.isArray(neighbors?.callers) ? neighbors.callers : [];

    for (const caller of callers) {
      if (!caller?.symbol || caller.symbol === target.qualifiedName) {
        continue;
      }

      const depth = current.depth + 1;
      const resolved = Boolean(caller.resolved);
      const existing = impacted.get(caller.symbol);

      if (!existing || depth < existing.depth || (depth === existing.depth && resolved && !existing.resolved)) {
        impacted.set(caller.symbol, { symbol: caller.symbol, depth, resolved });
      }

      if (resolved && !expanded.has(caller.symbol)) {
        queue.push({ symbol: caller.symbol, depth });
      }
    }
  }

  return {
    target: target.qualifiedName,
    impacted: [...impacted.values()].sort((a, b) => {
      if (a.depth !== b.depth) {
        return a.depth - b.depth;
      }
      return a.symbol.localeCompare(b.symbol);
    }),
  };
}

async function getRepoOverviewGraph(workspaceRoot, options = {}) {
  const rawLimit = Number(options.limit || 40);
  const limit = Number.isFinite(rawLimit) ? Math.max(5, Math.min(200, Math.floor(rawLimit))) : 40;
  const rawBucket = Number(options.bucketSize || 10);
  const bucketSize = Number.isFinite(rawBucket) ? Math.max(1, Math.floor(rawBucket)) : 10;
  const rawKind = String(options.kind || "all").toLowerCase();
  const kind = new Set(["all", "function", "method", "class", "const"]).has(rawKind) ? rawKind : "all";
  const rawEdgeScope = String(options.edgeScope || "resolved").toLowerCase();
  const edgeScope = rawEdgeScope === "all" ? "all" : "resolved";
  const rawEdgeTypes = String(options.edgeTypes || "calls").toLowerCase();
  const edgeTypes = rawEdgeTypes === "calls+inherits" ? "calls+inherits" : "calls";
  const resolvedOnlyClause = edgeScope === "resolved" ? " AND e.resolved = 1" : "";
  const edgeTypeClause = edgeTypes === "calls+inherits" ? "('calls', 'inherits')" : "('calls')";

  const topRows = await queryRows(
    workspaceRoot,
    `
    WITH inbound AS (
      SELECT dst.id AS symbol_id, COUNT(*) AS count
      FROM edges e
      JOIN symbols dst ON dst.id = e.dst_id
      WHERE e.edge_type IN ${edgeTypeClause}${resolvedOnlyClause}
      GROUP BY dst.id
    ),
    outbound AS (
      SELECT src.id AS symbol_id, COUNT(*) AS count
      FROM edges e
      JOIN symbols src ON src.id = e.src_id
      WHERE e.edge_type IN ${edgeTypeClause}${resolvedOnlyClause}
      GROUP BY src.id
    )
    SELECT s.qualified_name AS qualified_name,
           s.kind AS kind,
           COALESCE(inbound.count, 0) AS inbound_calls,
           COALESCE(outbound.count, 0) AS outbound_calls
    FROM symbols s
    LEFT JOIN inbound ON inbound.symbol_id = s.id
    LEFT JOIN outbound ON outbound.symbol_id = s.id
        WHERE (? = 'all' OR s.kind = ?)
    ORDER BY inbound_calls DESC, outbound_calls DESC, s.qualified_name
    LIMIT ?
    `,
        [kind, kind, limit],
    options
  );

  const selectedNames = topRows.map((row) => row.qualified_name).filter(Boolean);
  const nodes = topRows.map((row, index) => ({
    id: row.qualified_name,
    label: row.qualified_name,
    depth: Math.min(2, Math.floor(index / bucketSize)),
    resolution: "resolved",
    kind: row.kind || "symbol",
  }));

  if (selectedNames.length === 0) {
    return { target: `Repository Overview (${kind}, ${edgeScope} edges, ${edgeTypes}, top ${limit})`, nodes, edges: [] };
  }

  const inClause = buildPlaceholders(selectedNames.length);
  const edges = await queryRows(
    workspaceRoot,
    `
    SELECT src.qualified_name AS source,
           dst.qualified_name AS target,
           e.resolved AS resolved
    FROM edges e
    JOIN symbols src ON src.id = e.src_id
    JOIN symbols dst ON dst.id = e.dst_id
    WHERE e.edge_type IN ${edgeTypeClause}
      ${resolvedOnlyClause}
      AND src.qualified_name IN (${inClause})
      AND dst.qualified_name IN (${inClause})
    ORDER BY source, target
    `,
    [...selectedNames, ...selectedNames],
    options
  );

  return {
    target: `Repository Overview (${kind}, ${edgeScope} edges, ${edgeTypes}, top ${limit})`,
    nodes,
    edges: edges.map((row) => ({
      from: row.source,
      to: row.target,
      resolution: Number(row.resolved || 0) === 1 ? "resolved" : "unresolved",
    })),
  };
}

module.exports = {
  SqliteBridgeError,
  bindParams,
  queryRows,
  searchSymbols,
  loadSymbolBody,
  findSymbolLocation,
  listSymbolsForFile,
  getNeighborsForSymbol,
  getImpactForSymbol,
  getRepoOverviewGraph,
};
