# Client performance v1

Same-run, whole-product TUI benchmark for four labels:

| label | implementation | process model |
| --- | --- | --- |
| `best-agent-ts` | best-agent at the dispatched `source_sha` | one Node process hosting the harness and TUI |
| `dim-rust` | Dim at the dispatched `dim_sha` | Rust TUI client plus the Rust app-server it starts |
| `opencode-ts` | `@opencode/cli@2.2.7` | TypeScript client plus the server it starts with `--standalone` |
| `opencode-native` | `opencode-native 0.0.0-rs-7` | Rust client plus the TypeScript server it starts with `--standalone` |

This is not a copy of OpenCode's published benchmark and its numbers are not comparable to
OpenCode's machine. The purpose is to put every label on one runner, with one mock provider, one
PTY, one prompt script and one process sampler, then report same-run ratios.

## What is measured

- **First frame**: exec to the first PTY output that prints any cell, blank or not.
- **First paint**: exec to the first xterm cell with text or non-default background.
- **Ready**: exec to the first prompt-idle screen after the target's own bootstrap. Each label has
  its own ready marker in `matrix.json` (for example `Type a message` and the selected model).
- **Peak RSS**: every 20 ms, sum RSS over every process carrying the run's unique `BENCH_RUN_ID`;
  the process set is rediscovered from `/proc/*/environ` so a detached app-server is not lost.
- **CPU**: utime+stime (+ reaped children) over the same process set, at ready and after 20 turns.
- **Turns**: 20 prompts typed through the PTY, each ending when the mock stream completed, the
  screen is idle and the PTY has been quiet for 150 ms.

Each run gets a fresh `HOME`, `XDG_*` tree, project directory and mock provider under
`--sandbox-root` (default `/tmp/best-agent-client-perf`, short enough for Dim's Unix socket and
native to the Linux filesystem). The mock is an
offline OpenAI-compatible `/v1/chat/completions` stub with one fixed streamed reply: 40 chunks,
5 ms apart, about 1.6 KB of markdown. Every target gets the same reply. Rounds interleave targets;
odd rounds reverse the order. Raw rows stay in `results.csv`; `summary.ts` reports medians and
interquartile ranges.

The benchmark runs on Linux because the process sampler reads `/proc`. It is not a GUI FPS
measurement and it does not measure model quality, billed tokens or task success.

## Run locally (Linux)

```sh
cd perf/client-v1
npm install --ignore-scripts --no-audit --no-fund

BENCH_NODE="$(command -v node)" \
BENCH_BEST_AGENT=/path/to/best-agent/apps/cli/dist/index.js \
BENCH_DIM=/path/to/dimcode \
BENCH_OPENCODE_TS=/path/to/opencode \
BENCH_OPENCODE_NATIVE=/path/to/opencode-native \
bun bench.ts --matrix matrix.json --rounds 2 --turns 20 \
  --sandbox-root /tmp/best-agent-client-perf --out /tmp/client-perf/results.csv

bun summarize.ts /tmp/client-perf/results.csv --out-dir /tmp/client-perf
```

`best-agent` must be built (`pnpm build`); `dimcode` is the `dimcode` binary; `opencode` is the
`@opencode/cli` binary; `opencode-native` is the preview binary from
[`simonklee/opencode-native-preview`](https://github.com/simonklee/opencode-native-preview).

## CI

`.github/workflows/client-perf.yml` builds best-agent and Dim from pinned commits, installs the
two OpenCode binaries, runs the matrix and uploads `results.csv`, `summary.md`, `summary.json`,
`meta.json`, provenance and failure screens. The workflow needs the repository secret
`BEST_AGENT_SOURCE_TOKEN` to read the private best-agent source. It never uploads that token.

The hosted job is a shared runner, not an isolated benchmark host. Load average is recorded before
and after every run; use the same-run ratios, not a cross-machine comparison.
