import {
  classifyExistingChanges, classifyReport, endpointPriceReport, evaluateAutoMerge, guardReport, oneLine,
  priceOverrideReports, smokeReports, smokeTestAll, smokeTestModel, summarizePriceOverrides,
} from '../catalogReview';

const caps = { supportsTemperature: false, supportsTools: true, supportsToolChoice: true };
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('summarizePriceOverrides / priceOverrideReports', () => {
  const pricing = (overrides: unknown[]) => ({ prompt: '0.0000001', completion: '0.0000005', overrides });

  it('reports a long-prompt tier with its multiplier and threshold (Haiku 5.5 shape: 5x above 100k)', () => {
    const overrides = summarizePriceOverrides(pricing([{ min_prompt_tokens: 100000, prompt: '0.0000005', completion: '0.0000025' }]));
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({ kind: 'long_prompt', minPromptTokens: 100000 });
    expect(overrides[0].multiplier).toBeCloseTo(5, 6);
    const [line] = priceOverrideReports('openrouter/anthropic/claude-haiku-5.5', overrides);
    expect(line).toMatch(/^⚠️ LONG-PROMPT PRICE TIER/);
    expect(line).toContain('5.0x');
    expect(line).toContain('100k');
  });

  it('reports time-of-day windows only when a window costs more than the listed rate', () => {
    // deepseek-v4-pro-0813 shape: listed (cheap) rate, weekday peak window at 2x.
    const peak = summarizePriceOverrides({ prompt: '0.00000066', completion: '0.00000198', overrides: [
      { utc_days: ['saturday', 'sunday'], prompt: '0.00000066', completion: '0.00000198' },
      { utc_days: ['monday'], utc_start: 100, utc_end: 400, prompt: '0.00000132', completion: '0.00000396' },
    ] });
    expect(peak).toHaveLength(1);
    expect(peak[0].kind).toBe('time_of_day');
    expect(peak[0].multiplier).toBeCloseTo(2, 6);
    expect(priceOverrideReports('m', peak)[0]).toMatch(/^⚠️ TIME-OF-DAY PRICING.*2\.0x/);
    expect(summarizePriceOverrides({ prompt: '0.000001', completion: '0.000002', overrides: [
      { utc_days: ['sunday'], prompt: '0.000001', completion: '0.000002' }] })).toEqual([]);
  });

  it('flags an override kind it does not recognise instead of ignoring it', () => {
    const o = summarizePriceOverrides(pricing([{ region: 'eu', prompt: '0.0000002', completion: '0.000001' }]));
    expect(priceOverrideReports('m', o)[0]).toMatch(/^⚠️ UNMODELED PRICE OVERRIDE/);
  });

  it('returns nothing for a model with no overrides or malformed ones', () => {
    expect(summarizePriceOverrides({ prompt: '1', completion: '2' })).toEqual([]);
    expect(summarizePriceOverrides({ prompt: '1', completion: '2', overrides: [null, 'x', 4] })).toEqual([]);
    expect(summarizePriceOverrides(undefined)).toEqual([]);
  });
});

describe('endpointPriceReport', () => {
  const eps = (...prices: Array<[string, string]>) => ({ data: { endpoints: prices.map(([prompt, completion]) => ({ pricing: { prompt, completion } })) } });

  it('is informational when the listed price agrees with the endpoints', () => {
    const [line] = endpointPriceReport('m', 0.2, eps(['0.0000001', '0.0000005'], ['0.00000011', '0.00000055']));
    expect(line).toMatch(/^ℹ️ ENDPOINT PRICES/);
  });

  it('warns when endpoints charge far more than the listed price', () => {
    const [line] = endpointPriceReport('m', 0.2, eps(['0.000001', '0.000005'], ['0.000001', '0.000005'], ['0.000001', '0.000005']));
    expect(line).toMatch(/^⚠️ QUOTE VS ENDPOINTS/);
  });

  it('warns when the listed price is $0 but endpoints are paid, and tolerates both free', () => {
    expect(endpointPriceReport('m', 0, eps(['0.000001', '0.000001']))[0]).toMatch(/^⚠️ QUOTE VS ENDPOINTS/);
    expect(endpointPriceReport('m', 0, eps(['0', '0']))[0]).toMatch(/^ℹ️/);
  });

  it('warns rather than passing when endpoint prices cannot be read', () => {
    expect(endpointPriceReport('m', 0.2, { data: { endpoints: [] } })[0]).toMatch(/^⚠️ ENDPOINT PRICES UNAVAILABLE/);
    expect(endpointPriceReport('m', 0.2, eps(['x', 'y']))[0]).toMatch(/^⚠️ ENDPOINT PRICES UNAVAILABLE/);
    expect(endpointPriceReport('m', 0.2, null)[0]).toMatch(/^⚠️ ENDPOINT PRICES UNAVAILABLE/);
  });
});

