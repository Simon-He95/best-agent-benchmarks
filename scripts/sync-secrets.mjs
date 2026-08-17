/**
 * Push the local dimcode OAuth provider config to THIS repo's GitHub Actions benchmark secrets.
 *
 *   node scripts/sync-secrets.mjs [--repo <owner/repo>] [--matrix gpt4o,claude,deepseek]
 *
 *   --repo    target repository (default: current git remote)
 *   --matrix  also fill MATRIX_PROVIDER_<NAME>_* slots with the same config
 *
 * Requirements: `gh` CLI authenticated (`gh auth login`), local provider config at
 * ~/.best-agent/provider.json (BEST_AGENT_PROVIDER_CONFIG overrides).
 *
 * Values are fed to `gh secret set` via stdin, never through argv, so they do not appear in
 * the process list or shell history. Nothing is printed to the terminal.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function repoFromRemote() {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const url = (result.stdout ?? "").trim();
  const match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/u);
  return match ? match[1] : undefined;
}

function providerConfigPath(environment = process.env) {
  const override = environment.BEST_AGENT_PROVIDER_CONFIG;
  if (override !== undefined) {
    if (!isAbsolute(override)) throw new Error("BEST_AGENT_PROVIDER_CONFIG must be absolute.");
    return override;
  }
  const home = homedir();
  return home ? resolve(home, ".best-agent", "provider.json") : undefined;
}

function readProviderConfig() {
  const path = providerConfigPath();
  if (!path || !existsSync(path)) {
    throw new Error(`Provider config not found at ${path ?? "(no home)"}. Log in via dimcode OAuth first.`);
  }
  const value = JSON.parse(readFileSync(path, "utf8"));
  // provider.json uses `baseURL` (uppercase); tolerate `baseUrl` too.
  const { kind, model, apiKey, compatibilityMode } = value ?? {};
  const baseUrl = value?.baseURL ?? value?.baseUrl;
  if (typeof kind !== "string" || kind.length === 0 || typeof model !== "string" || typeof apiKey !== "string") {
    throw new Error(`Provider config at ${path} is missing kind/model/apiKey.`);
  }
  return { kind, model, apiKey, baseUrl, compatibilityMode };
}

function setSecret(name, value, repo) {
  if (value === undefined || value === null || value === "") return;
  // Omit --body so gh reads the value from stdin — the secret never appears in argv
  // or shell history.
  const result = spawnSync("gh", ["secret", "set", name, "--repo", repo], {
    input: String(value),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`gh secret set ${name} failed: ${(result.stderr ?? "").trim()}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  let repo;
  let matrix = [];
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--repo":
        repo = argv[++i];
        break;
      case "--matrix":
        matrix = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!repo) {
    repo = repoFromRemote();
    if (!repo) throw new Error("Cannot infer repo; pass --repo <owner/repo>.");
  }

  const config = readProviderConfig();
  setSecret("BENCHMARK_PROVIDER_KIND", config.kind, repo);
  setSecret("BENCHMARK_PROVIDER_MODEL", config.model, repo);
  setSecret("BENCHMARK_PROVIDER_API_KEY", config.apiKey, repo);
  setSecret("BENCHMARK_PROVIDER_BASE_URL", config.baseUrl, repo);
  setSecret("BENCHMARK_PROVIDER_COMPATIBILITY_MODE", config.compatibilityMode, repo);

  for (const name of matrix) {
    const prefix = `MATRIX_PROVIDER_${name.toUpperCase()}`;
    setSecret(`${prefix}_KIND`, config.kind, repo);
    setSecret(`${prefix}_MODEL`, config.model, repo);
    setSecret(`${prefix}_API_KEY`, config.apiKey, repo);
    setSecret(`${prefix}_BASE_URL`, config.baseUrl, repo);
    setSecret(`${prefix}_COMPATIBILITY_MODE`, config.compatibilityMode, repo);
  }

  process.stdout.write(`Secrets synced to ${repo} (kind=${config.kind}, model=${config.model}).\n`);
}

main();
