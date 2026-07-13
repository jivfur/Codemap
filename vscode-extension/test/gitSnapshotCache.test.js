const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    getGitSnapshotCacheDir,
    getGitSnapshotCachePath,
    listGitSnapshotCacheEntries,
    pruneGitSnapshotCache,
    restoreGitSnapshotCache,
    saveGitSnapshotCache,
} = require("../src/gitSnapshotCache");

function makeWorkspace() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "codemap-git-cache-"));
}

test("snapshot cache path is keyed by head sha", () => {
    const root = "/tmp/repo";
    assert.equal(getGitSnapshotCacheDir(root), path.join(root, ".codemap", "git-index-cache"));
    assert.equal(getGitSnapshotCachePath(root, "abc123"), path.join(root, ".codemap", "git-index-cache", "abc123.db"));
});

test("saveGitSnapshotCache copies index db into commit cache", async () => {
    const root = makeWorkspace();
    const sourceDbPath = path.join(root, "index.db");
    fs.writeFileSync(sourceDbPath, "snapshot-data", "utf-8");

    const saved = await saveGitSnapshotCache(root, "abc123", sourceDbPath);
    assert.equal(saved, true);

    const cachePath = getGitSnapshotCachePath(root, "abc123");
    assert.equal(fs.readFileSync(cachePath, "utf-8"), "snapshot-data");
});

test("restoreGitSnapshotCache copies cached db back to index db", async () => {
    const root = makeWorkspace();
    const sourceDbPath = path.join(root, "index.db");
    fs.writeFileSync(sourceDbPath, "snapshot-data", "utf-8");

    await saveGitSnapshotCache(root, "abc123", sourceDbPath);
    fs.writeFileSync(sourceDbPath, "stale-data", "utf-8");

    const restored = await restoreGitSnapshotCache(root, "abc123", sourceDbPath);
    assert.equal(restored, true);
    assert.equal(fs.readFileSync(sourceDbPath, "utf-8"), "snapshot-data");
});

test("restoreGitSnapshotCache returns false when cache is missing", async () => {
    const root = makeWorkspace();
    const targetDbPath = path.join(root, "index.db");

    const restored = await restoreGitSnapshotCache(root, "missing", targetDbPath);
    assert.equal(restored, false);
});

test("pruneGitSnapshotCache keeps only the newest snapshots", async () => {
    const root = makeWorkspace();
    const sourceDbPath = path.join(root, "index.db");
    fs.writeFileSync(sourceDbPath, "snapshot-data", "utf-8");

    const heads = ["a1", "a2", "a3", "a4", "a5", "a6"];
    for (const head of heads) {
        await saveGitSnapshotCache(root, head, sourceDbPath);
    }

    const entries = await listGitSnapshotCacheEntries(root);
    assert.equal(entries.length, 5);
    assert.equal(entries.some((entry) => entry.path.endsWith("a1.db")), false);
    assert.equal(entries.some((entry) => entry.path.endsWith("a6.db")), true);
});

test("pruneGitSnapshotCache removes oldest snapshots beyond the limit", async () => {
    const root = makeWorkspace();
    const cacheDir = getGitSnapshotCacheDir(root);
    fs.mkdirSync(cacheDir, { recursive: true });

    const oldFiles = ["old-1.db", "old-2.db", "old-3.db"];
    for (const [index, fileName] of oldFiles.entries()) {
        const filePath = path.join(cacheDir, fileName);
        fs.writeFileSync(filePath, `data-${index}`, "utf-8");
        const date = new Date(Date.now() - (index + 3) * 1000);
        fs.utimesSync(filePath, date, date);
    }

    const removedCount = await pruneGitSnapshotCache(root, 2);
    assert.equal(removedCount, 1);
    assert.equal(fs.existsSync(path.join(cacheDir, "old-3.db")), false);
    assert.equal(fs.existsSync(path.join(cacheDir, "old-1.db")), true);
    assert.equal(fs.existsSync(path.join(cacheDir, "old-2.db")), true);
});