describe('smokeTestModel', () => {
  it('is skipped (never passed) without a key', async () => {
    const request = jest.fn();
    const r = await smokeTestModel('openrouter/anthropic/claude-haiku-5.5', caps, { request: request as any });
    expect(r.status).toBe('skipped');
    expect(request).not.toHaveBeenCalled();
  });

  it('sends the backend request shape: tools, tool_choice, require_parameters, no unsupported temperature', async () => {
    const request = jest.fn().mockResolvedValue(ok({ provider: 'Amazon Bedrock', choices: [{ message: { content: 'OK' } }] }));
    const r = await smokeTestModel('openrouter/anthropic/claude-haiku-5.5', caps, { apiKey: 'k', request: request as any });
    expect(r).toMatchObject({ status: 'passed' });
    expect(r.detail).toContain('Amazon Bedrock');
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer k');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('anthropic/claude-haiku-5.5');
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe('auto');
    expect(body.provider.require_parameters).toBe(true);
    expect(body).not.toHaveProperty('temperature'); // supportsTemperature: false
  });

  it('sends temperature when supported, and the Google-provider ignore list for Gemini', async () => {
    const request = jest.fn().mockResolvedValue(ok({ choices: [{ message: { content: 'OK' } }] }));
    await smokeTestModel('openrouter/google/gemini-3.5-flash-lite', { ...caps, supportsTemperature: true }, { apiKey: 'k', request: request as any });
    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body.temperature).toBe(0.7);
    expect(body.provider.ignore).toEqual(['Google']);
  });

  it('accepts a tool call with no text as a pass', async () => {
    const request = jest.fn().mockResolvedValue(ok({ choices: [{ message: { content: null, tool_calls: [{ id: '1' }] } }] }));
    expect((await smokeTestModel('openrouter/x/y', caps, { apiKey: 'k', request: request as any })).status).toBe('passed');
  });

  it('fails on the routing 404, an empty reply, and a network error — without leaking the key', async () => {
    const notFound = jest.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: { message: 'No endpoints found that can handle the requested parameters' } }) });
    const a = await smokeTestModel('openrouter/x/y', caps, { apiKey: 'secret-key', request: notFound as any });
    expect(a.status).toBe('failed');
    expect(a.detail).toContain('No endpoints found');
    const empty = jest.fn().mockResolvedValue(ok({ choices: [{ message: { content: '  ' } }] }));
    expect((await smokeTestModel('openrouter/x/y', caps, { apiKey: 'secret-key', request: empty as any })).status).toBe('failed');
    const boom = jest.fn().mockRejectedValue(new Error('socket hang up'));
    const c = await smokeTestModel('openrouter/x/y', caps, { apiKey: 'secret-key', request: boom as any });
    expect(c.status).toBe('failed');
    expect(JSON.stringify([a, c])).not.toContain('secret-key');
  });

  it('turns results into report lines, failures and skips as warnings', () => {
    const lines = smokeReports([
      { id: 'a', status: 'passed', detail: 'routed' }, { id: 'b', status: 'failed', detail: 'HTTP 404' }, { id: 'c', status: 'skipped', detail: 'no key' },
    ]);
    expect(lines[0]).toMatch(/^✅ LIVE SMOKE TEST passed: a/);
    expect(lines[1]).toMatch(/^⚠️ LIVE SMOKE TEST FAILED: b/);
    expect(lines[2]).toMatch(/^⚠️ LIVE SMOKE TEST SKIPPED: c/);
  });
});

