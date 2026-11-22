// ENG-1012: the autofix runner's least-priv role (ENG-651) must not be told to read prod logs.
// Harsha's ENG-1031 decision: keep the role narrow, stop the caller. Every attempt surfaced as a
// prod EB ERROR event (s3:ListBucket / s3:DeleteObject denials on the EB log bucket).
// Run: node --test .linear-autofix/test/no-prod-log-retrieval.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const prompts = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');

test('runner prompts exist', () => {
  assert.ok(prompts.includes('prompt.md'));
});

for (const f of prompts) {
  test(`${f} never instructs an EB environment-info log pull`, () => {
    const body = readFileSync(join(dir, f), 'utf8');
    const runnable = body.split('\n').filter((l) => /aws\s+(elasticbeanstalk|logs)\b/.test(l));
    assert.deepEqual(runnable.filter((l) => /environment-info|start-query|filter-log-events|tail-log/.test(l)), []);
  });
}

test('prompt.md tells the agent prod logs are off-limits', () => {
  const body = readFileSync(join(dir, 'prompt.md'), 'utf8');
  assert.match(body, /Do NOT read production backend logs/);
});
