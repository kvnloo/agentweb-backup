jest.mock('../../utils/agentModeAlerts', () => ({ sendAgentModeOncallAlert: jest.fn() }));
jest.mock('../../utils/secretsManager', () => ({ getSecret: jest.fn() }));

import {
  evaluateKeyBudget,
  runOpenRouterKeyBudgetCheck,
} from '../openRouterKeyBudgetCron';

const okFetch = (data: any) =>
  jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data }) });

describe('ENG-2156 evaluateKeyBudget', () => {
  it('flags the 2026-09-25 incident shape ($399.91 of $400) at the 95% threshold', () => {
    const v = evaluateKeyBudget({ usage: 2683, limit: 400, limit_remaining: 0.09 });
    expect(v.threshold).toBe(0.95);
    expect(v.fraction).toBeCloseTo(0.9998, 3);
  });

  it('prefers limit_remaining over lifetime usage for a monthly-reset key', () => {
    // Lifetime usage far above the limit, but this month only 10% spent.
    expect(evaluateKeyBudget({ usage: 5000, limit: 800, limit_remaining: 720 }).threshold).toBeNull();
  });

  it('falls back to usage when limit_remaining is absent', () => {
    expect(evaluateKeyBudget({ usage: 650, limit: 800 }).threshold).toBe(0.8);
  });

  it('never alerts for an unlimited key', () => {
    expect(evaluateKeyBudget({ usage: 1e6, limit: null })).toEqual({ fraction: null, threshold: null });
  });

  it('stays quiet below 80%', () => {
    expect(evaluateKeyBudget({ usage: 0, limit: 800, limit_remaining: 200 }).threshold).toBeNull();
  });
});

describe('ENG-2156 runOpenRouterKeyBudgetCheck', () => {
  it('pages oncall with a per-threshold dedupe key when the cap is nearly exhausted', async () => {
    const alert = jest.fn().mockResolvedValue(true);
    const r = await runOpenRouterKeyBudgetCheck({
      apiKey: 'k',
      fetchImpl: okFetch({ label: 'agentweb-prod', usage: 399.91, limit: 400, limit_remaining: 0.09 }),
      alert,
    });
    expect(r.alerted).toBe(true);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0].dedupeKey).toBe('openrouter-key-budget:0.95');
    expect(alert.mock.calls[0][0].subject).toBe('OpenRouter key past 95% of its monthly limit');
    expect(alert.mock.calls[0][0].message).toContain('100%');
  });

  it('ENG-2706: keeps one stable subject within a threshold band (85% and 88%)', async () => {
    const alert = jest.fn().mockResolvedValue(true);
    await runOpenRouterKeyBudgetCheck({ apiKey: 'k', fetchImpl: okFetch({ usage: 340, limit: 400, limit_remaining: 60 }), alert });
    await runOpenRouterKeyBudgetCheck({ apiKey: 'k', fetchImpl: okFetch({ usage: 352, limit: 400, limit_remaining: 48 }), alert });
    expect(alert).toHaveBeenCalledTimes(2);
    const [a, b] = alert.mock.calls.map((c: any[]) => c[0]);
    expect(a.subject).toBe(b.subject);
    expect(a.subject).not.toMatch(/8[58]%/);
    expect(a.message).toContain('85%');
    expect(b.message).toContain('88%');
    expect(b.context['Used (%)']).toBe('88%');
  });

  it('ENG-2706: crossing 80% -> 95% still yields a distinct subject', async () => {
    const alert = jest.fn().mockResolvedValue(true);
    await runOpenRouterKeyBudgetCheck({ apiKey: 'k', fetchImpl: okFetch({ usage: 340, limit: 400, limit_remaining: 60 }), alert });
    await runOpenRouterKeyBudgetCheck({ apiKey: 'k', fetchImpl: okFetch({ usage: 384, limit: 400, limit_remaining: 16 }), alert });
    const [a, b] = alert.mock.calls.map((c: any[]) => c[0]);
    expect(a.subject).toBe('OpenRouter key past 80% of its monthly limit');
    expect(b.subject).toBe('OpenRouter key past 95% of its monthly limit');
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });

  it('does not page when healthy', async () => {
    const alert = jest.fn();
    const r = await runOpenRouterKeyBudgetCheck({
      apiKey: 'k',
      fetchImpl: okFetch({ usage: 10, limit: 800, limit_remaining: 790 }),
      alert,
    });
    expect(r.alerted).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it('never throws and never pages when OpenRouter /key fails', async () => {
    const alert = jest.fn();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const r = await runOpenRouterKeyBudgetCheck({ apiKey: 'k', fetchImpl, alert });
    expect(r.error).toContain('401');
    expect(alert).not.toHaveBeenCalled();
  });

  it('does not send the key anywhere but OpenRouter', async () => {
    const fetchImpl = okFetch({ usage: 1, limit: null });
    await runOpenRouterKeyBudgetCheck({ apiKey: 'secret-k', fetchImpl, alert: jest.fn() });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/key',
      expect.objectContaining({ headers: { Authorization: 'Bearer secret-k' } })
    );
  });
});
