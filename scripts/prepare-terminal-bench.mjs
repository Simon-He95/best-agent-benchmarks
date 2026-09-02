#!/usr/bin/env node
/**
 * Terminal-Bench 4.0 corpus freeze.
 *
 * Verifies a local checkout of harbor-framework/terminal-bench at the pinned v4.0.0
 * commit, recomputes the dataset digest, reads every task's `task.toml` +
 * `instruction.md`, and writes one frozen manifest that the generation harness and
 * the report job consume. The manifest is the single source for task identity,
 * prompt hashes, and eligibility classification (GPU / runner-resource bound).
 *
 * Usage:
 *   node scripts/prepare-terminal-bench.mjs --source <checkout> [--output <path>]
 *
 * Options:
 *   --source <path>        terminal-bench git checkout (pinned commit)
 *   --output <path>        frozen manifest JSON (default: results/corpora/terminal-bench-4.0.json)
 *   --task-list <path>     (optional) write one task name per line
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = JSON.parse(
  readFileSync(join(repoRoot, "config", "terminal-bench.json"), "utf8"),
);
const pinned = config.dataset;

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function parseArgs(argv) {
  const parsed = {
    source: undefined,
    output: resolve(repoRoot, "results", "corpora", "terminal-bench-4.0.json"),
    taskList: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--source":
        parsed.source = resolve(argv[++i]);
        break;
      case "--output":
        parsed.output = resolve(argv[++i]);
        break;
      case "--task-list":
        parsed.taskList = resolve(argv[++i]);
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!parsed.source) throw new Error("--source <terminal-bench checkout> is required.");
  return parsed;
}

function gitHead(source) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: source,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Cannot read git HEAD of ${source}: ${result.stderr || "unknown error"}`);
  }
  return result.stdout.trim();
}

function readTomlDict(source, taskDir, fields) {
  // task.toml is TOML; Node has no built-in parser. python3's tomllib is part of
  // stdlib on 3.11+ (present on GitHub ubuntu runners and modern macOS).
  const script = `
import sys, json, tomllib
with open(sys.argv[1], "rb") as f:
    data = tomllib.load(f)
out = {}
for path in ${JSON.stringify(fields)}:
    node = data
    for key in path:
        node = node.get(key) if isinstance(node, dict) else None
        if node is None:
            break
    out[".".join(path)] = node
print(json.dumps(out))
`;
  const result = spawnSync("python3", ["-c", script, join(source, "tasks", taskDir, "task.toml")], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to parse task.toml for ${taskDir}: ${result.stderr || "unknown error"}`,
    );
  }
  return JSON.parse(result.stdout);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = args.source;
  if (!existsSync(join(source, "tasks", "dataset.toml"))) {
    throw new Error(`tasks/dataset.toml not found under ${source}.`);
  }

  const head = gitHead(source);
  if (head !== pinned.sourceCommit) {
    throw new Error(
      `Checkout HEAD ${head} does not match pinned ${pinned.sourceCommit} ` +
        `(${pinned.sourceTag}).`,
    );
  }

  const datasetToml = readFileSync(join(source, "tasks", "dataset.toml"), "utf8");
  const datasetTomlSha256 = sha256(datasetToml);
  if (datasetTomlSha256 !== pinned.datasetTomlSha256) {
    throw new Error(
      `dataset.toml sha256 ${datasetTomlSha256} does not match pinned ` +
        `${pinned.datasetTomlSha256}.`,
    );
  }

  const namePattern = /\[\[tasks\]\]\s*\nname = "terminal-bench\/([a-z0-9-]+)"/g;
  const digestPattern = /digest = "sha256:([0-9a-f]{64})"/g;
  const names = [...datasetToml.matchAll(namePattern)].map((m) => m[1]);
  const digestMatches = [...datasetToml.matchAll(digestPattern)].map((m) => m[1]);
  if (names.length !== pinned.taskCount) {
    throw new Error(
      `dataset.toml declares ${names.length} tasks; config pins ${pinned.taskCount}.`,
    );
  }
  if (digestMatches.length !== names.length) {
    throw new Error(`dataset.toml digest count mismatch (${digestMatches.length}).`);
  }

  const tasks = names.map((taskDir, index) => {
    const taskConfig = readTomlDict(source, taskDir, [
      ["agent", "timeout_sec"],
      ["verifier", "environment_mode"],
      ["verifier", "timeout_sec"],
      ["environment", "cpus"],
      ["environment", "memory_mb"],
      ["environment", "gpus"],
    ]);
    const instructionPath = join(source, "tasks", taskDir, "instruction.md");
    if (!existsSync(instructionPath)) {
      throw new Error(`Task ${taskDir} is missing instruction.md.`);
    }
    const instruction = readFileSync(instructionPath, "utf8");
    if (instruction.trim().length === 0) {
      throw new Error(`Task ${taskDir} has an empty instruction.md.`);
    }
    const gpus = Number(taskConfig["environment.gpus"] ?? 0);
    const cpus = Number(taskConfig["environment.cpus"] ?? 1);
    const memoryMb = Number(taskConfig["environment.memory_mb"] ?? 1024);
    const agentTimeoutSec = Number(taskConfig["agent.timeout_sec"] ?? 0);
    const verifierTimeoutSec = Number(taskConfig["verifier.timeout_sec"] ?? 0);
    return {
      name: `terminal-bench/${taskDir}`,
      datasetOrder: index + 1,
      digest: digestMatches[index],
      instructionSha256: sha256(instruction),
      instructionBytes: Buffer.byteLength(instruction, "utf8"),
      agentTimeoutSec,
      verifierTimeoutSec,
      verifierEnvironmentMode: taskConfig["verifier.environment_mode"] ?? "separate",
      cpus,
      memoryMb,
      gpus,
      gpuRequired: gpus >= 1,
      resourceExceeded:
        cpus > config.generation.hostCpus ||
        memoryMb > config.generation.hostMemoryMb,
    };
  });

  const gpuTasks = tasks.filter((t) => t.gpuRequired).map((t) => t.name);
  const exceededTasks = tasks.filter((t) => t.resourceExceeded).map((t) => t.name);
  // Cross-check against the frozen config classification so a corpus change cannot
  // silently rename eligibility categories.
  const sorted = (xs) => [...xs].sort();
  const sameList = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
  if (!sameList(gpuTasks, config.gpuTasks)) {
    throw new Error(`GPU classification drifted: ${JSON.stringify(gpuTasks)}`);
  }
  if (!sameList(exceededTasks, config.resourceExceededTasks)) {
    throw new Error(`Resource classification drifted: ${JSON.stringify(exceededTasks)}`);
  }

  const manifest = {
    profileId: config.profileId,
    dataset: {
      name: pinned.name,
      version: pinned.version,
      sourceRepository: pinned.sourceRepository,
      sourceTag: pinned.sourceTag,
      sourceCommit: pinned.sourceCommit,
      datasetTomlSha256,
      taskCount: tasks.length,
    },
    gpuTasks,
    resourceExceededTasks: exceededTasks,
    tasks,
  };
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestSha256 = sha256(body);
  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, body);
  if (args.taskList) {
    writeFileSync(args.taskList, `${tasks.map((t) => t.name).join("\n")}\n`);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        profileId: manifest.profileId,
        sourceCommit: pinned.sourceCommit,
        datasetTomlSha256,
        taskCount: tasks.length,
        gpuTasks: gpuTasks.length,
        resourceExceededTasks: exceededTasks.length,
        manifestSha256,
        output: args.output,
      },
      null,
      2,
    )}\n`,
  );
}

main();