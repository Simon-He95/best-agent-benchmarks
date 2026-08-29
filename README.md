# best-agent-benchmarks

Public macOS generation runner for the pinned best-agent CLI on SWE-bench Verified.

## Evaluation boundary

This repository does not implement a second grader. It installs the public CLI version from
`config/best-agent-candidate.json` and runs the byte-exact harness and official evaluator frozen
from that record's source commit. Their SHA-256 values are part of the same candidate record.
Local Markdown only presents canonical evaluator dispositions.

The hosted workflow is deliberately two-stage:

1. GitHub's macOS runner executes `best-agent run` and publishes exact frozen predictions.
2. A macOS machine with Docker Desktop evaluates those same predictions with the pinned
   official SWE-bench Docker evaluator.

The workflow acquires and hash-verifies the pinned corpus once per run, then distributes those
same bytes to every bounded generation batch.

The first-stage report is always `official-swe-bench-docker-deferred` with `passAt1: null`.
It is not a second grader and cannot be reported as pass@1.

## Fixed composition

- CLI candidate: the exact version in `config/best-agent-candidate.json`.
- Provider model, compatibility, reasoning effort, and authenticated transport profile: the
  exact profile in the same candidate record; CI supplies only its rotating OAuth credential.
- Dataset: SWE-bench Verified, pinned revision and JSONL hash in
  `config/swe-bench-verified.json`.
- Workspace: macOS sandbox backend with read/write/exec grants.
- Interaction and network ToolBindings: excluded.
- Exec subprocesses: macOS Seatbelt denies network access.
- Task selection: fixed before generation with offset/limit/shards or an explicit `--tasks`
  list.
- Hosted diagnostic batches contain at most 10 predeclared tasks.
- The formal 500-task run uses 100 predeclared batches of 5 to stay below the hosted job timeout.
- Hidden tests, official logs, and verdicts never enter the model attempt.

## Hosted macOS generation

Set `BENCHMARK_PROVIDER_KIND`, `BENCHMARK_PROVIDER_MODEL`,
`BENCHMARK_PROVIDER_API_KEY`, and optional provider URL/compatibility secrets, then run the
`Benchmark` workflow. Use `swe_bench_tasks` for a predeclared diagnostic failure set.
The workflow installs the published npm package and never checks out the private best-agent
repository.
Generation jobs install `ripgrep`, the CLI search tool's required macOS runtime.

Failure-only batches measure diagnostic recovery. They must not be merged into an old run and
reported as pass@1. A new pass@1 requires one preselected attempt for every task in a complete
batch.

## Local official evaluation

Download one generation artifact without changing its report or prediction files. Use a pinned
SWE-bench v4.1.0 checkout at commit `726c5461e2ef52d83cf1ea2107870a8bb3328d57`:

```bash
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
