/**
 * Tests for the continuous account-health evaluators (ENG-1266).
 *
 * Every documented churn/at-risk incident in the August 2026 audit — RankAI (broken
 * pixel), Haven ($6,549 overspend), ThinkingAI/TransAmerica (disconnected ad account)
 * — was caught manually, after the fact. These evaluators are pure functions over
 * already-computed signals (the tracking-monitor sweep's summary counts, connected-
 * account records, and platform-reported spend/cap figures) so a scheduled sweep can
 * flag the same failure classes continuously instead of waiting for a human audit.
 */
import {
  evaluatePixelHealth,
  evaluateBudgetVariance,
  evaluateAdConnectivity,
  evaluateAccountHealth,
  DEFAULT_BUDGET_VARIANCE_THRESHOLD_PCT,
} from '../services/accountHealthService';

describe('evaluatePixelHealth', () => {
  it('flags an account with a destination alert (RankAI failure mode: promoted page carries no pixel the account owns)', () => {
    const result = evaluatePixelHealth({ blackouts: 0, destinationAlerts: 1, destinationOk: 0 });
    expect(result.flagged).toBe(true);
    expect(result.reason).toMatch(/destination/i);
  });

  it('flags an account with an attribution blackout (no conversion events firing for the blackout window)', () => {
    const result = evaluatePixelHealth({ blackouts: 1, destinationAlerts: 0, destinationOk: 2 });
    expect(result.flagged).toBe(true);
    expect(result.reason).toMatch(/blackout/i);
  });

  it('does not flag a healthy account with confirmed destinations and no blackout', () => {
    const result = evaluatePixelHealth({ blackouts: 0, destinationAlerts: 0, destinationOk: 3 });
    expect(result.flagged).toBe(false);
  });
});

describe('evaluateBudgetVariance', () => {
  it('flags spend exceeding the configured cap beyond the threshold (Haven failure mode: $6,549 over an approved cap)', () => {
    const result = evaluateBudgetVariance({
      configuredCapCents: 10000_00,
      actualSpendCents: 16549_00,
    });
    expect(result.flagged).toBe(true);
    expect(result.reason).toMatch(/cap/i);
  });

  it('does not flag spend within the default threshold of the cap', () => {
    const result = evaluateBudgetVariance({
      configuredCapCents: 10000_00,
      actualSpendCents: 10300_00, // 3% over, under the 10% default threshold
    });
    expect(result.flagged).toBe(false);
  });

  it('flags spend exactly at the threshold boundary as not flagged, and just over as flagged', () => {
    const atThreshold = evaluateBudgetVariance({
      configuredCapCents: 10000_00,
      actualSpendCents: 11000_00, // exactly +10%
    });
    expect(atThreshold.flagged).toBe(false);

    const overThreshold = evaluateBudgetVariance({
      configuredCapCents: 10000_00,
      actualSpendCents: 11001_00,
    });
    expect(overThreshold.flagged).toBe(true);
  });

  it('never divides by zero and does not flag when no cap is configured', () => {
    const result = evaluateBudgetVariance({ configuredCapCents: 0, actualSpendCents: 500_00 });
    expect(result.flagged).toBe(false);
    expect(result.reason).toMatch(/no cap configured/i);
  });

  it('honors a custom threshold', () => {
    const result = evaluateBudgetVariance({
      configuredCapCents: 10000_00,
      actualSpendCents: 10600_00, // 6% over
      thresholdPct: 5,
    });
    expect(result.flagged).toBe(true);
  });

  it('exposes the default threshold constant used when none is passed', () => {
    expect(DEFAULT_BUDGET_VARIANCE_THRESHOLD_PCT).toBeGreaterThan(0);
  });

  it('does not flag malformed (NaN) budget inputs — reports a data gap instead of a false positive', () => {
    const result = evaluateBudgetVariance({ configuredCapCents: NaN, actualSpendCents: 500_00 });
    expect(result.flagged).toBe(false);
    expect(result.reason).toMatch(/not finite/i);

    const result2 = evaluateBudgetVariance({ configuredCapCents: 1000_00, actualSpendCents: NaN });
    expect(result2.flagged).toBe(false);
    expect(result2.reason).toMatch(/not finite/i);

    const result3 = evaluateBudgetVariance({
      configuredCapCents: 1000_00,
      actualSpendCents: 500_00,
      thresholdPct: Infinity,
    });
    expect(result3.flagged).toBe(false);
    expect(result3.reason).toMatch(/not finite/i);
  });

  it('does not flag negative budget inputs — reports a data gap instead of a false positive', () => {
    const negativeCap = evaluateBudgetVariance({ configuredCapCents: -100_00, actualSpendCents: 500_00 });
    expect(negativeCap.flagged).toBe(false);
    expect(negativeCap.reason).toMatch(/negative/i);

    const negativeSpend = evaluateBudgetVariance({ configuredCapCents: 1000_00, actualSpendCents: -1 });
    expect(negativeSpend.flagged).toBe(false);
    expect(negativeSpend.reason).toMatch(/negative/i);

    // Spend exactly at the cap (0% over) must not be flagged by a negative threshold's
    // inverted comparison (0 > -1 is true).
    const negativeThreshold = evaluateBudgetVariance({
      configuredCapCents: 1000_00,
      actualSpendCents: 1000_00,
      thresholdPct: -1,
    });
    expect(negativeThreshold.flagged).toBe(false);
    expect(negativeThreshold.reason).toMatch(/negative/i);
  });
});

