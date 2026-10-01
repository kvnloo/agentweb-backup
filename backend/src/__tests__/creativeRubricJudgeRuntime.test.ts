/**
 * ENG-2140 (ENG-2128 T8): the runtime hook that judges sampled ad creatives and stores the result
 * on their human-eval candidate. Off by default; never throws.
 */
import sharp from 'sharp';
import { evaluateCreativeGates, type CreativeGateResult } from '../services/creativeGates';
import {
  RUBRIC_CRITERIA,
  SURFACE_CRITERIA,
  type CreativeRubricResult,
  type RubricSurface,
  type StoredCreativePairwise,
  type RubricJudgeLlm,
  type RubricJudgeLlmRequest,
} from '../services/creativeRubricJudge';
import {
  judgeHumanEvalCandidate,
  placementFromGates,
  readRubricJudgeConfig,
  selectPriorBest,
  shouldSampleCreativeRubricJudge,
  type CandidateRubricDeps,
  type CandidateRubricInput,
  type PriorCandidateLike,
} from '../services/creativeRubricJudgeRuntime';
import { HumanEvalService } from '../services/humanEvalService';

const ON = { CREATIVE_RUBRIC_JUDGE_ENABLED: 'true', CREATIVE_RUBRIC_JUDGE_SAMPLE_RATE: '1' };

function passingGates(): CreativeGateResult {
  return evaluateCreativeGates(
    { bytes: 1000, decoded: true, width: 1080, height: 1350, format: 'png', luminanceStdDev: 40 },
    { requestedSize: '1080x1350' },
  );
}

function verdictJson(surface: RubricSurface = 'ad_image'): string {
  const out: Record<string, { rationale: string; verdict: string }> = {};
  for (const id of SURFACE_CRITERIA[surface]) out[id] = { rationale: `why ${id}`, verdict: 'pass' };
  return JSON.stringify(out);
}

function pairwiseJson(): string {
  const out: Record<string, { rationale: string; preference: string }> = {};
  for (const id of RUBRIC_CRITERIA) out[id] = { rationale: `why ${id}`, preference: '1' };
  out.overall = { rationale: 'overall', preference: '1' };
  return JSON.stringify(out);
}

function harness(llmBehaviour: string | Error = verdictJson()) {
  const calls: RubricJudgeLlmRequest[] = [];
  const stored: Array<{ candidateId: string; result: CreativeRubricResult }> = [];
  const llm: RubricJudgeLlm = {
    complete: jest.fn(async (request: RubricJudgeLlmRequest) => {
      calls.push(request);
      if (llmBehaviour instanceof Error) throw llmBehaviour;
      return { text: llmBehaviour };
    }),
  };
  const loadBrandData = jest.fn(async () => ({ brandName: 'Acme', primaryColor: '#123456' }));
  const deps: CandidateRubricDeps = {
    env: ON,
    random: () => 0,
    llm,
    loadBrandData,
    store: jest.fn(async (candidateId: string, result: CreativeRubricResult) => {
      stored.push({ candidateId, result });
    }),
  };
  return { deps, calls, stored, loadBrandData };
}

let imageDataUri: string;
beforeAll(async () => {
  const bytes = await sharp({ create: { width: 40, height: 50, channels: 3, background: '#3366cc' } }).png().toBuffer();
  imageDataUri = `data:image/png;base64,${bytes.toString('base64')}`;
});

function input(overrides: Partial<CandidateRubricInput> = {}): CandidateRubricInput {
  return {
    candidateId: 'cand-1',
    userId: 'user-1',
    category: 'ad',
    artifactUrl: imageDataUri,
    creativeGates: passingGates(),
    brief: { generationRequest: 'A 4:5 ad for Acme demos' },
    ...overrides,
  };
}