describe('evaluateAutoMerge', () => {
  const one = [{ id: 'm', adminOnly: true }];
  const clean = { existingChanges: { changed: 0, blockers: [] as string[] }, observationDegraded: false };
  const verdict = (o: Partial<Parameters<typeof evaluateAutoMerge>[0]>) =>
    evaluateAutoMerge({ additions: one, reports: [], smoke: { m: 'passed' }, ...clean, ...o });

  it('is eligible only when admin-only, clean, smoke-tested, existing models safe and data complete', () => {
    expect(verdict({ reports: ['ℹ️ note', '✅ LIVE SMOKE TEST passed: m (x)'] }).eligible).toBe(true);
  });

  it('is eligible with no new models and nothing wrong (clean refresh)', () => {
    expect(verdict({ additions: [], smoke: {} }).eligible).toBe(true);
  });

  it.each([
    ['a model that is not admin-only', { additions: [{ id: 'm', adminOnly: false }] }, /admin-only/],
    ['a warning item', { reports: ['⚠️ PRICE OUTLIER: m'] }, /No review items/],
    ['a BARE warning sign (no variation selector)', { reports: ['⚠ PRICE OUTLIER: m'] }, /No review items/],
    ['a bold-wrapped warning', { reports: ['**⚠️ PRICE OUTLIER: m**'] }, /No review items/],
    ['a report line it has never seen (fail closed)', { reports: ['Something new happened'] }, /No review items/],
    ['a failed smoke test', { smoke: { m: 'failed' } }, /smoke test/],
    ['a skipped smoke test', { smoke: { m: 'skipped' } }, /smoke test/],
    ['a smoke test that has not run', { smoke: {} }, /smoke test/],
    ['a score jump on an existing model', { existingChanges: { changed: 1, blockers: ['x: score 30 -> 99'] } }, /Existing models/],
    ['a degraded upstream observation (Artificial Analysis failed)', { observationDegraded: true }, /Upstream data/],
  ])('is NOT eligible with %s', (_name, override, blocker) => {
    const v = verdict(override as any);
    expect(v.eligible).toBe(false);
    expect(v.blockers.join('|')).toMatch(blocker as RegExp);
  });

  it('does not double count smoke warnings as review items', () => {
    const v = verdict({ reports: ['⚠️ LIVE SMOKE TEST FAILED: m — x'], smoke: { m: 'failed' } });
    expect(v.checks.find(c => c.name.startsWith('No review items'))!.ok).toBe(true);
  });

  it('lists tolerated score refreshes without blocking', () => {
    const v = verdict({ additions: [], smoke: {}, existingChanges: { changed: 2, blockers: [] } });
    expect(v.eligible).toBe(true);
    expect(v.checks.find(c => c.name.startsWith('Existing models'))!.detail).toContain('2 score refresh');
  });
});

describe('classifyReport', () => {
  it.each([
    ['⚠️ PRICE OUTLIER: m', 'warning'], ['⚠ bare sign', 'warning'], [' **⚠️ wrapped**', 'warning'],
    ['Artificial Analysis failed: HTTP 500', 'warning'],
    ['Artificial Analysis unavailable: ARTIFICIAL_ANALYSIS_API_KEY not set; top-N detection skipped.', 'warning'],
    ['ℹ️ PRICE DROP: m', 'info'], ['✅ LIVE SMOKE TEST passed: m (x)', 'info'],
    ['openrouter/x/y: AA unmatched; score unchanged', 'benign'],
    ['openrouter/x/y: live quote ($1/$2 in/out) diverges from curated price ($3/$4); not applied', 'benign'],
    ['Artificial Analysis skipped: ARTIFICIAL_ANALYSIS_API_KEY is missing; scores unchanged.', 'benign'],
    ['Slack model alert failed; inspect webhook configuration.', 'benign'],
    ['A brand new kind of line', 'unrecognized'], ['', 'unrecognized'],
  ])('%p -> %s', (line, expected) => { expect(classifyReport(line)).toBe(expected); });
});

describe('classifyExistingChanges', () => {
  const reg = { a: { qualityScore: 30, qualityScoreSource: 'Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-07, slug-a (https://x)' }, hand: { qualityScore: 30, qualityScoreSource: 'Artificial Analysis Intelligence Index v4.3.2, snapshot 2026-09-22, Hand Written, Max' } };
  const src = (slug: string) => `Artificial Analysis Intelligence Index, API v2, snapshot 2026-10-08, ${slug} (https://x)`;

  it('tolerates a small score move on the same slug', () => {
    expect(classifyExistingChanges(reg, { a: { qualityScore: 30.4, qualityScoreSource: src('slug-a') } }, [])).toEqual({ changed: 1, blockers: [] });
  });
  it('blocks a jump of more than 3 points (the 30 -> 36 mismatch class)', () => {
    expect(classifyExistingChanges(reg, { a: { qualityScore: 36, qualityScoreSource: src('slug-a') } }, []).blockers[0]).toMatch(/30 -> 36/);
  });
  it('blocks a changed Artificial Analysis slug even when the score is close', () => {
    expect(classifyExistingChanges(reg, { a: { qualityScore: 31, qualityScoreSource: src('slug-b') } }, []).blockers[0]).toMatch(/slug-a -> slug-b/);
  });
  it('does not compare slugs when the old source was hand-written', () => {
    expect(classifyExistingChanges(reg, { hand: { qualityScore: 31, qualityScoreSource: src('anything') } }, []).blockers).toEqual([]);
  });
  it('blocks a first-ever score and any non-score field, ignores new additions and the inferred-family backfill', () => {
    const empty = { n: {} as Record<string, unknown> };
    expect(classifyExistingChanges(empty, { n: { qualityScore: 40, qualityScoreSource: src('s') } }, []).blockers[0]).toMatch(/first-ever/);
    expect(classifyExistingChanges(reg, { a: { adminOnly: false } }, []).blockers[0]).toMatch(/unexpected change to adminOnly/);
    expect(classifyExistingChanges(reg, { newmodel: { qualityScore: 99 } }, ['newmodel'])).toEqual({ changed: 0, blockers: [] });
    expect(classifyExistingChanges(reg, { 'openrouter/x-ai/grok-4.7': { family: 'grok' } }, [])).toEqual({ changed: 0, blockers: [] });
  });
});

