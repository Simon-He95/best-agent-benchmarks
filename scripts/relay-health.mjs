/**
 * Relay channel health gate. Probes the configured provider model and reports how often the
 * upstream channel is available. Exits 0 when the success rate meets the threshold, else 1
 * with a clear "relay overloaded, wait and retry" message — so a benchmark run never burns
 * tasks while the dimcode relay's channel pool is saturated (get_channel_failed).
 *
 * Usage:
 *   RELAY_HEALTH_ROUNDS=8 RELAY_HEALTH_THRESHOLD=0.5 node scripts/relay-health.mjs
 *
 * Environment: BEST_AGENT_PROVIDER_KIND/MODEL/API_KEY/BASE_URL (same as the bench run).
 */

const rounds = Number(process.env.RELAY_HEALTH_ROUNDS ?? 8);
const threshold = Number(process.env.RELAY_HEALTH_THRESHOLD ?? 0.5);
const model = process.env.BEST_AGENT_PROVIDER_MODEL;
const apiKey = process.env.BEST_AGENT_PROVIDER_API_KEY;
const baseURL = (process.env.BEST_AGENT_PROVIDER_BASE_URL ?? "https://api.openai.com/v1").replace(
  /\/$/u,
  "",
);

if (!model || !apiKey) {
  process.stderr.write("BEST_AGENT_PROVIDER_MODEL/API_KEY are required.\n");
  process.exit(1);
}

let ok = 0;
let failed = 0;
for (let i = 0; i < rounds; i += 1) {
  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "OK" }],
        max_tokens: 5,
      }),
    });
    if (response.status === 200) ok += 1;
    else failed += 1;
  } catch {
    failed += 1;
  }
  if (i < rounds - 1) await new Promise((resolve) => setTimeout(resolve, 500));
}

const rate = ok / Math.max(rounds, 1);
process.stdout.write(`relay health: ${ok}/${rounds} ok (${(rate * 100).toFixed(0)}%) for ${model}\n`);
if (rate < threshold) {
  process.stderr.write(
    `RELAY OVERLOADED: ${model} channel availability ${(rate * 100).toFixed(0)}% ` +
      `below the ${(threshold * 100).toFixed(0)}% threshold. ` +
      "Wait for the relay to stabilize, then retry the run.\n",
  );
  process.exit(1);
}
process.exit(0);
