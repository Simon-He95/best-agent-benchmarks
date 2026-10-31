#!/usr/bin/env node
/**
 * IBench runner for one frozen best-agent CLI candidate.
 *
 * This script owns everything around `ibench run`: it checks out the pinned
 * IBench release, installs the Harbor installed-agent plugin for the CLI,
 * materializes the frozen provider identity from a host credential, builds the
 * shared task base image, dispatches the predeclared task set, and transcribes
 * IBench's own `results.json` into a pass-rate report. It never grades a task
 * itself: `rewards.reward` in IBench's results is the only verdict source.
 *
 * Usage:
 *   node scripts/ibench-run.mjs [options]
 *
 * Options:
 *   --config <path>          frozen profile (default config/ibench.json)
 *   --tasks <ids>            comma-separated task ids (default: every released task)
 *   --limit <n>              take n tasks after offset
 *   --offset <n>             skip the first n tasks
 *   --shard <i> --shard-total <n>   take tasks where index % n == i
 *   --output <dir>           run directory (default results/ibench/<run-id>)
 *   --solver-config <path>   Harbor JobConfig for solving
 *   --score-config <path>    Harbor JobConfig for scoring
 *   --n-concurrent <n>       parallel trials (default from the profile)
 *   --solver-only            stop after collecting patches; score later
 *   --score-only             re-grade an existing run in place, no solver rerun
 *   --ibench-source <path>   IBench checkout (default .tmp/ibench-<sha8>)
 *   --skip-uv-sync           reuse an existing environment
 *   --skip-base-image        do not build the shared ibench-dev image
 *   --dry-run                print the plan without running anything
 *
 * Environment:
 *   BENCHMARK_PROVIDER_API_KEY  dim OAuth access token for the frozen provider
 *   DEEPSEEK_API_KEY            optional official scorer credential
 *   UV_DEFAULT_INDEX            optional package index override for uv
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROVIDER_CONNECTION_ID = "dimcode-api-oauth";
const DEFAULT_CREDENTIAL_REF = "benchmark-ci-dim-oauth";

export function parseArgs(argv) {
  const options = {
    configPath: join(repoRoot, "config/ibench.json"),
    taskIds: undefined,
    limit: undefined,
    offset: 0,
    shard: undefined,
    shardTotal: undefined,
    output: undefined,
    solverConfig: undefined,
    scoreConfig: undefined,
    nConcurrent: undefined,
    solverOnly: false,
    scoreOnly: false,
    ibenchSource: undefined,
    skipUvSync: false,
    skipBaseImage: false,
    dryRun: false,
  };
  const value = (name, index) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${name} requires a value.`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--config": options.configPath = resolve(value(arg, index)); index += 1; break;
      case "--tasks": options.taskIds = value(arg, index); index += 1; break;
      case "--limit": options.limit = Number(value(arg, index)); index += 1; break;
      case "--offset": options.offset = Number(value(arg, index)); index += 1; break;
      case "--shard": options.shard = Number(value(arg, index)); index += 1; break;
      case "--shard-total": options.shardTotal = Number(value(arg, index)); index += 1; break;
      case "--output": options.output = resolve(value(arg, index)); index += 1; break;
      case "--solver-config": options.solverConfig = resolve(value(arg, index)); index += 1; break;
      case "--score-config": options.scoreConfig = resolve(value(arg, index)); index += 1; break;
      case "--n-concurrent": options.nConcurrent = Number(value(arg, index)); index += 1; break;
      case "--solver-only": options.solverOnly = true; break;
      case "--score-only": options.scoreOnly = true; break;
      case "--ibench-source": options.ibenchSource = resolve(value(arg, index)); index += 1; break;
      case "--skip-uv-sync": options.skipUvSync = true; break;
      case "--skip-base-image": options.skipBaseImage = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "--help": options.help = true; break;
      default: throw new Error(`unknown option: ${arg}`);
    }
  }
  if (options.taskIds !== undefined && (options.limit !== undefined || options.shard !== undefined)) {
    throw new Error("--tasks cannot be combined with --limit or --shard.");
  }
  if (options.scoreOnly && options.solverOnly) {
    throw new Error("--score-only and --solver-only are opposite ends of the same run.");
  }
  if (options.scoreOnly && options.dryRun) {
    throw new Error("--score-only grades an existing run and has no plan to print.");
  }
  if ((options.shard === undefined) !== (options.shardTotal === undefined)) {
    throw new Error("--shard and --shard-total must be given together.");
  }
  return options;
}

/** Predeclare the exact task set for this run; nothing is chosen after the fact. */
export function selectTasks(tasks, { taskIds, limit, offset = 0, shard, shardTotal }) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const byName = new Map(tasks.map((task) => [task.name, task]));
  let selected;
  if (taskIds !== undefined) {
    const tokens = taskIds.split(",").map((token) => token.trim()).filter(Boolean);
    if (tokens.length === 0) throw new Error("--tasks is empty.");
    const unknown = tokens.filter((token) => !byId.has(token) && !byName.has(token));
    if (unknown.length > 0) throw new Error(`--tasks contains unknown ids or names: ${unknown.join(", ")}`);
    selected = tokens.map((token) => byId.get(token) ?? byName.get(token));
    if (new Set(selected.map((task) => task.id)).size !== selected.length) {
      throw new Error("--tasks selects the same task twice.");
    }
  } else {
    if (!Number.isInteger(offset) || offset < 0) throw new Error("--offset must be a non-negative integer.");
    selected = tasks.slice(offset);
    if (shard !== undefined) {
      if (!Number.isInteger(shardTotal) || shardTotal < 1) throw new Error("--shard-total must be positive.");
      if (!Number.isInteger(shard) || shard < 0 || shard >= shardTotal) throw new Error("--shard must be 0..shardTotal-1.");
      selected = selected.filter((_, index) => index % shardTotal === shard);
    }
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer.");
      selected = selected.slice(0, limit);
    }
  }
  if (selected.length === 0) throw new Error("The predeclared task set is empty.");
  return selected;
}