describe('config and sampling', () => {
  it('is off by default: no flag means disabled with sample rate 0 and the Sonnet default', () => {
    expect(readRubricJudgeConfig({})).toEqual({ enabled: false, sampleRate: 0, model: 'anthropic.claude-sonnet-5' });
  });

  it('reads the flag, clamps the rate and takes a model override', () => {
    expect(
      readRubricJudgeConfig({ ...ON, CREATIVE_RUBRIC_JUDGE_SAMPLE_RATE: '7', CREATIVE_RUBRIC_JUDGE_MODEL: ' anthropic.claude-opus-5 ' }),
    ).toEqual({ enabled: true, sampleRate: 1, model: 'anthropic.claude-opus-5' });
    expect(readRubricJudgeConfig({ ...ON, CREATIVE_RUBRIC_JUDGE_SAMPLE_RATE: 'lots' }).sampleRate).toBe(0);
    expect(readRubricJudgeConfig({ CREATIVE_RUBRIC_JUDGE_ENABLED: 'TRUE' }).enabled).toBe(false);
  });

  it('samples below the rate only', () => {
    const config = { enabled: true, sampleRate: 0.1, model: 'm' };
    expect(shouldSampleCreativeRubricJudge(config, () => 0.05)).toBe(true);
    expect(shouldSampleCreativeRubricJudge(config, () => 0.1)).toBe(false);
    expect(shouldSampleCreativeRubricJudge({ ...config, enabled: false }, () => 0)).toBe(false);
    expect(shouldSampleCreativeRubricJudge({ ...config, sampleRate: 0 }, () => 0)).toBe(false);
  });
});

describe('judgeHumanEvalCandidate', () => {
  it('does nothing when the flag is off: no brand read, no LLM call, nothing stored', async () => {
    const h = harness();
    await expect(judgeHumanEvalCandidate(input(), { ...h.deps, env: {} })).resolves.toBeNull();
    await expect(
      judgeHumanEvalCandidate(input(), { ...h.deps, env: { CREATIVE_RUBRIC_JUDGE_ENABLED: 'true' } }),
    ).resolves.toBeNull();
    expect(h.calls).toHaveLength(0);
    expect(h.loadBrandData).not.toHaveBeenCalled();
    expect(h.deps.store).not.toHaveBeenCalled();
  });

  it('does nothing for an unsampled creative', async () => {
    const h = harness();
    const deps = { ...h.deps, env: { ...ON, CREATIVE_RUBRIC_JUDGE_SAMPLE_RATE: '0.25' }, random: () => 0.5 };
    await expect(judgeHumanEvalCandidate(input(), deps)).resolves.toBeNull();
    expect(h.calls).toHaveLength(0);
    expect(h.deps.store).not.toHaveBeenCalled();
  });

  it('judges an organic post image on the image criteria that apply to it (ENG-2192)', async () => {
    const h = harness(verdictJson('organic_image'));
    const result = await judgeHumanEvalCandidate(input({ category: 'organic_post' }), h.deps);

    expect(result).toMatchObject({ status: 'ok', surface: 'organic_image', passedCount: 5, criteriaCount: 5, passed: true });
    expect(h.calls[0].system).toContain('organic (unpaid) post');
    expect(h.calls[0].system).not.toContain('offer_specificity');
    expect(h.stored).toHaveLength(1);
  });

  it('judges an uncategorized image as a non-ad image, not on the ad floor (ENG-2192)', async () => {
    const h = harness(verdictJson('organic_image'));
    await expect(judgeHumanEvalCandidate(input({ category: undefined }), h.deps)).resolves.toMatchObject({ surface: 'organic_image' });
  });

  it('judges a sampled ad with the account brand and placement, and stores the result on the candidate', async () => {
    const h = harness();
    const result = await judgeHumanEvalCandidate(input(), h.deps);

    expect(result).toMatchObject({ status: 'ok', passedCount: 7, passed: true, advisory: true });
    expect(h.loadBrandData).toHaveBeenCalledWith('user-1');
    expect(h.stored).toEqual([{ candidateId: 'cand-1', result }]);
    const text = h.calls[0].content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
    expect(text).toContain('"brandName": "Acme"');
    expect(text).toContain('Meta Feed — portrait 4:5 (1080x1350)');
    expect(text).toContain('A 4:5 ad for Acme demos');
  });

  it('records a skip, without an LLM call, when the gates failed or did not run', async () => {
    const h = harness();
    const failed = evaluateCreativeGates({ bytes: 1000, decoded: false, decodeError: 'bad' }, {});
    const skippedFailed = await judgeHumanEvalCandidate(input({ creativeGates: failed }), h.deps);
    const skippedMissing = await judgeHumanEvalCandidate(input({ creativeGates: undefined }), h.deps);

    expect(skippedFailed).toMatchObject({ status: 'skipped', reason: expect.stringContaining('gates failed') });
    expect(skippedMissing).toMatchObject({ status: 'skipped', reason: expect.stringContaining('no deterministic gate result') });
    expect(h.calls).toHaveLength(0);
    expect(h.stored.map((s) => s.result.status)).toEqual(['skipped', 'skipped']);
  });

  it('stores an explicit error when the judge fails, and does not throw', async () => {
    const h = harness(new Error('upstream 503'));
    const result = await judgeHumanEvalCandidate(input(), h.deps);
    expect(result).toMatchObject({ status: 'error', error: { kind: 'llm_error' } });
    expect(h.stored).toHaveLength(1);
    expect(h.stored[0].result).not.toHaveProperty('passed');
  });

  it('swallows a storage or brand-read failure', async () => {
    const h = harness();
    const storeFails = { ...h.deps, store: jest.fn(async () => { throw new Error('ConditionalCheckFailed'); }) };
    await expect(judgeHumanEvalCandidate(input(), storeFails)).resolves.toBeNull();
    const brandFails = { ...h.deps, loadBrandData: jest.fn(async () => { throw new Error('dynamo down'); }) };
    await expect(judgeHumanEvalCandidate(input(), brandFails)).resolves.toBeNull();
  });
});

