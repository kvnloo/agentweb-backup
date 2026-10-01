import {
  clearZ0RandomizedOutcomeEvidenceCacheForTests,
  exportOutcomeAssignmentToZ0Safe,
  getZ0RandomizedOutcomeEvidence,
  projectOutcomeAssignmentToZ0,
  randomizedOutcomeEvidenceReviewReady,
  validateZ0RandomizedOutcomeEvidenceSummaryV1,
  type Z0RandomizedOutcomeEvidenceSummaryV1,
} from '../services/z0OutcomeRandomizedEvidence';
import type { Z0OutcomeFetchLike } from '../services/z0OutcomeObservation';

const assignment = {
  decisionTraceId: 'a'.repeat(64),
  subjectId: 'raw-randomized-unit',
  experimentId: 'agentweb-live-outcome-v1',
  pairId: 'pair-1',
  armId: 'candidate' as const,
  treatmentHash: 'a'.repeat(16),
  selectionPolicy: 'production' as const,
  assignmentMethod: 'randomized' as const,
  assignmentProbability: 0.5,
  assignedAt: '2026-09-01T11:59:59Z',
};

const coverage = {
  schema: 'z0int.agentweb_outcome_coverage.v1' as const,
  as_of: '2026-10-01T12:00:00+00:00',
  policy: {
    min_eligible_per_window: 4,
    min_coverage: 1,
    min_complete_coverage: 1,
  },
  expectations: 4,
  observations: 12,
  required_windows: ['1h', '24h', '7d'] as const,
  by_window: {
    '1h': {
      registered: 4, eligible: 4, observed: 4, complete: 4, partial: 0, missing: 0,
      early_or_invalid: 0, coverage: 1, complete_coverage: 1, passes: true, reasons: [],
    },
    '24h': {
      registered: 4, eligible: 4, observed: 4, complete: 4, partial: 0, missing: 0,
      early_or_invalid: 0, coverage: 1, complete_coverage: 1, passes: true, reasons: [],
    },
    '7d': {
      registered: 4, eligible: 4, observed: 4, complete: 4, partial: 0, missing: 0,
      early_or_invalid: 0, coverage: 1, complete_coverage: 1, passes: true, reasons: [],
    },
  },
  orphan_observations: 0,
  promotion_gate: {
    eligible: true,
    necessary_not_sufficient: true as const,
    causal_quality_proven: false as const,
    reasons: [],
  },
};

const effect = {
  candidate_n: 2,
  reference_n: 2,
  candidate_mean: 0.22,
  reference_mean: 0.11,
  difference_in_means: 0.11,
  standard_error: 0.02,
  ci95: [0.0708, 0.1492] as [number, number],
};

const summary: Z0RandomizedOutcomeEvidenceSummaryV1 = {
  schema: 'z0int.agentweb_randomized_outcome_evidence.v1',
  as_of: '2026-10-01T12:00:00+00:00',
  coverage: {
    ...coverage,
    required_windows: ['1h', '24h', '7d'],
  },
  policy: {
    min_total_live_units: 4,
    min_complete_units_per_arm: 2,
  },
  experiments: {
    'agentweb-live-outcome-v1': {
      registered_assignments: 4,
      valid_randomized_assignments: 4,
      assignment_probability: 0.5,
      arms: {
        candidate: { units: 2, treatment_hashes: ['a'.repeat(16)] },
        reference: { units: 2, treatment_hashes: ['b'.repeat(16)] },
      },
      metric_windows: {
        'agentweb.analytics:conversion_rate': {
          '1h': effect,
          '24h': effect,
          '7d': effect,
        },
      },
      review_ready: true,
      human_review_required: true,
      auto_promotion_allowed: false,
      causal_quality_proven: false,
      reasons: [],
    },
  },
  review_ready_any: true,
  human_review_required: true,
  auto_promotion_allowed: false,
  causal_quality_proven: false,
};

function response(payload: unknown, status = 200): Z0OutcomeFetchLike {
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })) as unknown as Z0OutcomeFetchLike;
}

