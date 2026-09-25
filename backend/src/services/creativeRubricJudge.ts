/**
 * Creative rubric judge (ENG-2140, ENG-2128 T8).
 *
 * An LLM judge that applies ENG-421's 7-criterion launch-ready floor to a generated ad creative
 * as binary checks (rationale before verdict), and a pairwise mode that compares a creative with
 * a prior one for the same account and placement. Criteria and prompts: creativeRubricJudgePrompt.ts.
 *
 * ADVISORY ONLY. Nothing blocks on a verdict until the grader is validated against human labels
 * (ENG-2136 agreement harness; `mayGate('creative-rubric-judge')` in loops/eval/evalRegistry.ts).
 *
 * Judge family: generation runs on Gemini and gpt-image, so the judge defaults to Claude Sonnet
 * (ENG-2128 principle 1) and refuses a Google or OpenAI model. Calls go through the OpenRouter
 * gateway (`AgentModeService.callLLM`) unless the caller injects another `RubricJudgeLlm`.
 *
 * Failure is explicit: an unreadable image, an LLM error, unparseable output, a missing criterion
 * or an invalid verdict each return `status: 'error'` with a reason. Such a result carries no
 * verdicts, so it can never be read as a pass. The public functions never throw.
 */
import type { PairwiseChoice } from '../loops/eval/agreement';
import { LLM_MODEL_REGISTRY } from './agentMode/llmModelRegistry';
import type { CreativeGateResult } from './creativeGates';
import {
  PAIRWISE_SYSTEM_PROMPT,
  RUBRIC_CRITERIA,
  RUBRIC_PROMPT_VERSION,
  RUBRIC_SYSTEM_PROMPT,
  type RubricCriterionId,
} from './creativeRubricJudgePrompt';

export { RUBRIC_CRITERIA, type RubricCriterionId } from './creativeRubricJudgePrompt';

export const CREATIVE_RUBRIC_GRADER_ID = 'creative-rubric-judge';
export const CREATIVE_RUBRIC_VERSION = '2026-09-25.1';

/** Claude Sonnet 5: a vision model outside the generators' families (registry: llmModelRegistry.ts). */
export const DEFAULT_RUBRIC_JUDGE_MODEL = 'anthropic.claude-sonnet-5';

/** Providers of the image generators (Gemini image, gpt-image). A judge from them grades its own family. */
const GENERATOR_PROVIDERS = new Set<string>(['google', 'openai']);

const JUDGE_TIMEOUT_MS = 90_000;
const JUDGE_MAX_OUTPUT_TOKENS = 4_000;
/** Longest image edge sent to the judge; larger images cost more tokens without changing a verdict. */
const JUDGE_IMAGE_MAX_EDGE = 1568;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_BRIEF_FIELD_CHARS = 2_000;

// ── inputs ───────────────────────────────────────────────────────────────────

/** The creative's image: a URL (our S3, https, or a data URI) or the encoded bytes. */
export type CreativeImageInput = { url: string } | { bytes: Buffer };

/** The subset of `brandGuidelines.brandData` the judge reads. Founder details are left out. */
export interface RubricBrandProfile {
  brandName?: string;
  tagline?: string;
  valueProposition?: string;
  domain?: string;
  primaryColor?: string;
  primaryColorEnd?: string;
  secondaryColor?: string;
  fontFamily?: string;
  toneOfVoice?: string;
  keyMessages?: string[];
  brandValues?: string[];
  targetAudience?: string;
  brandPersonality?: string;
}

export interface CreativeBrief {
  /** Campaign goal / objective. */
  goal?: string;
  audience?: string;
  cta?: string;
  offer?: string;
  /** Placement the creative was made for, e.g. "Meta feed portrait 4:5 (1080x1350)". */
  placement?: string;
  /** The generation request, when that is the only brief there is (agent-mode generate_image). */
  generationRequest?: string;
  brand?: RubricBrandProfile;
}

export interface CreativeCopy {
  headline?: string;
  primaryText?: string;
  description?: string;
  cta?: string;
}

export interface CreativeUnderReview {
  image: CreativeImageInput;
  copy?: CreativeCopy;
  /** Deterministic gate result (ENG-2139); a failed check is shown to the judge. */
  gates?: CreativeGateResult;
}

// ── results ──────────────────────────────────────────────────────────────────

export type RubricVerdict = 'pass' | 'fail';

export interface RubricCriterionResult {
  rationale: string;
  verdict: RubricVerdict;
}

