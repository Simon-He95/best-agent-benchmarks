# Transport attribution and CI observations

**Status:** Proposed; source implementation awaits independent review. Human explicitly authorizes latest-main three-task CI diagnosis and same-task/same-budget acceptance (2026-10-26); no gateway log access is available.

## Objective and owners

Separate exact model return receipts, authoritative primary terminal, external setup/process errors and derived report stage. Add only the client-side CI observations necessary to distinguish request send, headers/body arrival and cancellation; never infer gateway internals from missing observations. Best-agent Product One-shot evidence and Kernel N15 remain the producer contract; this external report cannot alter it. Frozen corpus/CLI/provider/task budget/grader/attempt selection remain the sole owners named by AGENTS.md and config/frontier-harness.json. No new Harness state/input/directive/lifecycle/retry or error schema.

## Reporting contract

- Keep every raw JSONL model failure and the same canonical disposition/rewards/duration/exception. Keep raw counts visible; separately count matching primary failures before/after that primary terminal. A late return cannot cause an already-terminal primary. Do not relabel the original failure or overwrite terminal.
- A terminal model-failure supports the existing provider-stage grouping (model-invocation boundary, not proof of upstream-only root cause). A stopped primary with only late failures stays inconclusive absent a separately proved external AgentTimeoutError. Real provider/source failures remain represented. Missing/foreign/incomplete evidence supplies no clean/root-cause proof.
- Infra keyword matching must not consume task text embedded in NonZeroAgentExitCodeError or an exception from an attempt that already made model calls. Known pre-model setup/build errors keep existing classification. No arbitrary provider-stall-duration threshold is a cause proof.
- Compare actual report CLI on the identical captured three-task result/evidence/exception inputs before and after. Grader outcomes and raw failure totals must be equal. Positive source-failure, explicit budget exception, pre-model image quota and missing/foreign-terminal controls prevent hiding errors.

## Optional CI observation slice

The diagnostic benchmark owner may preload a task-private Node module only in a separately predeclared diagnostic run. Observe existing undici diagnostics channels; never wrap fetch/dispatcher or change endpoint, request bytes/headers, stream mode, timers, signals, retry or model input. Probe source contains no task/evaluator hints and lives outside /app. SHA and preload execution are recorded. Preflight must prove the actual SEA supports the preload; a missing probe is missing evidence, never interpreted as no traffic.

Output is task-local bounded JSONL (at most8MiB, with explicit incomplete/drop/failure metadata). It contains monotonic timestamps and request-local sequence, method/URL origin+pathname (no query), request-body byte count/hash when already a string/byte array, status and bounded allowlisted request ID, first/last received-chunk timestamps, received byte/chunk totals and closed error name/code. No request/response body, authentication/cookie/other headers, error stack or arbitrary source message is recorded. Existing CLI stderr/evidence retain their own original errors; probe metadata never replaces them. A remote request ID is correlation only, not completion or fault authority.

Each observer callback isolates only its own capture I/O/serialization failure, latches incomplete and never throws into the caller or swallows the actual transport error. Normal source error/stop remains unchanged. The probe does not spawn work, control Run or create automatic retries. Counters/hash work impose measured diagnostic overhead; no runtime latency or task quality claim from instrumentation alone.

Only one additional declared observation attempt per cell of current-main baseline40280938950 is allowed, same candidate/task/budgets/model/effort/grader. It is a diagnostic remeasurement/unknown-cause variance observation, preserves both verdicts and passAt1=null, and cannot be used as best-of-N or merged pass rate. The manifest, preload source SHA and same logical dispatch inputs are committed before dispatch. This run is not automatically authorized by its report; it is within the Human's explicit CI diagnosis request. No earlier36b recheck is extended.

## Scope and verification

- scripts/frontier-harness-failures.mjs and test/frontier-harness-failures.test.mjs: report-only correction and real-CLI same-artifact/positive controls.
- tools/frontier-harness-agent/frontier_harness_best_agent/transport-observer.cjs and package/plugin installation: optional diagnostic preload only; local HTTP headers/body/error/abort/full-response tests and actual SEA preflight. Normal runs unchanged.
- Existing workflow pin/corpus/provider/grader/timeout/egress rules remain; a diagnostic-only manifest/explicit environment selection gates the observation workload, never production fallback or feature policy.
- Latest-main controlled one-shot HTTP repro proves actual stopped→late transport order and genuine503→failed/model-failure order, one call each. Existing PR296/compact/source/continuation owners are unchanged; no corresponding product source changes are proposed.

## Acceptance and benefit

Retain report correction only if same-artifact unsupported provider/infra attribution falls while canonical grades and all raw errors remain. Retain the diagnostic probe only if actual client phase/request correlation is captured faithfully with unchanged source/result/request counts and no secret/body leakage or uncontrolled callback exception. A probe can establish waiting at a client boundary, not gateway queue/upstream generation. No promise of lower ToolCall failures, runtime speed, task score or billed tokens. A runtime streaming/timeout/retry change requires separate admission and measured same-task/budget benefit; none is covered here.
