#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [rootInput, githubEnvInput, configInput] = process.argv.slice(2);
if (!rootInput || !githubEnvInput || !configInput) {
  throw new Error(
    "Usage: materialize-ci-provider.mjs <root> <github-env-file> <provider-config>",
  );
}
const apiKey = process.env.BENCHMARK_PROVIDER_API_KEY;
if (!apiKey) throw new Error("BENCHMARK_PROVIDER_API_KEY is required.");

const candidate = JSON.parse(
  readFileSync(resolve(configInput), "utf8"),
);
const provider = candidate.provider;
if (
  provider?.kind !== "openai" ||
  provider.model !== "deepseek-v4-flash" ||
  provider.compatibilityMode !== "compatible" ||
  provider.reasoningEffort !== "high" ||
  provider.transportProfile !== "dim-oauth" ||
  typeof provider.baseURL !== "string"
) {
  throw new Error("The frozen benchmark provider profile is invalid.");
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
      reasoningEffort: provider.reasoningEffort,
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
  `BEST_AGENT_PROVIDER_CONFIG=${providerPath}\nDIMCODE_HOME=${dimcodeHome}\n`,
  { flag: "a" },
);
process.stdout.write(
  `${JSON.stringify({ model: provider.model, reasoningEffort: provider.reasoningEffort, transportProfile: provider.transportProfile })}\n`,
);
