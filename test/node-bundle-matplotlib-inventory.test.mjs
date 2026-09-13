import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {validateInventory} from '../scripts/node-bundle-matplotlib-inventory.mjs';

const config = JSON.parse(fs.readFileSync(new URL('../config/node-bundle-matplotlib-inventory.json', import.meta.url)));
const selection = JSON.parse(fs.readFileSync(new URL('../config/node-bundle-failed-tasks.json', import.meta.url)));

test('inventory admits only the next frozen instance and pinned official image', () => {
  validateInventory(config, selection);
  for (const change of [{taskIndex: 29}, {instanceId: 'django__django-16667'}, {baseCommit: 'a'.repeat(40)}, {imageRef: config.imageRef.split('@')[0] + ':latest'}, {modelAttempt: true}]) {
    assert.throws(() => validateInventory({...config, ...change}, selection));
  }
});

test('remaining inventories stay in the frozen Matplotlib range and bind each base/image identity', () => {
  for (const index of [31, 32, 33]) {
    const next = JSON.parse(fs.readFileSync(new URL('../config/node-bundle-matplotlib-inventory-' + index + '.json', import.meta.url)));
    validateInventory(next, selection);
    assert.throws(() => validateInventory({...next, imageRef: config.imageRef}, selection));
    assert.throws(() => validateInventory({...next, baseCommit: config.baseCommit}, selection));
  }
  assert.throws(() => validateInventory({...config, taskIndex: 34}, selection));
});
