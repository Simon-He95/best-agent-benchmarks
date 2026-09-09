# Frozen Node bundle CI

Engineering preflight for the local-spec100-epoch002 candidate. This is not the published beta.20 executable and is not a scored benchmark run. Existing SEA workflows and their candidate configuration remain unchanged.

`config/node-bundle-candidate.json` owns this diagnostic candidate's exact CJS, Node archive/binary, and first official instance image identities. CI retrieves the CJS from a private source-repository asset; the source token is scoped to that download step, never supplied to the container. No source maps or source checkout are distributed publicly.

The initial workflow only runs a scripted local provider in an unprivileged, no-host-mount Linux container. It has no real-provider credentials and cannot dispatch task models or an evaluator. It records runtime/image facts, raw stdout/stderr, tool evidence, storage and environment checks. The container's full-access tool policy applies inside the container, including paths outside its workspace; it grants no access to the runner filesystem or Docker socket.

Actual hosted preflight evidence and a fresh review are required before adding the one-task model/evaluator stage. That stage must preserve one attempt, full trajectory, terminal patch hash, fresh official evaluator isolation, and canonical verdict immutability. The selected diagnostic result must retain `passAt1: null`; no closed-book claim is made. Previous local attempts remain independent and immutable.

Architecture classification: Conformance through existing Application/external-system and output boundaries (080/084). Benchmark controller owns invocation, process receipts and artifact admission; Kernel remains sole owner of Run facts. Changes to contribution cardinality, RuntimeState, KernelInput/Directive, transition, cursor, lifecycle, and Kernel authority: None. No Harness retries, fallback, or evaluator feedback into a Run.
