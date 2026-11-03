# Budget-stopped 25 diagnostic rerun, 2026-11-04

This run is user-authorized and limited to the 25 budget-stopped tasks from run 41557196637. The comparison is a new diagnostic reading, never a replacement or stitched pass@1. Original patches, terminal causes, process receipts and raw evidence remain immutable.

Candidate is built from the fetched origin/main commit be07d81d492cb120a42f61738e44a10efba4581b using the existing public private-source/encrypted-diagnostics single Linux workflow 41672181016. No source changes, six-platform matrix or npm publication are requested. The same npm registry cutoff as the baseline (2026-11-02T08:17:53Z) is retained. Final archive identity is frozen in config/ibench.json before inference.

Selection and per-task baseline are in config/ibench-budget25-be07d81d-20261104.json. Seven existing custom-task IBench workflow dispatches use four tasks per group (one in the last), concurrent trials 2 per group, solver-only, 3600 s official agent budget, one extra attempt per task, no retries. Corpus, solver JobConfig, permissions, gateway, model deepseek-v4-flash and effort high are unchanged. The15completed and4billing-interrupted tasks are excluded.

The existing workflow always uploads the complete results/ibench root after success/failure, retaining batch artifacts 30 days: canonical candidate.patch and hashes, full root/headless-child evidence JSONL, actual per-tool timestamps, model HTTP/usage/diagnostics, stdout/stderr, process/finalization receipts and runtime/compact artifacts. Downloads must remain separated by workflow run ID because every existing custom-task job uses the batch name custom; do not merge-overwrite those directories. Completeness must be checked against each final footer and prefix hash after completion; missing/truncated evidence remains a failure, not a complete trace.

Completion means authoritative CLI/Run normal completion, not official scoring success. Keep all 25 tasks in the denominator, including failed/stopped/empty-patch cases. Compare empty/nonempty/source-scope patches, paired agent wall times, median/p90/range and per-task deltas. Setup/build times remain separate; elapsed/model usage observations are not billed savings or proof of causality. Official scorer remains deferred, passAt1 null and leaderboard-comparable false.

Controller checks reuse the existing corpus/ledger local fixtures (hash-checked by unchanged tests); they never enter task containers. npm test 279/279 and the iBench-specific Node suite passed. Dispatch is frozen before any model call. Run IDs and exact dispatch SHA are retained in .tmp/dispatch-state.json. No automation, recurring monitor or automatic rerun is created; the user will request follow-up after the run finishes.

Archive: 57286546 bytes, SHA256 88f9ef620b839ab1be1e09630d02a4c9bb044ebf96b031bb091b250975b6d318; private immutable tag ibench-linux-be07d81d492c. Public build 41672181016 conclusion success, only Linux job executed.
