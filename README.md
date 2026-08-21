# best-agent-benchmarks

Public macOS generation runner for `@best-agent/cli` on SWE-bench Verified.

## Evaluation boundary

This repository does not grade patches. It reads the one candidate commit and CLI version from
`config/best-agent-candidate.json` and delegates generation, frozen-patch capture,
official Docker execution, verdict projection, and aggregation to that commit's canonical
SWE-bench implementation. Local Markdown only presents those canonical dispositions.

The hosted workflow is deliberately two-stage:

1. GitHub's macOS runner executes `best-agent run` and publishes exact frozen predictions.
2. A macOS machine with Docker Desktop evaluates those same predictions with the pinned
   official SWE-bench Docker evaluator.

The first-stage report is always `official-swe-bench-docker-deferred` with `passAt1: null`.
It is not a second grader and cannot be reported as pass@1.

## Fixed composition

- CLI candidate: the exact version in `config/best-agent-candidate.json`.
- Dataset: SWE-bench Verified, pinned revision and JSONL hash in
  `config/swe-bench-verified.json`.
- Workspace: plain backend with read/write/exec grants.
- Interaction and network ToolBindings: excluded.
- Exec subprocesses: not claimed to be physically network-isolated.
- Task selection: fixed before generation with offset/limit/shards or an explicit `--tasks`
  list.
- Hidden tests, official logs, and verdicts never enter the model attempt.

## Hosted macOS generation

Set `BENCHMARK_PROVIDER_KIND`, `BENCHMARK_PROVIDER_MODEL`,
`BENCHMARK_PROVIDER_API_KEY`, and optional provider URL/compatibility secrets, then run the
`Benchmark` workflow. Use `swe_bench_tasks` for a predeclared diagnostic failure set.

Failure-only batches measure diagnostic recovery. They must not be merged into an old run and
reported as pass@1. A new pass@1 requires one preselected attempt for every task in a complete
batch.

## Local official evaluation

Download one generation artifact without changing its report or prediction files. Point the
commands below at a clean checkout of the pinned best-agent commit and a pinned SWE-bench
v4.1.0 checkout at commit `726c5461e2ef52d83cf1ea2107870a8bb3328d57`:

```bash
export BEST_AGENT_SOURCE_DIR=/absolute/path/to/best-agent

node scripts/prepare-swe-bench.mjs \
  --evaluator-source /absolute/path/to/SWE-bench \
  --evaluator-python /absolute/path/to/swe-bench-venv/bin/python \
  --docker /usr/local/bin/docker \
  --manifest /absolute/path/to/official-evaluator-manifest.json

node scripts/evaluate-official.mjs \
  --report /absolute/path/to/swe-bench-results.<tag>.shard-0.json \
  --predictions /absolute/path/to/swe-bench-results.<tag>.shard-0.predictions \
  --manifest /absolute/path/to/official-evaluator-manifest.json \
  --output /absolute/path/to/swe-bench-results.<tag>.shard-0.official.json
```

`scripts/evaluate-official.mjs` imports the pinned evaluator directly. It never invokes the
CLI, provider, or model and never parses raw test output itself.
