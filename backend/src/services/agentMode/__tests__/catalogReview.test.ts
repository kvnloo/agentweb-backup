import {
  endpointPriceReport, evaluateAutoMerge, priceOverrideReports, smokeReports, smokeTestModel, summarizePriceOverrides,
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

  it('is eligible only when admin-only, warning-free and smoke-tested', () => {
    expect(evaluateAutoMerge({ additions: one, reports: ['ℹ️ note'], smoke: { m: 'passed' } }).eligible).toBe(true);
  });

  it('is eligible with no new models and no warnings (score-only refresh)', () => {
    expect(evaluateAutoMerge({ additions: [], reports: [], smoke: {} }).eligible).toBe(true);
  });

  it.each([
    ['a model that is not admin-only', [{ id: 'm', adminOnly: false }], [], { m: 'passed' }, /admin-only/],
    ['a warning item', one, ['⚠️ PRICE OUTLIER: m'], { m: 'passed' }, /No review items/],
    ['a failed smoke test', one, [], { m: 'failed' }, /smoke test/],
    ['a skipped smoke test', one, [], { m: 'skipped' }, /smoke test/],
    ['a smoke test that has not run', one, [], {}, /smoke test/],
  ])('is NOT eligible with %s', (_name, additions, reports, smoke, blocker) => {
    const v = evaluateAutoMerge({ additions: additions as any, reports, smoke: smoke as any });
    expect(v.eligible).toBe(false);
    expect(v.blockers.join('|')).toMatch(blocker as RegExp);
  });

  it('does not double count smoke warnings as review items', () => {
    const v = evaluateAutoMerge({ additions: one, reports: ['⚠️ LIVE SMOKE TEST FAILED: m — x'], smoke: { m: 'failed' } });
    expect(v.checks.find(c => c.name.startsWith('No review items'))!.ok).toBe(true);
  });
});
