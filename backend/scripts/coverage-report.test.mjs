/**
 * ENG-1376: regression suite for scripts/coverage-report.mjs — the single point
 * where a backend coverage threshold is enforced. Run with `node --test`.
 *
 * The load-bearing property is the first test: two jobs that each cover a
 * different half of the same file must merge to the union, not to whichever
 * artifact was read last. That is the whole reason the script exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'coverage-report.mjs');
const BACKEND_ROOT = path.resolve(HERE, '..');
const THRESHOLDS = path.join(BACKEND_ROOT, 'coverage-thresholds.json');

let tmp;
test.before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'covreport-'));
});
test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * A file with four statements, `covered` of which were hit. Shaped like the
 * istanbul coverage-final.json jest actually emits.
 */
function fileCoverage(relPath, hits) {
  const statementMap = {};
  const s = {};
  hits.forEach((count, i) => {
    statementMap[String(i)] = {
      start: { line: i + 1, column: 0 },
      end: { line: i + 1, column: 10 },
    };
    s[String(i)] = count;
  });
  return {
    path: path.join(BACKEND_ROOT, relPath),
    statementMap,
    s,
    fnMap: {},
    f: {},
    branchMap: {},
    b: {},
  };
}

function writeArtifact(name, obj) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

function run(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('merges two jobs into the union, not the last one read', () => {
  // Job A covers statements 0 and 1; job B covers 2 and 3. Neither job alone
  // sees more than 50% of the file; together they see all of it.
  const a = writeArtifact('a.json', {
    [path.join(BACKEND_ROOT, 'src/services/agentModeService.ts')]: fileCoverage(
      'src/services/agentModeService.ts',
      [1, 1, 0, 0],
    ),
  });
  const b = writeArtifact('b.json', {
    [path.join(BACKEND_ROOT, 'src/services/agentModeService.ts')]: fileCoverage(
      'src/services/agentModeService.ts',
      [0, 0, 1, 1],
    ),
  });

  const summaryOut = path.join(tmp, 'merged.json');
  const soloOut = path.join(tmp, 'solo.json');

  run([a], { COVERAGE_SUMMARY_OUT: soloOut });
  const solo = JSON.parse(fs.readFileSync(soloOut, 'utf8'));
  assert.equal(solo.total.statements.pct, 50, 'one artifact alone sees half');

  run([a, b], { COVERAGE_SUMMARY_OUT: summaryOut });
  const merged = JSON.parse(fs.readFileSync(summaryOut, 'utf8'));
  assert.equal(merged.total.statements.pct, 100, 'merged sees the union');
  assert.equal(merged.total.statements.covered, 4);
});

test('fails when a metric is below its threshold', () => {
  const low = writeArtifact('low.json', {
    [path.join(BACKEND_ROOT, 'src/services/thin.ts')]: fileCoverage('src/services/thin.ts', [
      1, 0, 0, 0,
    ]),
  });
  const res = run([low]);
  assert.equal(res.code, 1, '25% statements must not pass any real threshold');
  assert.match(res.stderr, /below threshold/);
});

test('passes when every metric is at or above its threshold', () => {
  const full = writeArtifact('full.json', {
    [path.join(BACKEND_ROOT, 'src/services/full.ts')]: fileCoverage('src/services/full.ts', [
      1, 1, 1, 1,
    ]),
  });
  const res = run([full]);
  assert.equal(res.code, 0, `expected pass, got:\n${res.stdout}\n${res.stderr ?? ''}`);
});

test('a missing artifact is fatal, not silently skipped', () => {
  // Half the evidence judged against a whole-suite threshold reads as a real
  // regression. Refuse rather than report a number built from one job.
  const res = run([path.join(tmp, 'does-not-exist.json')]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /missing coverage input/);
});

test('an empty artifact is fatal', () => {
  const empty = writeArtifact('empty.json', {});
  const res = run([empty]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /no files/);
});

test('no arguments is fatal', () => {
  const res = run([]);
  assert.equal(res.code, 2);
});

// CodeRabbit on #2547: a corrupt artifact must exit 2 (bad input), never 1.
// Exit 1 is reserved for "coverage is genuinely below the bar", and confusing
// the two sends someone hunting for a regression that is really a broken file.
for (const [label, payload] of [
  ['null', 'null'],
  ['an array', '[1, 2]'],
  ['a number', '42'],
]) {
  test(`an artifact containing ${label} is fatal, not a crash`, () => {
    const p = path.join(tmp, `bad-${label.replace(/\W/g, '')}.json`);
    fs.writeFileSync(p, payload);
    const res = run([p]);
    assert.equal(res.code, 2, `expected exit 2, got ${res.code}`);
    assert.match(res.stderr, /not a JSON object of file coverage/);
  });
}

test('a coverage-summary.json passed by mistake is fatal, and says so', () => {
  // The realistic corruption: right file name, wrong reporter. istanbul throws
  // a bare Error here, which would otherwise surface as an exit-1 stack trace.
  const p = writeArtifact('summary-shaped.json', {
    total: { lines: { total: 1, covered: 1, skipped: 0, pct: 100 } },
  });
  const res = run([p]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /could not merge/);
  assert.match(res.stderr, /not a summary/);
});

test('the markdown names its measured scope and every threshold', () => {
  const full = writeArtifact('md.json', {
    [path.join(BACKEND_ROOT, 'src/routes/x.ts')]: fileCoverage('src/routes/x.ts', [1, 1, 1, 1]),
  });
  const mdOut = path.join(tmp, 'out.md');
  const res = run([full], { COVERAGE_MARKDOWN_OUT: mdOut });
  assert.equal(res.code, 0);
  const md = fs.readFileSync(mdOut, 'utf8');
  // AC2: the comment has to say what it measured, not just print a percentage.
  assert.match(md, /backend\/src\/\*\*\/\*\.ts/);
  assert.match(md, /src\/scripts\//);
  assert.match(md, /Merged across \*\*both\*\* backend test jobs/);
  assert.match(md, /`src\/routes`/, 'per-directory breakdown present');
  // The comment-update step keys off this marker. Without it, it falls back to
  // matching the visible heading, which on PR #2547 matched Linear's linkback
  // comment (it quotes the ticket, which quotes this report) and overwrote it.
  assert.ok(md.startsWith('<!-- backend-coverage-report -->'), 'marker must lead the body');
  const workflow = fs.readFileSync(
    path.join(BACKEND_ROOT, '..', '.github', 'workflows', 'tests.yml'),
    'utf8',
  );
  assert.match(
    workflow,
    /const MARKER = '<!-- backend-coverage-report -->';/,
    'the workflow must look for the same marker this script emits',
  );
  assert.doesNotMatch(
    workflow,
    /c\.body\.includes\('📊/,
    'the workflow must not identify its comment by the visible heading',
  );
  for (const metric of ['Statements', 'Branches', 'Functions', 'Lines']) {
    assert.match(md, new RegExp(`\\| ${metric} \\|`));
  }
});

test('coverage-thresholds.json is the only threshold, and is well formed', () => {
  const t = JSON.parse(fs.readFileSync(THRESHOLDS, 'utf8'));
  for (const metric of ['statements', 'branches', 'functions', 'lines']) {
    assert.equal(typeof t[metric], 'number', `${metric} must be a number`);
    assert.ok(t[metric] > 0 && t[metric] <= 100, `${metric} must be a real percentage`);
  }
  // AC3: jest.config.js must not carry a competing threshold.
  const jestConfig = fs.readFileSync(path.join(BACKEND_ROOT, 'jest.config.js'), 'utf8');
  assert.doesNotMatch(
    jestConfig.replace(/\/\/.*$/gm, ''),
    /coverageThreshold/,
    'jest.config.js must not re-declare a coverage threshold',
  );
  // ...and neither may the workflow. Comment lines are stripped first: the
  // history of *why* the flag was removed is narrated there on purpose, and
  // matching it would make the test forbid its own explanation.
  const workflow = fs
    .readFileSync(path.join(BACKEND_ROOT, '..', '.github', 'workflows', 'tests.yml'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  assert.doesNotMatch(
    workflow,
    /coverageThreshold/,
    'the workflow must not pass or re-implement a coverage threshold',
  );
  // The github-script step that used to re-implement the 95% bar is gone too;
  // a threshold comparison hidden in JS is still a second mechanism.
  assert.doesNotMatch(
    workflow,
    /pct\s*>=\s*\d/,
    'the workflow must not compare coverage percentages inline',
  );
});
