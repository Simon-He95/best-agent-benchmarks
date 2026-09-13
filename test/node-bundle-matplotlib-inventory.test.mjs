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
