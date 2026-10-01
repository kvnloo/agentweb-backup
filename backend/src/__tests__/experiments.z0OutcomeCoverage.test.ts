import {
  clearZ0OutcomeCoverageCacheForTests,
  exportOutcomeExpectationToZ0Safe,
  getZ0OutcomeCoverage,
  outcomeDataPromotionEligible,
  projectOutcomeExpectationToZ0,
  validateZ0OutcomeCoverageSummaryV1,
} from '../services/z0OutcomeCoverage';
import type { Z0OutcomeFetchLike } from '../services/z0OutcomeObservation';

const input = {
  decisionTraceId: 'a'.repeat(64),
  decisionTime: '2026-09-01T12:00:00Z',
  executionTime: '2026-09-01T12:00:05Z',
  requiredWindows: ['7d', '1h', '24h'] as const,
  subjectId: 'raw-customer-coverage',
  metric: {
    source: 'agentweb.analytics',
    name: 'conversion_rate',
    unit: 'ratio',
    direction: 'higher_better' as const,
  },
};

const summary = {
  schema: 'z0int.agentweb_outcome_coverage.v1',
  as_of: '2026-10-01T12:00:00+00:00',
  policy: {
    min_eligible_per_window: 20,
    min_coverage: 0.9,
    min_complete_coverage: 0.85,
  },
  expectations: 20,
  observations: 60,
  required_windows: ['1h', '24h', '7d'],
  by_window: {
    '1h': {
      registered: 20, eligible: 20, observed: 20, complete: 20, partial: 0, missing: 0,
      early_or_invalid: 0, coverage: 1, complete_coverage: 1, passes: true, reasons: [],
    },
    '24h': {
      registered: 20, eligible: 20, observed: 20, complete: 20, partial: 0, missing: 0,
      early_or_invalid: 0, coverage: 1, complete_coverage: 1, passes: true, reasons: [],
    },
    '7d': {
      registered: 20, eligible: 20, observed: 20, complete: 20, partial: 0, missing: 0,
      early_or_invalid: 0, coverage: 1, complete_coverage: 1, passes: true, reasons: [],
    },
  },
  orphan_observations: 0,
  promotion_gate: {
    eligible: true,
    necessary_not_sufficient: true,
    causal_quality_proven: false,
    reasons: [],
  },
} as const;

function response(payload: unknown, status = 200): Z0OutcomeFetchLike {
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })) as unknown as Z0OutcomeFetchLike;
}

describe('z0 outcome expectation and coverage gate', () => {
  beforeEach(() => clearZ0OutcomeCoverageCacheForTests());

  it('projects a deterministic privacy-minimized expectation', () => {
    const projected = projectOutcomeExpectationToZ0(input);
    expect(projected.required_windows).toEqual(['1h', '24h', '7d']);
    expect(projected.expectation_id).toMatch(/^agentweb-outcome-expectation-[a-f0-9]{64}$/);
    expect(projected.subject_ref).toMatch(/^agentweb-subject:[a-f0-9]{24}$/);
    expect(JSON.stringify(projected)).not.toContain('raw-customer-coverage');
    expect(projected.quality_authoritative).toBe(false);
  });

  it('keeps the same immutable slot identity when required windows change', () => {
    const first = projectOutcomeExpectationToZ0(input);
    const changed = projectOutcomeExpectationToZ0({
      ...input,
      requiredWindows: ['1h', '24h'],
    });
    expect(changed.expectation_id).toBe(first.expectation_id);
    expect(changed.required_windows).not.toEqual(first.required_windows);
  });

  it('is default-off and makes no expectation transport call', async () => {
    const fetchImpl = jest.fn() as unknown as Z0OutcomeFetchLike;
    const result = await exportOutcomeExpectationToZ0Safe(input, {
      env: {} as NodeJS.ProcessEnv,
      fetchImpl,
    });
    expect(result).toEqual({ exported: false, reason: 'disabled' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('exports expectation replay metadata', async () => {
    const projected = projectOutcomeExpectationToZ0(input);
    const fetchImpl = response({
      ok: true,
      expectation_id: projected.expectation_id,
      replayed: true,
    });
    const result = await exportOutcomeExpectationToZ0Safe(input, {
      env: {
        Z0INT_AGENTWEB_OUTCOME_EXPECT: 'shadow',
        Z0INT_SERVICE_URL: 'http://z0.test/',
      } as NodeJS.ProcessEnv,
      fetchImpl,
    });
    expect(result).toEqual({
      exported: true,
      reason: 'replayed',
      expectation_id: projected.expectation_id,
      replayed: true,
    });
    expect((fetchImpl as unknown as jest.Mock).mock.calls[0][0])
      .toBe('http://z0.test/v1/observe/outcome/expectation');
  });

  it('validates the conservative gate contract', () => {
    expect(validateZ0OutcomeCoverageSummaryV1(summary)).toEqual([]);
    expect(outcomeDataPromotionEligible(summary)).toBe(true);
    expect(outcomeDataPromotionEligible({
      ...summary,
      promotion_gate: { ...summary.promotion_gate, eligible: false },
    })).toBe(false);
  });

  it('rejects a coverage response that claims causal proof', () => {
    expect(validateZ0OutcomeCoverageSummaryV1({
      ...summary,
      promotion_gate: {
        ...summary.promotion_gate,
        causal_quality_proven: true,
      },
    })).toContain('coverage gate cannot claim causal quality');
  });

  it('caches coverage reads instead of polling per turn', async () => {
    let now = 1000;
    const fetchImpl = response(summary) as unknown as jest.Mock;
    const first = await getZ0OutcomeCoverage({
      baseUrl: 'http://z0.test/',
      fetchImpl: fetchImpl as unknown as Z0OutcomeFetchLike,
      cacheTtlMs: 60_000,
      now: () => now,
    });
    now += 5000;
    const second = await getZ0OutcomeCoverage({
      baseUrl: 'http://z0.test',
      fetchImpl: fetchImpl as unknown as Z0OutcomeFetchLike,
      cacheTtlMs: 60_000,
      now: () => now,
    });
    expect(first).toEqual(summary);
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0])
      .toBe('http://z0.test/v1/observe/outcome/coverage');
  });
});
