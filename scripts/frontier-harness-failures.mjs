#!/usr/bin/env node
/**
 * FrontierHarness Eval v1.0 failure analysis.
 *
 * Reads frozen per-task harness records plus the persisted Pier trial
 * directories and produces a per-task "where did it go wrong" markdown report.
 * It only transcribes canonical records and captured logs; it never re-grades.
 *
 * Usage:
 *   node scripts/frontier-harness-failures.mjs \
 *     --results <dir> --jobs <dir> --output <report.md> [--json <summary.json>]
 *
 * Categories are evidence-backed derived views. They never replace Pier's
 * canonical disposition or trigger another attempt.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = JSON.parse(
  readFileSync(join(repoRoot, "config", "frontier-harness.json"), "utf8"),
);

/**
 * Tasks whose pinned instruction omits a rule their hidden tests require, as
 * declared in config/frontier-harness.json#specificationGaps.
 *
 * This is a declared corpus fact, not a derived guess: it labels why an attempt
 * fell short and keeps that attempt out of capability comparisons. It never
 * changes a canonical disposition or reward, and it never rewrites an instruction
 * — the pinned bytes stay exactly as the source froze them.
 */
const specificationGaps = new Map(
  (config.specificationGaps?.tasks ?? []).map((entry) => [entry.task, entry]),
);

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

/**
 * One owner for the "the agent used its whole declared budget" judgement.
 *
 * The failure analysis classifies it as a stage and the report discloses it for every
 * disposition — including a task that exhausted its budget and still passed, because the
 * verifier grades the delivered artifacts rather than the attempt. Two readings of one
 * fact would let the two artifacts disagree, so both import this predicate.
 */
export function isAgentBudgetExhaustion(exception, trialExceptionText) {
  const message = `${exception?.type ?? ""} ${exception?.message ?? ""}`;
  return /Agent execution timed out|AgentTimeoutError|Agent setup timed out|AgentSetupTimeoutError/iu.test(
    `${message}\n${trialExceptionText ?? ""}`,
  );
}

