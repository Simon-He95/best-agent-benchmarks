/**
 * Push the local dimcode OAuth login to THIS repo's GitHub Actions benchmark secrets.
 *
 * Reads the dimsdk OAuth persistence (DIMCODE_HOME first, ~/.dimcode fallback):
 *   <home>/dimcode/auth.json  -> nextApiOauth.access (JWT) + relayBaseUrl
 * and syncs it as an OpenAI-compatible provider for the bench workflow:
 *   BENCHMARK_PROVIDER_KIND = openai
 *   BENCHMARK_PROVIDER_MODEL = deepseek-v4-flash (--model override)
 *   BENCHMARK_PROVIDER_API_KEY = <oauth access token>
 *   BENCHMARK_PROVIDER_BASE_URL = <relayBaseUrl>
 *   BENCHMARK_PROVIDER_COMPATIBILITY_MODE = compatible
 *
 * The OAuth access token rotates roughly every 5-7 days; re-run this script to keep the
 * CI secrets fresh (same workflow the original best-agent repo used).
 *
 * Usage:
 *   node scripts/sync-secrets.mjs [--repo <owner/repo>] [--model <id>]
 *
 * Requirements: `gh` CLI authenticated, dimcode OAuth logged in on this machine.
 * Values are fed to `gh secret set` via stdin, never through argv — nothing is printed.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_MODEL = "deepseek-v4-flash";

function repoFromRemote() {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const url = (result.stdout ?? "").trim();
  const match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/u);
  return match ? match[1] : undefined;
}

/** dimcode home: DIMCODE_HOME when set, else ~/.dimcode. */
function dimcodeHome(environment = process.env) {
  const explicit = environment.DIMCODE_HOME?.trim();
  if (explicit) return resolve(explicit);
  return join(homedir() ?? ".", ".dimcode");
}

function readJsonRecord(filePath) {
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Reads the dimsdk OAuth login: JWT access token + relay base URL. */
function readOAuthLogin() {
  const home = dimcodeHome();
  const auth = readJsonRecord(join(home, "dimcode", "auth.json"));
  const tokens = auth.nextApiOauth ?? {};
  const access = typeof tokens.access === "string" && tokens.access.trim() ? tokens.access.trim() : undefined;
  const relayBaseUrl =
    typeof tokens.relayBaseUrl === "string" && tokens.relayBaseUrl.trim()
      ? tokens.relayBaseUrl.trim()
      : undefined;
  if (!access || !relayBaseUrl) {
    throw new Error(
      `No dimcode OAuth login found at ${join(home, "dimcode", "auth.json")} (need nextApiOauth.access + relayBaseUrl). ` +
        "Log in through the dimcode OAuth flow first.",
    );
  }
  return { access, relayBaseUrl };
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
  let model = DEFAULT_MODEL;
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--repo":
        repo = argv[++i];
        break;
      case "--model":
        model = argv[++i] || DEFAULT_MODEL;
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!repo) {
    repo = repoFromRemote();
    if (!repo) throw new Error("Cannot infer repo; pass --repo <owner/repo>.");
  }

  const login = readOAuthLogin();
  setSecret("BENCHMARK_PROVIDER_KIND", "openai", repo);
  setSecret("BENCHMARK_PROVIDER_MODEL", model, repo);
  setSecret("BENCHMARK_PROVIDER_API_KEY", login.access, repo);
  setSecret("BENCHMARK_PROVIDER_BASE_URL", login.relayBaseUrl, repo);
  setSecret("BENCHMARK_PROVIDER_COMPATIBILITY_MODE", "compatible", repo);

  process.stdout.write(`Secrets synced to ${repo} (dimcode OAuth, model=${model}).\n`);
}

main();
