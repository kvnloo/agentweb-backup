import {
  TASTE_EXPERIMENT_SUITE_V1,
  buildBlindTastePairwise,
  createMeasuredPerformance,
  createTasteExperimentEvaluation,
  createTasteExperimentReceipt,
  scoreBlindTastePairwise,
  summarizeTastePairwise,
} from '../services/tasteExperimentHarness';

function tasteReceipt(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'taste.application-receipt.v1',
    applicationSchema: 'taste.application.v1',
    surface: 'landing_page',
    active: true,
    intensity: 'strong',
    confidence: 0.8,
    resolutionSource: 'surface_default',
    profileRevision: 'profile:v1:0123456789abcdef',
    settingsRevision: 'settings:v1:fedcba9876543210',
    dials: { designVariance: 8, motionIntensity: 4, visualDensity: 5 },
    signals: ['minimal:0.7', 'editorial:0.3'],
    generatedAt: '2026-10-01T06:00:00.000Z',
    ...overrides,
  } as any;
}

function receipt(
  arm: 'brand_only' | 'brand_taste' | 'brand_performance' | 'brand_taste_performance',
  overrides: Record<string, unknown> = {}
) {
  return createTasteExperimentReceipt({
    experimentId: 'taste-eval-1',
    caseId: 'landing-pricing-hero-v1',
    surface: 'landing_page',
    arm,
    brandRevision: 'brand:v1:abc',
    ...(arm === 'brand_taste' || arm === 'brand_taste_performance'
      ? { tasteReceipt: tasteReceipt() }
      : {}),
    ...(arm === 'brand_performance' || arm === 'brand_taste_performance'
      ? { performanceEvidenceRevision: 'perf:v1:123' }
      : {}),
    createdAt: '2026-10-01T06:00:00.000Z',
    ...overrides,
  } as any);
}