/** Compare a SHA-256 digest of exact bytes against the frozen release manifest. */
export function verifyFileSha256(path, expected) {
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (digest !== expected) {
    throw new Error(`frozen manifest hash mismatch: ${path} is ${digest}, expected ${expected}`);
  }
  return digest;
}

/**
 * Transcribe IBench's canonical results into a pass-rate report.
 *
 * `trials` carries one entry per declared task. A task passes only when the
 * trusted score step returned reward 1; a missing or failed trial stays a
 * non-pass, never a retry.
 */
export function computeReport({ profile, release, tasks, trials, run, context }) {
  const byId = new Map();
  for (const trial of trials ?? []) {
    const id = trial.task_id ?? trial.taskId;
    if (id !== undefined) byId.set(id, trial);
  }
  const rows = tasks.map((task) => {
    const trial = byId.get(task.id);
    const reward = trial?.rewards?.reward;
    const passed = reward === 1;
    return {
      id: task.id,
      name: task.name,
      status: trial?.status ?? "missing",
      passed,
      reward: typeof reward === "number" ? reward : null,
      error: trial?.error ?? null,
      verdicts: Array.isArray(trial?.verdicts) ? trial.verdicts.length : 0,
    };
  });
  const passed = rows.filter((row) => row.passed).length;
  const total = rows.length;
  const completeSet =
    total === release.taskCount &&
    rows.every((row, index) => row.id === tasks[index].id) &&
    new Set(rows.map((row) => row.id)).size === release.taskCount;
  return {
    schemaVersion: 1,
    benchmark: "ibench",
    generatedAt: new Date().toISOString(),
    runId: context.runId,
    release: {
      repository: release.repository,
      commit: release.commit,
      manifestSha256: release.releaseManifestSha256,
      taskCount: release.taskCount,
    },
    candidate: {
      harness: profile.solver.harness,
      label: profile.solver.label,
      solverConfig: profile.solver.config,
      scorerHarness: context.scorer.harness,
      scorerLabel: context.scorer.label,
      scorerConfig: context.scorer.config,
      scorerIsOfficial: context.scorer.official,
    },
    provider: {
      model: profile.provider.model,
      reasoningEffort: profile.provider.reasoningEffort,
      baseURL: profile.provider.baseURL,
      transportProfile: profile.provider.transportProfile,
    },
    instructionProfile: release.instructionProfile,
    solverOnly: Boolean(run.solverOnly),
    // A solver-only run has no verdicts yet; its rate stays undefined instead
    // of reading as a measured zero.
    passRate: run.solverOnly || total === 0 ? null : passed / total,
    deferred: Boolean(run.solverOnly),
    passed,
    total,
    comparableToPublishedLeaderboard: completeSet && !run.solverOnly && context.scorer.official,
    baseline: profile.baseline,
    tasks: rows,
  };
}