export interface PairwiseCriterionResult {
  rationale: string;
  preference: PairwiseChoice;
}

export type RubricJudgeErrorKind =
  | 'model_not_allowed'
  | 'image_unavailable'
  | 'llm_error'
  | 'malformed_output'
  | 'missing_criteria'
  | 'invalid_verdict';

export interface RubricJudgeError {
  kind: RubricJudgeErrorKind;
  message: string;
}

export interface RubricJudgeUsage {
  inputTokens: number;
  outputTokens: number;
  /** OpenRouter-reported cost when present. */
  costUsd?: number;
}

interface RubricResultBase {
  graderId: typeof CREATIVE_RUBRIC_GRADER_ID;
  version: string;
  promptVersion: string;
  /** Always true until the grader is validated; consumers must not block on a verdict. */
  advisory: true;
  model: string;
  evaluatedAt: string;
  usage?: RubricJudgeUsage;
}

export type CreativeRubricResult =
  | (RubricResultBase & {
      mode: 'single';
      status: 'ok';
      criteria: Record<RubricCriterionId, RubricCriterionResult>;
      passedCount: number;
      /** All 7 criteria pass (ENG-421: the floor is met only when every criterion passes). */
      passed: boolean;
    })
  | (RubricResultBase & { mode: 'single'; status: 'error'; error: RubricJudgeError })
  | (RubricResultBase & { mode: 'single'; status: 'skipped'; reason: string });

/**
 * `preference` is from A's side (A = the creative under review, B = the prior one) and uses the
 * agreement harness's `PairwiseChoice`, so a list of results feeds `pairwiseWinRate` directly.
 */
export type CreativePairwiseResult =
  | (RubricResultBase & {
      mode: 'pairwise';
      status: 'ok';
      preference: PairwiseChoice;
      rationale: string;
      criteria: Record<RubricCriterionId, PairwiseCriterionResult>;
      /** Order the two were shown in; kept so position bias can be measured later. */
      presentedOrder: 'AB' | 'BA';
    })
  | (RubricResultBase & { mode: 'pairwise'; status: 'error'; error: RubricJudgeError });

// ── LLM client ───────────────────────────────────────────────────────────────

export type RubricJudgeContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface RubricJudgeLlmRequest {
  model: string;
  system: string;
  content: RubricJudgeContentPart[];
  maxTokens: number;
  timeoutMs: number;
}

export interface RubricJudgeLlmResponse {
  text: string;
  usage?: RubricJudgeUsage;
}

export interface RubricJudgeLlm {
  complete(request: RubricJudgeLlmRequest): Promise<RubricJudgeLlmResponse>;
}

interface ChatCompletionLike {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown };
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Reads text and token usage from an OpenAI-shaped chat completion. */
export function readChatCompletion(res: ChatCompletionLike): RubricJudgeLlmResponse {
  const content = res.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : '';
  const usage = res.usage
    ? {
        inputTokens: finiteOr(res.usage.prompt_tokens, 0),
        outputTokens: finiteOr(res.usage.completion_tokens, 0),
        ...(typeof res.usage.cost === 'number' && Number.isFinite(res.usage.cost) ? { costUsd: res.usage.cost } : {}),
      }
    : undefined;
  return usage ? { text, usage } : { text };
}

/** Production client: the OpenRouter gateway, metered as `creative_rubric_judge` system spend. */
export const gatewayRubricJudgeLlm: RubricJudgeLlm = {
  async complete(request) {
    const { agentModeService } = await import('./agentModeService');
    const res: ChatCompletionLike = await agentModeService.callLLM(
      request.model,
      [
        { role: 'system', content: request.system },
        { role: 'user', content: request.content },
      ],
      {
        max_completion_tokens: request.maxTokens,
        timeoutMs: request.timeoutMs,
        usageContext: { feature: 'creative_rubric_judge' },
        taskClass: 'nonstandard_consumer',
      },
    );
    return readChatCompletion(res);
  },
};

// ── helpers ──────────────────────────────────────────────────────────────────

class JudgeFailure extends Error {
  constructor(readonly kind: RubricJudgeErrorKind, message: string) {
    super(message);
  }
}

