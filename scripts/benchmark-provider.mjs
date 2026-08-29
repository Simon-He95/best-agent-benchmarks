import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Provider description helpers for the v3 benchmark scripts.
 *
 * The benchmark scripts spawn the v3 CLI one-shot `run` command, which resolves the provider
 * itself (explicit flags > `BEST_AGENT_PROVIDER_*` env > `~/.best-agent/provider.json` >
 * dimcode OAuth persistence). These helpers only *describe* the resolved provider for the
 * report — they never hold, print, or forward API keys.
 */

function providerConfigPath(environment = process.env) {
  const override = environment.BEST_AGENT_PROVIDER_CONFIG;
  if (override !== undefined) {
    if (!isAbsolute(override)) throw new Error("BEST_AGENT_PROVIDER_CONFIG must be absolute.");
    return override;
  }
  const home = homedir();
  return home ? join(home, ".best-agent", "provider.json") : undefined;
}

function readProviderFile(environment = process.env) {
  const path = providerConfigPath(environment);
  if (path === undefined || !existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Bounded provider description with the full non-secret request identity. */
export function describeBenchmarkProvider(environment = process.env) {
  const file = readProviderFile(environment);
  const kind = environment.BEST_AGENT_PROVIDER_KIND ?? file?.kind ?? (file ? undefined : "unknown");
  const model = environment.BEST_AGENT_PROVIDER_MODEL ?? file?.model ?? "unconfigured";
  const compatibilityMode =
    environment.BEST_AGENT_PROVIDER_COMPATIBILITY_MODE ?? file?.compatibilityMode ?? undefined;
  const baseURL = environment.BEST_AGENT_PROVIDER_BASE_URL ?? file?.baseURL ?? undefined;
  const reasoningEffort = file?.reasoningEffort;
  const transportProfile = file?.transportProfile;
  return Object.freeze({
    kind: String(kind ?? "unknown"),
    model: String(model),
    ...(compatibilityMode === undefined ? {} : { compatibilityMode }),
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(transportProfile === undefined ? {} : { transportProfile }),
  });
}
