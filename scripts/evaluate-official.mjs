#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as evaluator from "./swe-bench-official-evaluator.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function parseEvaluationArgs(argv) {
  const parsed = { concurrency: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--report") parsed.reportPath = resolve(argv[++index]);
    else if (argv[index] === "--predictions") parsed.predictionDir = resolve(argv[++index]);
    else if (argv[index] === "--manifest") parsed.manifestPath = resolve(argv[++index]);
    else if (argv[index] === "--output") parsed.outputPath = resolve(argv[++index]);
    else if (argv[index] === "--concurrency") parsed.concurrency = Number(argv[++index]);
    else throw new Error(`Unknown evaluation argument: ${argv[index]}`);
  }
  for (const key of ["reportPath", "predictionDir", "manifestPath", "outputPath"]) {
    if (!parsed[key]) throw new Error(`Missing required --${key.replace(/Path$/u, "")} argument.`);
  }
  if (!Number.isInteger(parsed.concurrency) || parsed.concurrency <= 0) {
    throw new Error("--concurrency must be a positive integer.");
  }
  return parsed;
}

export async function evaluateDeferredReport(options) {
  if (existsSync(options.outputPath)) throw new Error("Refusing to overwrite evaluation output.");
  const sourceReport = JSON.parse(readFileSync(options.reportPath, "utf8"));
  if (
    sourceReport.evaluation?.method !== "official-swe-bench-docker-deferred" ||
    !Array.isArray(sourceReport.tasks)
  ) {
    throw new Error("Input must be one unmodified deferred-generation report.");
  }
  const predictionPaths = readdirSync(options.predictionDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => resolve(options.predictionDir, entry));
  const predictions = new Map();
  for (const predictionPath of predictionPaths) {
    const prediction = evaluator.readFrozenPrediction(predictionPath);
    if (predictions.has(prediction.instanceId)) throw new Error("Duplicate frozen prediction.");
    predictions.set(prediction.instanceId, { prediction, predictionPath });
  }
  const expectedPatchTasks = sourceReport.tasks.filter((task) => task.predictionPath);
  if (
    predictions.size !== expectedPatchTasks.length ||
    expectedPatchTasks.some((task) => !predictions.has(task.instance_id))
  ) {
    throw new Error("Deferred report and frozen prediction population do not match.");
  }
  const outputDir = options.outputPath.replace(/\.json$/u, ".official-evaluation");
  if (existsSync(outputDir)) throw new Error("Refusing to overwrite official evaluation data.");
  mkdirSync(outputDir, { recursive: true });
  const imageManifestPath = resolve(outputDir, "image-manifest.json");
  if (predictionPaths.length > 0) {
    await evaluator.freezeOfficialImageManifest({
      manifestPath: options.manifestPath,
      predictionPaths,
      outputPath: imageManifestPath,
    });
  }
  const tasks = [];
  for (let index = 0; index < sourceReport.tasks.length; index += options.concurrency) {
    const batch = sourceReport.tasks.slice(index, index + options.concurrency);
    const evaluated = await Promise.all(
      batch.map(async (task) => {
        const selected = predictions.get(task.instance_id);
        if (!selected) return task;
        const officialEvaluation = await evaluator.evaluateFrozenPrediction({
          manifestPath: options.manifestPath,
          predictionPath: selected.predictionPath,
          imageManifestPath,
          outputDir: resolve(outputDir, task.instance_id.replace(/[^a-zA-Z0-9._-]/gu, "-")),
        });
        return {
          ...task,
          officialEvaluation,
          verification: "official-swe-bench-docker",
          ...(officialEvaluation.verdict === "inconclusive"
            ? { evaluationError: officialEvaluation.reason }
            : {}),
        };
      }),
    );
    tasks.push(...evaluated);
  }
  const officialSummary = evaluator.summarizeOfficialEvaluations(tasks);
  const report = {
    ...sourceReport,
    evaluatedAt: new Date().toISOString(),
    evaluation: {
      ...sourceReport.evaluation,
      method: "official-swe-bench-docker",
      manifestPath: options.manifestPath,
      imageManifestPath: predictionPaths.length > 0 ? imageManifestPath : null,
      deferredSourceReport: options.reportPath,
    },
    generationSummary: sourceReport.summary,
    summary: officialSummary,
    tasks,
  };
  mkdirSync(dirname(options.outputPath), { recursive: true });
  writeFileSync(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  const markdownPath = options.outputPath.replace(/\.json$/u, ".md");
  writeFileSync(markdownPath, renderMarkdown(report, evaluator.projectBenchmarkTaskDisposition), {
    flag: "wx",
  });
  return { outputPath: options.outputPath, markdownPath, summary: officialSummary };
}

function renderMarkdown(report, dispositionFor) {
  const lines = [
    "# Official SWE-bench evaluation",
    "",
    `- Candidate: ${report.candidateId}`,
    `- Source report: ${report.evaluation.deferredSourceReport}`,
    `- Official pass@1: ${report.summary.passAt1 ?? "inconclusive"}`,
    `- Coverage: ${report.summary.officialCoverage}`,
    "",
    "| Instance | Verdict | Reason |",
    "|---|---|---|",
  ];
  for (const task of report.tasks) {
    lines.push(
      `| ${task.instance_id} | ${dispositionFor(task)} | ${task.officialEvaluation?.reason ?? "not-evaluated"} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  evaluateDeferredReport(parseEvaluationArgs(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
