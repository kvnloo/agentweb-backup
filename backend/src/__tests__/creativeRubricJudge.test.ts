/**
 * ENG-2140 (ENG-2128 T8): creative rubric judge — ENG-421's 7 criteria as binary checks, and the
 * pairwise mode. The LLM is a stub; images are rendered with sharp in-process.
 */
import sharp from 'sharp';
import { pairwiseWinRate } from '../loops/eval/agreement';
import {
  CREATIVE_RUBRIC_GRADER_ID,
  DEFAULT_RUBRIC_JUDGE_MODEL,
  RUBRIC_CRITERIA,
  brandProfileFromBrandData,
  imageForJudge,
  judgeCreative,
  judgeCreativePair,
  parsePairwiseOutput,
  parseRubricOutput,
  readChatCompletion,
  type CreativeRubricResult,
  type RubricCriterionId,
  type RubricJudgeLlm,
  type RubricJudgeLlmRequest,
} from '../services/creativeRubricJudge';
import { LLM_MODEL_REGISTRY } from '../services/agentMode/llmModelRegistry';
import { extractS3KeyFromUrl, getS3ObjectAsBuffer } from '../utils/s3Utils';

jest.mock('../utils/s3Utils', () => ({
  extractS3KeyFromUrl: jest.fn(),
  getS3ObjectAsBuffer: jest.fn(),
}));

const mockExtractKey = jest.mocked(extractS3KeyFromUrl);
const mockGetObject = jest.mocked(getS3ObjectAsBuffer);

async function png(width = 40, height = 50): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#3366cc' } }).png().toBuffer();
}

function verdictJson(overrides: Partial<Record<RubricCriterionId, 'pass' | 'fail'>> = {}): string {
  const out: Record<string, { rationale: string; verdict: string }> = {};
  for (const id of RUBRIC_CRITERIA) out[id] = { rationale: `why ${id}`, verdict: overrides[id] ?? 'pass' };
  return JSON.stringify(out);
}

function pairwiseJson(per: '1' | '2' | 'tie', overall: '1' | '2' | 'tie'): string {
  const out: Record<string, { rationale: string; preference: string }> = {};
  for (const id of RUBRIC_CRITERIA) out[id] = { rationale: `why ${id}`, preference: per };
  out.overall = { rationale: 'overall why', preference: overall };
  return JSON.stringify(out);
}

function stubLlm(text: string | Error): { llm: RubricJudgeLlm; calls: RubricJudgeLlmRequest[] } {
  const calls: RubricJudgeLlmRequest[] = [];
  return {
    calls,
    llm: {
      complete: jest.fn(async (request: RubricJudgeLlmRequest) => {
        calls.push(request);
        if (text instanceof Error) throw text;
        return { text, usage: { inputTokens: 3000, outputTokens: 500, costUsd: 0.0165 } };
      }),
    },
  };
}

const FIXED_NOW = () => new Date('2026-09-25T10:00:00.000Z');

function expectErrorWithoutVerdicts(result: CreativeRubricResult, kind: string): void {
  expect(result.status).toBe('error');
  if (result.status !== 'error') return;
  expect(result.error.kind).toBe(kind);
  // An error result must never be readable as a pass.
  expect(result).not.toHaveProperty('passed');
  expect(result).not.toHaveProperty('criteria');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExtractKey.mockReturnValue(null);
});

describe('default judge model', () => {
  it('is a registered vision model outside the generators\' families', () => {
    const config = LLM_MODEL_REGISTRY[DEFAULT_RUBRIC_JUDGE_MODEL];
    expect(config).toBeDefined();
    expect(config.supportsVision).toBe(true);
    expect(config.provider).toBe('anthropic');
  });
});

describe('parseRubricOutput', () => {
  it('parses all 7 criteria with rationale and verdict', () => {
    const parsed = parseRubricOutput(verdictJson({ offer_specificity: 'fail' }));
    expect(Object.keys(parsed)).toEqual([...RUBRIC_CRITERIA]);
    expect(parsed.offer_specificity).toEqual({ rationale: 'why offer_specificity', verdict: 'fail' });
    expect(parsed.hook_clarity.verdict).toBe('pass');
  });

  it('tolerates a ```json fence, as the portal judge does', () => {
    expect(parseRubricOutput('```json\n' + verdictJson() + '\n```').brand_fidelity.verdict).toBe('pass');
  });

  it.each([
    ['prose', 'The creative looks good overall.', 'is not JSON'],
    ['an array', '[1,2]', 'is not a JSON object'],
    ['truncated JSON', verdictJson().slice(0, 40), 'is not JSON'],
  ])('rejects %s', (_label, raw, message) => {
    expect(() => parseRubricOutput(raw)).toThrow(message);
  });

  it('names every missing criterion', () => {
    const partial = JSON.parse(verdictJson()) as Record<string, unknown>;
    delete partial.proof_integrity;
    delete partial.policy_compliance;
    expect(() => parseRubricOutput(JSON.stringify(partial))).toThrow('missing: proof_integrity, policy_compliance');
  });

  it('rejects a verdict outside pass|fail and an empty rationale', () => {
    const bad = JSON.parse(verdictJson()) as Record<string, Record<string, unknown>>;
    bad.hook_clarity.verdict = 'maybe';
    expect(() => parseRubricOutput(JSON.stringify(bad))).toThrow('"hook_clarity" verdict must be "pass" or "fail"');
    const noWhy = JSON.parse(verdictJson()) as Record<string, Record<string, unknown>>;
    noWhy.format_readiness.rationale = '  ';
    expect(() => parseRubricOutput(JSON.stringify(noWhy))).toThrow('"format_readiness" has no rationale');
  });
});

