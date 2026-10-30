# Exec schema: completed paired 30-task reading

This comparison shows **no task-success uplift and no verified net benefit**. Both arms have 23 canonical passes over the original 30-task set. PR [606](https://github.com/Simon-He95/best-agent/pull/606) remains draft; no task is retried and no metric is repaired. The [machine-readable readout](exec-schema-pair-20261031.json) is derived evidence, not a second grader.

## Frozen composition and canonical results

Both manifests were committed before dispatch. The only runtime source delta is the exec schema; source pins are `892e50f5d748e990ecce218d794c92af2ab2852f` and `8a86cdb7053b6cac46240f60fa5f5f09a513aee6`. Provider, high reasoning effort, corpus, budgets, grader, mirrors, prefix and collect behavior are unchanged. Each arm contains exactly one solver attempt per task. All 30 paired first requests have the same instructions and the same other 27 tool definitions; the original two exec schema branches match, and the candidate carries the explicit 2020-12 branch.

| Metric | Control | Candidate |
| --- | ---: | ---: |
| Run | [41093838098](https://github.com/Simon-He95/best-agent-benchmarks/actions/runs/41093838098) | [41093852204](https://github.com/Simon-He95/best-agent-benchmarks/actions/runs/41093852204) |
| Expected / present / missing | 30 / 30 / 0 | 30 / 30 / 0 |
| Canonical passed / failed / error / not-evaluated | 23 / 7 / 0 / 0 | 23 / 6 / 1 / 0 |
| Raw passes / original denominator | 23/30 (76.67%) | 23/30 (76.67%) |
| Frozen report passAt1 | 0.7666666666666667 | null |
| Parent model requests observed | 1625 | 1483 |
| Parent model outcomes / late failure observations | 1620 / 5 | 1478 / 5 |
| Parent ToolResults | 1807 | 1657 |
| Parent malformed-input | 21/1807 (1.16%) | 20/1657 (1.21%) |
| Parent exec malformed-input | 13/1045 (1.24%) | 19/869 (2.19%) |
| Parent exec conflicting-fields refusals | 8 | 15 |
| New args-only spelling observed in parent calls | 0 | 0 |
| Empty committed patch artifacts | 1 (meriyah) | 0 |
| GitHub wall seconds, including build/queue/verifier | 6108 | 5840 |

The candidate fails `verdicts.complete` because of regex-log's error; its other acceptance checks pass. The control's five report acceptance checks pass. These are copied report fields, not a claim that the child-trajectory audit passed. The error stays in the original 30-task denominator; no 23/29 reading is substituted. Fewer parent requests, one fewer malformed result, fewer empty patches, or a shorter workflow are not task-success or cost improvements.

## Paired task changes

| Task | Control | Candidate |
| --- | --- | --- |
| terminal-bench/code-from-image | passed | failed |
| terminal-bench/dna-insert | failed | passed |
| datacurve/httpx-multipart-response-parsing | failed | passed |
| terminal-bench/regex-log | passed | error |

Two gains (httpx and dna-insert) are offset by code-from-image's failure and regex-log's error. Neither verdict selection nor remeasurement is permitted. Both arktype attempts passed, with two parent malformed-input results each. Its parent model requests were 160 versus 140, but the candidate also delegated two operations whose full traces are not available; that is not a demonstrated full-tree efficiency gain.

## Source errors and control flow

The candidate regex-log evidence has one model request and zero model outcomes/accepted tools. Its snapshot is `cancelled/stopped`, then a late `transport` observation arrives after 839,242 ms. Stderr only says `v3 run cancelled: stopped`; no HTTP 400, upstream cause, or successful answer is observed. The canonical task disposition remains error and passAt1 remains null. This cannot be reclassified as a proven environment fault or removed from the denominator. All five model-failure observations in each arm follow stopped terminal snapshots; they must not be presented as five independently diagnosed provider outages.

All 41 parent `not-invoked/malformed-input` results (21 control, 20 candidate) were found unchanged in later actual ModelRequests. Parent accepted ToolCalls and ToolResults match 1807/1807 and 1657/1657. The exec canonicalizer, N8/N9, authorization, backend routing and terminal rules were not changed. No new retry, fallback, field deletion, forced continuation or working-tree capture was introduced.

## Usage and trajectory limits

| Provider-reported parent totals | Control | Candidate |
| --- | ---: | ---: |
| Tasks contributing usage | 30 | 29 |
| Input tokens, including reported cache reads | 155,288,904 | 162,785,141 |
| Output tokens | 1,021,047 | 916,975 |
| Total tokens | 156,309,951 | 163,702,116 |
| Reported cache-read tokens | 153,255,616 | 160,349,056 |
| Reported model calls | 1620 | 1478 |
| costUsd | null | null |

These totals are not complete whole-agent-tree cost. The candidate regex-log call has no reported usage, and child usage/requests cannot be independently reconstructed. No billed-token or monetary saving is claimed. The exec schema itself grew 577→989 encoded bytes (+412), which is a byte cost, not a token measure.

All 60 parent evidence SHA256 values match their canonical records; every footer is complete and its prefix hash, sequence and expected/written/observed counts verify. However, control expr/python-statemachine accepted six child operations; candidate arktype/expr/python-statemachine accepted seven. Their packaged subagent databases contain zero operation, attempt and transcript rows. The one-shot owner's cleanup removes its own rows after child disposal; the report packages retain parent summaries, not the full child tool/model trajectories. Therefore the counts above are explicitly parent-only, and the whole-tree incidence of args-only calls remains unverified. We cannot approve a fully audited inference-time/capability publication from these packages alone. This gap does not change any canonical verdict and is not repaired in this exec-only PR.

Public egress and no contamination gate provide no closed-book or clean-capability claim. One paired realization also does not establish a general causal success-rate effect.

## Correctness evidence, retained failure, and decision

Same-input Ajv2020/canonicalizer tests demonstrate that the existing legal `args:["-c",line]` spelling is now expressible in schema; malformed pairs and conflicting fields remain refused. Source `8a86cdb70` passed typecheck, lint, touched-file formatting and the complete pnpm test sweep, all exit 0, no accepted exception. Those checks are not benchmark task success.

The first candidate `30a23b2d3` remains rejected: smoke `41088968970` returned HTTP 400 `invalid_request_error` on its first model invocation with no tool entry. Its workflow was green but its task was error; the response did not name the schema keyword. Its interrupted local sweep exited 130 and is not a passed gate. Baseline smoke `41088955431` and final smoke `41090846783` both passed regex-log with 15/18 calls; that earlier smoke result does not replace the later candidate full-run error. All three smoke records remain in history.

The completed paired workload supplies no task-success gain; exec parent refusal rate is higher, no parent call used the newly advertised spelling, and complete cost/child evidence is unavailable. The conformance correction is real, but its net task benefit is unproven. Keep the PR draft and do not recommend merging it as a demonstrated Harness improvement. No additional model attempts or unrelated interface changes were made.

## Full paired population

| Task | Control | Candidate | Parent requests (control/candidate) | Parent malformed (control/candidate) |
| --- | --- | --- | ---: | ---: |
| datacurve/anko-typed-variable-bindings | passed | passed | 77/117 | 0/4 |
| datacurve/arktype-json-schema-refs-dependencies | passed | passed | 160/140 | 2/2 |
| terminal-bench/build-cython-ext | passed | passed | 61/55 | 1/0 |
| terminal-bench/chess-best-move | failed | failed | 25/15 | 0/0 |
| terminal-bench/code-from-image | passed | failed | 21/23 | 0/0 |
| terminal-bench/constraints-scheduling | passed | passed | 3/6 | 0/0 |
| terminal-bench/db-wal-recovery | passed | passed | 12/11 | 0/0 |
| terminal-bench/dna-insert | failed | passed | 15/15 | 0/1 |
| datacurve/expr-try-catch-errors | failed | failed | 213/113 | 1/1 |
| terminal-bench/extract-elf | passed | passed | 15/9 | 0/0 |
| datacurve/fastapi-deprecation-response-headers | passed | passed | 103/68 | 1/0 |
| terminal-bench/gcode-to-text | failed | failed | 27/31 | 0/1 |
| terminal-bench/git-leak-recovery | passed | passed | 8/9 | 0/0 |
| datacurve/httpx-multipart-response-parsing | failed | passed | 90/69 | 1/0 |
| datacurve/katex-multicolumn-array-spans | passed | passed | 103/117 | 0/6 |
| terminal-bench/kv-store-grpc | passed | passed | 19/13 | 0/0 |
| terminal-bench/largest-eigenval | failed | failed | 7/7 | 0/0 |
| terminal-bench/log-summary-date-ranges | passed | passed | 6/5 | 0/0 |
| terminal-bench/merge-diff-arc-agi-task | passed | passed | 49/18 | 2/0 |
| datacurve/meriyah-explicit-resource-declarations | failed | failed | 163/178 | 5/1 |
| terminal-bench/modernize-scientific-stack | passed | passed | 5/5 | 0/0 |
| terminal-bench/multi-source-data-merger | passed | passed | 8/9 | 0/0 |
| terminal-bench/openssl-selfsigned-cert | passed | passed | 20/8 | 0/0 |
| terminal-bench/polyglot-c-py | passed | passed | 11/14 | 1/0 |
| datacurve/python-statemachine-state-data-scoping | passed | passed | 215/219 | 6/0 |
| terminal-bench/regex-log | passed | error | 12/1 | 0/0 |
| terminal-bench/sanitize-git-repo | passed | passed | 21/12 | 0/0 |
| datacurve/scc-bounded-memory-spilling | passed | passed | 129/172 | 1/3 |
| terminal-bench/sqlite-db-truncate | passed | passed | 15/13 | 0/1 |
| terminal-bench/vulnerable-secret | passed | passed | 12/11 | 0/0 |

Canonical report SHA256: control `380ba5f147c79dd7465cae41d00fe490869d3e7b91f870010cfd308e93a0a292`; candidate `626cdae1c9b0d0205c5b9af7cf32cfede4a49f9c6532db8f84100414371856fc`. The raw JSON copies in history are byte-identical to their artifacts. Local reproduction artifacts and analyzer outputs remain under `/tmp/best-agent-capture-review.QPYhKa`; report-only updates do not enter any runtime call path, so no completed code gate is rerun.