describe('z0 randomized outcome evidence', () => {
  beforeEach(() => clearZ0RandomizedOutcomeEvidenceCacheForTests());

  it('projects immutable randomized assignment identity without raw unit id', () => {
    const projected = projectOutcomeAssignmentToZ0(assignment);
    expect(projected.assignment_id).toMatch(/^agentweb-outcome-assignment-[a-f0-9]{64}$/);
    expect(projected.unit_ref).toMatch(/^agentweb-subject:[a-f0-9]{24}$/);
    expect(JSON.stringify(projected)).not.toContain('raw-randomized-unit');
    expect(projected.quality_authoritative).toBe(false);

    const changed = projectOutcomeAssignmentToZ0({
      ...assignment,
      armId: 'reference',
      treatmentHash: 'b'.repeat(16),
    });
    expect(changed.assignment_id).toBe(projected.assignment_id);
  });

  it('rejects impossible assignment probability before export', () => {
    expect(() => projectOutcomeAssignmentToZ0({
      ...assignment,
      assignmentProbability: 1,
    })).toThrow(/strictly between 0 and 1/);
  });

  it('is default-off and makes no assignment call', async () => {
    const fetchImpl = jest.fn() as unknown as Z0OutcomeFetchLike;
    const result = await exportOutcomeAssignmentToZ0Safe(assignment, {
      env: {} as NodeJS.ProcessEnv,
      fetchImpl,
    });
    expect(result).toEqual({ exported: false, reason: 'disabled' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('exports assignment replay metadata', async () => {
    const projected = projectOutcomeAssignmentToZ0(assignment);
    const fetchImpl = response({
      ok: true,
      assignment_id: projected.assignment_id,
      replayed: true,
    });
    const result = await exportOutcomeAssignmentToZ0Safe(assignment, {
      env: {
        Z0INT_AGENTWEB_OUTCOME_ASSIGNMENT: 'shadow',
        Z0INT_SERVICE_URL: 'http://z0.test/',
      } as NodeJS.ProcessEnv,
      fetchImpl,
    });
    expect(result).toEqual({
      exported: true,
      reason: 'replayed',
      assignment_id: projected.assignment_id,
      replayed: true,
    });
    expect((fetchImpl as unknown as jest.Mock).mock.calls[0][0])
      .toBe('http://z0.test/v1/observe/outcome/assignment');
  });

  it('validates review-only randomized evidence', () => {
    expect(validateZ0RandomizedOutcomeEvidenceSummaryV1(summary)).toEqual([]);
    expect(randomizedOutcomeEvidenceReviewReady(
      summary,
      'agentweb-live-outcome-v1',
    )).toBe(true);
  });

  it('consumer refuses review if server overclaims auto-promotion or arm sample', () => {
    expect(randomizedOutcomeEvidenceReviewReady({
      ...summary,
      auto_promotion_allowed: true as never,
    }, 'agentweb-live-outcome-v1')).toBe(false);

    expect(randomizedOutcomeEvidenceReviewReady({
      ...summary,
      experiments: {
        ...summary.experiments,
        'agentweb-live-outcome-v1': {
          ...summary.experiments['agentweb-live-outcome-v1'],
          arms: {
            ...summary.experiments['agentweb-live-outcome-v1'].arms,
            candidate: {
              ...summary.experiments['agentweb-live-outcome-v1'].arms.candidate,
              units: 1,
            },
          },
        },
      },
    }, 'agentweb-live-outcome-v1')).toBe(false);
  });

  it('rejects a summary that claims causal quality is already proven', () => {
    expect(validateZ0RandomizedOutcomeEvidenceSummaryV1({
      ...summary,
      causal_quality_proven: true,
    })).toContain('summary cannot claim causal quality proven');
  });

  it('caches review evidence instead of polling per decision', async () => {
    let now = 1000;
    const fetchImpl = response(summary) as unknown as jest.Mock;
    const first = await getZ0RandomizedOutcomeEvidence({
      baseUrl: 'http://z0.test/',
      fetchImpl: fetchImpl as unknown as Z0OutcomeFetchLike,
      cacheTtlMs: 60_000,
      now: () => now,
    });
    now += 5000;
    const second = await getZ0RandomizedOutcomeEvidence({
      baseUrl: 'http://z0.test',
      fetchImpl: fetchImpl as unknown as Z0OutcomeFetchLike,
      cacheTtlMs: 60_000,
      now: () => now,
    });
    expect(first).toEqual(summary);
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0])
      .toBe('http://z0.test/v1/observe/outcome/randomized-evidence');
  });
});
