// Refreshes the dimcode.cn OAuth access token (read from the dimsdk auth.json),
// writes the new token back, then re-syncs CI secrets via sync-secrets.mjs.
// Never prints credentials — reads/writes files only.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const home = process.env.DIMCODE_HOME ?? join(homedir(), ".dimcode");
const authPath = join(home, "dimcode", "auth.json");
const auth = JSON.parse(readFileSync(authPath, "utf8"));
const oa = auth.nextApiOauth ?? {};
if (!oa.refresh || !oa.tokenEndpoint || !oa.clientId || !oa.clientSecret) {
  throw new Error("Missing refresh credentials in " + authPath);
}

// Dim OAuth refresh uses x-www-form-urlencoded (matching best-agent's v3-oauth-refresh).
const body = new URLSearchParams({
  grant_type: "refresh_token",
  refresh_token: oa.refresh,
  client_id: oa.clientId,
});
if (oa.clientSecret) body.set("client_secret", oa.clientSecret);
if (oa.scope) body.set("scope", oa.scope);

const res = await fetch(oa.tokenEndpoint, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body,
});
if (!res.ok) {
  const body = await res.text();
  throw new Error(`refresh failed HTTP ${res.status}: ${body.slice(0, 200)}`);
}
const data = await res.json();
if (!data.access_token && !data.access) throw new Error("refresh response missing access token");
const access = data.access_token ?? data.access;
const refresh = data.refresh_token ?? oa.refresh;
const expiresIn = data.expires_in ?? oa.expires_in;
const expires = data.expires_at ?? (expiresIn ? Date.now() + expiresIn * 1000 : undefined);

// Write back (atomic-ish: write temp then rename).
const updated = { ...auth, nextApiOauth: { ...oa, access, refresh, ...(expires ? { expires } : {}) } };
writeFileSync(authPath + ".tmp", JSON.stringify(updated, null, 2), "utf8");
writeFileSync(authPath, JSON.stringify(updated, null, 2), "utf8");

console.log(`refreshed OK — new access ${access.slice(0, 8)}…, expires ${expires ? new Date(expires).toISOString() : "?"}`);

// Re-sync CI secrets.
const sync = spawnSync("node", ["scripts/sync-secrets.mjs"], { cwd: import.meta.dirname ? join(import.meta.dirname, "..") : ".", encoding: "utf8" });
if (sync.status !== 0) throw new Error("sync-secrets failed: " + (sync.stderr ?? "").slice(0, 300));
console.log("CI secrets synced.");
