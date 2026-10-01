# FrontierHarness Eval v1.0 — best-agent's final result on the field's own axes

Rendered by `scripts/frontier-harness-field-chart.mjs` into `leader-chart-final-vs-field-16x9.svg` (+ `.png`), 2400×1350, on 2026-10-01. Data: `leaderboard-comparison-deepseek-v4.1-flash-36915041446.json`, built by `scripts/frontier-harness-comparison.mjs` from the frozen record of run 36915041446 and the published snapshot.

| harness | pass rate | cost per pass | median time per successful task | source |
| --- | --- | --- | --- | --- |
| **best-agent** (this repository's self-run) | **76.7%** (23/30) | **$0.1383** | 619s | run 36915041446, deepseek-v4.1-flash max effort |
| Codex | 66.7% (20/30) | $3.47 | 403s | published leaderboard, 0.148.0 |
| DSH Creator | 63.3% (19/30) | $3.28 | 404s | published leaderboard, 0.1.0-rc.8 |
| Claude Code | 63.3% (19/30) | $18.34 | 578s | published leaderboard, 2.1.237 |
| Pi | 60.0% (18/30) | $2.43 | 453s | published leaderboard, 0.84.2 |
| DSH PTC | 60.0% (18/30) | $4.58 | 464s | published leaderboard, 0.1.0-rc.8 |
| DSH Standard | 60.0% (18/30) | $3.46 | 377s | published leaderboard, 0.1.0-rc.8 |
| Oh My Pi | 56.7% (17/30) | $4.75 | 406s | published leaderboard, 17.4.0 |
| Kimi Code | 56.7% (17/30) | $3.65 | 476s | published leaderboard, 0.37.2 |
| DSH Minimal | 56.7% (17/30) | $4.72 | 341s | published leaderboard, 0.1.0-rc.8 |
| Exo Harness | 53.3% (16/30) | $1.05 | 377s | published leaderboard, 0.1.0 |
| OpenCode | 50.0% (15/30) | $3.24 | 387s | published leaderboard, 1.18.19 |
| Hermes | 50.0% (15/30) | $2.90 | 418s | published leaderboard, 0.20.4 |

Field average: 58.1% at $4.66 per pass. Best published entry: Codex 66.7% at $3.47. Cheapest published entry: Exo Harness at $1.05. This run is 25.1× below the best published entry's cost per pass.

Same tokens, the field's own price table (kimi-k3-2026-08-20): $6.71 per pass — a re-pricing, not a bill; it separates token volume from unit price.

## The boundary this comparison travels with

1. **Different model.** The published field ran one model only (Kimi K3, Fireworks (published baselines)); this run is deepseek-v4.1-flash max effort. The page places this run *next to* the published rows; it is not a harness-versus-harness comparison.
2. **Different runtime.** The field runs on Runta golden checkpoints (fresh restore, identical vCPU/memory/disk); this run is a diagnostic self-run on GitHub-hosted runners. Repository rule: a self-run is not comparable to the published leaderboard, and the figure says so on its face.
3. **Cost is a price table, not a bill.** The published rows are priced on kimi-k3-2026-08-20; this run on the adopted DeepSeek public list (off-peak), because the repository ships no frozen table for its provider and its records carry `costUsd: null` by design. The low cost is mostly unit price; the hollow star shows what the same tokens would cost on the field's table.
4. **Nothing was re-measured for this figure.** The number is the frozen run's own single predeclared attempt per cell: 23 passed, 6 failed, 1 without a verdict. No cell was refilled from a recovery batch, and no repaired reading is mixed in.
5. **Cost coverage.** 100% of the 30 cells carry a recorded usage block; a cell without one would contribute nothing to the sum rather than an estimate.
