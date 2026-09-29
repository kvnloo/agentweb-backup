/**
 * ENG-2145 / ENG-782 contract: offline eval suite + regression gate. Regression vs a versioned
 * baseline (CI-aware), fail closed on every evaluator failure, a recorded human bypass, and
 * blocking only for validated graders behind an explicit flag. Fixtures are synthetic.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  BaselineValidationError,
  EvalTargetError,
  OFFLINE_SUITE_VERSION,
  baselineFromObservations,
  compareMetric,
  differenceInterval,
  exitCodeFor,
  metricMayBlock,
  parseBaseline,
  parseBypass,
  renderReport,
  resolveTarget,
  runOfflineSuite,
  type Baseline,
  type BaselineMetric,
  type GateConfig,
  type MetricObservation,
  type SourceResult,
  type SuiteSource,
} from '../loops/eval/offlineSuite';
import { failureReplaySource, replayFixtureSource } from '../loops/eval/offlineSuiteSources';
import { REPLAY_FIXTURES } from '../loops/eval/agentModeReplayFixtures';
import type { RegisteredReplayCase } from '../loops/eval/failureReplayCatalog';

const NOW = new Date('2026-09-26T08:00:00.000Z');
const REPORT_ONLY: GateConfig = { blockingFlag: false };
const VALIDATED = (id: string) => id === 'validated-grader';
const BLOCKING: GateConfig = { blockingFlag: true, mayGate: VALIDATED, graderType: () => 'code' };

function metric(overrides: Partial<BaselineMetric> = {}): BaselineMetric {
  return {
    metricId: 'quality',
    graderId: 'validated-grader',
    graderVersion: '1',
    kind: 'probabilistic',
    category: 'quality',
    n: 100,
    passes: 90,
    threshold: 0.03,
    minN: 80,
    placeholder: false,
    ...overrides,
  };
}

function observation(overrides: Partial<MetricObservation> = {}): MetricObservation {
  return {
    metricId: 'quality',
    graderId: 'validated-grader',
    graderVersion: '1',
    kind: 'probabilistic',
    category: 'quality',
    n: 100,
    passes: 90,
    placeholder: false,
    failures: [],
    ...overrides,
  };
}

function baseline(metrics: BaselineMetric[], overrides: Partial<Baseline> = {}): Baseline {
  return {
    schemaVersion: 1,
    baselineId: 'test-baseline-v1',
    suiteVersion: OFFLINE_SUITE_VERSION,
    createdAt: '2026-09-25T00:00:00.000Z',
    target: 'local',
    source: 'unit test',
    metrics,
    ...overrides,
  };
}

type SourceBody = SourceResult extends infer R ? (R extends SourceResult ? Omit<R, 'source'> : never) : never;

const source = (id: string, result: SourceBody | (() => Promise<SourceResult>)): SuiteSource => ({
  id,
  run: typeof result === 'function' ? result : async () => ({ source: id, ...result }) as SourceResult,
});

const okSource = (...observations: MetricObservation[]) => source('fake', { status: 'ok', observations, notes: [] });

async function run(b: Baseline, sources: SuiteSource[], gate: GateConfig = REPORT_ONLY, extra: Partial<Parameters<typeof runOfflineSuite>[0]> = {}) {
  return runOfflineSuite({ baseline: b, baselineFile: 'baselines/test.json', target: 'local', sources, gate, now: () => NOW, ...extra });
}

describe('baseline file', () => {
  it('parses the committed local baseline and records metric, threshold, n and grader version for each metric', () => {
    const file = path.join(__dirname, '../loops/eval/baselines/local-deterministic.json');
    const b = parseBaseline(JSON.parse(fs.readFileSync(file, 'utf8')));
    expect(b.target).toBe('local');
    expect(b.suiteVersion).toBe(OFFLINE_SUITE_VERSION);
    for (const m of b.metrics) {
      expect(m).toEqual(expect.objectContaining({ metricId: expect.any(String), graderVersion: expect.any(String), threshold: expect.any(Number), n: expect.any(Number) }));
    }
  });

  it('rejects malformed baselines naming the bad field', () => {
    const good = baseline([metric()]);
    expect(() => parseBaseline({ ...good, schemaVersion: 2 })).toThrow(BaselineValidationError);
    expect(() => parseBaseline({ ...good, metrics: [] })).toThrow('metrics must be a non-empty array');
    expect(() => parseBaseline({ ...good, metrics: [metric({ passes: 101 })] })).toThrow('passes must not exceed n');
    expect(() => parseBaseline({ ...good, metrics: [metric({ threshold: 1 })] })).toThrow('threshold');
    expect(() => parseBaseline({ ...good, metrics: [metric(), metric()] })).toThrow('duplicate metricId quality');
    expect(() => parseBaseline({ ...good, target: 'production' })).toThrow('never production');
  });

  it('builds a baseline from a clean run: deterministic metrics allow no drop, probabilistic ones the default threshold', () => {
    const b = baselineFromObservations(
      [observation({ metricId: 'det', kind: 'deterministic', n: 5, passes: 5 }), observation({ metricId: 'prob', n: 50, passes: 45 })],
      { baselineId: 'x', target: 'staging', source: 'test', now: NOW },
    );
    expect(b.metrics.map((m) => [m.metricId, m.threshold, m.minN])).toEqual([['det', 0, 5], ['prob', 0.05, 40]]);
  });
});

describe('target', () => {
  it('runs on local or staging and refuses production', () => {
    expect(resolveTarget('staging')).toBe('staging');
    expect(() => resolveTarget('production')).toThrow(EvalTargetError);
    expect(() => resolveTarget('prod')).toThrow('never production');
    expect(() => resolveTarget(undefined)).toThrow('target must be local or staging');
  });
});

describe('regression vs baseline', () => {
  it('computes a Newcombe interval for the change in rate', () => {
    const ci = differenceInterval({ passes: 60, n: 100 }, { passes: 90, n: 100 });
    expect(ci.low).toBeLessThan(-0.3);
    expect(ci.high).toBeLessThan(0);
    const same = differenceInterval({ passes: 90, n: 100 }, { passes: 90, n: 100 });
    expect(same.low).toBeLessThan(0);
    expect(same.high).toBeGreaterThan(0);
  });

  it('passes a clean run and cites baseline, threshold and n', async () => {
    const result = await run(baseline([metric()]), [okSource(observation({ passes: 91 }))]);
    expect(result.verdict).toBe('pass');
    const report = renderReport(result);
    expect(report).toContain('test-baseline-v1');
    expect(report).toContain('90.0% (90/100)');
    expect(report).toContain('91.0% (91/100');
    expect(report).toContain('3.0%, minN 80');
  });

  it('does not call a point dip inside sampling noise a regression, even past the threshold', () => {
    const c = compareMetric(metric(), observation({ passes: 85 }), REPORT_ONLY);
    expect(c.drop).toBeCloseTo(0.05);
    expect(c.status).toBe('pass');
    expect(c.reason).toContain('within sampling noise');
  });

  it('flags a statistically meaningful drop beyond the threshold', () => {
    const c = compareMetric(metric(), observation({ passes: 70 }), REPORT_ONLY);
    expect(c.status).toBe('regression');
    expect(c.diffCI?.high).toBeLessThan(0);
  });

  it('needs the sample to resolve it: the same 5-point drop is a regression at n=2000', () => {
    const big = metric({ n: 2000, passes: 1800, minN: 1600 });
    expect(compareMetric(big, observation({ n: 2000, passes: 1700 }), REPORT_ONLY).status).toBe('regression');
  });

  it('does not flag a significant drop that stays within the threshold', () => {
    const c = compareMetric(metric({ n: 5000, passes: 4500, minN: 4000, threshold: 0.03 }), observation({ n: 5000, passes: 4400 }), REPORT_ONLY);
    expect(c.status).toBe('pass');
  });

  it('treats any failure of a deterministic case as a regression, naming the case', () => {
    const c = compareMetric(metric({ kind: 'deterministic', n: 2, passes: 2, minN: 2, threshold: 0 }), observation({ kind: 'deterministic', n: 2, passes: 1, failures: ['eng-286'] }), REPORT_ONLY);
    expect(c.status).toBe('regression');
    expect(c.reason).toContain('eng-286');
  });

  it('turns a deliberately degraded candidate reply into a red verdict and the recorded replies into green', async () => {
    const fixtures = REPLAY_FIXTURES.map((f) => ({ ...f, isPlaceholder: false }));
    const load = async () => ({ fixtures, notes: [] });
    const clean = replayFixtureSource({ load, candidate: async () => 'Yes.' });
    const degraded = replayFixtureSource({ load, candidate: async () => 'word '.repeat(2000) });
    const cleanObs = (await clean.run()) as Extract<SourceResult, { status: 'ok' }>;
    const b = baselineFromObservations(cleanObs.observations, { baselineId: 'candidate-v1', target: 'local', source: 'test', now: NOW });

    expect((await run(b, [clean])).verdict).toBe('pass');
    const red = await run(b, [degraded]);
    expect(red.verdict).toBe('regression');
    expect(red.comparisons[0].current?.failures).toEqual(fixtures.filter((f) => !f.pending).map((f) => f.id));
  });

  it('replays the registered ENG-591 cases green today and red when a case regresses', async () => {
    const good = (await failureReplaySource().run()) as Extract<SourceResult, { status: 'ok' }>;
    const b = baselineFromObservations(good.observations, { baselineId: 'replay-v1', target: 'local', source: 'test', now: NOW });
    expect((await run(b, [failureReplaySource()])).verdict).toBe('pass');

    const broken: RegisteredReplayCase[] = [
      { id: 'eng-286-write-without-read-back', incident: 'ENG-286', failure: 'must flag', graderId: 'agent-tool-correctness', check: () => false },
      { id: 'eng-286-read-back-accepted', incident: 'ENG-286', failure: 'must pass', graderId: 'agent-tool-correctness', check: () => { throw new Error('boom'); } },
    ];
    const red = await run(b, [failureReplaySource(broken)]);
    expect(red.verdict).toBe('regression');
    expect(red.comparisons[0].reason).toContain('eng-286-write-without-read-back');
    expect(red.comparisons[0].reason).toContain('threw: boom');
  });
});

describe('fail closed: an evaluator problem is never a pass', () => {
  const b = baseline([metric()]);

  it.each<[string, SuiteSource]>([
    ['unavailable (throws)', source('okareo', async () => { throw new Error('ECONNREFUSED'); })],
    ['unavailable', source('okareo', { status: 'failed', failure: 'unavailable', message: 'HTTP 503' })],
    ['unauthenticated', source('okareo', { status: 'failed', failure: 'unauthenticated', message: 'HTTP 401' })],
    ['malformed', source('okareo', { status: 'failed', failure: 'malformed', message: 'no check_values' })],
    ['malformed counts', okSource(observation({ passes: 120 }))],
    ['not configured', source('okareo', { status: 'not_configured', reason: 'OKAREO_API_KEY is not set' })],
  ])('%s → unavailable', async (_label, s) => {
    const result = await run(b, [s]);
    expect(result.verdict).toBe('unavailable');
    expect(result.unavailable.length).toBeGreaterThan(0);
  });

  it('times out a source that never answers', async () => {
    const hang = source('okareo', () => new Promise<SourceResult>(() => undefined));
    const result = await run(b, [hang], REPORT_ONLY, { sourceTimeoutMs: 20 });
    expect(result.verdict).toBe('unavailable');
    expect(result.unavailable.join('\n')).toContain('timeout');
  });

  it('refuses to compare across a grader version change, too small a sample, or another target', async () => {
    expect((await run(b, [okSource(observation({ graderVersion: '2' }))])).unavailable.join('\n')).toContain('grader version changed');
    expect((await run(b, [okSource(observation({ n: 10, passes: 10 }))])).unavailable.join('\n')).toContain('below the baseline minimum of 80');
    const staging = await run(baseline([metric()], { target: 'staging' }), [okSource(observation())]);
    expect(staging.verdict).toBe('unavailable');
  });

  it('keeps a regression visible when another source is also down', async () => {
    const result = await run(baseline([metric(), metric({ metricId: 'other' })]), [okSource(observation({ passes: 60 })), source('okareo', { status: 'failed', failure: 'timeout', message: 'slow' })]);
    expect(result.verdict).toBe('regression');
    expect(result.unavailable.join('\n')).toContain('okareo: timeout');
  });
});

describe('gate mode: report-only until a validated grader and the explicit flag', () => {
  const b = baseline([metric()]);
  const regressed = () => okSource(observation({ passes: 60 }));

  it('never blocks while the flag is off, even for a validated grader', async () => {
    const result = await run(b, [regressed()], { blockingFlag: false, mayGate: VALIDATED });
    expect(result).toMatchObject({ verdict: 'regression', mode: 'report_only', blocks: false });
    expect(exitCodeFor(result)).toBe(0);
  });

  it('never blocks on an unvalidated grader, even with the flag on (today: every registry grader)', async () => {
    const result = await run(b, [regressed()], { blockingFlag: true });
    expect(result).toMatchObject({ verdict: 'regression', mode: 'report_only', blocks: false });
    expect(result.modeReason).toContain('mayGate');
    expect(result.comparisons[0].mayBlockReason).toContain('not validated');
  });

  it('blocks a regression on a validated grader once the flag is on', async () => {
    const result = await run(b, [regressed()], BLOCKING);
    expect(result).toMatchObject({ verdict: 'regression', mode: 'blocking', blocks: true });
    expect(exitCodeFor(result)).toBe(1);
  });

  it('blocks an unavailable evaluator in blocking mode (fail closed)', async () => {
    const result = await run(b, [source('okareo', { status: 'failed', failure: 'unauthenticated', message: 'HTTP 401' })], BLOCKING);
    expect(result).toMatchObject({ verdict: 'unavailable', mode: 'blocking', blocks: true });
    expect(exitCodeFor(result)).toBe(2);
  });

  it('passes in blocking mode when nothing regressed', async () => {
    const result = await run(b, [okSource(observation())], BLOCKING);
    expect(result).toMatchObject({ verdict: 'pass', mode: 'blocking', blocks: false });
  });

  it('never lets a placeholder metric or an LLM-judged security metric block', () => {
    expect(metricMayBlock({ graderId: 'validated-grader', category: 'quality', placeholder: true }, BLOCKING).mayBlock).toBe(false);
    const judge: GateConfig = { blockingFlag: true, mayGate: () => true, graderType: () => 'llm_judge' };
    expect(metricMayBlock({ graderId: 'validated-grader', category: 'security', placeholder: false }, judge)).toEqual({
      mayBlock: false,
      reason: 'security is never gated on an LLM judge (ENG-782)',
    });
    expect(metricMayBlock({ graderId: 'validated-grader', category: 'quality', placeholder: false }, judge).mayBlock).toBe(true);
  });

  it('treats a current run on placeholders as non-evidence even against a real baseline', () => {
    const c = compareMetric(metric(), observation({ placeholder: true }), BLOCKING);
    expect(c).toMatchObject({ placeholder: true, mayBlock: false });
  });
});

describe('recorded human bypass', () => {
  const b = baseline([metric()]);

  it('requires who, why and which ticket, and refuses an automation identity', () => {
    expect(parseBypass({}, NOW)).toBeNull();
    expect(() => parseBypass({ by: 'Harsha' }, NOW)).toThrow('by, reason and ticket are all required');
    expect(() => parseBypass({ by: 'claude', reason: 'staging outage, shipping fix', ticket: 'ENG-1' }, NOW)).toThrow('automation identity');
    expect(() => parseBypass({ by: 'github-actions[bot]', reason: 'staging outage, shipping fix', ticket: 'ENG-1' }, NOW)).toThrow('automation identity');
    expect(() => parseBypass({ by: 'Harsha', reason: 'because', ticket: 'ENG-1' }, NOW)).toThrow('at least 10 characters');
    expect(() => parseBypass({ by: 'Harsha', reason: 'Okareo outage, hotfix', ticket: 'see slack' }, NOW)).toThrow('issue key');
    expect(parseBypass({ by: 'Harsha', reason: 'Okareo outage, hotfix', ticket: 'ENG-2151' }, NOW)).toEqual({
      by: 'Harsha', reason: 'Okareo outage, hotfix', ticket: 'ENG-2151', at: NOW.toISOString(),
    });
  });

  it('lifts a block, keeps the verdict, and records who, when and why in the output', async () => {
    const bypass = parseBypass({ by: 'Harsha', reason: 'Okareo outage during a security hotfix', ticket: 'ENG-2151' }, NOW);
    const result = await run(b, [source('okareo', { status: 'failed', failure: 'unavailable', message: 'HTTP 503' })], BLOCKING, { bypass });
    expect(result).toMatchObject({ verdict: 'unavailable', blocks: false, bypass: { by: 'Harsha', ticket: 'ENG-2151', at: NOW.toISOString(), applied: true } });
    expect(exitCodeFor(result)).toBe(0);
    expect(renderReport(result)).toContain('Bypass: APPLIED — by Harsha at 2026-09-26T08:00:00.000Z, ENG-2151: Okareo outage during a security hotfix');
  });

  it('is recorded but not applied when nothing blocks', async () => {
    const bypass = parseBypass({ by: 'Harsha', reason: 'Okareo outage during a security hotfix', ticket: 'ENG-2151' }, NOW);
    const result = await run(b, [okSource(observation({ passes: 60 }))], REPORT_ONLY, { bypass });
    expect(result.bypass).toMatchObject({ applied: false, note: 'nothing to bypass: gate is report-only' });
  });
});
