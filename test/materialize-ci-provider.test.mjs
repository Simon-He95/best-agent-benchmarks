import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/materialize-ci-provider.mjs', import.meta.url));
for (const config of ['node-bundle-generation.json', 'terminal-bench.json']) {
  test(`materializes the unchanged frozen provider from ${config}`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-profile-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const configPath = fileURLToPath(new URL('../config/' + config, import.meta.url));
    const provider = JSON.parse(fs.readFileSync(configPath)).provider;
    const token = 'fixture.' + Buffer.from(JSON.stringify({exp: Math.floor(Date.now() / 1000) + 3600})).toString('base64url') + '.fixture';
    const result = spawnSync(process.execPath, [script, root, path.join(root, 'env'), configPath], {env: {...process.env, BENCHMARK_PROVIDER_API_KEY: token}, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(fs.readFileSync(path.join(root, 'provider.json')));
    for (const key of ['kind', 'model', 'baseURL', 'compatibilityMode', 'reasoningEffort', 'transportProfile']) assert.equal(actual[key], provider[key]);
    assert(!result.stdout.includes(token));
  });
}
test('rejects mixed profiles and expired tokens before writing credentials', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-reject-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = JSON.parse(fs.readFileSync(new URL('../config/node-bundle-generation.json', import.meta.url)));
  for (const [model, reasoningEffort, exp] of [['deepseek-v4-flash', 'max', 4102444800], ['deepseek-v4.1-flash', 'high', 4102444800], ['deepseek-v4-flash', 'high', 1]]) {
    const configPath = path.join(root, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({...source, provider: {...source.provider, model, reasoningEffort}}));
    const token = 'fixture.' + Buffer.from(JSON.stringify({exp})).toString('base64url') + '.fixture';
    const result = spawnSync(process.execPath, [script, path.join(root, 'output'), path.join(root, 'env'), configPath], {env: {...process.env, BENCHMARK_PROVIDER_API_KEY: token}, encoding: 'utf8'});
    assert.equal(result.status, 1);
    assert(!fs.existsSync(path.join(root, 'output')));
  }
});