describe('placementFromGates', () => {
  it('labels a known placement, falls back to the requested size, ignores auto', () => {
    expect(placementFromGates(passingGates())).toBe('Meta Feed — portrait 4:5 (1080x1350)');
    const ratio = evaluateCreativeGates({ bytes: 1, decoded: true, width: 800, height: 450, luminanceStdDev: 40 }, { requestedSize: '16:9' });
    expect(placementFromGates(ratio)).toBe('requested size 16:9');
    const auto = evaluateCreativeGates({ bytes: 1, decoded: true, width: 800, height: 450, luminanceStdDev: 40 }, { requestedSize: 'auto' });
    expect(placementFromGates(auto)).toBeUndefined();
  });
});

describe('selectPriorBest', () => {
  const gates = passingGates();
  const ok = (passedCount: number): CreativeRubricResult => ({
    graderId: 'creative-rubric-judge',
    version: 'v',
    promptVersion: 'p',
    advisory: true,
    model: 'm',
    evaluatedAt: '2026-09-01T00:00:00.000Z',
    mode: 'single',
    status: 'ok',
    criteria: {} as never,
    passedCount,
    passed: passedCount === 7,
  });
  const cand = (id: string, createdAt: string, extra: Partial<PriorCandidateLike> = {}): PriorCandidateLike => ({
    candidateId: id,
    userId: 'user-1',
    reviewType: 'creative_image',
    artifactUrl: `https://x/${id}.png`,
    createdAt,
    creativeGates: gates,
    ...extra,
  });
  const target = cand('target', '2026-09-20T00:00:00.000Z');

  it('prefers the highest rubric pass count, then the most recent, for the same user and placement', () => {
    const pool = [
      cand('old-best', '2026-09-01T00:00:00.000Z', { creativeRubric: ok(6) }),
      cand('recent-weaker', '2026-09-10T00:00:00.000Z', { creativeRubric: ok(4) }),
      cand('recent-unjudged', '2026-09-15T00:00:00.000Z'),
      cand('other-user', '2026-09-16T00:00:00.000Z', { userId: 'user-2', creativeRubric: ok(7) }),
      cand('later', '2026-09-21T00:00:00.000Z', { creativeRubric: ok(7) }),
      cand('square', '2026-09-17T00:00:00.000Z', {
        creativeRubric: ok(7),
        creativeGates: evaluateCreativeGates({ bytes: 1, decoded: true, width: 1080, height: 1080, luminanceStdDev: 40 }, { requestedSize: '1080x1080' }),
      }),
      target,
    ];
    expect(selectPriorBest(target, pool)?.candidateId).toBe('old-best');
    expect(selectPriorBest(target, pool.filter((c) => c.creativeRubric === undefined))?.candidateId).toBe('recent-unjudged');
  });

  it('returns null without a placement or a prior', () => {
    expect(selectPriorBest(cand('t', '2026-09-20T00:00:00.000Z', { creativeGates: undefined }), [cand('a', '2026-09-01T00:00:00.000Z')])).toBeNull();
    expect(selectPriorBest(target, [target])).toBeNull();
  });
});

