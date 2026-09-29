/**
 * Runtime hook for the creative rubric judge (ENG-2140, ENG-2128 T8; every creative: ENG-2192).
 *
 * When a generated creative's human-eval candidate is stored, a sampled share of them is scored by
 * the rubric judge and the result is stored as `creativeRubric` on the same AW-HumanEvalQueue item:
 *  - agent-mode `generate_image` ads on the 7-criterion ad floor, organic/uncategorized images on
 *    the criteria that apply to any image (agent mode has no ad copy at generation time);
 *  - deployed landing pages, from the source the deploy has in memory (loaded only when sampled).
 * For an ad image with a prior best (`selectPriorBest`: same account, category and placement), a
 * pairwise verdict new-vs-prior is stored as `creativePairwise` too. Onboarding creatives, which
 * have no candidate, go through creativeRubricOnboarding.ts with the same config and sampling.
 *
 * Model calls per sampled creative: 1 single verdict, +1 pairwise for an ad image with a prior best
 * (which also costs one AW-HumanEvalQueue scan of the account's candidates).
 *
 * OFF by default. Nothing runs, and no model is called, unless
 *   CREATIVE_RUBRIC_JUDGE_ENABLED=true  and  CREATIVE_RUBRIC_JUDGE_SAMPLE_RATE > 0 (0..1).
 * CREATIVE_RUBRIC_JUDGE_MODEL overrides the judge model (default: Claude Sonnet 5).
 *
 * Advisory and fire-and-forget: the hook never throws and nothing waits on it.
 */
import type { CreativeGateResult } from './creativeGates';
import { PLACEMENT_SPECS } from './creativePlacementSpecs';
import {
  DEFAULT_RUBRIC_JUDGE_MODEL,
  brandProfileFromBrandData,
  judgeCreative,
  judgeCreativePair,
  judgeLandingPage,
  skippedRubricResult,
  type CreativeBrief,
  type CreativeCopy,
  type CreativeRubricResult,
  type ImageRubricSurface,
  type RubricJudgeLlm,
  type StoredCreativePairwise,
} from './creativeRubricJudge';

export interface RubricJudgeRuntimeConfig {
  enabled: boolean;
  /** Share of eligible creatives to judge, 0..1. */
  sampleRate: number;
  model: string;
}

type Env = Record<string, string | undefined>;

export function readRubricJudgeConfig(env: Env = process.env): RubricJudgeRuntimeConfig {
  const rate = Number(env.CREATIVE_RUBRIC_JUDGE_SAMPLE_RATE);
  return {
    enabled: env.CREATIVE_RUBRIC_JUDGE_ENABLED === 'true',
    sampleRate: Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 0,
    model: env.CREATIVE_RUBRIC_JUDGE_MODEL?.trim() || DEFAULT_RUBRIC_JUDGE_MODEL,
  };
}

export function shouldSampleCreativeRubricJudge(
  config: RubricJudgeRuntimeConfig,
  random: () => number = Math.random,
): boolean {
  return config.enabled && config.sampleRate > 0 && random() < config.sampleRate;
}

export interface CandidateRubricInput {
  candidateId: string;
  userId?: string;
  /** The human-eval review type; absent reads as 'creative_image'. */
  reviewType?: string;
  /**
   * Image candidates: 'ad' is judged on the 7-criterion ad floor (ENG-421 is an ad launch bar);
   * 'organic_post' and uncategorized images on the criteria that apply to any image (ENG-2192).
   */
  category?: string;
  artifactUrl?: string;
  /** The candidate's createdAt; needed to find an earlier prior best for the pairwise verdict. */
  createdAt?: string;
  creativeGates?: CreativeGateResult;
  /** Landing pages: the generated page source, read only when this page is sampled. */
  loadLandingPageSource?: () => Promise<string | undefined>;
  /** What the generation flow knows about the brief. The brand profile is loaded here. */
  brief?: Omit<CreativeBrief, 'brand'>;
}

export interface CandidateRubricDeps {
  env?: Env;
  random?: () => number;
  llm?: RubricJudgeLlm;
  loadBrandData?: (userId: string) => Promise<Record<string, unknown> | null | undefined>;
  store?: (candidateId: string, result: CreativeRubricResult) => Promise<void>;
  /** The account's earlier image candidates, for the prior best. */
  loadPriorCandidates?: (userId: string) => Promise<PriorCandidateLike[]>;
  storePairwise?: (candidateId: string, result: StoredCreativePairwise) => Promise<void>;
}

export async function defaultLoadBrandData(userId: string): Promise<Record<string, unknown> | null | undefined> {
  const { resolveBrandGuidelinesForUser } = await import('./agentMode/brandLogo');
  return (await resolveBrandGuidelinesForUser(userId))?.brandData;
}

