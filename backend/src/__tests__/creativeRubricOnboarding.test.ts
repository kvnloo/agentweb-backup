/**
 * ENG-2192: rubric verdicts for onboarding creatives, stored on the AW-Users variants they judge.
 * The LLM and the store are stubs; images are rendered with sharp in-process.
 */
import sharp from 'sharp';
import type { AdCopyVariant } from '../services/adCopyStatusService';
import type { AdImageVariant } from '../services/adImageStatusService';
import { evaluateCreativeGates, type CreativeGateResult } from '../services/creativeGates';
import {
  RUBRIC_CRITERIA,
  SURFACE_CRITERIA,
  type RubricJudgeLlm,
  type RubricJudgeLlmRequest,
  type RubricSurface,
} from '../services/creativeRubricJudge';
import {
  judgeOnboardingAdCopy,
  judgeOnboardingAdImages,
  type OnboardingRubricDeps,
} from '../services/creativeRubricOnboarding';

const ON = { CREATIVE_RUBRIC_JUDGE_ENABLED: 'true', CREATIVE_RUBRIC_JUDGE_SAMPLE_RATE: '1' };
const RUN_AT = '2026-09-28T10:00:00.000Z';
const PREVIOUS_RUN_AT = '2026-09-20T10:00:00.000Z';

function gates(passed = true): CreativeGateResult {
  return evaluateCreativeGates(
    { bytes: 1000, decoded: true, width: 1080, height: 1080, format: 'png', luminanceStdDev: passed ? 40 : 0 },
    { requestedSize: '1080x1080', placement: 'meta_feed_square' },
  );
}

function verdict(surface: RubricSurface): string {
  const out: Record<string, { rationale: string; verdict: string }> = {};
  for (const id of SURFACE_CRITERIA[surface]) out[id] = { rationale: `why ${id}`, verdict: 'pass' };
  return JSON.stringify(out);
}

function pairwise(): string {
  const out: Record<string, { rationale: string; preference: string }> = {};
  for (const id of RUBRIC_CRITERIA) out[id] = { rationale: `why ${id}`, preference: 'tie' };
  out.overall = { rationale: 'overall', preference: '2' };
  return JSON.stringify(out);
}

