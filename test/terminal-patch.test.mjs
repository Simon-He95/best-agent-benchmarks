import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureTerminalPatch } from "../scripts/swe-bench-harness.mjs";

test("capture excludes only the reserved runtime while preserving the complete source delta", () => {
  const root = mkdtempSync(join(tmpdir(), "benchmark-capture-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const put = (path, content) => writeFileSync(join(repo, path), content);
  try {
    git("init");
    git("config", "user.email", "test@example.test");
    git("config", "user.name", "Capture test");
    put(".gitignore", "*.so\n.benchmark-runtime/\n");
    put("staged.py", "original\n");
    put("unstaged.py", "original\n");
    put("deleted.py", "original\n");
    git("add", "-A");
    git("commit", "-m", "base");
    const baseCommit = git("rev-parse", "HEAD").trim();
    mkdirSync(join(repo, ".benchmark-runtime"));
    put(".benchmark-runtime/python", "not source\n");
    put("native.so", Buffer.from([0, 255, 17]));
    put(".gitignore", "*.so\n");
    put("committed.py", "model commit\n");
    git("add", "-A");
    git("commit", "-m", "model changes including its runtime");
    put("staged.py", "staged\n");
    git("add", "staged.py");
    put("unstaged.py", "unstaged\n");
    put("untracked.py", "untracked\n");
    put("untracked.bin", Buffer.from([0, 1, 255]));
    put(".benchmark-runtime.txt", "not the reserved prefix\n");
    rmSync(join(repo, "deleted.py"));
    const indexPath = join(repo, ".git/index");
    const before = createHash("sha256").update(readFileSync(indexPath)).digest("hex");
    const patch = captureTerminalPatch({
      repoDir: repo, baseCommit, temporaryIndexPath: join(root, "capture.index"),
    });
    assert.doesNotMatch(patch, /[ab]\/\.benchmark-runtime\//u);
    assert.doesNotMatch(patch, /native\.so/u);
    for (const path of [".gitignore", "staged.py", "unstaged.py", "deleted.py", "committed.py", "untracked.py", "untracked.bin", ".benchmark-runtime.txt"]) {
      assert.ok(patch.includes(`diff --git a/${path} b/${path}`), path);
    }
    assert.equal(createHash("sha256").update(readFileSync(indexPath)).digest("hex"), before);
    const applied = join(root, "applied");
    execFileSync("git", ["clone", "--no-hardlinks", repo, applied]);
    execFileSync("git", ["checkout", "--detach", baseCommit], { cwd: applied });
    execFileSync("git", ["apply", "--check", "-"], { cwd: applied, input: patch });
    execFileSync("git", ["apply", "-"], { cwd: applied, input: patch });
    assert.equal(readFileSync(join(applied, "unstaged.py"), "utf8"), "unstaged\n");
    assert.deepEqual(readFileSync(join(applied, "untracked.bin")), Buffer.from([0, 1, 255]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
