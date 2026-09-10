import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const ledger = JSON.parse(fs.readFileSync(new URL('../config/node-bundle-rerun-ledger.json', import.meta.url), 'utf8'));
const selection = JSON.parse(fs.readFileSync(new URL('../config/node-bundle-failed-tasks.json', import.meta.url), 'utf8'));
const historical = selection.historicalComposite;

test('rerun ledger is diagnostic-only and never claims pass@1', () => {
  assert.equal(ledger.diagnosticOnly, true);
  assert.equal(ledger.passAt1, null);
  assert.equal(ledger.rerunComposite.passAt1, null);
  assert.equal(ledger.crossCandidateCombinedDiagnostic.passAt1, null);
  assert.equal(ledger.historicalComposite.passAt1, null);
});

test('historical composite stays the frozen snapshot from the selection config', () => {
  for (const key of ['total', 'resolved', 'testFailed', 'noPrediction', 'pending', 'rate']) {
    assert.equal(ledger.historicalComposite[key], historical[key], `Frozen historical field ${key} must never drift`);
  }
  assert.equal(ledger.historicalComposite.resolved, 437);
  assert.equal(ledger.historicalComposite.total, 500);
});

test('rerun composite counts reconcile with the per-task entries', () => {
  const tasks = ledger.tasks;
  const evaluated = tasks.filter(task => task.verdict === 'resolved' || task.verdict === 'test-failed');
  const resolved = tasks.filter(task => task.verdict === 'resolved');
  const testFailed = tasks.filter(task => task.verdict === 'test-failed');
  const notEvaluated = tasks.filter(task => task.verdict === 'not-evaluated');
  const inFlight = tasks.filter(task => task.verdict === 'in-flight');
  assert.equal(ledger.rerunComposite.evaluated, evaluated.length);
  assert.equal(ledger.rerunComposite.resolved, resolved.length);
  assert.equal(ledger.rerunComposite.testFailed, testFailed.length);
  assert.equal(ledger.rerunComposite.notEvaluated, notEvaluated.length);
  assert.equal(ledger.rerunComposite.inFlight, inFlight.length);
  assert.equal(ledger.rerunComposite.total, 63);
  assert.equal(ledger.rerunComposite.notAttempted, ledger.notAttempted.count);
  assert.equal(evaluated.length + notEvaluated.length + inFlight.length + ledger.notAttempted.count, 63);
});

test('cross-candidate combined count is the sum and stays diagnostic', () => {
  const combined = ledger.crossCandidateCombinedDiagnostic;
  assert.equal(combined.resolved, historical.resolved + ledger.rerunComposite.resolved);
  assert.equal(combined.total, 500);
  assert.equal(combined.rate, Number((combined.resolved / combined.total).toFixed(3)));
  assert.match(combined.note, /never be reported as pass@1/);
});

test('every verdicted task carries canonical provenance', () => {
  for (const task of ledger.tasks) {
    if (task.verdict === 'resolved' || task.verdict === 'test-failed') {
      assert.match(task.attemptId, /-node-[0-9]+-001$/, `${task.instanceId} must cite its sole attempt`);
      assert(task.runId || task.evaluationRunId, `${task.instanceId} must cite its run`);
      assert(['test-failed', 'resolved'].includes(task.verdict));
    }
    if (task.verdict === 'resolved') {
      assert.match(task.patchSha256, /^[a-f0-9]{64}$/, 'A resolution must cite the frozen patch hash');
    }
    if (task.verdict === 'not-evaluated' || task.verdict === 'in-flight') {
      assert.equal(task.attemptId, undefined, 'No verdict implies no attempt identity is asserted');
    }
    assert.equal(ledger.passAt1, null);
  }
});

test('the sole resolution is django-11400 with its verified identity', () => {
  const resolved = ledger.tasks.filter(task => task.verdict === 'resolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].instanceId, 'django__django-11400');
  assert.equal(resolved[0].attemptId, 'django__django-11400-node-34436490804-001');
  assert.equal(resolved[0].patchSha256, 'a8fd07c3cfca16257263a9fe07f12364620a673242095f2355a3d2748f14a142');
  assert.equal(ledger.rerunComposite.resolved, 1);
  assert.equal(ledger.crossCandidateCombinedDiagnostic.resolved, 438);
});

test('task indices match the frozen selection order for listed tasks', () => {
  const byIndex = new Map(selection.tasks.map((task, position) => [position, task.instanceId]));
  for (const task of ledger.tasks) {
    assert.equal(task.instanceId, byIndex.get(task.taskIndex), `${task.instanceId} must sit at its frozen selection index`);
  }
  const indices = ledger.tasks.map(task => task.taskIndex);
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b), 'Ledger entries stay in frozen selection order');
});
