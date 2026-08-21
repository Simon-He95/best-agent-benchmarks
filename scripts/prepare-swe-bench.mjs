#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as evaluator from "./swe-bench-official-evaluator.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function parsePrepareArgs(argv) {
  const parsed = {
    corpusPath: resolve(repoRoot, "results", "corpora", "swe-bench-verified.jsonl"),
    manifestPath: resolve(repoRoot, ".tmp", "official-evaluator-manifest.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--corpus") parsed.corpusPath = resolve(argv[++index]);
    else if (argv[index] === "--manifest") parsed.manifestPath = resolve(argv[++index]);
    else if (argv[index] === "--evaluator-source") {
      parsed.evaluatorSourceDir = resolve(argv[++index]);
    } else if (argv[index] === "--evaluator-python") {
      parsed.evaluatorPython = resolve(argv[++index]);
    } else if (argv[index] === "--docker") parsed.dockerExecutable = resolve(argv[++index]);
    else throw new Error(`Unknown prepare argument: ${argv[index]}`);
  }
  return parsed;
}

export async function prepareSweBench(options) {
  if (!options.evaluatorSourceDir) throw new Error("--evaluator-source is required.");
  const profile = JSON.parse(
    readFileSync(resolve(repoRoot, "config", "swe-bench-verified.json"), "utf8"),
  );
  if (!existsSync(options.corpusPath)) downloadCorpus(profile, options.corpusPath);
  const bytes = readFileSync(options.corpusPath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== profile.jsonlBytes || hash !== profile.jsonlSha256) {
    throw new Error("Frozen SWE-bench Verified corpus bytes do not match the tracked profile.");
  }
  const rows = bytes
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const selectedInstanceIds = rows.map((row) => row.instance_id).sort();
  if (
    rows.length !== profile.taskCount ||
    selectedInstanceIds.some((id) => typeof id !== "string") ||
    new Set(selectedInstanceIds).size !== profile.taskCount
  ) {
    throw new Error("Frozen SWE-bench Verified corpus population is invalid.");
  }
  const manifest = {
    schemaVersion: 1,
    profileId: profile.profileId,
    evaluatorPython: options.evaluatorPython ?? resolveExecutable("python3"),
    evaluatorSourceDir: options.evaluatorSourceDir,
    gitExecutable: resolveExecutable("git"),
    dockerExecutable:
      options.dockerExecutable ?? resolveExecutable("docker", "/usr/local/bin/docker"),
    evaluatorVersion: evaluator.OFFICIAL_EVALUATOR_VERSION,
    evaluatorCommit: evaluator.OFFICIAL_EVALUATOR_COMMIT,
    dataset: {
      schemaVersion: 1,
      profileId: profile.profileId,
      sourceDatasetName: profile.sourceDatasetName,
      split: profile.split,
      sourceRevision: profile.sourceRevision,
      localDatasetJsonlPath: options.corpusPath,
      localDatasetJsonlSha256: profile.jsonlSha256,
      localDatasetJsonlBytes: profile.jsonlBytes,
      selectedInstanceIds,
    },
    platform: evaluator.OFFICIAL_PLATFORM,
    evaluationTimeoutSeconds: evaluator.OFFICIAL_EVALUATION_TIMEOUT_SECONDS,
    imagePullTimeoutSeconds: evaluator.OFFICIAL_IMAGE_PULL_TIMEOUT_SECONDS,
  };
  mkdirSync(dirname(options.manifestPath), { recursive: true });
  writeFileSync(options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  const admitted = evaluator.loadOfficialEvaluatorManifest(options.manifestPath);
  evaluator.verifyOfficialDatasetManifest(admitted);
  return { corpusPath: options.corpusPath, manifestPath: options.manifestPath };
}

function downloadCorpus(profile, outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  const endpoint = new URL("https://datasets-server.huggingface.co/rows");
  endpoint.searchParams.set("dataset", profile.sourceDatasetName);
  endpoint.searchParams.set("config", "default");
  endpoint.searchParams.set("split", profile.split);
  endpoint.searchParams.set("revision", profile.sourceRevision);
  endpoint.searchParams.set("length", "100");
  const script = [
    "import json,sys,urllib.request",
    "url,out=sys.argv[1:]",
    "lines=[]",
    "offset=0",
    "while True:",
    "    with urllib.request.urlopen(f'{url}&offset={offset}', timeout=120) as response:",
    "        rows=json.load(response).get('rows', [])",
    "    if not rows: break",
    "    lines.extend(json.dumps(row['row'], ensure_ascii=False) for row in rows)",
    "    if len(rows) < 100: break",
    "    offset += 100",
    "if not lines: raise SystemExit(2)",
    "with open(out, 'x', encoding='utf-8') as handle: handle.write('\\n'.join(lines)+'\\n')",
  ].join("\n");
  const result = spawnSync(resolveExecutable("python3"), ["-c", script, endpoint.href, temporaryPath], {
    encoding: "utf8",
    timeout: 300_000,
  });
  if (result.status !== 0) {
    rmSync(temporaryPath, { force: true });
    throw new Error(result.stderr || result.stdout || "Pinned corpus download failed.");
  }
  renameSync(temporaryPath, outputPath);
}

function resolveExecutable(name, fallback) {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim().startsWith("/")) return result.stdout.trim();
  if (fallback) return fallback;
  throw new Error(`Required executable is missing: ${name}.`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  prepareSweBench(parsePrepareArgs(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