describe('guardReport', () => {
  const result = (o: object) => JSON.stringify(o);
  it('passes when every check passed', () => {
    expect(guardReport(result({ numTotalTests: 52, numFailedTests: 0 }))[0]).toMatch(/^✅ CAPABILITY GUARD passed: 52/);
  });
  it('names the failing checks as a warning', () => {
    const [line] = guardReport(result({ numTotalTests: 52, numFailedTests: 1, testResults: [{ assertionResults: [
      { status: 'passed', title: 'ok one' }, { status: 'failed', title: 'openrouter/x/y is routable with every parameter callLLM can send it' }] }] }));
    expect(line).toMatch(/^⚠️ CAPABILITY GUARD FAILED: 1 of 52/);
    expect(line).toContain('openrouter/x/y is routable');
  });
  it('is a warning when the result is missing, unparseable or has no tests (fail closed)', () => {
    expect(guardReport(undefined)[0]).toMatch(/^⚠️ CAPABILITY GUARD NOT RUN/);
    expect(guardReport('not json')[0]).toMatch(/^⚠️ CAPABILITY GUARD NOT RUN/);
    expect(guardReport(result({ numTotalTests: 0, numFailedTests: 0 }))[0]).toMatch(/^⚠️ CAPABILITY GUARD NOT RUN/);
  });
});

describe('oneLine and smoke hardening', () => {
  it('flattens newlines and control characters from third-party text', () => {
    expect(oneLine('bad\nline\r\n- injected\t\u0007item')).toBe('bad line - injected item');
    expect(oneLine('x'.repeat(500), 50)).toHaveLength(50);
  });
  it('keeps a multi-line provider error on one report line', async () => {
    const request = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: { message: 'line one\n- ⚠️ forged' } }) });
    const r = await smokeTestModel('openrouter/x/y', caps, { apiKey: 'k', request: request as any });
    expect(r.detail).not.toMatch(/[\r\n]/);
  });
  it('runs several models with bounded concurrency and caps how many it tries', async () => {
    let inflight = 0, peak = 0;
    const request = jest.fn().mockImplementation(async () => {
      inflight++; peak = Math.max(peak, inflight); await new Promise(r => setTimeout(r, 5)); inflight--;
      return ok({ choices: [{ message: { content: 'OK' } }] });
    });
    const models = Array.from({ length: 10 }, (_, i) => ({ id: `openrouter/x/m${i}`, capabilities: caps }));
    const results = await smokeTestAll(models, { apiKey: 'k', request: request as any, concurrency: 3, maxModels: 8 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(results.map(r => r.id)).toEqual(models.map(m => m.id));
    expect(results.filter(r => r.status === 'passed')).toHaveLength(8);
    expect(results.filter(r => r.status === 'skipped')).toHaveLength(2);
    expect(request).toHaveBeenCalledTimes(8);
  });
});

describe('override and endpoint edge cases', () => {
  it('treats a window with only utc_start/utc_end as time-of-day, not "unmodeled"', () => {
    const o = summarizePriceOverrides({ prompt: '0.000001', completion: '0.000002', overrides: [{ utc_start: 100, utc_end: 400, prompt: '0.000002', completion: '0.000004' }] });
    expect(o[0].kind).toBe('time_of_day');
  });
  it('sees a cache-only surcharge', () => {
    const o = summarizePriceOverrides({ prompt: '0.000001', completion: '0.000002', input_cache_read: '0.0000001', overrides: [
      { min_prompt_tokens: 200000, prompt: '0.000001', completion: '0.000002', input_cache_read: '0.0000005' }] });
    expect(o).toHaveLength(1);
    expect(o[0].multiplier).toBeCloseTo(5, 6);
  });
  it('does not flag a cache override when the base has no cache price', () => {
    expect(summarizePriceOverrides({ prompt: '0.000001', completion: '0.000002', overrides: [
      { min_prompt_tokens: 1, prompt: '0.000001', completion: '0.000002', input_cache_read: '0.0000005' }] })).toEqual([]);
  });
  it('ignores endpoints with a null or blank price instead of counting them as free', () => {
    const payload = { data: { endpoints: [
      { pricing: { prompt: null, completion: null } }, { pricing: { prompt: '', completion: '' } },
      { pricing: { prompt: '0.0000001', completion: '0.0000005' } }] } };
    const [line] = endpointPriceReport('m', 0.2, payload);
    expect(line).toMatch(/^ℹ️ ENDPOINT PRICES.*1 endpoint\(s\)/);
  });
});