describe('judgeCreative', () => {
  it('returns 7 binary results, the pass count and usage', async () => {
    const { llm, calls } = stubLlm(verdictJson({ proof_integrity: 'fail' }));
    const result = await judgeCreative(
      { image: { bytes: await png() } },
      { goal: 'Book demos', cta: 'Book a demo', brand: { brandName: 'Acme', primaryColor: '#123456' } },
      { llm, now: FIXED_NOW },
    );

    expect(result).toMatchObject({
      graderId: CREATIVE_RUBRIC_GRADER_ID,
      advisory: true,
      mode: 'single',
      status: 'ok',
      model: DEFAULT_RUBRIC_JUDGE_MODEL,
      passedCount: 6,
      passed: false,
      evaluatedAt: '2026-09-25T10:00:00.000Z',
      usage: { inputTokens: 3000, outputTokens: 500, costUsd: 0.0165 },
    });
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.criteria.proof_integrity.verdict).toBe('fail');

    expect(calls).toHaveLength(1);
    const [request] = calls;
    expect(request.model).toBe(DEFAULT_RUBRIC_JUDGE_MODEL);
    expect(request.system).toContain('rationale');
    const image = request.content.find((p) => p.type === 'image_url');
    expect(image && image.type === 'image_url' && image.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    const text = request.content.filter((p) => p.type === 'text').map((p) => (p.type === 'text' ? p.text : '')).join('\n');
    expect(text).toContain('"brandName": "Acme"');
    expect(text).toContain('"cta": "Book a demo"');
  });

  it('reports passed only when all 7 pass', async () => {
    const result = await judgeCreative({ image: { bytes: await png() } }, {}, { llm: stubLlm(verdictJson()).llm });
    expect(result).toMatchObject({ status: 'ok', passedCount: 7, passed: true });
  });

  it.each([
    ['malformed output', 'Looks fine to me!', 'malformed_output'],
    ['missing criteria', JSON.stringify({ hook_clarity: { rationale: 'x', verdict: 'pass' } }), 'missing_criteria'],
    ['an invalid verdict', verdictJson().replace('"pass"', '"yes"'), 'invalid_verdict'],
  ])('turns %s into an explicit failure, never a pass', async (_label, raw, kind) => {
    const result = await judgeCreative({ image: { bytes: await png() } }, {}, { llm: stubLlm(raw).llm });
    expectErrorWithoutVerdicts(result, kind);
    // Usage is kept so a failed call's spend is still visible.
    expect(result.usage).toEqual({ inputTokens: 3000, outputTokens: 500, costUsd: 0.0165 });
  });

  it('turns an LLM error into llm_error', async () => {
    const result = await judgeCreative({ image: { bytes: await png() } }, {}, { llm: stubLlm(new Error('429 rate limited')).llm });
    expectErrorWithoutVerdicts(result, 'llm_error');
    if (result.status === 'error') expect(result.error.message).toContain('429');
  });

  it.each([
    ['a Gemini model (generator family)', 'gemini-3.5-flash'],
    ['an OpenAI model (generator family)', 'gpt-5.5'],
    ['an unregistered model', 'anthropic.claude-sonnet-99'],
  ])('refuses %s without calling the LLM', async (_label, model) => {
    const { llm, calls } = stubLlm(verdictJson());
    const result = await judgeCreative({ image: { bytes: await png() } }, {}, { llm, model });
    expectErrorWithoutVerdicts(result, 'model_not_allowed');
    expect(calls).toHaveLength(0);
  });

  it('fails with image_unavailable on bytes that are not an image, without calling the LLM', async () => {
    const { llm, calls } = stubLlm(verdictJson());
    const result = await judgeCreative({ image: { bytes: Buffer.from('not an image') } }, {}, { llm });
    expectErrorWithoutVerdicts(result, 'image_unavailable');
    expect(calls).toHaveLength(0);
  });
});

