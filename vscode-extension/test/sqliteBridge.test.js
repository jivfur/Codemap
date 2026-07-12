const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SqliteBridgeError, bindParams, getImpactForSymbol, queryRows, searchSymbols } = require("../src/sqliteBridge");

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codemap-sqlite-"));
}

test("bindParams escapes values and enforces counts", () => {
  const sql = bindParams("SELECT * FROM symbols WHERE name = ? AND file_id = ?", ["O'Brien", 7]);
  assert.equal(sql, "SELECT * FROM symbols WHERE name = 'O''Brien' AND file_id = 7");

  assert.throws(() => bindParams("SELECT ?", []), /parameter count/i);
  assert.throws(() => bindParams("SELECT 1", ["extra"]), /parameter count/i);
});

test("queryRows rejects non-readonly SQL", async () => {
  const root = makeWorkspace();
  fs.writeFileSync(path.join(root, "index.db"), "", "utf-8");

  await assert.rejects(() => queryRows(root, "DELETE FROM symbols"), (error) => {
    assert.equal(error.code, "READONLY_ONLY");
    return true;
  });
});

test("queryRows reports missing DB", async () => {
  const root = makeWorkspace();

  await assert.rejects(() => queryRows(root, "SELECT 1"), (error) => {
    assert.equal(error.code, "DB_MISSING");
    return true;
  });
});

test("queryRows maps corrupt DB errors", async () => {
  const root = makeWorkspace();
  const dbPath = path.join(root, "index.db");
  fs.writeFileSync(dbPath, "not-a-db", "utf-8");

  const fakeRunner = async () => {
    const err = new Error("bad db");
    err.stderr = "Error: file is not a database";
    throw err;
  };

  await assert.rejects(
    () => queryRows(root, "SELECT 1", [], { runner: fakeRunner, dbPath }),
    (error) => {
      assert.ok(error instanceof SqliteBridgeError);
      assert.equal(error.code, "DB_CORRUPT");
      return true;
    }
  );
});

test("searchSymbols returns normalized rows", async () => {
  const root = makeWorkspace();
  const dbPath = path.join(root, "index.db");
  fs.writeFileSync(dbPath, "db", "utf-8");

  const fakeRunner = async () => ({
    stdout: JSON.stringify([
      { kind: "function", qualified_name: "pkg.mod.run", path: "pkg/mod.py" },
      { kind: "class", qualified_name: "pkg.mod.Service", path: "pkg/mod.py" },
    ]),
    stderr: "",
  });

  const rows = await searchSymbols(root, "run", {
    dbPath,
    runner: fakeRunner,
  });

  assert.deepEqual(rows, [
    { kind: "function", qualifiedName: "pkg.mod.run", path: "pkg/mod.py" },
    { kind: "class", qualifiedName: "pkg.mod.Service", path: "pkg/mod.py" },
  ]);
});

test("getImpactForSymbol returns deterministic BFS closure", async () => {
  const graph = {
    "pkg.mod.target": {
      callers: [
        { symbol: "pkg.mod.a", resolved: true },
        { symbol: "pkg.mod.unresolved", resolved: false },
      ],
      callees: [],
    },
    "pkg.mod.a": {
      callers: [{ symbol: "pkg.mod.b", resolved: true }],
      callees: [],
    },
    "pkg.mod.b": {
      callers: [{ symbol: "pkg.mod.target", resolved: true }],
      callees: [],
    },
  };

  const result = await getImpactForSymbol("/tmp/repo", "target", {
    targetResolver: async () => ({ qualifiedName: "pkg.mod.target" }),
    neighborsResolver: async (symbol) => graph[symbol] || { callers: [], callees: [] },
  });

  assert.equal(result.target, "pkg.mod.target");
  assert.deepEqual(result.impacted, [
    { symbol: "pkg.mod.a", depth: 1, resolved: true },
    { symbol: "pkg.mod.unresolved", depth: 1, resolved: false },
    { symbol: "pkg.mod.b", depth: 2, resolved: true },
  ]);
});
