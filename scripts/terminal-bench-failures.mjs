#!/usr/bin/env node
/**
 * Terminal-Bench 4.0 failure analysis.
 *
 * Reads frozen per-task harness records plus the persisted Harbor trial
 * directories and produces a per-task "where did it go wrong" markdown report.
 * It only transcribes canonical records and captured logs; it never re-grades.
 *
 * Usage:
 *   node scripts/terminal-bench-failures.mjs \
 *     --results <dir> --jobs <dir> --output <report.md> [--json <summary.json>]
 *
 * Failure stages:
 *   environment-build  Harbor could not build/start the task container
 *   agent-install      The CLI could not be installed into the container
 *   agent-run          The CLI crashed or exited non-zero during the attempt
 *   timeout            The attempt was killed by the agent-timeout budget
 *   verifier-failed    The agent finished but the official verifier scored 0
 *   not-evaluated      No canonical trial record exists (infra gap)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function parseArgs(argv) {
  const parsed = { results: undefined, jobs: undefined, output: undefined, json: undefined };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--results":
        parsed.results = resolve(argv[++i]);
        break;
      case "--jobs":
        parsed.jobs = resolve(argv[++i]);
        break;
      case "--output":
        parsed.output = resolve(argv[++i]);
        break;
      case "--json":
        parsed.json = resolve(argv[++i]);
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!parsed.results || !parsed.jobs || !parsed.output) {
    throw new Error("--results, --jobs and --output are required.");
  }
  return parsed;
}

function readTextSafe(path, limitBytes = 200_000) {
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, "utf8");
    return text.length > limitBytes ? text.slice(-limitBytes) : text;
  } catch {
    return undefined;
  }
}

function tail(text, lines) {
  if (text === undefined) return undefined;
  const all = text.split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

function findTrialDir(jobsRoot, taskShort, jobName) {
  const jobDir = join(jobsRoot, taskShort, jobName);
  if (!existsSync(jobDir)) {
    // Fall back to any job dir under the task when the recorded name differs.
    const taskDir = join(jobsRoot, taskShort);
    if (!existsSync(taskDir)) return undefined;
    const candidates = [];
    for (const entry of readdirSync(taskDir)) {
      const path = join(taskDir, entry);
      if (!statSync(path).isDirectory()) continue;
      for (const sub of readdirSync(path)) {
        const trial = join(path, sub);
        if (existsSync(join(trial, "result.json"))) candidates.push(trial);
      }
    }
    return candidates.sort().pop();
  }
  const candidates = [];
  for (const entry of readdirSync(jobDir)) {
    const path = join(jobDir, entry);
    if (statSync(path).isDirectory() && existsSync(join(path, "result.json"))) {
      candidates.push(path);
    }
  }
  return candidates.sort().pop();
}

function classifyFailure(record) {
  const disposition = record.result?.disposition;
  const exception = record.result?.exception;
  const message = `${exception?.type ?? ""} ${exception?.message ?? ""}`;
  if (disposition === "not-evaluated") return "not-evaluated";
  if (disposition === "passed") return "passed";
  if (record.result?.rewards !== undefined) return "verifier-failed";
  if (/Docker compose command failed/iu.test(message)) return "environment-build";
  if (/install-cli\.sh/iu.test(message)) return "agent-install";
  if (/timed? ?out|TimeoutError|deadline/iu.test(message)) return "timeout";
  if (/best-agent|NonZeroAgentExitCodeError/iu.test(message)) return "agent-run";
  return "unknown";
}

function analyzeEvidence(evidencePath) {
  if (!existsSync(evidencePath)) return { present: false };
  let lines = [];
  try {
    lines = readFileSync(evidencePath, "utf8").split("\n").filter((line) => line.trim());
  } catch {
    return { present: true, readable: false };
  }
  const entries = [];
  let errorCount = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      entries.push(parsed);
      const text = JSON.stringify(parsed);
      if (/"error"|"isError":\s*true|"status":\s*"(failed|error)"/iu.test(text)) errorCount++;
    } catch {
      entries.push({ unparsable: line.slice(0, 200) });
    }
  }
  const last = entries[entries.length - 1];
  return {
    present: true,
    entries: entries.length,
    errorEntries: errorCount,
    lastEntry: last === undefined ? undefined : JSON.stringify(last).slice(0, 600),
  };
}

function fenced(text, maxLines = 40, title) {
  const trimmed = tail(text, maxLines);
  if (trimmed === undefined || trimmed.trim() === "") return "";
  return [
    title ? `<details open><summary>${title}</summary>\n` : "",
    "```",
    trimmed.slice(0, 8000),
    "```",
    title ? "\n</details>" : "",
    "",
  ].join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const records = [];
  for (const file of readdirSync(args.results)) {
    if (!file.startsWith("terminal-bench-results.")) continue;
    if (!file.endsWith(".json")) continue;
    try {
      records.push(JSON.parse(readFileSync(join(args.results, file), "utf8")));
    } catch {
      // skip unparsable partial records
    }
  }
  const failed = records
    .filter((record) => record.result?.disposition !== "passed")
    .sort((a, b) => a.task.name.localeCompare(b.task.name));

  const summaries = [];
  const sections = [];
  for (const record of failed) {
    const taskShort = record.task.name.split("/").pop();
    const stage = classifyFailure(record);
    const trialDir = findTrialDir(args.jobs, taskShort, record.jobName);
    const verifierStdout = trialDir
      ? readTextSafe(join(trialDir, "verifier", "test-stdout.txt"))
      : undefined;
    const verifierStderr = trialDir
      ? readTextSafe(join(trialDir, "verifier", "test-stderr.txt"))
      : undefined;
    const exceptionText = trialDir ? readTextSafe(join(trialDir, "exception.txt")) : undefined;
    const agentStdout = trialDir
      ? readTextSafe(join(trialDir, "agent", "best-agent-stdout.txt"))
      : undefined;
    const evidence = trialDir
      ? analyzeEvidence(join(trialDir, "agent", "best-agent-evidence.jsonl"))
      : { present: false };

    summaries.push({
      task: record.task.name,
      stage,
      disposition: record.result.disposition,
      rewards: record.result.rewards ?? undefined,
      durationMs: record.durationMs,
      exceptionType: record.result.exception?.type,
    });

    const rewardLine =
      record.result.rewards === undefined
        ? ""
        : `| rewards | ${JSON.stringify(record.result.rewards)} |\n`;
    sections.push([
      `### ${taskShort} — ${stage}`,
      "",
      "| field | value |",
      "| --- | --- |",
      `| task | ${record.task.name} |`,
      `| disposition | ${record.result.disposition} |`,
      rewardLine
        ? rewardLine.trimEnd()
        : `| exception | ${record.result.exception?.type ?? "n/a"} |`,
      `| duration | ${Math.round((record.durationMs ?? 0) / 1000)}s |`,
      `| agent budget | ${Math.round(record.effectiveAgentTimeoutSec ?? 0)}s |`,
      "",
      record.result.exception
        ? fenced(
            `${record.result.exception.type ?? ""}\n${record.result.exception.message ?? ""}`,
            30,
            "Exception (harness record)",
          )
        : "",
      exceptionText ? fenced(exceptionText, 40, "Harbor exception.txt (tail)") : "",
      stage === "verifier-failed" && verifierStdout
        ? fenced(verifierStdout, 60, "Verifier test-stdout (tail) — where the task failed")
        : "",
      verifierStderr && verifierStderr.trim()
        ? fenced(verifierStderr, 20, "Verifier test-stderr (tail)")
        : "",
      agentStdout
        ? fenced(agentStdout, 40, "best-agent stdout (tail)")
        : "_no agent stdout captured_",
      evidence.present
        ? fenced(
            [
              `entries: ${evidence.entries ?? "?"}`,
              `error-flagged entries: ${evidence.errorEntries ?? "?"}`,
              evidence.lastEntry ? `last entry: ${evidence.lastEntry}` : "",
            ].join("\n"),
            10,
            "Attempt evidence (JSONL) summary",
          )
        : "_no attempt evidence captured (agent never started a model loop)_",
      "",
    ].filter((part) => part !== "").join("\n"));
  }

  const byStage = {};
  for (const summary of summaries) {
    byStage[summary.stage] = (byStage[summary.stage] ?? 0) + 1;
  }
  const markdown = [
    `# Terminal-Bench 4.0 failure analysis`,
    "",
    `Analyzed ${records.length} frozen task records; ${failed.length} not passed.`,
    "",
    "## Failure stage summary",
    "",
    "| stage | count | meaning |",
    "| --- | --- | --- |",
    ...Object.entries(byStage)
      .sort((a, b) => b[1] - a[1])
      .map(
        ([stage, count]) =>
          `| ${stage} | ${count} | ${{
            "environment-build": "task container build/start failed",
            "agent-install": "CLI install into the container failed",
            "agent-run": "CLI crashed / exited non-zero during the attempt",
            timeout: "attempt exceeded the agent timeout budget",
            "verifier-failed": "agent finished; official verifier scored 0",
            "not-evaluated": "no canonical trial record (infra gap)",
            unknown: "unclassified",
          }[stage] ?? ""} |`,
      ),
    "",
    "## Per-task details",
    "",
    ...sections,
  ].join("\n");

  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, markdown);
  if (args.json) {
    mkdirSync(dirname(args.json), { recursive: true });
    writeFileSync(
      args.json,
      `${JSON.stringify({ taskCount: records.length, failedCount: failed.length, byStage, tasks: summaries }, null, 2)}\n`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({ records: records.length, failed: failed.length, byStage }, null, 2)}\n`,
  );
}

main();