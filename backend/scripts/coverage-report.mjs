#!/usr/bin/env node
/**
 * ENG-1376: merge the coverage of the two backend test jobs and judge the result once.
 *
 * The backend suite is split across two CI jobs (`backend-tests-a` runs the
 * ~293 agentMode files, `backend-tests-b` runs the other ~1,200). Only job B
 * used to collect coverage, so every module whose tests live in job A read as
 * near-zero regardless of how well tested it was: agentModeService.ts (12,790
 * statements) measured 13.4% and agentModeController.ts (3,908) measured 15.5%
 * — together ~15% of the backend, mis-reported purely because of where their
 * tests were scheduled. Both jobs now emit coverage-final.json and this script
 * merges them before anything is compared to a threshold.
 *
 * It is also the ONLY place a coverage threshold is enforced. jest.config.js
 * deliberately carries no `coverageThreshold` (a per-job threshold would judge
 * each job on a fraction of the evidence), and the workflow no longer
 * re-implements the bar in a github-script step.
 *
 * Usage:
 *   node scripts/coverage-report.mjs <coverage-final.json> [<coverage-final.json> ...]
 *
 * Env:
 *   COVERAGE_MARKDOWN_OUT  path to write the PR-comment markdown to (optional)
 *   COVERAGE_SUMMARY_OUT   path to write the merged istanbul summary JSON to (optional)
 *
 * Exit codes: 0 = every metric at or above its threshold, 1 = below, 2 = bad input.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import libCoverage from 'istanbul-lib-coverage';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THRESHOLDS_PATH = path.join(BACKEND_ROOT, 'coverage-thresholds.json');
const METRICS = ['statements', 'branches', 'functions', 'lines'];

function die(msg) {
  console.error(`coverage-report: ${msg}`);
  process.exit(2);
}

const inputs = process.argv.slice(2);
if (inputs.length === 0) die('no coverage-final.json paths given');

// A missing or empty input is fatal, never silently skipped. Half the evidence
// scored against a whole-suite threshold is exactly the failure mode this
// script exists to remove — it would read as a real regression and send someone
// hunting for a bug that is really a dropped artifact.
const map = libCoverage.createCoverageMap({});
for (const input of inputs) {
  if (!fs.existsSync(input)) die(`missing coverage input: ${input}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(input, 'utf8'));
  } catch (err) {
    die(`could not parse ${input}: ${err.message}`);
  }
  // `JSON.parse` happily returns null, a number or an array, and Object.keys
  // throws on the first of those — an uncaught TypeError and exit 1, which is
  // the code this script reserves for "coverage is below the bar". A corrupt
  // artifact must not be indistinguishable from a real regression.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    die(`coverage input is not a JSON object of file coverage: ${input}`);
  }
  const fileCount = Object.keys(parsed).length;
  if (fileCount === 0) die(`coverage input has no files: ${input}`);
  console.log(`coverage-report: merging ${fileCount} files from ${input}`);
  // istanbul throws a bare Error on a well-formed object with the wrong shape.
  // The realistic way to get here is passing coverage-summary.json instead of
  // coverage-final.json, which is an easy mistake and deserves a message that
  // says so rather than a stack trace.
  try {
    map.merge(parsed);
  } catch (err) {
    die(
      `could not merge ${input}: ${err.message}. ` +
        'Expected an istanbul coverage-final.json (per-file counters), not a summary.',
    );
  }
}

if (!fs.existsSync(THRESHOLDS_PATH)) die(`missing ${THRESHOLDS_PATH}`);
const thresholds = JSON.parse(fs.readFileSync(THRESHOLDS_PATH, 'utf8'));
for (const metric of METRICS) {
  if (typeof thresholds[metric] !== 'number') {
    die(`coverage-thresholds.json is missing a numeric "${metric}"`);
  }
}

const files = map.files();
if (files.length === 0) die('merged coverage map is empty');

const total = map.getCoverageSummary().toJSON();

// Per-top-level-directory breakdown, so the comment shows where the number
// comes from instead of a single opaque percentage.
const byDir = new Map();
for (const file of files) {
  // istanbul records absolute paths from the machine that ran the tests. In CI
  // that is the same workspace layout as this job, so `relative` resolves
  // cleanly — but a merge of artifacts produced elsewhere would otherwise
  // yield `../../..` noise as a directory name. Fall back to slicing at `src/`
  // so the grouping degrades to something readable instead of something wrong.
  let rel = path.relative(BACKEND_ROOT, file);
  if (rel.startsWith('..')) {
    const marker = `${path.sep}src${path.sep}`;
    const at = file.lastIndexOf(marker);
    rel = at === -1 ? path.basename(file) : file.slice(at + 1);
  }
  const parts = rel.split(path.sep);
  // src/services/foo.ts -> "src/services"; src/app.ts -> "src (root)"
  const dir = parts.length > 2 ? `${parts[0]}/${parts[1]}` : `${parts[0]} (root)`;
  if (!byDir.has(dir)) byDir.set(dir, libCoverage.createCoverageSummary());
  byDir.get(dir).merge(map.fileCoverageFor(file).toSummary());
}

const pct = (m) => total[m].pct;
const failing = METRICS.filter((m) => pct(m) < thresholds[m]);

const statusIcon = (m) => (pct(m) >= thresholds[m] ? '✅' : '❌');
const rows = METRICS.map(
  (m) =>
    `| ${m[0].toUpperCase()}${m.slice(1)} | ${total[m].pct}% (${total[m].covered}/${total[m].total}) | ${thresholds[m]}% | ${statusIcon(m)} |`,
).join('\n');

const dirRows = [...byDir.entries()]
  .sort((a, b) => b[1].toJSON().statements.total - a[1].toJSON().statements.total)
  .map(([dir, summary]) => {
    const s = summary.toJSON();
    return `| \`${dir}\` | ${s.statements.pct}% | ${s.branches.pct}% | ${s.functions.pct}% | ${s.statements.total} |`;
  })
  .join('\n');

// A hidden marker is this report's identity for the comment-update step. The
// visible heading cannot be: Linear's linkback quotes the ticket, the ticket
// quotes this report, and on PR #2547 the update step matched Linear's comment
// on the heading and overwrote it.
const MARKER = '<!-- backend-coverage-report -->';

const markdown = `${MARKER}
## 📊 Backend Test Coverage

Merged across **both** backend test jobs (agentMode + everything else) over ${files.length} source files.

| Metric | Coverage | Threshold | Status |
|--------|----------|-----------|--------|
${rows}

<details>
<summary>By directory</summary>

| Directory | Statements | Branches | Functions | Statements measured |
|-----------|-----------|----------|-----------|---------------------|
${dirRows}

</details>

**Measured:** \`backend/src/**/*.ts\` — every backend source file except \`*.d.ts\`, \`__tests__/\`, \`__mocks__/\`, \`src/types/\` (type-only) and \`src/scripts/\` (one-off operational scripts).

${failing.length === 0 ? '✅ All thresholds met.' : `❌ Below threshold: ${failing.join(', ')}.`} Thresholds live in \`backend/coverage-thresholds.json\` and only ratchet up (ENG-1376).`;

console.log('');
console.log(markdown);

if (process.env.COVERAGE_MARKDOWN_OUT) {
  fs.writeFileSync(process.env.COVERAGE_MARKDOWN_OUT, markdown);
}
if (process.env.COVERAGE_SUMMARY_OUT) {
  const out = { total };
  for (const [dir, summary] of byDir) out[dir] = summary.toJSON();
  fs.writeFileSync(process.env.COVERAGE_SUMMARY_OUT, JSON.stringify(out, null, 2));
}
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

if (failing.length > 0) {
  console.error(
    `\ncoverage-report: below threshold: ${failing
      .map((m) => `${m}=${pct(m)}% (need ${thresholds[m]}%)`)
      .join(', ')}`,
  );
  process.exit(1);
}
