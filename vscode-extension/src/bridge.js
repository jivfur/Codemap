const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function normalizeOutput(text) {
  if (!text) {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

async function runGraphCommand(cwd, args, options = {}) {
  const pythonCommand = options.pythonCommand || "python3";
  const runner = options.runner || execFileAsync;

  const result = await runner(pythonCommand, ["graph.py", ...args], {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";

  return {
    lines: normalizeOutput(stdout),
    stderr,
  };
}

async function resolveGitHead(cwd, options = {}) {
  const runner = options.runner || execFileAsync;

  try {
    const result = await runner("git", ["rev-parse", "HEAD"], {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
    return stdout || null;
  } catch {
    return null;
  }
}

async function resolveGitWorkingTreeClean(cwd, options = {}) {
  const runner = options.runner || execFileAsync;

  try {
    const result = await runner("git", ["status", "--porcelain"], {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
    return stdout.length === 0;
  } catch {
    return null;
  }
}

function parseSearchRows(lines) {
  return lines
    .filter((line) => line.startsWith("["))
    .map((line) => {
      const close = line.indexOf("]");
      const kind = close > 1 ? line.slice(1, close) : "symbol";
      const rest = close >= 0 ? line.slice(close + 1).trim() : line;
      return { kind, text: rest };
    });
}

module.exports = {
  normalizeOutput,
  runGraphCommand,
  resolveGitHead,
  resolveGitWorkingTreeClean,
  parseSearchRows,
};
