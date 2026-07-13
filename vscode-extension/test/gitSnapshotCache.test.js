const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    getGitSnapshotCacheDir,
    getGitSnapshotCachePath,
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