const fs = require("node:fs/promises");
const path = require("node:path");

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
    return true;
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
    restoreGitSnapshotCache,
    saveGitSnapshotCache,
};