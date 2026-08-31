# Benchmark execution rules

- A publishable SWE-bench Verified pass@1 must come from one frozen candidate running all 500 frozen tasks, with exactly one predeclared model attempt per task. Never combine candidates, rescue runs, or selected failure reruns into pass@1.
- Selected subsets and historical re-evaluations are diagnostic only. Label them as such and keep `passAt1` null.
- Before a task attempt is terminal, never expose `test_patch`, FAIL_TO_PASS, PASS_TO_PASS, gold/reference patches, official commands, evaluator verdicts, evaluator logs, or task-specific hints through the prompt, workspace, tools, memory, or context.
- Give the model a repository containing only the frozen `base_commit`. Remove later branch/tag/remote refs, reflogs, and reachable future objects before the attempt; the model must not be able to inspect a later upstream fix through Git history.
- Preserve the complete inference-time trajectory for every task. A final patch or post-hoc summary is not a trajectory and cannot support an official result claim.
- A closed-book claim requires a mechanically verified network boundary. Hiding web tool schemas or adding a prompt prohibition alone is insufficient when shell subprocesses retain network access.
- Never use evaluator output to retry the model, alter the same attempt, run best-of-N, select a patch, replace a task, or reinterpret an existing verdict.
- Freeze the terminal patch and hash before evaluation. The pinned official SWE-bench Docker evaluator and its canonical record are the only grader; do not infer another verdict from logs, exit codes, or host tests.
- Infrastructure uncertainty remains `inconclusive`; missing predictions remain `not-evaluated`. Do not retry or overwrite a canonical verdict. Resume only work that has no canonical record.
- Benchmark-level recovery may fill only a task with no prediction when source evidence mechanically proves a pre-model environment failure or an explicit provider transport failure. Freeze the recovery manifest before recovery, use the same candidate and formal run, preserve the failed evidence, and never replace an existing prediction.
- `config/swe-bench-verified.json`, `config/swe-bench-full-batches.json`, and `config/best-agent-candidate.json` are the single sources for corpus, full-run selection, and candidate identity. Do not reconstruct those facts from reports or documentation.
- Keep hosted generation batches at no more than 10 tasks. A formal full run must pin the model explicitly and preserve every raw generation and official-evaluation artifact.
- Do not publish a candidate or trigger, cancel, restart, or modify GitHub benchmark runs without explicit user authorization.