describe('evaluateAdConnectivity', () => {
  const futureExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const pastExpiry = Date.now() - 1000;

  it('flags an account with no ad-platform connections at all (ThinkingAI failure mode)', () => {
    const result = evaluateAdConnectivity([]);
    expect(result.flagged).toBe(true);
    expect(result.reason).toMatch(/no.*ad.*platform/i);
  });

  it('flags an account whose only ad connection has an expired token (TransAmerica failure mode)', () => {
    const result = evaluateAdConnectivity([
      { platform: 'meta', config: { token_expires_at: pastExpiry } } as any,
    ]);
    expect(result.flagged).toBe(true);
    expect(result.reason).toMatch(/expired|invalid/i);
  });

  it('does not flag an account with at least one valid, unexpired ad-platform connection', () => {
    const result = evaluateAdConnectivity([
      { platform: 'meta', config: { token_expires_at: futureExpiry } } as any,
    ]);
    expect(result.flagged).toBe(false);
  });

  it('ignores non-ad-platform connections (e.g. gmail, linkedin organic) when deciding connectivity', () => {
    const result = evaluateAdConnectivity([
      { platform: 'gmail', config: { token_expires_at: futureExpiry } } as any,
    ]);
    expect(result.flagged).toBe(true);
  });

  it('is healthy when at least one of several ad platforms is connected, even if another expired', () => {
    const result = evaluateAdConnectivity([
      { platform: 'google_ads', config: { token_expires_at: pastExpiry } } as any,
      { platform: 'meta', config: { token_expires_at: futureExpiry } } as any,
    ]);
    expect(result.flagged).toBe(false);
  });

  it('accepts an explicit evaluation time so the same inputs give the same result deterministically', () => {
    const fixedNow = 1_700_000_000_000;
    const token = { platform: 'meta', config: { token_expires_at: fixedNow + 1000 } } as any;
    expect(evaluateAdConnectivity([token], fixedNow).flagged).toBe(false);
    expect(evaluateAdConnectivity([token], fixedNow + 2000).flagged).toBe(true);
  });
});

describe('evaluateAccountHealth (composition, no false positives)', () => {
  const futureExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;

  it('flags nothing for three independently healthy seeded accounts checked together', () => {
    const result = evaluateAccountHealth({
      userId: 'user-healthy',
      pixel: { blackouts: 0, destinationAlerts: 0, destinationOk: 2 },
      budget: { configuredCapCents: 5000_00, actualSpendCents: 4800_00 },
      connectedAccounts: [{ platform: 'meta', config: { token_expires_at: futureExpiry } } as any],
    });
    expect(result.flagged).toBe(false);
    expect(result.flags).toHaveLength(0);
  });

  it('flags exactly the failing check when only the pixel check fails (RankAI reconstruction)', () => {
    const result = evaluateAccountHealth({
      userId: 'user-rankai',
      pixel: { blackouts: 0, destinationAlerts: 1, destinationOk: 0 },
      budget: { configuredCapCents: 5000_00, actualSpendCents: 4800_00 },
      connectedAccounts: [{ platform: 'meta', config: { token_expires_at: futureExpiry } } as any],
    });
    expect(result.flagged).toBe(true);
    expect(result.flags.map((f) => f.check)).toEqual(['pixel']);
    expect(result.flags[0].reason).toMatch(/destination.*no pixel/i);
  });

  it('flags exactly the failing check when only the budget check fails (Haven reconstruction)', () => {
    const result = evaluateAccountHealth({
      userId: 'user-haven',
      pixel: { blackouts: 0, destinationAlerts: 0, destinationOk: 1 },
      budget: { configuredCapCents: 10000_00, actualSpendCents: 16549_00 },
      connectedAccounts: [{ platform: 'meta', config: { token_expires_at: futureExpiry } } as any],
    });
    expect(result.flagged).toBe(true);
    expect(result.flags.map((f) => f.check)).toEqual(['budget']);
  });

  it('flags exactly the failing check when only connectivity fails (ThinkingAI/TransAmerica reconstruction)', () => {
    const result = evaluateAccountHealth({
      userId: 'user-thinkingai',
      pixel: { blackouts: 0, destinationAlerts: 0, destinationOk: 0 },
      budget: { configuredCapCents: 0, actualSpendCents: 0 },
      connectedAccounts: [],
    });
    expect(result.flagged).toBe(true);
    expect(result.flags.map((f) => f.check)).toEqual(['connectivity']);
  });

  it('flags multiple checks at once when more than one signal is bad', () => {
    const result = evaluateAccountHealth({
      userId: 'user-multi-bad',
      pixel: { blackouts: 1, destinationAlerts: 0, destinationOk: 0 },
      budget: { configuredCapCents: 1000_00, actualSpendCents: 5000_00 },
      connectedAccounts: [],
    });
    expect(result.flagged).toBe(true);
    expect(result.flags.map((f) => f.check).sort()).toEqual(['budget', 'connectivity', 'pixel']);
  });
});