describe('imageForJudge', () => {
  it('downloads our own S3 objects (private) and inlines them, downscaled', async () => {
    mockExtractKey.mockReturnValue('users/u1/image.png');
    mockGetObject.mockResolvedValue({ buffer: await png(3000, 3000), contentType: 'image/png' });
    const uri = await imageForJudge({ url: 'https://agentweb-user-files.s3.amazonaws.com/users/u1/image.png' });
    expect(mockGetObject).toHaveBeenCalledWith('users/u1/image.png', undefined, 15 * 1024 * 1024);
    const meta = await sharp(Buffer.from(uri.split(',')[1], 'base64')).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1568);
  });

  it('passes any other https URL through for the provider to fetch, and refuses plain http', async () => {
    await expect(imageForJudge({ url: 'https://cdn.example.com/a.png' })).resolves.toBe('https://cdn.example.com/a.png');
    await expect(imageForJudge({ url: 'http://169.254.169.254/latest' })).rejects.toThrow('neither https');
    expect(mockGetObject).not.toHaveBeenCalled();
  });

  it('decodes a data URI', async () => {
    const uri = `data:image/png;base64,${(await png()).toString('base64')}`;
    await expect(imageForJudge({ url: uri })).resolves.toMatch(/^data:image\/jpeg;base64,/);
  });
});

describe('brandProfileFromBrandData', () => {
  it('keeps brand fields, drops founders and blanks', () => {
    expect(
      brandProfileFromBrandData({
        brandName: 'Acme',
        primaryColor: '#123456',
        tagline: '   ',
        keyMessages: ['Fast', 42, ''],
        founders: [{ name: 'Jane' }],
      }),
    ).toEqual({ brandName: 'Acme', primaryColor: '#123456', keyMessages: ['Fast'] });
    expect(brandProfileFromBrandData(undefined)).toBeUndefined();
    expect(brandProfileFromBrandData({ founders: [] })).toBeUndefined();
  });
});

describe('readChatCompletion', () => {
  it('reads text, tokens and OpenRouter cost', () => {
    expect(
      readChatCompletion({ choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 } }),
    ).toEqual({ text: '{}', usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.001 } });
    expect(readChatCompletion({ choices: [] })).toEqual({ text: '' });
  });
});

describe('pairwise', () => {
  it('maps the shown labels back to A/B for both presentation orders', () => {
    expect(parsePairwiseOutput(pairwiseJson('1', '1'), 'AB').preference).toBe('A');
    expect(parsePairwiseOutput(pairwiseJson('1', '1'), 'BA').preference).toBe('B');
    const parsed = parsePairwiseOutput(pairwiseJson('tie', '2'), 'AB');
    expect(parsed.preference).toBe('B');
    expect(parsed.criteria.hook_clarity).toEqual({ rationale: 'why hook_clarity', preference: 'tie' });
  });

  it('rejects a missing overall and a bad preference', () => {
    const noOverall = JSON.parse(pairwiseJson('1', '1')) as Record<string, unknown>;
    delete noOverall.overall;
    expect(() => parsePairwiseOutput(JSON.stringify(noOverall), 'AB')).toThrow('missing: overall');
    expect(() => parsePairwiseOutput(pairwiseJson('1', '1').replace('"preference":"1"', '"preference":"A"'), 'AB')).toThrow(
      'preference must be "1", "2" or "tie"',
    );
  });

  it('shows the pair in random order and returns a preference pairwiseWinRate accepts', async () => {
    const a = { image: { bytes: await png(40, 50) } };
    const b = { image: { bytes: await png(50, 50) } };

    const shownFirst = stubLlm(pairwiseJson('2', '1'));
    const ab = await judgeCreativePair(a, b, { goal: 'Book demos' }, { llm: shownFirst.llm, random: () => 0.1 });
    const shownSecond = stubLlm(pairwiseJson('2', '1'));
    const ba = await judgeCreativePair(a, b, { goal: 'Book demos' }, { llm: shownSecond.llm, random: () => 0.9 });

    expect(ab).toMatchObject({ mode: 'pairwise', status: 'ok', presentedOrder: 'AB', preference: 'A', advisory: true });
    expect(ba).toMatchObject({ mode: 'pairwise', status: 'ok', presentedOrder: 'BA', preference: 'B' });
    if (ab.status !== 'ok') throw new Error('expected ok');
    expect(ab.criteria.offer_specificity.preference).toBe('B');

    // Both images reach the judge, labelled 1 and 2.
    const request = shownFirst.calls[0];
    expect(request.content.filter((p) => p.type === 'image_url')).toHaveLength(2);
    expect(request.system).toContain('"1" | "2" | "tie"');

    const choices = [ab, ba].map((r) => (r.status === 'ok' ? r.preference : 'tie'));
    expect(pairwiseWinRate(choices)).toMatchObject({ n: 2, winRateA: 0.5, ties: 0 });
  });

  it('returns an explicit failure on malformed output', async () => {
    const a = { image: { bytes: await png() } };
    const result = await judgeCreativePair(a, a, {}, { llm: stubLlm('A is better').llm, random: () => 0.1 });
    expect(result).toMatchObject({ mode: 'pairwise', status: 'error', error: { kind: 'malformed_output' } });
    expect(result).not.toHaveProperty('preference');
  });
});