describe('HumanEvalService.setCreativeRubric', () => {
  it('writes creativeRubric onto an existing candidate only', async () => {
    const update = jest.fn((params: unknown) => ({ promise: async () => params }));
    const db = { put: jest.fn(), get: jest.fn(), scan: jest.fn(), update };
    const service = new HumanEvalService(db as unknown as ConstructorParameters<typeof HumanEvalService>[0]);
    const h = harness();
    const result = await judgeHumanEvalCandidate(input(), { ...h.deps, store: (id, r) => service.setCreativeRubric(id, r) });

    expect(update).toHaveBeenCalledWith({
      TableName: expect.stringMatching(/AW-HumanEvalQueue$/),
      Key: { candidateId: 'cand-1' },
      UpdateExpression: 'SET creativeRubric = :rubric',
      ConditionExpression: 'attribute_exists(candidateId)',
      ExpressionAttributeValues: { ':rubric': result },
    });
  });
});

describe('landing pages (ENG-2192)', () => {
  const lpInput = (overrides: Partial<CandidateRubricInput> = {}): CandidateRubricInput => ({
    candidateId: 'lp-1',
    userId: 'user-1',
    reviewType: 'landing_page',
    artifactUrl: 'https://acme.example.com',
    brief: { generationRequest: 'Demo-booking page for Acme' },
    ...overrides,
  });

  it('judges the deployed page from the source the deploy holds, and stores it on the candidate', async () => {
    const h = harness(verdictJson('landing_page'));
    const loadLandingPageSource = jest.fn(async () => '// file: app/page.tsx\nexport default function Page() { return <h1>Close 40% faster</h1>; }');

    const result = await judgeHumanEvalCandidate(lpInput({ loadLandingPageSource }), h.deps);

    expect(result).toMatchObject({ status: 'ok', surface: 'landing_page', criteriaCount: SURFACE_CRITERIA.landing_page.length });
    const text = h.calls[0].content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
    expect(text).toContain('Close 40% faster');
    expect(text).toContain('live at https://acme.example.com');
    expect(h.calls[0].content.some((p) => p.type === 'image_url')).toBe(false);
    expect(h.stored[0]).toMatchObject({ candidateId: 'lp-1', result: { surface: 'landing_page' } });
  });

  it('never reads the source of an unsampled page', async () => {
    const h = harness();
    const loadLandingPageSource = jest.fn(async () => 'source');
    const deps = { ...h.deps, env: { ...ON, CREATIVE_RUBRIC_JUDGE_SAMPLE_RATE: '0.25' }, random: () => 0.5 };

    await expect(judgeHumanEvalCandidate(lpInput({ loadLandingPageSource }), deps)).resolves.toBeNull();
    expect(loadLandingPageSource).not.toHaveBeenCalled();
  });

  it('records a skip, without an LLM call, when no source is available', async () => {
    const h = harness();
    const result = await judgeHumanEvalCandidate(lpInput(), h.deps);

    expect(result).toMatchObject({ status: 'skipped', surface: 'landing_page' });
    expect(h.calls).toHaveLength(0);
  });
});