function classifyFailure(record, evidence, trialExceptionText) {
  const disposition = record.result?.disposition;
  const exception = record.result?.exception;
  const message = `${exception?.type ?? ""} ${exception?.message ?? ""}`;
  if (disposition === "not-evaluated") return "inconclusive";
  if (disposition === "passed") return "passed";
  // The agent used its whole declared budget and Pier killed the run: the
  // model was still working, so this is a budget outcome, not a model failure.
  if (isAgentBudgetExhaustion(exception, trialExceptionText)) return "agent-timeout";
  if (/Docker|compose|image|container|agent setup|install-cli\.sh/iu.test(message)) return "infra";
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

/**
 * The verifier's own record of *how* a delivered patch failed, as opposed to
 * whether the task was solved.
 *
 * A grader that reports `f2p` rows "missing from report" while the raw log shows a
 * build break is describing one delivery failure, not N functional failures: the
 * scored suite never produced results at all, because the patch (or a test file it
 * added) did not compile in the configuration the task scores in. Reporting that
 * as "8 of 9 fail-to-pass tests failed" overstates how far the attempt got and
 * hides a delivery defect behind a capability number, so it is derived here as its
 * own evidence-backed view. The canonical disposition and rewards are untouched.
 *
 * @param {{ rewards?: object, log?: string }} input the frozen verifier rewards and
 *   the captured verifier stdout (the frame appends run.log to it).
 * @returns {{ delivery: string, missingFromReport: number, typecheckError: string|null, f2p: object|null, signals: string[] }}
 */
export function classifyVerifierDelivery({ rewards, log }) {
  const text = typeof log === "string" ? log : "";
  const missingFromReport = (text.match(/missing from report \(test did not run/gu) ?? []).length;
  const buildSignals = [
    ["go-build-failed", /\[build failed\]/u],
    ["reporter-failed-build-event", /"FailedBuild"\s*:/u],
    ["scored-report-missing", /missing or invalid JSON — every whitelisted id/iu],
    ["compile-error", /cannot find package|undefined: \w|syntax error/iu],
  ].filter(([, pattern]) => pattern.test(text));
  const typecheckMatch = text.match(/\berror TS\d{3,5}\b/u);
  const f2p =
    rewards !== undefined && Number.isFinite(Number(rewards.f2p_total))
      ? {
          passed: Number(rewards.f2p_passed),
          total: Number(rewards.f2p_total),
          partial: Number.isFinite(Number(rewards.partial)) ? Number(rewards.partial) : null,
        }
      : null;
  let delivery = "unknown";
  if (missingFromReport > 0 && buildSignals.length > 0) {
    delivery = "build-failed";
  } else if (typecheckMatch !== null) {
    delivery = "typecheck-failed";
  } else if (missingFromReport > 0) {
    // Rows that never produced a result without a visible build break: the
    // report is incomplete, which is not the same claim as "the suite ran".
    delivery = "incomplete-report";
  } else if (f2p !== null) {
    delivery = "ran";
  }
  return {
    delivery,
    missingFromReport,
    typecheckError: typecheckMatch === null ? null : typecheckMatch[0],
    f2p,
    signals: buildSignals.map(([name]) => name),
  };
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
  let modelFailureCount = 0;
  let terminalCause;
  const failedTools = [];
  for (const line of lines) {
    try {
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
    } catch {
      entries.push({ unparsable: line.slice(0, 200) });
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
    if (!file.startsWith("frontier-harness-results.")) continue;
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
    const verifierRewardPath = trialDir ? join(trialDir, "verifier", "reward.json") : undefined;
    let verifierRewards;
    if (verifierRewardPath && existsSync(verifierRewardPath)) {
      try {
        verifierRewards = JSON.parse(readFileSync(verifierRewardPath, "utf8"));
      } catch {
        verifierRewards = undefined;
      }
    }
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
    const stage = classifyFailure(record, evidence, exceptionText);
    const verifier = classifyVerifierDelivery({
      rewards: verifierRewards ?? record.result.rewards,
      log: verifierStdout,
    });
    // A delivery that never compiled is not a capability result, and a task whose
    // instruction omits a rule its grader requires is not a capability measurement
    // either. Both are named separately while the canonical verdict stays untouched.
    const gap = specificationGaps.get(record.task.name);
    const derivedStage =
      stage === "model" && verifier.delivery === "build-failed"
        ? "delivery"
        : stage === "model" && gap !== undefined
          ? "specification-gap"
          : stage;

    summaries.push({
      task: record.task.name,
      stage: derivedStage,
      disposition: record.result.disposition,
      rewards: record.result.rewards ?? undefined,
      verifier,
      ...(gap === undefined ? {} : { specificationGap: gap }),
      durationMs: record.durationMs,
      exceptionType: record.result.exception?.type,
      terminalCause: evidence.terminalCause,
      evidenceSha256: record.artifacts?.evidenceSha256,
      failedTools: evidence.failedTools ?? [],
    });

    const rewardLine =
      record.result.rewards === undefined
        ? ""
        : `| rewards | ${JSON.stringify(record.result.rewards)} |\n`;
    const deliveryLine =
      verifier.delivery === "build-failed"
        ? `| delivery | **build-failed** — ${verifier.missingFromReport} fail-to-pass rows never produced a result (${verifier.signals.join(", ")}); this is one delivery defect, not ${verifier.missingFromReport} functional failures |`
        : verifier.delivery === "typecheck-failed"
          ? `| delivery | **typecheck-failed** (${verifier.typecheckError}) |`
          : verifier.delivery === "incomplete-report"
            ? `| delivery | **incomplete-report** — ${verifier.missingFromReport} fail-to-pass rows never produced a result, with no build break in the captured output |`
            : verifier.f2p === null
              ? ""
              : `| delivery | ran — fail-to-pass ${verifier.f2p.passed}/${verifier.f2p.total}${
                  verifier.f2p.partial === null ? "" : ` (partial ${verifier.f2p.partial.toFixed(4)})`
                } |`;
    sections.push([
      `### ${taskShort} — ${derivedStage}`,
      "",
      "| field | value |",
      "| --- | --- |",
      `| task | ${record.task.name} |`,
      `| disposition | ${record.result.disposition} |`,
      rewardLine
        ? rewardLine.trimEnd()
        : `| exception | ${record.result.exception?.type ?? "n/a"} |`,
      deliveryLine,
      gap === undefined
        ? ""
        : `| specification gap | ${gap.omission} ${gap.observed} The canonical verdict stands; this outcome is excluded from capability comparisons. |`,
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
      exceptionText ? fenced(exceptionText, 40, "Pier exception.txt (tail)") : "",
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
    `# FrontierHarness Eval v1.0 failure analysis`,
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
            provider: "model provider invocation failed",
            harness: "Harness terminal cause prevented completion",
            tool: "a Tool terminal cause prevented completion",
            model: "Harness completed; the task verifier returned reward 0",
            verifier: "task verifier or grader execution failed",
            delivery: "the delivered patch never built in the scored configuration",
            "specification-gap":
              "the pinned instruction omits a rule the hidden tests require, so the reward 0 is not a capability measurement",
            inconclusive: "available evidence does not prove one cause",
          }[stage] ?? ""} |`,
      ),
    "",
    ...(byStage["specification-gap"] === undefined
      ? []
      : [
          `${byStage["specification-gap"]} of the not-passed tasks are declared specification gaps`,
          `(config/frontier-harness.json#specificationGaps): their instruction never states a rule the`,
          "grader requires. Their canonical verdicts stand, and capability comparisons must exclude them.",
          "",
        ]),
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