function toJudgeError(err: unknown): RubricJudgeError {
  if (err instanceof JudgeFailure) return { kind: err.kind, message: err.message };
  return { kind: 'llm_error', message: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
}

/** Throws `model_not_allowed` unless the model is a registered vision model outside the generators' providers. */
export function assertJudgeModelAllowed(model: string): void {
  const config = LLM_MODEL_REGISTRY[model];
  if (!config) throw new JudgeFailure('model_not_allowed', `judge model "${model}" is not in the model registry`);
  if (!config.supportsVision) throw new JudgeFailure('model_not_allowed', `judge model "${model}" does not accept images`);
  if (!config.provider || GENERATOR_PROVIDERS.has(config.provider)) {
    throw new JudgeFailure(
      'model_not_allowed',
      `judge model "${model}" is from ${config.provider ?? 'an unknown provider'}, not a family independent of the image generators`,
    );
  }
}

function clip(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_BRIEF_FIELD_CHARS) : undefined;
}

function clipList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(clip).filter((v): v is string => v !== undefined).slice(0, 10);
  return items.length > 0 ? items : undefined;
}

/** Picks the judge's brand profile out of a stored `brandGuidelines.brandData` record. */
export function brandProfileFromBrandData(brandData: Record<string, unknown> | null | undefined): RubricBrandProfile | undefined {
  if (!brandData) return undefined;
  const profile: RubricBrandProfile = {};
  const stringKeys = [
    'brandName',
    'tagline',
    'valueProposition',
    'domain',
    'primaryColor',
    'primaryColorEnd',
    'secondaryColor',
    'fontFamily',
    'toneOfVoice',
    'targetAudience',
    'brandPersonality',
  ] as const;
  for (const key of stringKeys) {
    const value = clip(brandData[key]);
    if (value !== undefined) profile[key] = value;
  }
  const keyMessages = clipList(brandData.keyMessages);
  if (keyMessages) profile.keyMessages = keyMessages;
  const brandValues = clipList(brandData.brandValues);
  if (brandValues) profile.brandValues = brandValues;
  return Object.keys(profile).length > 0 ? profile : undefined;
}

function briefForPrompt(brief: CreativeBrief): Record<string, unknown> {
  return {
    goal: clip(brief.goal) ?? null,
    audience: clip(brief.audience) ?? null,
    cta: clip(brief.cta) ?? null,
    offer: clip(brief.offer) ?? null,
    placement: clip(brief.placement) ?? null,
    generationRequest: clip(brief.generationRequest) ?? null,
    brandProfile: brief.brand ?? null,
  };
}

function gatesForPrompt(gates: CreativeGateResult | undefined): Record<string, unknown> | null {
  if (!gates) return null;
  return {
    passed: gates.passed,
    ...(gates.placement ? { placement: gates.placement } : {}),
    ...(gates.width && gates.height ? { size: `${gates.width}x${gates.height}` } : {}),
    failedChecks: gates.checks.filter((c) => c.status === 'fail').map((c) => ({ id: c.id, reason: c.reason ?? '' })),
  };
}

