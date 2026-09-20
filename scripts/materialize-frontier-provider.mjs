#!/usr/bin/env node
/**
 * Materializes the frozen frontier-harness provider identity.
 *
 * Usage:
 *   node scripts/materialize-frontier-provider.mjs <root> <github-env-file> \
 *     <provider-config> [reasoning-effort]
 *
 * The reasoning effort is the frozen profile's default unless the run declares
 * one of the profile's own `reasoningEffortOptions`; an undeclared effort is
 * refused here, so every attempt runs at an effort the frozen config names.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [rootInput, githubEnvInput, configInput, reasoningEffortInput] = process.argv.slice(2);
if (!rootInput || !githubEnvInput || !configInput) {
  throw new Error(
    "Usage: materialize-frontier-provider.mjs <root> <github-env-file> <provider-config> [reasoning-effort]",
  );
}
const apiKey = process.env.BENCHMARK_PROVIDER_API_KEY;
if (!apiKey) throw new Error("BENCHMARK_PROVIDER_API_KEY is required.");

const candidate = JSON.parse(
  readFileSync(resolve(configInput), "utf8"),
);
const provider = candidate.provider;
const options = provider?.reasoningEffortOptions;
if (
  provider?.kind !== "openai" ||
  provider.model !== "glm-5.3" ||
  provider.compatibilityMode !== "compatible" ||
  provider.transportProfile !== "dim-oauth" ||
  typeof provider.baseURL !== "string" ||
  !Array.isArray(options) ||
  options.length < 1 ||
  new Set(options).size !== options.length ||
  !options.includes(provider.reasoningEffort)
) {
  throw new Error("The frozen frontier-harness provider profile is invalid.");
}
const requested = (reasoningEffortInput ?? "").trim();
const reasoningEffort = requested === "" ? provider.reasoningEffort : requested;
if (!options.includes(reasoningEffort)) {
  throw new Error(
    `Reasoning effort ${reasoningEffort} is not a declared option of the frozen frontier-harness provider profile.`,
  );
}

const tokenParts = apiKey.split(".");
if (tokenParts.length !== 3) throw new Error("Benchmark OAuth access token is not a JWT.");
const tokenPayload = JSON.parse(Buffer.from(tokenParts[1], "base64url").toString("utf8"));
if (!Number.isInteger(tokenPayload.exp) || tokenPayload.exp * 1_000 <= Date.now()) {
  throw new Error("Benchmark OAuth access token is expired.");
}

const root = resolve(rootInput);
const dimcodeHome = resolve(root, "dimcode-home");
const providerPath = resolve(root, "provider.json");
const credentialRef = "benchmark-ci-dim-oauth";
mkdirSync(resolve(dimcodeHome, "dimcode"), { recursive: true });
writeFileSync(
  resolve(dimcodeHome, "config.json"),
  `${JSON.stringify(
    {
      settings: {
        providerConnections: {
          "dimcode-api-oauth": {
            adapter: "openai",
            credentialRef,
            baseUrl: provider.baseURL,
            models: [{ id: provider.model, type: "chat", vision: false }],
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
  resolve(dimcodeHome, "dimcode", "auth.json"),
  `${JSON.stringify(
    {
      nextApiOauth: {
        type: "oauth",
        access: apiKey,
        expires: tokenPayload.exp * 1_000,
        relayBaseUrl: provider.baseURL,
        credentialRef,
      },
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
writeFileSync(
  providerPath,
  `${JSON.stringify(
    {
      kind: provider.kind,
      model: provider.model,
      apiKey,
      baseURL: provider.baseURL,
      compatibilityMode: provider.compatibilityMode,
      reasoningEffort,
      credentialRef,
      transportProfile: provider.transportProfile,
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
writeFileSync(
  resolve(githubEnvInput),
  `BEST_AGENT_PROVIDER_CONFIG=${providerPath}\nDIMCODE_HOME=${dimcodeHome}\nBEST_AGENT_PROVIDER_BASE_URL=${provider.baseURL}\n`,
  { flag: "a" },
);
process.stdout.write(
  `${JSON.stringify({ model: provider.model, reasoningEffort, transportProfile: provider.transportProfile })}\n`,
);