async function dataUri(background: string): Promise<string> {
  const bytes = await sharp({ create: { width: 40, height: 40, channels: 3, background } }).png().toBuffer();
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

let imageUrl: string;
let previousImageUrl: string;
beforeAll(async () => {
  imageUrl = await dataUri('#3366cc');
  previousImageUrl = await dataUri('#cc6633');
});

function image(id: string, overrides: Partial<AdImageVariant> = {}): AdImageVariant {
  return { id, imageUrl, prompt: `prompt ${id}`, gates: gates(), ...overrides };
}

function copy(id: string): AdCopyVariant {
  return { id, headline: `Headline ${id}`, primaryText: `Primary ${id}`, cta: 'Learn More', variety: 'PA' };
}

function harness(env: Record<string, string> = ON) {
  const calls: RubricJudgeLlmRequest[] = [];
  const llm: RubricJudgeLlm = {
    complete: jest.fn(async (request: RubricJudgeLlmRequest) => {
      calls.push(request);
      if (request.system.includes('comparing TWO')) return { text: pairwise() };
      if (request.system.includes('ONE piece of generated ad copy')) return { text: verdict('ad_copy') };
      return { text: verdict('ad_image') };
    }),
  };
  const deps: OnboardingRubricDeps = {
    env,
    random: () => 0,
    llm,
    loadBrandData: jest.fn(async () => ({ brandName: 'Acme' })),
    saveImageVariants: jest.fn(async () => undefined),
    saveCopyVariants: jest.fn(async () => undefined),
  };
  return { deps, calls };
}

const textOf = (request: RubricJudgeLlmRequest): string =>
  request.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');

describe('judgeOnboardingAdImages', () => {
  it('does nothing when the flag is off: no brand read, no LLM call, no write', async () => {
    const h = harness({});
    await expect(judgeOnboardingAdImages({ userId: 'u1', completedAt: RUN_AT, variants: [image('variant-1')] }, h.deps)).resolves.toBeNull();
    expect(h.calls).toHaveLength(0);
    expect(h.deps.loadBrandData).not.toHaveBeenCalled();
    expect(h.deps.saveImageVariants).not.toHaveBeenCalled();
  });

  it('stores a verdict on each real variant, conditional on the run it judged, and skips placeholders', async () => {
    const h = harness();
    const variants = [image('variant-1'), image('variant-2', { imageUrl: 'placeholder://ad-image-failed#2' }), image('variant-3', { gates: gates(false) })];

    const stored = await judgeOnboardingAdImages({ userId: 'u1', completedAt: RUN_AT, variants }, h.deps);

    expect(h.calls).toHaveLength(1);
    expect(stored?.[0].creativeRubric).toMatchObject({ status: 'ok', passedCount: 7 });
    expect(stored?.[1]).toEqual(variants[1]);
    expect(stored?.[2].creativeRubric).toMatchObject({ status: 'skipped', reason: expect.stringContaining('gates failed') });
    expect(h.deps.saveImageVariants).toHaveBeenCalledWith('u1', RUN_AT, stored);
  });

  it('compares each judged variant with the previous run\'s best one of the same placement', async () => {
    const h = harness();
    const previous = { completedAt: PREVIOUS_RUN_AT, variants: [image('variant-1', { imageUrl: previousImageUrl })] };

    const stored = await judgeOnboardingAdImages({ userId: 'u1', completedAt: RUN_AT, variants: [image('variant-1')], previous }, h.deps);

    expect(h.calls).toHaveLength(2);
    expect(stored?.[0].creativePairwise).toMatchObject({
      mode: 'pairwise',
      status: 'ok',
      preference: expect.stringMatching(/^[AB]$/),
      priorId: 'previous-run:variant-1',
      priorArtifactUrl: previousImageUrl,
    });
  });

  it('makes no pairwise call without a previous run', async () => {
    const h = harness();
    const stored = await judgeOnboardingAdImages({ userId: 'u1', completedAt: RUN_AT, variants: [image('variant-1')], previous: { variants: [] } }, h.deps);

    expect(h.calls).toHaveLength(1);
    expect(stored?.[0]).not.toHaveProperty('creativePairwise');
  });

  it('drops the verdicts, without throwing, when the run was regenerated while it was judged', async () => {
    const h = harness();
    h.deps.saveImageVariants = jest.fn(async () => {
      throw Object.assign(new Error('conditional'), { code: 'ConditionalCheckFailedException' });
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(judgeOnboardingAdImages({ userId: 'u1', completedAt: RUN_AT, variants: [image('variant-1')] }, h.deps)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('regenerated while it was being judged'));
    warn.mockRestore();
  });
});

describe('judgeOnboardingAdCopy', () => {
  it('judges the copy as the full ad with its image, and the copy alone when the image failed', async () => {
    const h = harness();
    const stored = await judgeOnboardingAdCopy(
      {
        userId: 'u1',
        completedAt: RUN_AT,
        copyVariants: [copy('variant-1'), copy('variant-2')],
        imageVariants: [image('variant-1'), image('variant-2', { imageUrl: 'placeholder://ad-image-failed#2' })],
      },
      h.deps,
    );

    expect(h.calls).toHaveLength(2);
    const hasImage = (c: RubricJudgeLlmRequest) => c.content.some((p) => p.type === 'image_url');
    const withImage = h.calls.find(hasImage);
    const alone = h.calls.find((c) => !hasImage(c));
    expect(withImage && textOf(withImage)).toContain('"headline": "Headline variant-1"');
    expect(alone && textOf(alone)).toContain('"headline": "Headline variant-2"');
    expect(stored?.[0].creativeRubric).toMatchObject({ status: 'ok', passedCount: 7 });
    expect(stored?.[1].creativeRubric).toMatchObject({ status: 'ok', surface: 'ad_copy' });
    expect(h.deps.saveCopyVariants).toHaveBeenCalledWith('u1', RUN_AT, stored);
  });

  it('does nothing when the flag is off', async () => {
    const h = harness({});
    await expect(
      judgeOnboardingAdCopy({ userId: 'u1', completedAt: RUN_AT, copyVariants: [copy('variant-1')], imageVariants: [] }, h.deps),
    ).resolves.toBeNull();
    expect(h.calls).toHaveLength(0);
    expect(h.deps.saveCopyVariants).not.toHaveBeenCalled();
  });
});