async function defaultStore(candidateId: string, result: CreativeRubricResult): Promise<void> {
  const { humanEvalService } = await import('./humanEvalService');
  await humanEvalService.setCreativeRubric(candidateId, result);
}

async function defaultLoadPriorCandidates(userId: string): Promise<PriorCandidateLike[]> {
  const { humanEvalService } = await import('./humanEvalService');
  return humanEvalService.listCandidatesForUser(userId, 'creative_image');
}

async function defaultStorePairwise(candidateId: string, result: StoredCreativePairwise): Promise<void> {
  const { humanEvalService } = await import('./humanEvalService');
  await humanEvalService.setCreativePairwise(candidateId, result);
}

/** The image surface a human-eval image candidate is judged on (ENG-2192). */
export function imageSurfaceForCategory(category: string | undefined): ImageRubricSurface {
  return category === 'ad' ? 'ad_image' : 'organic_image';
}

/**
 * The single verdict for an image, or why it was skipped: the rubric runs only after the
 * deterministic gates ran and passed. No model call on a skip.
 */
export async function judgeGatedImage(
  input: { imageUrl: string; gates?: CreativeGateResult; copy?: CreativeCopy; surface: ImageRubricSurface },
  brief: CreativeBrief,
  config: RubricJudgeRuntimeConfig,
  llm?: RubricJudgeLlm,
): Promise<CreativeRubricResult> {
  const tag = input.surface === 'ad_image' ? undefined : input.surface;
  if (!input.gates) {
    return skippedRubricResult(config.model, 'no deterministic gate result (gates did not run on this image)', new Date(), tag);
  }
  if (!input.gates.passed) {
    return skippedRubricResult(config.model, 'deterministic gates failed; the rubric runs only after they pass', new Date(), tag);
  }
  const placement = brief.placement ?? placementFromGates(input.gates);
  return judgeCreative(
    { image: { url: input.imageUrl }, gates: input.gates, ...(input.copy ? { copy: input.copy } : {}) },
    { ...brief, ...(placement ? { placement } : {}) },
    { model: config.model, surface: input.surface, ...(llm ? { llm } : {}) },
  );
}

/**
 * The runtime pairwise verdict for an ad image with an ok single verdict (ENG-2192): the new
 * creative (A) against `selectPriorBest` over `pool` (B). Null when there is no prior best; the
 * pairwise prompt is the ad floor, so only ad images are compared.
 */
export async function pairwiseVsPriorBest<T extends PriorCandidateLike>(
  target: PriorCandidateLike,
  pool: readonly T[],
  brief: CreativeBrief,
  config: RubricJudgeRuntimeConfig,
  llm?: RubricJudgeLlm,
): Promise<StoredCreativePairwise | null> {
  const prior = selectPriorBest(target, pool);
  if (!prior?.artifactUrl || !target.artifactUrl) return null;
  const placement = brief.placement ?? placementFromGates(target.creativeGates);
  const pair = await judgeCreativePair(
    {
      image: { url: target.artifactUrl },
      ...(target.creativeGates ? { gates: target.creativeGates } : {}),
    },
    { image: { url: prior.artifactUrl }, ...(prior.creativeGates ? { gates: prior.creativeGates } : {}) },
    { ...brief, ...(placement ? { placement } : {}) },
    { model: config.model, ...(llm ? { llm } : {}) },
  );
  return { ...pair, priorId: prior.candidateId, priorArtifactUrl: prior.artifactUrl };
}

/** "Meta Feed — portrait 4:5 (1080x1350)" from the gate result, else the requested size. */
export function placementFromGates(gates: CreativeGateResult | undefined): string | undefined {
  if (!gates) return undefined;
  if (gates.placement) {
    const spec = PLACEMENT_SPECS[gates.placement];
    return `${spec.label} (${spec.width}x${spec.height})`;
  }
  return gates.requestedSize && gates.requestedSize !== 'auto' ? `requested size ${gates.requestedSize}` : undefined;
}

/**
 * Judges a stored human-eval candidate when the flag is on and it is sampled, and stores the
 * result on the candidate. Returns the stored result, or null when nothing ran. Never throws.
 */
