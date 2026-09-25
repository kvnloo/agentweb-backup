/**
 * Runtime hook for the creative rubric judge (ENG-2140, ENG-2128 T8).
 *
 * After agent-mode `generate_image` makes an ad creative and its human-eval candidate is stored
 * (with the ENG-2139 gate result), a sampled share of those creatives is scored by the rubric
 * judge and the result is stored as `creativeRubric` on the same AW-HumanEvalQueue item.
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
  skippedRubricResult,
  type CreativeBrief,
  type CreativeRubricResult,
  type RubricJudgeLlm,
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
  /** Only 'ad' creatives are judged: ENG-421's floor is an ad launch bar (offer, media buyer). */
  category?: string;
  artifactUrl?: string;
  creativeGates?: CreativeGateResult;
  /** What the generation flow knows about the brief. The brand profile is loaded here. */
  brief?: Omit<CreativeBrief, 'brand'>;
}

export interface CandidateRubricDeps {
  env?: Env;
  random?: () => number;
  llm?: RubricJudgeLlm;
  loadBrandData?: (userId: string) => Promise<Record<string, unknown> | null | undefined>;
  store?: (candidateId: string, result: CreativeRubricResult) => Promise<void>;
}

async function defaultLoadBrandData(userId: string): Promise<Record<string, unknown> | null | undefined> {
  const { resolveBrandGuidelinesForUser } = await import('./agentMode/brandLogo');
  return (await resolveBrandGuidelinesForUser(userId))?.brandData;
}

async function defaultStore(candidateId: string, result: CreativeRubricResult): Promise<void> {
  const { humanEvalService } = await import('./humanEvalService');
  await humanEvalService.setCreativeRubric(candidateId, result);
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
    if (input.category !== 'ad' || !input.artifactUrl) return null;
    if (!shouldSampleCreativeRubricJudge(config, deps.random)) return null;

    const store = deps.store ?? defaultStore;
    let result: CreativeRubricResult;
    if (!input.creativeGates) {
      result = skippedRubricResult(config.model, 'no deterministic gate result (gates did not run on this image)');
    } else if (!input.creativeGates.passed) {
      result = skippedRubricResult(config.model, 'deterministic gates failed; the rubric runs only after they pass');
    } else {
      const brandData = input.userId ? await (deps.loadBrandData ?? defaultLoadBrandData)(input.userId) : undefined;
      const brand = brandProfileFromBrandData(brandData);
      const placement = input.brief?.placement ?? placementFromGates(input.creativeGates);
      result = await judgeCreative(
        { image: { url: input.artifactUrl }, gates: input.creativeGates },
        { ...input.brief, ...(placement ? { placement } : {}), ...(brand ? { brand } : {}) },
        { model: config.model, ...(deps.llm ? { llm: deps.llm } : {}) },
      );
    }
    await store(input.candidateId, result);
    if (result.status === 'error') {
      console.warn(`[creative-rubric] candidate ${input.candidateId}: judge failed (${result.error.kind}): ${result.error.message}`);
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

/** A prior candidate the pairwise mode can compare against. */
export interface PriorCandidateLike {
  candidateId: string;
  userId?: string;
  reviewType: string;
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
