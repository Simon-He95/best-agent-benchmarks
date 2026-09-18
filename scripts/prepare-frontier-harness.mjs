#!/usr/bin/env node
/**
 * FrontierHarness Eval v1.0 corpus freeze.
 *
 * Verifies a local checkout of frontier-harness-eval/eval at the pinned
 * commit, cross-checks the frozen benchmark task ids in benchmark.json against
 * config/frontier-harness.json, reads every task's `task.toml` +
 * `instruction.md`, and writes one frozen manifest that the generation harness
 * and the report job consume. The manifest is the single source for task
 * identity, prompt hashes, environment images, timeouts, and eligibility
 * classification (GPU / runner-resource bound).
 *
 * Usage:
 *   node scripts/prepare-frontier-harness.mjs --source <checkout> [--output <path>]
 *
 * Options:
 *   --source <path>        frontier-harness-eval git checkout (pinned commit)
 *   --output <path>        frozen manifest JSON (default: results/corpora/frontier-harness-1.0.json)
 *   --task-list <path>     (optional) write one task id per line
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = JSON.parse(
  readFileSync(join(repoRoot, "config", "frontier-harness.json"), "utf8"),
);
const pinned = config.source;

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function parseArgs(argv) {
  const parsed = {
    source: undefined,
    output: resolve(repoRoot, "results", "corpora", "frontier-harness-1.0.json"),
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
  if (!parsed.source) throw new Error("--source <frontier-harness-eval checkout> is required.");
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
  if (!existsSync(join(source, "tasks"))) {
    throw new Error(`tasks/ not found under ${source}.`);
  }
  if (!existsSync(join(source, "benchmark.json"))) {
    throw new Error(`benchmark.json not found under ${source}.`);
  }

  const head = gitHead(source);
  if (head !== pinned.sourceCommit) {
    throw new Error(
      `Checkout HEAD ${head} does not match pinned ${pinned.sourceCommit}.`,
    );
  }

  const benchmark = JSON.parse(readFileSync(join(source, "benchmark.json"), "utf8"));
  if (benchmark.task_count !== pinned.taskCount) {
    throw new Error(
      `benchmark.json declares ${benchmark.task_count} tasks; config pins ${pinned.taskCount}.`,
    );
  }
  if (JSON.stringify(benchmark.task_ids) !== JSON.stringify(pinned.taskIds)) {
    throw new Error(
      "benchmark.json task ids do not match the frozen task list in config/frontier-harness.json.",
    );
  }

  const tasks = pinned.taskIds.map((taskId, index) => {
    const suite = taskId.split("/")[0];
    const taskDir = taskId.split("/").pop();
    const taskConfig = readTomlDict(source, taskDir, [
      ["task", "name"],
      ["agent", "timeout_sec"],
      ["agent", "network_mode"],
      ["verifier", "timeout_sec"],
      ["verifier", "environment_mode"],
      ["verifier", "network_mode"],
      ["environment", "docker_image"],
      ["environment", "workdir"],
      ["environment", "cpus"],
      ["environment", "memory_mb"],
      ["environment", "storage_mb"],
      ["environment", "gpus"],
      ["environment", "allow_internet"],
    ]);
    if (taskConfig["task.name"] !== taskId) {
      throw new Error(
        `task.toml name ${taskConfig["task.name"]} does not match the frozen task id ${taskId}.`,
      );
    }
    const instructionPath = join(source, "tasks", taskDir, "instruction.md");
    if (!existsSync(instructionPath)) {
      throw new Error(`Task ${taskDir} is missing instruction.md.`);
    }
    const instruction = readFileSync(instructionPath, "utf8");
    if (instruction.trim().length === 0) {
      throw new Error(`Task ${taskDir} has an empty instruction.md.`);
    }
    const dockerImage = String(taskConfig["environment.docker_image"] ?? "");
    if (!dockerImage) {
      throw new Error(`Task ${taskDir} declares no environment docker_image.`);
    }
    const agentTimeoutSec = Number(taskConfig["agent.timeout_sec"] ?? 0);
    if (!(agentTimeoutSec > 0)) {
      throw new Error(`Task ${taskDir} declares no agent timeout_sec.`);
    }
    const gpus = Number(taskConfig["environment.gpus"] ?? 0);
    const cpus = Number(taskConfig["environment.cpus"] ?? 1);
    const memoryMb = Number(taskConfig["environment.memory_mb"] ?? 1024);
    const storageMb = Number(taskConfig["environment.storage_mb"] ?? 10240);
    return {
      name: taskId,
      suite,
      datasetOrder: index + 1,
      instructionSha256: sha256(instruction),
      instructionBytes: Buffer.byteLength(instruction, "utf8"),
      dockerImage,
      workdir: taskConfig["environment.workdir"] ?? "/app",
      agentTimeoutSec,
      agentNetworkMode: taskConfig["agent.network_mode"] ?? null,
      verifierTimeoutSec: Number(taskConfig["verifier.timeout_sec"] ?? 0),
      verifierEnvironmentMode: taskConfig["verifier.environment_mode"] ?? "separate",
      verifierNetworkMode: taskConfig["verifier.network_mode"] ?? null,
      allowInternet: taskConfig["environment.allow_internet"] === true,
      cpus,
      memoryMb,
      storageMb,
      gpus,
      gpuRequired: gpus >= 1,
      resourceExceeded:
        cpus > config.generation.hostCpus ||
        memoryMb > config.generation.hostMemoryMb,
    };
  });

  const suiteCounts = tasks.reduce((acc, task) => {
    acc[task.suite] = (acc[task.suite] ?? 0) + 1;
    return acc;
  }, {});
  if (suiteCounts["terminal-bench"] !== pinned.terminalBenchTaskCount) {
    throw new Error(
      `Frozen corpus contains ${suiteCounts["terminal-bench"]} terminal-bench tasks; config pins ${pinned.terminalBenchTaskCount}.`,
    );
  }
  if (suiteCounts["datacurve"] !== pinned.deepSweTaskCount) {
    throw new Error(
      `Frozen corpus contains ${suiteCounts["datacurve"]} datacurve tasks; config pins ${pinned.deepSweTaskCount}.`,
    );
  }

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
      benchmarkLabel: pinned.benchmarkLabel,
      sourceRepository: pinned.sourceRepository,
      sourceCommit: pinned.sourceCommit,
      benchmarkTaskCount: benchmark.task_count,
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
        taskCount: tasks.length,
        terminalBenchTasks: suiteCounts["terminal-bench"],
        datacurveTasks: suiteCounts["datacurve"],
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
