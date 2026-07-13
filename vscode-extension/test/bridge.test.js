const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeOutput, parseSearchRows, resolveGitHead, resolveGitWorkingTreeClean, runGraphCommand } = require("../src/bridge");

test("normalizeOutput trims trailing spaces and drops empty lines", () => {
  const out = normalizeOutput("one  \n\n two\n");
  assert.deepEqual(out, ["one", " two"]);
});

test("parseSearchRows reads kind and text", () => {
  const rows = parseSearchRows([
    "[function] pkg.mod.run (pkg/mod.py)",
    "  - details",
    "[class] pkg.mod.Child (pkg/mod.py)",
  ]);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    kind: "function",
    text: "pkg.mod.run (pkg/mod.py)",
  });
  assert.deepEqual(rows[1], {
    kind: "class",
    text: "pkg.mod.Child (pkg/mod.py)",
  });
});

test("runGraphCommand delegates to runner with graph.py", async () => {
  const calls = [];
  const fakeRunner = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return {
      stdout: "line1\nline2\n",
      stderr: "",
    };
  };

  const result = await runGraphCommand("/tmp/repo", ["search", "abc"], {
    runner: fakeRunner,
    pythonCommand: "python3",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "python3");
  assert.deepEqual(calls[0].args, ["graph.py", "search", "abc"]);
  assert.equal(calls[0].options.cwd, "/tmp/repo");
  assert.deepEqual(result.lines, ["line1", "line2"]);
});

test("resolveGitHead returns trimmed SHA from git rev-parse", async () => {
  const calls = [];
  const fakeRunner = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return {
      stdout: "abc123\n",
      stderr: "",
    };
  };

  const head = await resolveGitHead("/tmp/repo", { runner: fakeRunner });
  assert.equal(head, "abc123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "git");
  assert.deepEqual(calls[0].args, ["rev-parse", "HEAD"]);
  assert.equal(calls[0].options.cwd, "/tmp/repo");
});

test("resolveGitHead returns null when git command fails", async () => {
  const fakeRunner = async () => {
    throw new Error("not a git repo");
  };

  const head = await resolveGitHead("/tmp/repo", { runner: fakeRunner });
  assert.equal(head, null);
});

test("resolveGitWorkingTreeClean returns true for clean status", async () => {
  const fakeRunner = async (cmd, args, options) => {
    assert.equal(cmd, "git");
    assert.deepEqual(args, ["status", "--porcelain"]);
    assert.equal(options.cwd, "/tmp/repo");
    return {
      stdout: "",
      stderr: "",
    };
  };

  const clean = await resolveGitWorkingTreeClean("/tmp/repo", { runner: fakeRunner });
  assert.equal(clean, true);
});

test("resolveGitWorkingTreeClean returns false for dirty status", async () => {
  const fakeRunner = async () => ({
    stdout: " M src/changed.py\n",
    stderr: "",
  });

  const clean = await resolveGitWorkingTreeClean("/tmp/repo", { runner: fakeRunner });
  assert.equal(clean, false);
});

test("resolveGitWorkingTreeClean returns null when git command fails", async () => {
  const fakeRunner = async () => {
    throw new Error("not a git repo");
  };

  const clean = await resolveGitWorkingTreeClean("/tmp/repo", { runner: fakeRunner });
  assert.equal(clean, null);
});
