import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Benchmark history helpers (v3).
 *
 * Family-based snapshot storage under `docs/benchmarks/history/<family>/`. Each snapshot
 * carries a candidate id (explicit env, git short sha, or `workspace`) and an ISO stamp so
 * the dashboard can render a trend over weekly runs. Pure file helpers only — they never
 * touch the Harness or the CLI.
 */

export function resolveCandidateId(repoRoot, envVarNames = []) {
  for (const envVarName of envVarNames) {
    const explicit = process.env[envVarName]?.trim();
    if (explicit) {
      return explicit;
    }
  }

  const generic = process.env.BEST_AGENT_BENCHMARK_CANDIDATE_ID?.trim();
  if (generic) {
    return generic;
  }

  const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env },
  });
  const candidateId = git.status === 0 ? (git.stdout ?? "").trim() : "";
  return candidateId || "workspace";
}

export function writeBenchmarkHistory(input) {
  const historyDir = resolve(input.benchmarksDir, "history", input.family);
  mkdirSync(historyDir, { recursive: true });

  const baseName = `${formatSnapshotStamp(input.generatedAt)}--${sanitizePathSegment(input.candidateId ?? "workspace")}`;
  const jsonPath = resolve(historyDir, `${baseName}.json`);
  const markdownPath = resolve(historyDir, `${baseName}.md`);
  writeFileSync(jsonPath, input.jsonText);
  writeFileSync(markdownPath, input.markdownText);

  return {
    baseName,
    jsonPath,
    markdownPath,
  };
}

export function listBenchmarkHistory(benchmarksDir, family) {
  const historyDir = resolve(benchmarksDir, "history", family);
  if (!existsSync(historyDir)) {
    return [];
  }

  return readdirSync(historyDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => {
      const jsonPath = resolve(historyDir, entry);
      try {
        const data = JSON.parse(readFileSync(jsonPath, "utf8"));
        const baseName = entry.replace(/\.json$/u, "");
        return {
          baseName,
          data,
          family,
          jsonPath,
          markdownPath: resolve(historyDir, `${baseName}.md`),
          relativeJsonPath: `./history/${family}/${entry}`,
          relativeMarkdownPath: `./history/${family}/${baseName}.md`,
        };
      } catch {
        return null;
      }
    })
    .filter((entry) => entry !== null)
    .sort((left, right) => {
      const leftTime = Date.parse(left.data?.generatedAt ?? "");
      const rightTime = Date.parse(right.data?.generatedAt ?? "");
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
        return rightTime - leftTime;
      }
      return right.baseName.localeCompare(left.baseName);
    });
}

export function readLatestBenchmarkHistorySnapshot(benchmarksDir, family) {
  return listBenchmarkHistory(benchmarksDir, family)[0]?.data ?? null;
}

function formatSnapshotStamp(generatedAt) {
  const iso = new Date(generatedAt).toISOString();
  return iso.replace(/[-:]/g, "").replace(/\./g, "").replace("Z", "Z");
}

function sanitizePathSegment(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "snapshot";
}