export function renderReportMarkdown(report) {
  const lines = [
    `# IBench run ${report.runId}`,
    "",
    `- Release: \`${report.release.commit}\` (${report.release.taskCount} tasks, profile \`${report.instructionProfile}\`)`,
    `- Solver: ${report.candidate.label}`,
    `- Scorer: ${report.candidate.scorerLabel}${report.candidate.scorerIsOfficial ? "" : " (non-official scorer)"}`,
    `- Provider: \`${report.provider.model}\` effort \`${report.provider.reasoningEffort}\` via ${report.provider.baseURL}`,
    report.passRate === null
      ? `- Pass rate: deferred (${report.passed}/${report.total} seen)`
      : `- Pass rate: **${report.passed}/${report.total}** = ${(report.passRate * 100).toFixed(1)}%`,
    `- Published DSH reference: ${report.baseline.passed}/${report.baseline.total} = ${(report.baseline.passRate * 100).toFixed(1)}% (${report.baseline.harness} / ${report.baseline.model}, ${report.baseline.source})`,
    `- Comparable to the published leaderboard: ${report.comparableToPublishedLeaderboard ? "yes" : "no"}`,
    report.solverOnly ? "- Solver-only run: scoring deferred, so no task has a verdict yet." : "",
    "",
    "| Task | Status | Reward | Verdicts | Error |",
    "| --- | --- | --- | --- | --- |",
    ...report.tasks.map(
      (task) =>
        `| \`${task.id}\` | ${task.status} | ${task.reward === null ? "-" : task.reward} | ${task.verdicts} | ${
          task.error === null ? "" : String(task.error).replace(/\|/g, "\\|").slice(0, 160)
        } |`,
    ),
    "",
  ];
  return lines.filter((line) => line !== "").join("\n") + "\n";
}

