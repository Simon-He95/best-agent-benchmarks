import assert from 'node:assert/strict';

export function selectFrozenTask(selection, entry = null) {
  const selected = entry ? selection.tasks[entry.taskIndex] : selection.tasks[0];
  if (!entry) assert.equal(selected.instanceId, 'django__django-10097');
  else assert.equal(selected.instanceId, entry.instanceId, 'Batch task left the frozen selection order');
  return selected;
}