describe('Taste experiment harness', () => {
  it('enforces orthogonal experiment-arm provenance', () => {
    expect(receipt('brand_only').tasteReceipt).toBeUndefined();
    expect(receipt('brand_taste').tasteReceipt?.profileRevision)
      .toBe('profile:v1:0123456789abcdef');
    expect(receipt('brand_performance').performanceEvidenceRevision).toBe('perf:v1:123');
    expect(receipt('brand_taste_performance')).toEqual(expect.objectContaining({
      performanceEvidenceRevision: 'perf:v1:123',
      tasteReceipt: expect.objectContaining({ schema: 'taste.application-receipt.v1' }),
    }));

    expect(() => createTasteExperimentReceipt({
      experimentId: 'e',
      caseId: 'c',
      surface: 'landing_page',
      arm: 'brand_taste',
      brandRevision: 'brand:v1',
    } as any)).toThrow('Taste arm requires tasteReceipt');

    expect(() => createTasteExperimentReceipt({
      experimentId: 'e',
      caseId: 'c',
      surface: 'landing_page',
      arm: 'brand_only',
      brandRevision: 'brand:v1',
      tasteReceipt: tasteReceipt(),
    } as any)).toThrow('Non-Taste arm must not include tasteReceipt');

    expect(() => createTasteExperimentReceipt({
      experimentId: 'e',
      caseId: 'c',
      surface: 'landing_page',
      arm: 'brand_performance',
      brandRevision: 'brand:v1',
    } as any)).toThrow('Performance arm requires performanceEvidenceRevision');
  });

  it('rejects inactive or cross-surface Taste receipts', () => {
    expect(() => createTasteExperimentReceipt({
      experimentId: 'e',
      caseId: 'c',
      surface: 'landing_page',
      arm: 'brand_taste',
      brandRevision: 'brand:v1',
      tasteReceipt: tasteReceipt({ active: false, intensity: 'off' }),
    } as any)).toThrow('active Taste application');

    expect(() => createTasteExperimentReceipt({
      experimentId: 'e',
      caseId: 'c',
      surface: 'landing_page',
      arm: 'brand_taste',
      brandRevision: 'brand:v1',
      tasteReceipt: tasteReceipt({ surface: 'image' }),
    } as any)).toThrow('surface must match');
  });

  it('builds deterministic blind pairs that expose no arm or Taste revision', () => {
    const brand = {
      candidateId: 'candidate-brand',
      artifactId: 'artifact-brand',
      artifactUrl: 'https://example.test/brand',
      receipt: receipt('brand_only'),
    };
    const taste = {
      candidateId: 'candidate-taste',
      artifactId: 'artifact-taste',
      artifactUrl: 'https://example.test/taste',
      receipt: receipt('brand_taste'),
    };

    const first = buildBlindTastePairwise(brand, taste);
    const second = buildBlindTastePairwise(taste, brand);

    expect(first.packet.pairId).toBe(second.packet.pairId);
    expect(first.packet.candidates).toEqual(second.packet.candidates);

    const publicJson = JSON.stringify(first.packet);
    expect(publicJson).not.toContain('brand_taste');
    expect(publicJson).not.toContain('profile:v1');
    expect(publicJson).not.toContain('settings:v1');
    expect(first.mapping.A.receipt.arm).not.toBe(first.mapping.B.receipt.arm);
  });

  it('rejects pairwise comparisons that introduce a performance confound', () => {
    const brandOnly = {
      candidateId: 'a',
      artifactId: 'a',
      receipt: receipt('brand_only'),
    };
    const tasteWithPerformance = {
      candidateId: 'b',
      artifactId: 'b',
      receipt: receipt('brand_taste_performance'),
    };

    expect(() => buildBlindTastePairwise(brandOnly, tasteWithPerformance))
      .toThrow('differing only by Taste');
  });

  it('requires traceable measured evidence for objective performance', () => {
    const measured = createMeasuredPerformance({
      metric: 'conversion_rate',
      value: 0.12,
      unit: 'ratio',
      evidenceRevision: 'meta-report:v4:abc',
      source: 'Meta Ads Insights',
      windowStart: '2026-09-01T00:00:00.000Z',
      windowEnd: '2026-09-30T23:59:59.000Z',
    });

    expect(measured.kind).toBe('measured');
    expect(measured.evidenceRevision).toBe('meta-report:v4:abc');

    expect(() => createMeasuredPerformance({
      metric: 'conversion_rate',
      value: Number.NaN,
      evidenceRevision: 'x',
      source: 'Meta Ads Insights',
      windowStart: '2026-09-01T00:00:00.000Z',
      windowEnd: '2026-09-30T23:59:59.000Z',
    })).toThrow('finite number');

    expect(() => createMeasuredPerformance({
      metric: 'conversion_rate',
      value: 0.12,
      evidenceRevision: 'x',
      source: '',
      windowStart: '2026-09-01T00:00:00.000Z',
      windowEnd: '2026-09-30T23:59:59.000Z',
    })).toThrow('source is required');
  });

  it('keeps human quality dimensions separate from measured performance', () => {
    const evaluation = createTasteExperimentEvaluation({
      candidateId: 'candidate-1',
      rubric: {
        briefCompliance: 5,
        brandCompliance: 4,
        accessibilityPolicy: 5,
        tasteAlignment: 4,
      },
    });
    expect(evaluation.objectivePerformance).toBeUndefined();

    expect(() => createTasteExperimentEvaluation({
      candidateId: 'candidate-1',
      rubric: {
        briefCompliance: 6,
        brandCompliance: 4,
        accessibilityPolicy: 5,
        tasteAlignment: 4,
      },
    })).toThrow('briefCompliance');
  });

  it('scores blinded preference without making a significance claim', () => {
    const brand = {
      candidateId: 'candidate-brand',
      artifactId: 'artifact-brand',
      receipt: receipt('brand_only'),
    };
    const taste = {
      candidateId: 'candidate-taste',
      artifactId: 'artifact-taste',
      receipt: receipt('brand_taste'),
    };
    const bundle = buildBlindTastePairwise(brand, taste);
    const tastePresentation = bundle.mapping.A.receipt.arm === 'brand_taste' ? 'A' : 'B';
    const win = scoreBlindTastePairwise(bundle, tastePresentation);
    const tie = scoreBlindTastePairwise(bundle, 'tie');

    expect(win.tasteOutcome).toBe('win');
    expect(win.performanceContext).toBe('without_performance');
    expect(tie.tasteOutcome).toBe('tie');

    expect(summarizeTastePairwise([win, win], 3).effect).toBe('insufficient');
    const summary = summarizeTastePairwise([win, win, tie], 3);
    expect(summary.effect).toBe('observed_help');
    expect(summary.note).toContain('no statistical-significance');
  });

  it('ships a fixed multi-surface suite without embedded performance claims', () => {
    expect(TASTE_EXPERIMENT_SUITE_V1.map((item) => item.caseId)).toEqual([
      'landing-pricing-hero-v1',
      'image-product-launch-v1',
      'social-launch-v1',
      'research-executive-brief-v1',
    ]);
    expect(new Set(TASTE_EXPERIMENT_SUITE_V1.map((item) => item.caseId)).size)
      .toBe(TASTE_EXPERIMENT_SUITE_V1.length);
    expect(JSON.stringify(TASTE_EXPERIMENT_SUITE_V1).toLowerCase())
      .not.toContain('conversion rate');
  });
});