describe('runtime pairwise vs prior best (ENG-2192)', () => {
  function pairwiseHarness(pool: PriorCandidateLike[]) {
    const h = harness();
    const pairwise: Array<{ candidateId: string; result: StoredCreativePairwise }> = [];
    const llm: RubricJudgeLlm = {
      complete: jest.fn(async (request: RubricJudgeLlmRequest) => {
        h.calls.push(request);
        return { text: request.system.includes('comparing TWO') ? pairwiseJson() : verdictJson() };
      }),
    };
    const deps: CandidateRubricDeps = {
      ...h.deps,
      llm,
      loadPriorCandidates: jest.fn(async () => pool),
      storePairwise: jest.fn(async (candidateId: string, result: StoredCreativePairwise) => {
        pairwise.push({ candidateId, result });
      }),
    };
    return { ...h, deps, pairwise };
  }

  const prior = (id: string, overrides: Partial<PriorCandidateLike> = {}): PriorCandidateLike => ({
    candidateId: id,
    userId: 'user-1',
    reviewType: 'creative_image',
    category: 'ad',
    artifactUrl: imageDataUri,
    createdAt: '2026-09-01T00:00:00.000Z',
    creativeGates: passingGates(),
    ...overrides,
  });

  it('compares a judged ad with the prior best ad of the same placement and stores the verdict', async () => {
    const h = pairwiseHarness([prior('old-ad'), prior('old-organic', { category: 'organic_post', createdAt: '2026-09-10T00:00:00.000Z' })]);

    await judgeHumanEvalCandidate(input({ createdAt: '2026-09-20T00:00:00.000Z' }), h.deps);

    expect(h.calls).toHaveLength(2);
    expect(h.pairwise).toEqual([
      { candidateId: 'cand-1', result: expect.objectContaining({ mode: 'pairwise', status: 'ok', priorId: 'old-ad', priorArtifactUrl: imageDataUri }) },
    ]);
    expect(h.deps.loadPriorCandidates).toHaveBeenCalledWith('user-1');
  });

  it('makes no pairwise call when there is no prior best, and none for organic images', async () => {
    const none = pairwiseHarness([prior('later', { createdAt: '2026-09-30T00:00:00.000Z' })]);
    await judgeHumanEvalCandidate(input({ createdAt: '2026-09-20T00:00:00.000Z' }), none.deps);
    expect(none.calls).toHaveLength(1);
    expect(none.pairwise).toHaveLength(0);

    const organic = pairwiseHarness([prior('old-organic', { category: 'organic_post' })]);
    organic.deps.llm = { complete: jest.fn(async () => ({ text: verdictJson('organic_image') })) };
    await judgeHumanEvalCandidate(input({ category: 'organic_post', createdAt: '2026-09-20T00:00:00.000Z' }), organic.deps);
    expect(organic.deps.loadPriorCandidates).not.toHaveBeenCalled();
    expect(organic.pairwise).toHaveLength(0);
  });

  it('keeps the single verdict when the pairwise step fails', async () => {
    const h = pairwiseHarness([prior('old-ad')]);
    h.deps.loadPriorCandidates = jest.fn(async () => {
      throw new Error('scan failed');
    });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(judgeHumanEvalCandidate(input({ createdAt: '2026-09-20T00:00:00.000Z' }), h.deps)).resolves.toMatchObject({ status: 'ok' });
    expect(h.stored).toHaveLength(1);
    expect(h.pairwise).toHaveLength(0);
  });
});

describe('HumanEvalService.setCreativePairwise (ENG-2192)', () => {
  it('writes creativePairwise onto an existing candidate only', async () => {
    const update = jest.fn((params: unknown) => ({ promise: async () => params }));
    const db = { put: jest.fn(), get: jest.fn(), scan: jest.fn(), update };
    const service = new HumanEvalService(db as unknown as ConstructorParameters<typeof HumanEvalService>[0]);
    const result = { mode: 'pairwise', status: 'error', priorId: 'old' } as unknown as StoredCreativePairwise;

    await service.setCreativePairwise('cand-1', result);

    expect(update).toHaveBeenCalledWith({
      TableName: expect.stringMatching(/AW-HumanEvalQueue$/),
      Key: { candidateId: 'cand-1' },
      UpdateExpression: 'SET creativePairwise = :pairwise',
      ConditionExpression: 'attribute_exists(candidateId)',
      ExpressionAttributeValues: { ':pairwise': result },
    });
  });
});
