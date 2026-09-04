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
 * Categories are evidence-backed derived views. They never replace Harbor's
 * canonical disposition or trigger another attempt.
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
  const text = readFileSync(path, "utf8");
  return text.length > limitBytes ? text.slice(-limitBytes) : text;
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

function classifyFailure(record, evidence) {
  const disposition = record.result?.disposition;
  const exception = record.result?.exception;
  const message = `${exception?.type ?? ""} ${exception?.message ?? ""}`;
  if (disposition === "not-evaluated") return "inconclusive";
  if (disposition === "passed") return "passed";
  if (/Docker|compose|image|container|agent setup|install-cli\.sh/iu.test(message)) return "infra";
  if (exception?.type === "AgentTimeoutError") return "agent-timeout";
  if (exception?.type === "VerifierTimeoutError") return "verifier";
  if (evidence.modelFailureCount > 0 || evidence.terminalCause === "model-failure") {
    return "provider";
  }
  if (evidence.terminalCause === "tool-unknown") return "tool";
  if (evidence.terminalCause === "run-deadline") return "harness";
  if (record.result?.rewards !== undefined && evidence.terminalCause === "completed") {
    return "model";
  }
  if (/verifier|grader/iu.test(message)) return "verifier";
  return "inconclusive";
}

function analyzeEvidence(evidencePath) {
  if (!existsSync(evidencePath)) return { present: false };
  const lines = readFileSync(evidencePath, "utf8").split("\n").filter((line) => line.trim());
  const entries = [];
  let modelFailureCount = 0;
  let terminalCause;
  const failedTools = [];
  for (const line of lines) {
    const parsed = JSON.parse(line);
    entries.push(parsed);
    if (parsed.type === "model-failure") modelFailureCount += 1;
    if (parsed.type === "terminal-snapshot") {
      terminalCause = parsed.snapshot?.terminalCause;
      for (const item of parsed.snapshot?.transcript ?? []) {
        const closure = item?.kind === "tool" ? item.result?.closure : undefined;
        if (
          closure &&
          (closure.kind !== "known" || closure.status === "failed")
        ) {
          failedTools.push({
            sequence: parsed.sequence,
            callId: item.result?.callId,
            name: item.result?.name,
            closure,
          });
        }
      }
    }
  }
  const last = entries[entries.length - 1];
  return {
    present: true,
    entries: entries.length,
    modelFailureCount,
    terminalCause,
    failedTools,
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
    records.push(JSON.parse(readFileSync(join(args.results, file), "utf8")));
  }
  const failed = records
    .filter((record) => record.result?.disposition !== "passed")
    .sort((a, b) => a.task.name.localeCompare(b.task.name));

  const summaries = [];
  const sections = [];
  for (const record of failed) {
    const taskShort = record.task.name.split("/").pop();
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
    const agentStderr = trialDir
      ? readTextSafe(join(trialDir, "agent", "best-agent-stderr.txt"))
      : undefined;
    const evidence = trialDir
      ? analyzeEvidence(join(trialDir, "agent", "best-agent-evidence.jsonl"))
      : { present: false };
    const stage = classifyFailure(record, evidence);

    summaries.push({
      task: record.task.name,
      stage,
      disposition: record.result.disposition,
      rewards: record.result.rewards ?? undefined,
      durationMs: record.durationMs,
      exceptionType: record.result.exception?.type,
      terminalCause: evidence.terminalCause,
      resourceExceededOnHostedRunner:
        record.task?.resourceExceededOnHostedRunner ?? false,
      evidenceSha256: record.artifacts?.evidenceSha256,
      failedTools: evidence.failedTools ?? [],
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
      record.result.disposition === "failed" && verifierStdout
        ? fenced(verifierStdout, 60, "Verifier test-stdout (tail) — where the task failed")
        : "",
      verifierStderr && verifierStderr.trim()
        ? fenced(verifierStderr, 20, "Verifier test-stderr (tail)")
        : "",
      agentStdout
        ? fenced(agentStdout, 40, "best-agent stdout (tail)")
        : "_no agent stdout captured_",
      agentStderr && agentStderr.trim()
        ? fenced(agentStderr, 40, "best-agent stderr (tail)")
        : "",
      evidence.present
        ? fenced(
            [
              `entries: ${evidence.entries ?? "?"}`,
              `terminal cause: ${evidence.terminalCause ?? "?"}`,
              `model failures: ${evidence.modelFailureCount ?? "?"}`,
              `failed tool closures: ${evidence.failedTools?.length ?? "?"}`,
              `evidence sha256: ${record.artifacts?.evidenceSha256 ?? "?"}`,
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
            infra: "task container, image, setup, or candidate installation failed",
            "agent-timeout": "Harbor stopped the agent at its task timeout",
            provider: "model provider invocation failed",
            harness: "Harness terminal cause prevented completion",
            tool: "a Tool terminal cause prevented completion",
            model: "Harness completed; official verifier returned reward 0",
            verifier: "official verifier or grader execution failed",
            inconclusive: "available evidence does not prove one cause",
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
