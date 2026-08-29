#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { isolateFrozenGitCommit } from "./swe-bench-harness.mjs";

const corpusPath = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: isolation-smoke.mjs <corpus-jsonl>");
const task = JSON.parse(readFileSync(corpusPath, "utf8").split("\n", 1)[0]);
if (!task.repo || !task.base_commit || !task.instance_id) {
  throw new Error("The first frozen corpus task is incomplete.");
}

const root = mkdtempSync(join(tmpdir(), "benchmark-isolation-smoke-"));
const repository = join(root, "repo");
try {
  requireSuccess("clone", ["clone", "--depth", "1", `https://github.com/${task.repo}.git`, repository]);
  requireSuccess("fetch base commit", ["-C", repository, "fetch", "--depth", "1", "origin", task.base_commit]);
  requireSuccess("checkout base commit", ["-C", repository, "checkout", "--detach", task.base_commit]);
  const isolated = isolateFrozenGitCommit(repository);
  if (isolated.status !== 0) {
    process.stderr.write(
      `${JSON.stringify(
        {
          instanceId: task.instance_id,
          isolation: isolated,
          diagnostics: Object.fromEntries(
            [
              ["version", ["--version"]],
              ["head", ["rev-parse", "HEAD"]],
              ["remote", ["remote", "-v"]],
              ["refs", ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes", "refs/tags"]],
              ["remoteHead", ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]],
              ["showRef", ["show-ref", "--head"]],
              ["fsck", ["fsck", "--unreachable", "--no-reflogs"]],
            ].map(([name, args]) => [name, inspectGit(repository, args)]),
          ),
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `${JSON.stringify({ ok: true, instanceId: task.instance_id, baseCommit: task.base_commit, host: { platform: process.platform, arch: process.arch } })}\n`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

function requireSuccess(label, args) {
  const result = spawnSync("git", args, { encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  }
}

function inspectGit(repository, args) {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