function copyForPrompt(copy: CreativeCopy | undefined): Record<string, string> | null {
  if (!copy) return null;
  const out: Record<string, string> = {};
  for (const key of ['headline', 'primaryText', 'description', 'cta'] as const) {
    const value = clip(copy[key]);
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function fencedJson(value: unknown): string {
  return ['```json', JSON.stringify(value, null, 2), '```'].join('\n');
}

function creativeParts(label: string, creative: CreativeUnderReview, imageUrl: string): RubricJudgeContentPart[] {
  const copy = copyForPrompt(creative.copy);
  return [
    {
      type: 'text',
      text: [
        `${label}`,
        copy ? `Ad copy:\n${fencedJson(copy)}` : 'Ad copy: none supplied — judge the text rendered in the image.',
        `Deterministic checks:\n${fencedJson(gatesForPrompt(creative.gates))}`,
        `${label} image:`,
      ].join('\n'),
    },
    { type: 'image_url', image_url: { url: imageUrl } },
  ];
}

async function downscaleToDataUri(buffer: Buffer): Promise<string> {
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new JudgeFailure('image_unavailable', `image is ${buffer.length} bytes, above the ${MAX_IMAGE_BYTES}-byte limit`);
  }
  try {
    const { default: sharp } = await import('sharp');
    const jpeg = await sharp(buffer)
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({ width: JUDGE_IMAGE_MAX_EDGE, height: JUDGE_IMAGE_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  } catch (err) {
    throw new JudgeFailure('image_unavailable', `image could not be decoded: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Resolves the image to something the judge model can read. Our own S3 objects are private, so
 * they are downloaded (size-capped) and inlined; any other https URL is passed through for the
 * model provider to fetch, so this never fetches an arbitrary URL server-side.
 */
export async function imageForJudge(image: CreativeImageInput): Promise<string> {
  if ('bytes' in image) return downscaleToDataUri(image.bytes);
  const url = image.url.trim();
  const dataUri = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(url);
  if (dataUri) return downscaleToDataUri(Buffer.from(dataUri[1], 'base64'));
  const { extractS3KeyFromUrl, getS3ObjectAsBuffer } = await import('../utils/s3Utils');
  const key = extractS3KeyFromUrl(url);
  if (key) {
    let buffer: Buffer;
    try {
      ({ buffer } = await getS3ObjectAsBuffer(key, undefined, MAX_IMAGE_BYTES));
    } catch (err) {
      throw new JudgeFailure('image_unavailable', `S3 read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return downscaleToDataUri(buffer);
  }
  if (/^https:\/\//i.test(url)) return url;
  throw new JudgeFailure('image_unavailable', 'image URL is neither https, a data URI, nor an object in our S3 bucket');
}

/** Parse the judge's JSON. Tolerates a code-fence wrapper (as the portal judge does); nothing else. */
function parseJudgeJson(raw: string): Record<string, unknown> {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new JudgeFailure('malformed_output', `judge output is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new JudgeFailure('malformed_output', 'judge output is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function entryFor(parsed: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const entry = parsed[key];
  return entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
}

function rationaleOf(entry: Record<string, unknown>, key: string): string {
  const rationale = typeof entry.rationale === 'string' ? entry.rationale.trim() : '';
  if (!rationale) throw new JudgeFailure('invalid_verdict', `"${key}" has no rationale`);
  return rationale;
}

function assertAllPresent(parsed: Record<string, unknown>, keys: readonly string[]): void {
  const missing = keys.filter((k) => entryFor(parsed, k) === null);
  if (missing.length > 0) throw new JudgeFailure('missing_criteria', `judge output is missing: ${missing.join(', ')}`);
}

/** Strict parse of a single-creative verdict: all 7 criteria, each with a rationale and pass|fail. */
export function parseRubricOutput(raw: string): Record<RubricCriterionId, RubricCriterionResult> {
  const parsed = parseJudgeJson(raw);
  assertAllPresent(parsed, RUBRIC_CRITERIA);
  const out = {} as Record<RubricCriterionId, RubricCriterionResult>;
  for (const id of RUBRIC_CRITERIA) {
    const entry = entryFor(parsed, id) as Record<string, unknown>;
    const verdict = entry.verdict;
    if (verdict !== 'pass' && verdict !== 'fail') {
      throw new JudgeFailure('invalid_verdict', `"${id}" verdict must be "pass" or "fail", got ${JSON.stringify(verdict)}`);
    }
    out[id] = { rationale: rationaleOf(entry, id), verdict };
  }
  return out;
}

function toChoice(value: unknown, key: string, order: 'AB' | 'BA'): PairwiseChoice {
  if (value === 'tie') return 'tie';
  if (value !== '1' && value !== '2') {
    throw new JudgeFailure('invalid_verdict', `"${key}" preference must be "1", "2" or "tie", got ${JSON.stringify(value)}`);
  }
  const first: PairwiseChoice = order === 'AB' ? 'A' : 'B';
  const second: PairwiseChoice = order === 'AB' ? 'B' : 'A';
  return value === '1' ? first : second;
}

/** Strict parse of a pairwise verdict, mapping the shown labels "1"/"2" back to A/B. */
export function parsePairwiseOutput(
  raw: string,
  order: 'AB' | 'BA',
): { preference: PairwiseChoice; rationale: string; criteria: Record<RubricCriterionId, PairwiseCriterionResult> } {
  const parsed = parseJudgeJson(raw);
  assertAllPresent(parsed, [...RUBRIC_CRITERIA, 'overall']);
  const criteria = {} as Record<RubricCriterionId, PairwiseCriterionResult>;
  for (const id of RUBRIC_CRITERIA) {
    const entry = entryFor(parsed, id) as Record<string, unknown>;
    criteria[id] = { rationale: rationaleOf(entry, id), preference: toChoice(entry.preference, id, order) };
  }
  const overall = entryFor(parsed, 'overall') as Record<string, unknown>;
  return {
    preference: toChoice(overall.preference, 'overall', order),
    rationale: rationaleOf(overall, 'overall'),
    criteria,
  };
}

export interface RubricJudgeOptions {
  model?: string;
  llm?: RubricJudgeLlm;
  now?: () => Date;
  /** Pairwise only: [0,1) source for the presentation order. */
  random?: () => number;
}

function base(model: string, now: () => Date, usage?: RubricJudgeUsage): RubricResultBase {
  return {
    graderId: CREATIVE_RUBRIC_GRADER_ID,
    version: CREATIVE_RUBRIC_VERSION,
    promptVersion: RUBRIC_PROMPT_VERSION,
    advisory: true,
    model,
    evaluatedAt: now().toISOString(),
    ...(usage ? { usage } : {}),
  };
}

// ── public API ───────────────────────────────────────────────────────────────

/** A result recording that the judge deliberately did not run (no model call was made). */
export function skippedRubricResult(model: string, reason: string, now: Date = new Date()): CreativeRubricResult {
  return { ...base(model, () => now), mode: 'single', status: 'skipped', reason };
}

/** Judges one creative against the 7 criteria. Never throws. */
export async function judgeCreative(
  creative: CreativeUnderReview,
  brief: CreativeBrief,
  options: RubricJudgeOptions = {},
): Promise<CreativeRubricResult> {
  const model = options.model ?? DEFAULT_RUBRIC_JUDGE_MODEL;
  const now = options.now ?? (() => new Date());
  const llm = options.llm ?? gatewayRubricJudgeLlm;
  let usage: RubricJudgeUsage | undefined;
  try {
    assertJudgeModelAllowed(model);
    const imageUrl = await imageForJudge(creative.image);
    const response = await llm.complete({
      model,
      system: RUBRIC_SYSTEM_PROMPT,
      content: [
        { type: 'text', text: `Brief:\n${fencedJson(briefForPrompt(brief))}` },
        ...creativeParts('Creative under review', creative, imageUrl),
        { type: 'text', text: 'Return your verdict JSON now.' },
      ],
      maxTokens: JUDGE_MAX_OUTPUT_TOKENS,
      timeoutMs: JUDGE_TIMEOUT_MS,
    });
    usage = response.usage;
    const criteria = parseRubricOutput(response.text);
    const passedCount = RUBRIC_CRITERIA.filter((id) => criteria[id].verdict === 'pass').length;
    return {
      ...base(model, now, usage),
      mode: 'single',
      status: 'ok',
      criteria,
      passedCount,
      passed: passedCount === RUBRIC_CRITERIA.length,
    };
  } catch (err) {
    return { ...base(model, now, usage), mode: 'single', status: 'error', error: toJudgeError(err) };
  }
}

/**
 * Compares creative A (usually the new one) with B (a prior creative for the same account and
 * placement) on the same brief. The two are shown in random order as "1" and "2" to keep
 * position bias out of the preference. Never throws.
 */
export async function judgeCreativePair(
  a: CreativeUnderReview,
  b: CreativeUnderReview,
  brief: CreativeBrief,
  options: RubricJudgeOptions = {},
): Promise<CreativePairwiseResult> {
  const model = options.model ?? DEFAULT_RUBRIC_JUDGE_MODEL;
  const now = options.now ?? (() => new Date());
  const llm = options.llm ?? gatewayRubricJudgeLlm;
  const order: 'AB' | 'BA' = (options.random ?? Math.random)() < 0.5 ? 'AB' : 'BA';
  let usage: RubricJudgeUsage | undefined;
  try {
    assertJudgeModelAllowed(model);
    const [imageA, imageB] = await Promise.all([imageForJudge(a.image), imageForJudge(b.image)]);
    const [first, second] = order === 'AB' ? [{ c: a, url: imageA }, { c: b, url: imageB }] : [{ c: b, url: imageB }, { c: a, url: imageA }];
    const response = await llm.complete({
      model,
      system: PAIRWISE_SYSTEM_PROMPT,
      content: [
        { type: 'text', text: `Brief:\n${fencedJson(briefForPrompt(brief))}` },
        ...creativeParts('Creative 1', first.c, first.url),
        ...creativeParts('Creative 2', second.c, second.url),
        { type: 'text', text: 'Return your verdict JSON now.' },
      ],
      maxTokens: JUDGE_MAX_OUTPUT_TOKENS,
      timeoutMs: JUDGE_TIMEOUT_MS,
    });
    usage = response.usage;
    const parsed = parsePairwiseOutput(response.text, order);
    return { ...base(model, now, usage), mode: 'pairwise', status: 'ok', ...parsed, presentedOrder: order };
  } catch (err) {
    return { ...base(model, now, usage), mode: 'pairwise', status: 'error', error: toJudgeError(err) };
  }
}