function run(command, args, { cwd, env = {}, allowFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 || allowFailure) return resolvePromise({ code, signal });
      reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}`));
    });
  });
}

function capture(command, args, { cwd } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolvePromise(stdout) : reject(new Error(`${command} failed: ${stderr.trim()}`)),
    );
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("The provider credential is not a JWT.");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

/**
 * Write the CLI's provider identity: provider.json plus the dimcode auth home
 * its `dim-oauth` transport resolves the access token from.
 */
export function materializeProvider({ profile, directory, token, credentialRef, auth = {} }) {
  if (!token) throw new Error("A provider access token is required.");
  const payload = decodeJwtPayload(token);
  if (!Number.isInteger(payload.exp) || payload.exp * 1000 <= Date.now()) {
    throw new Error("The provider access token is expired.");
  }
  const ref = credentialRef || DEFAULT_CREDENTIAL_REF;
  const dimcodeHome = join(directory, "dimcode-home");
  mkdirSync(join(dimcodeHome, "dimcode"), { recursive: true });
  writeFileSync(
    join(directory, "provider.json"),
    `${JSON.stringify(
      {
        kind: profile.kind,
        model: profile.model,
        apiKey: token,
        baseURL: profile.baseURL,
        compatibilityMode: profile.compatibilityMode,
        reasoningEffort: profile.reasoningEffort,
        credentialRef: ref,
        transportProfile: profile.transportProfile,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(dimcodeHome, "config.json"),
    `${JSON.stringify(
      {
        settings: {
          providerConnections: {
            [PROVIDER_CONNECTION_ID]: {
              adapter: "openai",
              credentialRef: ref,
              baseUrl: profile.baseURL,
              models: [{ id: profile.model, type: "chat", vision: false }],
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(dimcodeHome, "dimcode", "auth.json"),
    `${JSON.stringify(
      {
        nextApiOauth: {
          type: "oauth",
          access: token,
          expires: payload.exp * 1000,
          relayBaseUrl: profile.baseURL,
          credentialRef: ref,
          ...auth,
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return { providerConfig: join(directory, "provider.json"), dimcodeHome, expiresAt: payload.exp * 1000 };
}

/** Resolve the provider credential the same way the published CI path does. */
export function resolveProviderCredential(environment = process.env, home = homedir()) {
  if (environment.BENCHMARK_PROVIDER_API_KEY) {
    return { token: environment.BENCHMARK_PROVIDER_API_KEY, credentialRef: DEFAULT_CREDENTIAL_REF, source: "BENCHMARK_PROVIDER_API_KEY" };
  }
  const authPath = join(home, ".dimcode", "dimcode", "auth.json");
  if (existsSync(authPath)) {
    const auth = readJson(authPath).nextApiOauth;
    if (auth?.access) {
      const { access, expires, relayBaseUrl, clientSecret, refresh, ...rest } = auth;
      return {
        token: access,
        credentialRef: auth.credentialRef ?? DEFAULT_CREDENTIAL_REF,
        source: authPath,
        auth: rest,
      };
    }
  }
  throw new Error("No provider credential: set BENCHMARK_PROVIDER_API_KEY or log in with dimcode.");
}

function pickScorer(profile, override) {
  const official = profile.scorer.official;
  const fallback = profile.scorer.fallback;
  const officialReady = official.requires.every((name) => Boolean(process.env[name]));
  const chosen = override
    ? { config: override, harness: "custom", label: override, official: false }
    : officialReady
      ? { ...official, official: true }
      : { ...fallback, official: false };
  return {
    config: isAbsolute(chosen.config) ? chosen.config : join(repoRoot, chosen.config),
    harness: chosen.harness,
    label: chosen.label,
    official: chosen.official,
  };
}

async function ensureCheckout(source, release) {
  if (!existsSync(source)) {
    mkdirSync(dirname(source), { recursive: true });
    console.log(`ibench> cloning ${release.repository} into ${source}`);
    await run("git", ["clone", "--filter=blob:none", release.repository, source]);
  }
  await run("git", ["-C", source, "fetch", "--no-auto-maintenance", "origin", release.commit], {
    allowFailure: true,
  });
  await run("git", ["-C", source, "checkout", "--detach", release.commit]);
  const head = (await capture("git", ["-C", source, "rev-parse", "HEAD"])).trim();
  if (head !== release.commit) throw new Error(`IBench checkout is at ${head}, expected ${release.commit}`);
  const manifestPath = join(source, release.releaseManifest);
  const digest = verifyFileSha256(manifestPath, release.releaseManifestSha256);
  return { manifestPath, digest };
}

function baseImageVersion(source) {
  return readFileSync(join(source, "environments/base/VERSION"), "utf8").trim();
}

async function ensureBaseImage(source, version) {
  const image = `ibench-dev:${version}`;
  const existing = await run("docker", ["image", "inspect", image], { allowFailure: true });
  if (existing.code === 0) {
    console.log(`ibench> base image ${image} already present`);
    return image;
  }
  console.log(`ibench> building base image ${image}`);
  await run("bash", ["scripts/build-dev-images.sh"], { cwd: source });
  return image;
}

/**
 * Re-grade an existing run in place with a different scorer.
 *
 * IBench keeps the solver's frozen patches in `jobs/solve` and the compiled
 * score tasks in `compiled/score`, so `ibench score --overwrite` replaces the
 * judge without repeating a single model attempt. That is what lets a run be
 * solved once and then graded by the official scorer, keeping the harness
 * reading and the judge independent.
 */
async function scoreExistingRun({ options, profile, source, output, scorer, nConcurrent }) {
  const resultsPath = join(output, "results.json");
  const reportPath = join(output, "ibench-report.json");
  const previous = existsSync(reportPath) ? readJson(reportPath) : undefined;
  const results = readJson(resultsPath);
  const tasks = previous?.tasks?.length
    ? previous.tasks.map(({ id, name }) => ({ id, name }))
    : (results.trials ?? []).map((trial) => ({
        id: trial.task_id,
        name: trial.task_name ?? trial.task_id,
      }));
  if (tasks.length === 0) throw new Error(`${output} has no task to grade.`);
  const runId = previous?.runId ?? process.env.IBENCH_RUN_ID ?? `score-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  const providerDir = join(repoRoot, ".tmp", `ibench-provider-${process.pid}`);
  mkdirSync(providerDir, { recursive: true });
  const credential = resolveProviderCredential();
  const provider = materializeProvider({
    profile: profile.provider,
    directory: providerDir,
    token: credential.token,
    credentialRef: credential.credentialRef,
    auth: credential.auth,
  });
  try {
    if (!options.skipUvSync) await run("uv", ["sync", "--frozen"], { cwd: source });
    await run("uv", [
      "pip", "install", "--python", join(source, ".venv/bin/python"), "-e", join(repoRoot, "tools/ibench-agent"),
    ]);
    if (!options.skipBaseImage) await ensureBaseImage(source, baseImageVersion(source));

    const args = [
      "run", "--no-sync", "ibench", "score", output,
      "--config", scorer.config,
      "--n-concurrent", String(nConcurrent),
      "--overwrite",
    ];
    console.log(`ibench> ${["uv", ...args].join(" ")}`);
    const started = Date.now();
    const result = await run("uv", args, {
      cwd: source,
      allowFailure: true,
      env: {
        BEST_AGENT_PROVIDER_CONFIG: provider.providerConfig,
        DIMCODE_HOME: provider.dimcodeHome,
      },
    });
    const elapsedMs = Date.now() - started;
    const graded = readJson(resultsPath);
    const report = computeReport({
      profile,
      release: profile.release,
      tasks,
      trials: graded.trials ?? [],
      run: { solverOnly: false },
      context: { runId, scorer },
    });
    report.ibench = {
      exitCode: result.code,
      elapsedMs,
      phase: graded.phase,
      success: graded.success,
      error: graded.error ?? null,
      regraded: true,
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(output, "ibench-report.md"), renderReportMarkdown(report));
    const rate = report.passRate === null ? "deferred" : `${(report.passRate * 100).toFixed(1)}%`;
    console.log(
      `ibench> re-graded ${report.passed}/${report.total} = ${rate} ` +
        `(scorer: ${scorer.harness}${scorer.official ? "" : ", non-official"}); report: ${join(output, "ibench-report.md")}`,
    );
    if (graded.error) console.error(`ibench> score error: ${graded.error}`);
  } finally {
    rmSync(providerDir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0] + "*/\n");
    return;
  }
  const profile = readJson(options.configPath);
  if (profile.schemaVersion !== 1 || profile.benchmark !== "ibench") {
    throw new Error(`${options.configPath} is not an ibench profile.`);
  }
  const source = options.ibenchSource ?? join(repoRoot, ".tmp", `ibench-${profile.release.commit.slice(0, 8)}`);
  const { manifestPath } = await ensureCheckout(source, profile.release);
  const manifest = readJson(manifestPath);
  if (manifest.tasks.length !== profile.release.taskCount) {
    throw new Error(`release has ${manifest.tasks.length} tasks, profile freezes ${profile.release.taskCount}`);
  }
  const tasks = selectTasks(manifest.tasks, {
    taskIds: options.taskIds,
    limit: options.limit,
    offset: options.offset,
    shard: options.shard,
    shardTotal: options.shardTotal,
  });
  const runId = process.env.IBENCH_RUN_ID ?? `${profile.release.commit.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const output = options.output ?? join(repoRoot, "results", "ibench", runId);
  if (options.scoreOnly) {
    if (options.output === undefined) throw new Error("--score-only requires --output naming an existing run directory.");
    if (!existsSync(join(output, "results.json"))) throw new Error(`${output} is not an IBench run directory.`);
  } else if (existsSync(output)) {
    throw new Error(`run output already exists: ${output}`);
  }
  const solverConfig = options.solverConfig ?? join(repoRoot, profile.solver.config);
  const scorer = pickScorer(profile, options.scoreConfig);
  const nConcurrent = options.nConcurrent ?? profile.limits.nConcurrent;
  if (options.scoreOnly) {
    await scoreExistingRun({ options, profile, source, output, scorer, nConcurrent });
    return;
  }
  const declared = {
    runId,
    output,
    source,
    tasks: tasks.map((task) => task.id),
    solverConfig,
    scorerConfig: scorer.config,
    nConcurrent,
    solverOnly: options.solverOnly,
  };
  if (options.dryRun) {
    console.log(JSON.stringify({ ...declared, scorer, profile: profile.provider }, null, 2));
    return;
  }

  const providerDir = join(repoRoot, ".tmp", `ibench-provider-${runId}`);
  mkdirSync(providerDir, { recursive: true });
  const credential = resolveProviderCredential();
  const provider = materializeProvider({
    profile: profile.provider,
    directory: providerDir,
    token: credential.token,
    credentialRef: credential.credentialRef,
    auth: credential.auth,
  });
  console.log(
    `ibench> provider ${profile.provider.model}/${profile.provider.reasoningEffort} from ${credential.source} ` +
      `(expires ${new Date(provider.expiresAt).toISOString()})`,
  );

  if (!options.skipUvSync) {
    // `--frozen` installs the published lock verbatim. The release's pyproject
    // and lock do not satisfy `--locked` under newer uv, and re-resolving would
    // silently change the graded environment, so the lock itself is the pin.
    console.log("ibench> uv sync --frozen");
    await run("uv", ["sync", "--frozen"], { cwd: source });
  }
  console.log("ibench> installing the best-agent Harbor plugin into the IBench environment");
  await run("uv", ["pip", "install", "--python", join(source, ".venv/bin/python"), "-e", join(repoRoot, "tools/ibench-agent")]);

  if (!options.skipBaseImage) await ensureBaseImage(source, baseImageVersion(source));

  const args = [
    "run", "--no-sync", "ibench", "run",
    "--path", source,
    "--output", output,
    "--profile", profile.release.instructionProfile,
    "--n-concurrent", String(nConcurrent),
    "--solver-config", solverConfig,
    "--score-config", scorer.config,
    ...tasks.flatMap((task) => ["--task", task.id]),
    ...(options.solverOnly ? ["--solver-only"] : []),
  ];
  console.log(`ibench> ${["uv", ...args].join(" ")}`);
  const started = Date.now();
  let result;
  try {
    result = await run("uv", args, {
      cwd: source,
      allowFailure: true,
      env: {
        BEST_AGENT_PROVIDER_CONFIG: provider.providerConfig,
        DIMCODE_HOME: provider.dimcodeHome,
      },
    });
  } finally {
    // The materialized identity is a credential copy; the run keeps only its evidence.
    rmSync(providerDir, { recursive: true, force: true });
  }
  const elapsedMs = Date.now() - started;

  const resultsPath = join(output, "results.json");
  if (!existsSync(resultsPath)) {
    throw new Error(`IBench did not write ${resultsPath} (exit ${result.code ?? result.signal})`);
  }
  const ibenchResults = readJson(resultsPath);
  const report = computeReport({
    profile,
    release: profile.release,
    tasks,
    trials: ibenchResults.trials ?? [],
    run: { solverOnly: options.solverOnly },
    context: { runId, scorer },
  });
  report.ibench = {
    exitCode: result.code,
    elapsedMs,
    phase: ibenchResults.phase,
    success: ibenchResults.success,
    error: ibenchResults.error ?? null,
  };
  writeFileSync(join(output, "ibench-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(output, "ibench-report.md"), renderReportMarkdown(report));
  const rate = report.passRate === null ? "deferred" : `${(report.passRate * 100).toFixed(1)}%`;
  console.log(
    `ibench> ${report.passed}/${report.total} = ${rate} ` +
      `(scorer: ${scorer.harness}${scorer.official ? "" : ", non-official"}); report: ${join(output, "ibench-report.md")}`,
  );
  if (ibenchResults.error) console.error(`ibench> run error: ${ibenchResults.error}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`ibench-run: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