export async function judgeHumanEvalCandidate(
  input: CandidateRubricInput,
  deps: CandidateRubricDeps = {},
): Promise<CreativeRubricResult | null> {
  try {
    const config = readRubricJudgeConfig(deps.env);
    const isLandingPage = input.reviewType === 'landing_page';
    if (!isLandingPage && (input.reviewType ?? 'creative_image') !== 'creative_image') return null;
    if (!isLandingPage && !input.artifactUrl) return null;
    if (!shouldSampleCreativeRubricJudge(config, deps.random)) return null;

    const store = deps.store ?? defaultStore;
    const loadBrief = async (): Promise<CreativeBrief> => {
      const brandData = input.userId ? await (deps.loadBrandData ?? defaultLoadBrandData)(input.userId) : undefined;
      const brand = brandProfileFromBrandData(brandData);
      return { ...input.brief, ...(brand ? { brand } : {}) };
    };

    const surface = imageSurfaceForCategory(input.category);
    // The brand profile is only loaded when a model call will be made.
    const brief = isLandingPage || input.creativeGates?.passed ? await loadBrief() : { ...input.brief };
    let result: CreativeRubricResult;
    if (isLandingPage) {
      const source = await input.loadLandingPageSource?.();
      result = source
        ? await judgeLandingPage(
            { source, ...(input.artifactUrl ? { url: input.artifactUrl } : {}) },
            brief,
            { model: config.model, ...(deps.llm ? { llm: deps.llm } : {}) },
          )
        : skippedRubricResult(config.model, 'no landing-page source available to judge', new Date(), 'landing_page');
    } else {
      result = await judgeGatedImage(
        { imageUrl: input.artifactUrl as string, gates: input.creativeGates, surface },
        brief,
        config,
        deps.llm,
      );
    }
    await store(input.candidateId, result);
    if (result.status === 'error') {
      console.warn(`[creative-rubric] candidate ${input.candidateId}: judge failed (${result.error.kind}): ${result.error.message}`);
    }
    if (!isLandingPage && result.status === 'ok' && surface === 'ad_image' && input.userId && input.createdAt) {
      await storePriorBestPairwise(input, brief, config, deps);
    }
    return result;
  } catch (err) {
    console.warn(
      `[creative-rubric] candidate ${input.candidateId}: rubric hook failed (non-fatal):`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Pairwise vs the account's prior best ad of the same placement, stored on the candidate. Never throws. */
async function storePriorBestPairwise(
  input: CandidateRubricInput,
  brief: CreativeBrief,
  config: RubricJudgeRuntimeConfig,
  deps: CandidateRubricDeps,
): Promise<void> {
  try {
    const all = await (deps.loadPriorCandidates ?? defaultLoadPriorCandidates)(input.userId as string);
    // Ads are compared with ads only: an organic image is not a launch alternative for an ad.
    const pool = all.filter((c) => c.category === 'ad');
    const pairwise = await pairwiseVsPriorBest(
      {
        candidateId: input.candidateId,
        userId: input.userId,
        reviewType: 'creative_image',
        artifactUrl: input.artifactUrl,
        createdAt: input.createdAt as string,
        creativeGates: input.creativeGates,
      },
      pool,
      brief,
      config,
      deps.llm,
    );
    if (!pairwise) return;
    await (deps.storePairwise ?? defaultStorePairwise)(input.candidateId, pairwise);
    if (pairwise.status === 'error') {
      console.warn(`[creative-rubric] candidate ${input.candidateId}: pairwise failed (${pairwise.error.kind}): ${pairwise.error.message}`);
    }
  } catch (err) {
    console.warn(
      `[creative-rubric] candidate ${input.candidateId}: pairwise vs prior best failed (non-fatal):`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** A prior candidate the pairwise mode can compare against. */
export interface PriorCandidateLike {
  candidateId: string;
  userId?: string;
  reviewType: string;
  /** Human-eval category ('ad' | 'organic_post' | …) when known. */
  category?: string;
  artifactUrl?: string;
  createdAt: string;
  creativeGates?: CreativeGateResult;
  creativeRubric?: CreativeRubricResult;
}

function placementKey(c: PriorCandidateLike): string | undefined {
  return c.creativeGates?.placement ?? c.creativeGates?.requestedSize;
}

function passedCountOf(c: PriorCandidateLike): number {
  return c.creativeRubric?.status === 'ok' ? c.creativeRubric.passedCount : -1;
}

/**
 * The prior best creative for the same account and placement as `target`: among earlier image
 * candidates of the same user with the same placement, the one with the most rubric passes,
 * then the most recent. Null when there is none, or when the target's placement is unknown.
 */
export function selectPriorBest<T extends PriorCandidateLike>(target: PriorCandidateLike, pool: readonly T[]): T | null {
  const placement = placementKey(target);
  if (!target.userId || !placement) return null;
  const priors = pool.filter(
    (c) =>
      c.candidateId !== target.candidateId &&
      c.reviewType === 'creative_image' &&
      c.userId === target.userId &&
      !!c.artifactUrl &&
      placementKey(c) === placement &&
      c.createdAt < target.createdAt,
  );
  priors.sort((x, y) => passedCountOf(y) - passedCountOf(x) || y.createdAt.localeCompare(x.createdAt));
  return priors[0] ?? null;
}
