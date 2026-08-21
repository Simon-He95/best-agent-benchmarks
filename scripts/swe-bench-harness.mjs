#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const candidate = JSON.parse(
  readFileSync(resolve(repoRoot, "config", "best-agent-candidate.json"), "utf8"),
);
export const BEST_AGENT_EVALUATOR_COMMIT = candidate.commit;

export function resolveBestAgentSource(environment = process.env) {
  const configured = environment.BEST_AGENT_SOURCE_DIR;
  const sourceDir = configured ?? resolve(repoRoot, "tools", "best-agent-source");
  if (!isAbsolute(sourceDir)) throw new Error("BEST_AGENT_SOURCE_DIR must be absolute.");
  return sourceDir;
}

export function verifyBestAgentSource(sourceDir, commandRunner = spawnSync) {
  const harnessPath = resolve(sourceDir, "scripts", "swe-bench-harness.mjs");
  if (!existsSync(harnessPath)) {
    throw new Error(`Pinned best-agent harness is missing at ${harnessPath}.`);
  }
  const revision = commandRunner("git", ["-C", sourceDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  if (revision.status !== 0 || revision.stdout.trim() !== BEST_AGENT_EVALUATOR_COMMIT) {
    throw new Error(`best-agent source must be pinned at ${BEST_AGENT_EVALUATOR_COMMIT}.`);
  }
  const status = commandRunner(
    "git",
    ["-C", sourceDir, "status", "--porcelain", "--untracked-files=no"],
    { encoding: "utf8" },
  );
  if (status.status !== 0 || status.stdout.trim() !== "") {
    throw new Error("best-agent source must have no tracked working-tree changes.");
  }
  return harnessPath;
}

function main() {
  const sourceDir = resolveBestAgentSource();
  const harnessPath = verifyBestAgentSource(sourceDir);
  const args = [...process.argv.slice(2)];
  if (!args.includes("--output")) {
    let name = "swe-bench-results";
    const tagIndex = args.indexOf("--tag");
    if (tagIndex >= 0) name += `.${sanitize(args[tagIndex + 1])}`;
    const shardIndex = args.indexOf("--shard");
    if (shardIndex >= 0) name += `.shard-${args[shardIndex + 1]}`;
    args.push("--output", resolve(repoRoot, "results", `${name}.json`));
  }
  const result = spawnSync(process.execPath, [harnessPath, ...args], {
    cwd: sourceDir,
    env: process.env,
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 80);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
