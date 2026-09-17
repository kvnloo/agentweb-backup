const load = () => require('../pairedBenchmark');
const adapters = () => ({
  direct: { prepare: jest.fn(async () => {}), execute: jest.fn(async (..._args: any[]): Promise<unknown> => ({ messages: ['private'] })) },
  vendor: { prepare: jest.fn(async () => {}), execute: jest.fn(async (..._args: any[]): Promise<unknown> => ({ messages: ['private'] })) },
});
const options = (extra = {}) => ({ samples: 2, actions: ['list'], adapters: adapters(), equivalent: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b), ...extra });
test('rejects writes before preparing either adapter', async () => {
  const opts = options({ actions: ['send'] });
  await expect(load().runPairedBenchmark(opts)).rejects.toThrow('Invalid benchmark configuration');
  expect(opts.adapters.direct.prepare).not.toHaveBeenCalled();
});
test('alternates paired AB/BA separately in warm/cold strata with all warmups recorded', async () => {
  const result = await load().runPairedBenchmark(options());
  const measured = result.attempts.filter((r: any) => r.phase === 'measured');
  expect(measured.map((r: any) => `${r.cache}:${r.arm}`)).toEqual([
    'cold:direct', 'cold:vendor', 'cold:vendor', 'cold:direct',
    'warm:direct', 'warm:vendor', 'warm:vendor', 'warm:direct',
  ]);
  expect(result.attempts.filter((r: any) => r.phase === 'warmup')).toHaveLength(4);
  expect(result.pairs.every((p: any) => p.equivalence === 'equivalent')).toBe(true);
});
test('keeps failures and stage times without serializing payloads, errors, IDs or tokens', async () => {
  const opts = options();
  opts.adapters.vendor.execute.mockImplementation(async (...args: any[]) => {
    await args[1].stage('transport', async () => { throw new Error('private@example.com /accounts/secret bearer token'); });
  });
  const result = await load().runPairedBenchmark(opts);
  expect(result.attempts.filter((r: any) => r.arm === 'vendor').every((r: any) => r.status === 'failed')).toBe(true);
  expect(result.attempts.some((r: any) => r.failedStage === 'transport' && r.stages.transport >= 0)).toBe(true);
  expect(result.pairs.every((p: any) => p.equivalence === 'inconclusive')).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/private|secret|bearer|messages|accounts/);
  expect(result.summaries.every((r: any) => r.p99.status === 'inconclusive')).toBe(true);
});
test('records the innermost stage when instrumented stages are nested', async () => {
  const opts = options();
  opts.adapters.vendor.execute.mockImplementation(async (...args: any[]) => {
    await args[1].stage('transport', () => args[1].stage('normalize', async () => { throw new Error('private'); }));
  });
  const result = await load().runPairedBenchmark(opts);
  expect(result.attempts.filter((r: any) => r.arm === 'vendor' && r.executed).every((r: any) => r.failedStage === 'normalize')).toBe(true);
});
test('percentiles use all attempts and require 100 p99 samples', () => {
  expect(load().summarizeDurations(Array.from({ length: 100 }, (_, i) => i + 1))).toEqual({ attempts: 100, p50: 50, p95: 95, p99: { status: 'measured', value: 99 } });
  expect(load().summarizeDurations([1, 2]).p99).toEqual({ status: 'inconclusive', minimumSamples: 100 });
});
test('fixture comparison mismatch is explicit and exception is inconclusive', async () => {
  const mismatch = await load().runPairedBenchmark(options({ equivalent: () => false }));
  expect(mismatch.pairs.every((p: any) => p.equivalence === 'different')).toBe(true);
  const failure = await load().runPairedBenchmark(options({ equivalent: () => { throw new Error('private'); } }));
  expect(failure.pairs.every((p: any) => p.equivalence === 'inconclusive')).toBe(true);
});
test('does not call execution after reset failure and records the failed measured attempt', async () => {
  const opts = options();
  opts.adapters.direct.prepare.mockRejectedValue(new Error('private reset error'));
  const report = await load().runPairedBenchmark(opts);
  expect(opts.adapters.direct.execute).not.toHaveBeenCalled();
  expect(report.attempts.filter((a: any) => a.arm === 'direct' && a.phase === 'measured')).toHaveLength(4);
  expect(report.summaries.filter((s: any) => s.arm === 'direct').every((s: any) => s.failures === 2)).toBe(true);
});
test('fixed clock and fixtures produce repeatable reports, including stage instrumentation', async () => {
  const makeOptions = () => {
    let tick = 0;
    const opts = options({ now: () => ++tick });
    opts.adapters.direct.execute.mockImplementation(async (_action: any, context: any) => context.stage('transport', async () => ({ messages: ['private'] })));
    return opts;
  };
  expect(await load().runPairedBenchmark(makeOptions())).toEqual(await load().runPairedBenchmark(makeOptions()));
});
test('refuses hostile stage labels without retaining them', async () => {
  const opts = options();
  opts.adapters.vendor.execute.mockImplementation(async (_action: any, context: any) => context.stage('/accounts/private-token', async () => 'private'));
  const report = await load().runPairedBenchmark(opts);
  expect(JSON.stringify(report)).not.toMatch(/private|accounts/);
  expect(report.pairs.every((p: any) => p.equivalence === 'inconclusive')).toBe(true);
});
test('failed primer does not masquerade as a successful warm execution or sufficient p99 sample', async () => {
  const opts = options({ samples: 100 });
  opts.adapters.vendor.execute.mockRejectedValue(new Error('private'));
  const report = await load().runPairedBenchmark(opts);
  const warm = report.attempts.filter((a: any) => a.arm === 'vendor' && a.cache === 'warm' && a.phase === 'measured');
  expect(warm.every((a: any) => a.failedStage === 'warmup' && !a.executed)).toBe(true);
  const summary = report.summaries.find((s: any) => s.arm === 'vendor' && s.cache === 'warm');
  expect(summary.executionAttempts).toBe(0);
  expect(summary.p99.status).toBe('inconclusive');
});
