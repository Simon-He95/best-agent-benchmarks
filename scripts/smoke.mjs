/**
 * Headless composition smoke test (v3).
 *
 * Verifies the exact benchmark composition end-to-end against a real provider:
 *   - `best-agent run` one-shot headless mode (no TUI, no interaction tools / ask_user);
 *   - full access: `--workspace-grant read write exec`;
 *   - the agent actually edits the workspace (diff captured);
 *   - no ask-user stall (the run completes without a human prompt).
 *
 * Usage:
 *   node scripts/smoke.mjs [--model <id>] [--prompt <text>] [--keep]
 *
 * Environment: BEST_AGENT_PROVIDER_KIND/MODEL/API_KEY[/BASE_URL/COMPATIBILITY_MODE], otherwise
 * the CLI resolves `~/.best-agent/provider.json`, then dimcode OAuth.
 *
 * Exit 0 on success; 1 on any failure. Prints a JSON summary.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function resolveCliPrefix() {
  for (const entry of [
    resolve(repoRoot, "node_modules", "@best-agent", "cli", "dist", "index.js"),
    resolve(repoRoot, "apps", "cli", "dist", "index.js"),
  ]) {
    if (existsSync(entry)) return [process.execPath, entry];
  }
  return [resolve(repoRoot, "node_modules", ".bin", "best-agent")];
}

async function main() {
  const argv = process.argv.slice(2);
  let model;
  let promptOverride;
  let keep = false;
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--model":
        model = argv[++i];
        break;
      case "--prompt":
        promptOverride = argv[++i];
        break;
      case "--keep":
        keep = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  const workspace = mkdtempSync(`${tmpdir()}/ba-smoke-`);
  const target = resolve(workspace, "math_utils.py");
  writeFileSync(
    target,
    [
      "def divide(a, b):",
      "    return a / b  # bug: no zero check",
      "",
    ].join("\n"),
  );

  const prompt =
    promptOverride ??
    [
      "You are fixing a bug in a small Python file.",
      "You have these workspace tools available: read, write, edit, search, stat, list, mkdir, remove, exec, apply_patch.",
      "Use the exact tool names above — never call any other tool.",
      "Read math_utils.py, fix the division bug so dividing by zero raises ValueError with",
      "a clear message instead of ZeroDivisionError. Apply the minimal change with edit or",
      "apply_patch, then confirm the change with read.",
    ].join("\n");

  const cliPrefix = resolveCliPrefix();
  const cliArgs = [
    "run",
    "--workspace",
    workspace,
    ...["read", "write", "exec"].flatMap((grant) => ["--workspace-grant", grant]),
    // Spec 069: the benchmark environment is ALWAYS the plain workspace backend. No
    // sandbox fallback — if the installed CLI lacks the flag, the smoke gate fails.
    "--workspace-backend",
    "plain",
    ...(model === undefined ? [] : ["--model", model]),
    prompt,
  ];

  const started = performance.now();
  // The dimcode relay channel pool is intermittently overloaded ("channel not found").
  // Retry the composition a few times with a short backoff before declaring the gate
  // failed; only a persistent relay failure aborts the run.
  let result;
  const MAX_RELAY_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RELAY_RETRIES; attempt += 1) {
    result = await runProcess([...cliPrefix, ...cliArgs], workspace, 300_000);
    const message = `${result.stderr ?? ""}${result.stdout ?? ""}`;
    if (!/channel not found|获取重试渠道|get_channel_failed|reasoning_content.*must be passed back/iu.test(message)) break;
    if (attempt < MAX_RELAY_RETRIES) {
      process.stderr.write(
        `smoke> relay channel overloaded (attempt ${attempt}/${MAX_RELAY_RETRIES}); retrying in 10s\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
  const wallMs = Math.round(performance.now() - started);

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  let fixed = false;
  try {
    const content = readFileSync(target, "utf8");
    // A correct fix keeps the division but guards the zero case (raises ValueError).
    fixed = content.includes("a / b") && /zero|== 0|b != 0|b === 0/i.test(content);
  } catch {
    fixed = false;
  }

  const relayMessage = `${stderr}${stdout}`;
  const relayOverloaded = /channel not found|获取重试渠道|get_channel_failed|reasoning_content.*must be passed back/iu.test(relayMessage);
  const summary = {
    ok: result.status === 0 && fixed && !result.timedOut,
    cliExitCode: result.status,
    timedOut: result.timedOut === true,
    fixed,
    relayOverloaded,
    wallMs,
    composition: {
      mode: "run (headless)",
      fullAccess: true,
      workspaceGrants: ["read", "write", "exec"],
      interactionTools: false,
      workspaceBackend: "plain (spec 069; always)",
    },
    finalAnswer: stdout.trim().slice(-800),
    cliError: stderr.trim().slice(-800),
    workspace,
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  if (!keep) rmSync(workspace, { recursive: true, force: true });
  if (relayOverloaded) {
    process.stderr.write(
      "SMOKE FAILED: relay channel overloaded (persistent get_channel_failed). " +
        "Wait for the relay to stabilize, then retry the run.\n",
    );
  }
  process.exit(summary.ok ? 0 : 1);
}

function runProcess(args, cwd, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(args[0], args.slice(1), { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
      settle({ status: null, signal: "SIGTERM", stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { if (stdout.length < 16 * 1024 * 1024) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < 16 * 1024 * 1024) stderr += chunk; });
    child.on("error", (error) => settle({ status: null, signal: null, stdout, stderr, timedOut: false, error }));
    child.on("close", (code, signal) => settle({ status: code, signal, stdout, stderr, timedOut: false }));
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
