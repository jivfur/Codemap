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

module.exports = {
  SqliteBridgeError,
  bindParams,
  queryRows,
  searchSymbols,
  loadSymbolBody,
  findSymbolLocation,
  listSymbolsForFile,
  getNeighborsForSymbol,
};
