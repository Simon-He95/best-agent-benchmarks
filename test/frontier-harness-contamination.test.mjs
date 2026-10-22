import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { classifyCall, scanCell } from "../scripts/frontier-harness-contamination.mjs";

/**
 * The check has to separate three things that look alike in a tool call: a step the
 * task itself demanded, ordinary dependency installation, and reaching an answer
 * source. Each case below is one of those, taken from the two frozen artifacts this
 * repository already holds (runs 39620264048 and 39700728172).
 */

const REPO = "https://github.com/meriyah/meriyah";
const BASE = "d141eb14a40b79c04d1b1db5c20c6afa3844c0d9";

function cell({ instruction = "", repositoryUrl = REPO, baseCommit = BASE, calls }) {
  const root = mkdtempSync(join(tmpdir(), "fh-contamination-"));
  const dir = join(root, "meriyah-explicit-resource-declarations");
  mkdirSync(join(dir, "pier-task"), { recursive: true });
  mkdirSync(join(dir, "fh-run-1", "pier-task__x", "agent"), { recursive: true });
  writeFileSync(
    join(dir, "pier-task", "task.toml"),
    `[metadata]\nrepository_url = "${repositoryUrl}"\nbase_commit_hash = "${baseCommit}"\n`,
  );
  writeFileSync(join(dir, "pier-task", "instruction.md"), instruction);
  const transcript = calls.map((call, index) => ({
    kind: "assistant",
    message: { toolCalls: [{ callId: `call_${index}`, name: call.name ?? "exec", input: call.input }] },
  }));
  writeFileSync(
    join(dir, "fh-run-1", "pier-task__x", "agent", "best-agent-evidence.jsonl"),
    `${JSON.stringify({ type: "terminal-snapshot", snapshot: { transcript } })}\n`,
  );
  return root;
}

const exec = (command, args = []) => ({ name: "exec", input: { command, args } });

test("a clone the instruction itself names is the task's own step, not contamination", () => {
  // build-cython-ext really does tell the model to run this exact clone.
  const instruction = "You should clone the source code with `git clone --depth 1 --branch 0.5.3 https://github.com/SPOCKnots/pyknotid.git` to `/app/pyknotid`.";
  const root = cell({
    instruction,
    repositoryUrl: "https://github.com/meriyah/meriyah",
    calls: [
      exec("git", ["clone", "--depth", "1", "--branch", "0.5.3", "https://github.com/SPOCKnots/pyknotid.git", "/app/pyknotid"]),
      exec("python3", ["-m", "pip", "install", "numpy"]),
    ],
  });
  const result = scanCell(root, "meriyah-explicit-resource-declarations");
  assert.equal(result.verdict, "clean");
  assert.equal(result.counts["instruction-sanctioned"], 1);
  assert.equal(result.counts["other-network"], 1);
  assert.deepEqual(result.answerSource, []);
});

test("cloning the task's own repository is contamination", () => {
  const root = cell({
    calls: [exec("sh", ["-c", "cd /tmp && git clone --quiet --depth 50 https://github.com/meriyah/meriyah.git meriyah-git"])],
  });
  const result = scanCell(root, "meriyah-explicit-resource-declarations");
  assert.equal(result.verdict, "contaminated");
  assert.equal(result.counts["upstream-access"], 1);
});

test("history read inside a repository the instruction never named is an answer lookup", () => {
  const root = cell({
    calls: [
      exec("sh", ["-c", "git clone https://github.com/meriyah/meriyah.git m"]),
      exec("sh", ["-c", "git show d40161d -- src/parser.ts"]),
      exec("sh", ["-c", "git fetch --quiet --unshallow"]),
    ],
  });
  const result = scanCell(root, "meriyah-explicit-resource-declarations");
  assert.equal(result.verdict, "contaminated");
  assert.equal(result.counts["upstream-history"], 2);
});

test("the published package of the project under test is an answer source", () => {
  const root = cell({ calls: [exec("sh", ["-c", "npm pack meriyah@7.4.0 --silent"])] });
  const result = scanCell(root, "meriyah-explicit-resource-declarations");
  assert.equal(result.verdict, "contaminated");
  assert.equal(result.counts["published-package"], 1);
});

test("fetching the hidden test corpus is an answer source", () => {
  const root = cell({
    calls: [exec("sh", ["-c", "cd /app/test262/test262 && git fetch --depth=1 origin 6eec1ac9 && git show FETCH_HEAD:test/staging/x.js"])],
  });
  const result = scanCell(root, "meriyah-explicit-resource-declarations");
  assert.equal(result.verdict, "contaminated");
  assert.equal(result.counts["test-corpus"], 1);
});

test("dependency installation is egress but not contamination", () => {
  const root = cell({
    calls: [
      exec("python3", ["-m", "pip", "install", "cython", "setuptools"]),
      exec("sh", ["-c", "pip download planarity==0.4.1 -d /tmp/p"]),
    ],
  });
  const result = scanCell(root, "meriyah-explicit-resource-declarations");
  assert.equal(result.verdict, "clean");
  assert.equal(result.counts["other-network"], 2);
});

test("an attempt that never reached the network is clean with no findings", () => {
  const root = cell({ calls: [exec("node", ["--version"]), exec("git", ["status"])] });
  const result = scanCell(root, "meriyah-explicit-resource-declarations");
  assert.equal(result.verdict, "clean");
  assert.equal(result.networkCalls, 0);
});

test("a local npx runner is not egress", () => {
  assert.equal(classifyCall("npx run test/parser/next/_probe.ts", { repositoryUrl: REPO }), undefined);
});

test("--require-clean refuses a contaminated attempt with a non-zero exit", () => {
  const root = cell({ calls: [exec("sh", ["-c", "git clone https://github.com/meriyah/meriyah.git m"])] });
  const script = new URL("../scripts/frontier-harness-contamination.mjs", import.meta.url).pathname;
  assert.throws(
    () => execFileSync(process.execPath, [script, "--jobs", root, "--require-clean"], { encoding: "utf8", stdio: "pipe" }),
    (error) => error.status === 1,
  );
});
