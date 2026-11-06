/** Fails when any shipped artifact exceeds the 40 KB gzip budget (ENG-2782). */
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUDGET = 40 * 1024;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;
for (const file of ['dist/slack-start.js', 'dist/index.mjs', 'dist/react.mjs']) {
  const raw = readFileSync(resolve(root, file));
  const gz = gzipSync(raw, { level: 9 }).length;
  const ok = gz <= BUDGET;
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file}: ${(raw.length / 1024).toFixed(1)} KB raw, ${(gz / 1024).toFixed(1)} KB gzip (budget ${BUDGET / 1024} KB)`);
}
process.exit(failed ? 1 : 0);
