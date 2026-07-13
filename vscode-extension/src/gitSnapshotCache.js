const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_MAX_SNAPSHOTS = 5;

function getGitSnapshotCacheDir(workspaceRoot) {
    return path.join(workspaceRoot, ".codemap", "git-index-cache");
}

function getGitSnapshotCachePath(workspaceRoot, headSha) {
    return path.join(getGitSnapshotCacheDir(workspaceRoot), `${headSha}.db`);
}

async function saveGitSnapshotCache(workspaceRoot, headSha, sourceDbPath) {
    if (!workspaceRoot || !headSha || !sourceDbPath) {
        return false;
    }

    const cachePath = getGitSnapshotCachePath(workspaceRoot, headSha);
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.copyFile(sourceDbPath, cachePath);
    await pruneGitSnapshotCache(workspaceRoot, DEFAULT_MAX_SNAPSHOTS);
    return true;
}

async function listGitSnapshotCacheEntries(workspaceRoot) {
    const cacheDir = getGitSnapshotCacheDir(workspaceRoot);

    try {
        const entries = await fs.readdir(cacheDir, { withFileTypes: true });
        const cacheFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".db"));
        const stats = await Promise.all(
            cacheFiles.map(async (entry) => {
                const fullPath = path.join(cacheDir, entry.name);
                const stat = await fs.stat(fullPath);
                return { path: fullPath, mtimeMs: stat.mtimeMs };
            })
        );
        return stats.sort((left, right) => right.mtimeMs - left.mtimeMs);
    } catch (error) {
        if (error && error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
}

async function pruneGitSnapshotCache(workspaceRoot, maxSnapshots = DEFAULT_MAX_SNAPSHOTS) {
    const limit = Number.isFinite(maxSnapshots) ? Math.max(0, Math.floor(maxSnapshots)) : DEFAULT_MAX_SNAPSHOTS;
    const entries = await listGitSnapshotCacheEntries(workspaceRoot);

    if (entries.length <= limit) {
        return 0;
    }

    const removedEntries = entries.slice(limit);
    await Promise.all(removedEntries.map(async (entry) => {
        await fs.unlink(entry.path);
    }));
    return removedEntries.length;
}

async function restoreGitSnapshotCache(workspaceRoot, headSha, targetDbPath) {
    if (!workspaceRoot || !headSha || !targetDbPath) {
        return false;
    }

    const cachePath = getGitSnapshotCachePath(workspaceRoot, headSha);
    try {
        await fs.copyFile(cachePath, targetDbPath);
        return true;
    } catch (error) {
        if (error && error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

module.exports = {
    getGitSnapshotCacheDir,
    getGitSnapshotCachePath,
    listGitSnapshotCacheEntries,
    restoreGitSnapshotCache,
    pruneGitSnapshotCache,
    saveGitSnapshotCache,
};