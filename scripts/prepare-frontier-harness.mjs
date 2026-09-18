#!/usr/bin/env node
/**
 * FrontierHarness Eval v1.0 corpus freeze.
 *
 * Verifies a local checkout of frontier-harness-eval/eval at the pinned commit
 * (the task-list authority), then freezes every task's operative definition
 * from the authoritative per-suite sources pinned in
 * config/frontier-harness.json#taskSources:
 *
 *   terminal-bench/<name> -> laude-institute/terminal-bench-2 (the
 *       terminal-bench@2.0 registry corpus the official runner used; the eval
 *       repo's tasks/ copies are public metadata without tests/)
 *   datacurve/<name>      -> datacurve-ai/deep-swe (the official skill's
 *       reproduction ref; its -v1.1 separate-verifier images are the
 *       reproduction-correct environments)
 *
 * Writes one frozen manifest that the generation harness and the report job
 * consume. The manifest is the single source for task identity, prompt hashes,
 * environment images, timeouts, verifier topology, and eligibility
 * classification (GPU / runner-resource bound).
 *
 * Usage:
 *   node scripts/prepare-frontier-harness.mjs \
 *     --source <eval checkout> \
 *     --terminal-bench-source <terminal-bench-2 checkout> \
 *     --deep-swe-source <deep-swe checkout> \
 *     [--output <path>] [--task-list <path>]
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
const taskSources = config.taskSources;

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function parseArgs(argv) {
  const parsed = {
    source: undefined,
    terminalBenchSource: undefined,
    deepSweSource: undefined,
    output: resolve(repoRoot, "results", "corpora", "frontier-harness-1.0.json"),
    taskList: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--source":
        parsed.source = resolve(argv[++i]);
        break;
      case "--terminal-bench-source":
        parsed.terminalBenchSource = resolve(argv[++i]);
        break;
      case "--deep-swe-source":
        parsed.deepSweSource = resolve(argv[++i]);
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
  for (const [key, label] of [
    ["source", "frontier-harness-eval checkout"],
    ["terminalBenchSource", "terminal-bench-2 checkout"],
    ["deepSweSource", "deep-swe checkout"],
  ]) {
    if (!parsed[key]) throw new Error(`--${key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())} <${label}> is required.`);
  }
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

function readTomlDict(tomlPath, fields) {
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
  const result = spawnSync("python3", ["-c", script, tomlPath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to parse ${tomlPath}: ${result.stderr || "unknown error"}`,
    );
  }
  return JSON.parse(result.stdout);
}

function parseSizeToMb(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  const text = String(value).trim().toUpperCase();
  if (text.endsWith("G")) return Math.round(parseFloat(text.slice(0, -1)) * 1024);
  if (text.endsWith("M")) return Math.round(parseFloat(text.slice(0, -1)));
  if (text.endsWith("K")) return Math.round(parseFloat(text.slice(0, -1)) / 1024);
  throw new Error(`Cannot parse size ${JSON.stringify(value)}.`);
}

function sourceRootFor(suite) {
  if (suite === "terminal-bench") {
    return {
      root: "terminalBenchSource",
      pin: taskSources.terminalBench,
      taskDirTemplate: taskSources.terminalBench.taskPath,
    };
  }
  if (suite === "datacurve") {
    return {
      root: "deepSweSource",
      pin: taskSources.deepSwe,
      taskDirTemplate: taskSources.deepSwe.taskPath,
    };
  }
  throw new Error(`Unknown suite ${suite}.`);
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
  const sourceHeads = {
    terminalBenchSource: gitHead(args.terminalBenchSource),
    deepSweSource: gitHead(args.deepSweSource),
  };
  if (sourceHeads.terminalBenchSource !== taskSources.terminalBench.sourceCommit) {
    throw new Error(
      `terminal-bench-2 HEAD ${sourceHeads.terminalBenchSource} does not match pinned ${taskSources.terminalBench.sourceCommit}.`,
    );
  }
  if (sourceHeads.deepSweSource !== taskSources.deepSwe.sourceCommit) {
    throw new Error(
      `deep-swe HEAD ${sourceHeads.deepSweSource} does not match pinned ${taskSources.deepSwe.sourceCommit}.`,
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
    const short = taskId.split("/").pop();
    const origin = sourceRootFor(suite);
    const sourceTaskDir = origin.taskDirTemplate.replace("<name>", short);
    const taskDir = join(args[origin.root], ...sourceTaskDir.split("/"));
    if (!existsSync(join(taskDir, "task.toml"))) {
      throw new Error(`Task ${taskId} has no task.toml under ${taskDir}.`);
    }
    if (!existsSync(join(taskDir, "instruction.md"))) {
      throw new Error(`Task ${taskId} is missing instruction.md under ${taskDir}.`);
    }
    if (!existsSync(join(taskDir, "tests", "test.sh"))) {
      throw new Error(
        `Task ${taskId} has no tests/test.sh under ${taskDir}; Pier's verifier requires it.`,
      );
    }
    if (
      !existsSync(join(taskDir, "environment", "Dockerfile")) &&
      !existsSync(join(taskDir, "environment", "docker-compose.yaml"))
    ) {
      throw new Error(
        `Task ${taskId} has no environment/Dockerfile or environment/docker-compose.yaml under ${taskDir}.`,
      );
    }
    const taskConfig = readTomlDict(join(taskDir, "task.toml"), [
      ["task", "name"],
      ["agent", "timeout_sec"],
      ["agent", "network_mode"],
      ["verifier", "timeout_sec"],
      ["verifier", "environment_mode"],
      ["verifier", "network_mode"],
      ["verifier", "environment"],
      ["environment", "docker_image"],
      ["environment", "workdir"],
      ["environment", "cpus"],
      ["environment", "memory_mb"],
      ["environment", "memory"],
      ["environment", "storage_mb"],
      ["environment", "storage"],
      ["environment", "gpus"],
      ["environment", "allow_internet"],
    ]);
    const declaredName = taskConfig["task.name"];
    if (declaredName !== null && declaredName !== undefined && declaredName !== taskId) {
      throw new Error(
        `task.toml name ${declaredName} does not match the frozen task id ${taskId}.`,
      );
    }
    const instruction = readFileSync(join(taskDir, "instruction.md"), "utf8");
    if (instruction.trim().length === 0) {
      throw new Error(`Task ${taskId} has an empty instruction.md.`);
    }
    const dockerImage = String(taskConfig["environment.docker_image"] ?? "");
    if (!dockerImage) {
      throw new Error(`Task ${taskId} declares no environment docker_image.`);
    }
    const agentTimeoutSec = Number(taskConfig["agent.timeout_sec"] ?? 0);
    if (!(agentTimeoutSec > 0)) {
      throw new Error(`Task ${taskId} declares no agent timeout_sec.`);
    }
    const verifierEnvironmentMode =
      taskConfig["verifier.environment_mode"] ??
      (taskConfig["verifier.environment"] !== null &&
      taskConfig["verifier.environment"] !== undefined
        ? "separate"
        : "shared");
    const gpus = Number(taskConfig["environment.gpus"] ?? 0);
    const cpus = Number(taskConfig["environment.cpus"] ?? 1);
    const memoryMb =
      parseSizeToMb(taskConfig["environment.memory_mb"]) ??
      parseSizeToMb(taskConfig["environment.memory"]) ??
      1024;
    const storageMb =
      parseSizeToMb(taskConfig["environment.storage_mb"]) ??
      parseSizeToMb(taskConfig["environment.storage"]) ??
      10240;
    return {
      name: taskId,
      suite,
      datasetOrder: index + 1,
      sourceRepository: origin.pin.repository,
      sourceCommit: origin.pin.sourceCommit,
      sourceTaskDir,
      instructionSha256: sha256(instruction),
      instructionBytes: Buffer.byteLength(instruction, "utf8"),
      dockerImage,
      workdir: taskConfig["environment.workdir"] ?? null,
      agentTimeoutSec,
      agentNetworkMode: taskConfig["agent.network_mode"] ?? null,
      verifierTimeoutSec: Number(taskConfig["verifier.timeout_sec"] ?? 0),
      verifierEnvironmentMode,
      verifierNetworkMode: taskConfig["verifier.network_mode"] ?? null,
      allowInternet: taskConfig["environment.allow_internet"] !== false,
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
      terminalBenchSourceRepository: taskSources.terminalBench.repository,
      terminalBenchSourceCommit: taskSources.terminalBench.sourceCommit,
      deepSweSourceRepository: taskSources.deepSwe.repository,
      deepSweSourceCommit: taskSources.deepSwe.sourceCommit,
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
        terminalBenchSourceCommit: taskSources.terminalBench.sourceCommit,
        deepSweSourceCommit: taskSources.deepSwe.sourceCommit,
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
