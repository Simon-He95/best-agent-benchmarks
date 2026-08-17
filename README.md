# best-agent-benchmarks

Public benchmark harness for [best-agent](https://github.com/Simon-He95/best-agent) — runs the **published** `@best-agent/cli` headlessly and scores it against SWE-bench Lite.

Runs on GitHub Actions **public-repo free unlimited minutes** (standard `macos-latest` / `ubuntu-latest` runners). No local compute, no laptop heat.

## Benchmark composition (the important part)

Every task runs the CLI one-shot headless command, with the exact benchmark environment:

```bash
best-agent run \
  --workspace <repo> \
  --workspace-grant read --workspace-grant write --workspace-grant exec \
  [--workspace-backend plain] \
  <prompt>
```

- **Headless**: `best-agent run` is the one-shot non-interactive mode — no TUI.
- **No ask_user**: the `run` command excludes interaction ToolBindings (`ask_user`/`tool_approve` are never injected).
- **Full access**: permission mode `full` + `--workspace-grant read write exec`.
- **Plain workspace backend ALWAYS** (spec 069): `--workspace-backend plain` on every platform — macOS and Linux alike. There is no sandbox fallback: if the installed CLI lacks the flag, the harness/smoke **fail fast** rather than silently run a different, non-comparable backend.

## Status: read this first

The currently published CLI has a **regression in the `run` workspace tool surface**:

| CLI | `run` workspace tools (read/write/...) |
|---|---|
| `@best-agent/cli@latest` (0.0.2-beta.8) | ✗ ancient — no `--workspace` / grants at all |
| `@best-agent/cli@beta` (0.0.3-beta.1, current) | ✗ **broken** — every workspace tool call fails with `tool-unknown` |
| unpublished source (local build) | ✓ works |

Until a fixed version is published to npm, benchmarks are **blocked**: the plain backend is mandatory, and neither published release ships `--workspace-backend`. `scripts/smoke.mjs` (the CI smoke gate) fails by design — it catches exactly this. After the CLI ships `--workspace-backend` (and `--max-model-cycles`), the harness uses plain on every platform with no config change.

Benchmarks run on **`macos-latest`** (arm64) — the same architecture as the locally built macOS CLI — on public-repo free unlimited minutes.

## Run locally

```bash
npm install

# headless composition smoke (validates CLI + provider + full access + no ask_user)
node scripts/smoke.mjs

# full SWE-bench Lite run (first N tasks)
node scripts/swe-bench-harness.mjs --download --limit 3 --concurrency 2 --timeout 600000
```

Provider comes from `BEST_AGENT_PROVIDER_KIND/MODEL/API_KEY/BASE_URL/COMPATIBILITY_MODE` env, else `~/.best-agent/provider.json`, else dimcode OAuth — same resolution as the CLI itself.

## Run on GitHub Actions (free public-repo minutes)

1. Make this repo **public** (public repos get free unlimited standard-runner minutes).
2. Set benchmark provider secrets in **this** repo's Settings → Secrets and variables → Actions:

   ```bash
   gh secret set BENCHMARK_PROVIDER_KIND   --repo Simon-He95/best-agent-benchmarks --body openai
   gh secret set BENCHMARK_PROVIDER_MODEL  --repo Simon-He95/best-agent-benchmarks --body <model>
   gh secret set BENCHMARK_PROVIDER_API_KEY --repo Simon-He95/best-agent-benchmarks --body <key>
   # optional:
   gh secret set BENCHMARK_PROVIDER_BASE_URL           --repo ... --body <url>
   gh secret set BENCHMARK_PROVIDER_COMPATIBILITY_MODE --repo ... --body native
   ```

   (`scripts/sync-secrets.mjs` does this from the local `~/.best-agent/provider.json`.)

3. Actions → **Benchmark** → **Run workflow**:

   - `run_smoke` — fast headless composition gate (blocks the heavy job if the CLI is broken).
   - `run_swe_bench` + `swe_bench_limit` / `swe_bench_dataset` / `concurrency` / `timeout` — the heavy job. `swe_bench_dataset` = `lite` (300) or `verified` (500).
   - `reasoning_effort` — `low|medium|high|xhigh|max|none` (empty = model catalog default). Needs a CLI that carries the provider file's `reasoningEffort` in `run`.
   - `runner` = `macos-latest` (arm64; matches the locally published macOS CLI) — the standard, and free on public repos. `ubuntu-latest` also works once the CLI ships plain (plain is mandatory either way).
   - `swe_bench_models` + `swe_bench_shards` — parallel model × shard matrix; fragments auto-merge.

Results land in `results/` and as GitHub Actions artifacts, with a per-repo pass-rate table plus the per-task list.

## Notes

- The SWE-bench harness is adapted from the best-agent repo's `scripts/swe-bench-harness.mjs`; the changes are the CLI entry resolution (published package instead of local build), repo-local output paths, auto-detection of `--workspace-backend` / `--max-model-cycles`, dataset selection (`--dataset lite|verified`), per-repo result breakdown, and explicit `--reasoning-effort`.
- `--download` fetches the corpus (SWE-bench Lite 300 or Verified 500) from HuggingFace into `results/corpora/`.
- Keep `results/` and `corpora/` out of git (already in `.gitignore`) so model API keys never leak into history.
