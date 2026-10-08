/**
 * Creative rubric judge for onboarding creatives (ENG-2192).
 *
 * Onboarding ad images and ad copy have no human-eval candidate, so their verdicts are stored on
 * the variants they judge, in the existing AW-Users result fields:
 *  - `adImageResult.variants[].creativeRubric` (+ `creativePairwise` vs the previous run's best
 *    variant for the same placement) when the images are ready. The copy does not exist yet.
 *  - `adCopyResult.variants[].creativeRubric` when the copy is ready: the full ad, the copy with
 *    its image (matched by variant id), or the copy alone when that image failed or did not pass
 *    its deterministic gates.
 * Each write is conditional on the stored result still being the one that was judged
 * (`adImageCompletedAt` / `adCopyCompletedAt`), so a regeneration in between is never overwritten.
 *
 * Same switches and sampling as the candidate hook (creativeRubricJudgeRuntime.ts): nothing runs,
 * and no model is called, unless CREATIVE_RUBRIC_JUDGE_ENABLED=true and
 * CREATIVE_RUBRIC_JUDGE_SAMPLE_RATE > 0; each variant is sampled on its own. Model calls per
 * onboarding run when every variant is sampled: 3 image verdicts, up to 3 pairwise, 3 copy verdicts.
 *
 * Advisory and fire-and-forget: never throws, and nothing waits on it.
 */
import type { AdCopyVariant } from './adCopyStatusService';
import type { AdImageVariant } from './adImageStatusService';
import {
  brandProfileFromBrandData,
  judgeAdCopy,
  type CreativeBrief,
  type CreativeCopy,
  type CreativeRubricResult,
  type RubricJudgeLlm,
} from './creativeRubricJudge';
import {
  defaultLoadBrandData,
  judgeGatedImage,
  pairwiseVsPriorBest,
  readRubricJudgeConfig,
  shouldSampleCreativeRubricJudge,
  type PriorCandidateLike,
  type RubricJudgeRuntimeConfig,
} from './creativeRubricJudgeRuntime';

type Env = Record<string, string | undefined>;

/** Failed onboarding variants carry this URL instead of an image (onboardingAdImageService). */
const PLACEHOLDER_PREFIX = 'placeholder://';

export interface OnboardingRubricDeps {
  env?: Env;
  random?: () => number;
  llm?: RubricJudgeLlm;
  loadBrandData?: (userId: string) => Promise<Record<string, unknown> | null | undefined>;
  /** Writes the variants back only if the stored result's completedAt is still `completedAt`. */
  saveImageVariants?: (userId: string, completedAt: string, variants: AdImageVariant[]) => Promise<void>;
  saveCopyVariants?: (userId: string, completedAt: string, variants: AdCopyVariant[]) => Promise<void>;
}

function completedAtCondition(field: 'adImageCompletedAt' | 'adCopyCompletedAt', completedAt: string) {
  return { expression: '#done = :done', names: { '#done': field }, values: { ':done': completedAt } };
}

async function defaultSaveImageVariants(userId: string, completedAt: string, variants: AdImageVariant[]): Promise<void> {
  const { userDb } = await import('./db');
  await userDb.updateUser(userId, { adImageResult: { variants } }, { condition: completedAtCondition('adImageCompletedAt', completedAt) });
}

async function defaultSaveCopyVariants(userId: string, completedAt: string, variants: AdCopyVariant[]): Promise<void> {
  const { userDb } = await import('./db');
  await userDb.updateUser(userId, { adCopyResult: { variants } }, { condition: completedAtCondition('adCopyCompletedAt', completedAt) });
}

function isRealImage(v: AdImageVariant): boolean {
  return typeof v.imageUrl === 'string' && !!v.imageUrl && !v.imageUrl.startsWith(PLACEHOLDER_PREFIX);
}

function isConditionalCheckFailure(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ConditionalCheckFailedException';
}

function warn(message: string, err?: unknown): void {
  console.warn(`[creative-rubric] onboarding: ${message}${err ? `: ${err instanceof Error ? err.message : String(err)}` : ''}`);
}

async function briefFor(userId: string, deps: OnboardingRubricDeps): Promise<CreativeBrief> {
  const brand = brandProfileFromBrandData(await (deps.loadBrandData ?? defaultLoadBrandData)(userId));
  return brand ? { brand } : {};
}

async function save(write: () => Promise<void>, what: string): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (err) {
    if (isConditionalCheckFailure(err)) {
      warn(`${what} was regenerated while it was being judged; verdicts dropped`);
    } else {
      warn(`storing ${what} verdicts failed`, err);
    }
    return false;
  }
}

/** A stored onboarding variant as a pairwise pool entry. Ids are prefixed so a new run's
 * `variant-1` never matches the previous run's `variant-1` as "itself". */
function asPriorCandidate(userId: string, v: AdImageVariant, createdAt: string, idPrefix: string): PriorCandidateLike {
  return {
    candidateId: `${idPrefix}${v.id}`,
    userId,
    reviewType: 'creative_image',
    category: 'ad',
    artifactUrl: v.imageUrl,
    createdAt,
    ...(v.gates ? { creativeGates: v.gates } : {}),
    ...(v.creativeRubric ? { creativeRubric: v.creativeRubric } : {}),
  };
}

function sampledVariants<T>(variants: readonly T[], eligible: (v: T) => boolean, config: RubricJudgeRuntimeConfig, random?: () => number): T[] {
  return variants.filter((v) => eligible(v) && shouldSampleCreativeRubricJudge(config, random));
}

/**
 * Judges a ready onboarding image run's sampled variants, plus a pairwise verdict against the
 * previous run's best variant for the same placement, and stores both on the variants. Returns the
 * variants as stored, or null when nothing was judged or stored. Never throws.
 */
export async function judgeOnboardingAdImages(
  input: {
    userId: string;
    /** `adImageCompletedAt` of the stored result being judged. */
    completedAt: string;
    variants: AdImageVariant[];
    /** The run this one replaced, when there was one. */
    previous?: { completedAt?: string; variants: AdImageVariant[] };
  },
  deps: OnboardingRubricDeps = {},
): Promise<AdImageVariant[] | null> {
  try {
    const config = readRubricJudgeConfig(deps.env);
    const sampled = sampledVariants(input.variants, isRealImage, config, deps.random);
    if (sampled.length === 0) return null;

    const brief = sampled.some((v) => v.gates?.passed) ? await briefFor(input.userId, deps) : {};
    const previousAt = input.previous?.completedAt;
    const pool =
      previousAt && previousAt < input.completedAt
        ? (input.previous?.variants ?? []).filter(isRealImage).map((v) => asPriorCandidate(input.userId, v, previousAt, 'previous-run:'))
        : [];

    const judged = new Map<string, AdImageVariant>();
    await Promise.all(
      sampled.map(async (v) => {
        const variantBrief = { ...brief, generationRequest: v.prompt };
        const creativeRubric = await judgeGatedImage(
          { imageUrl: v.imageUrl, gates: v.gates, surface: 'ad_image' },
          variantBrief,
          config,
          deps.llm,
        );
        const creativePairwise =
          creativeRubric.status === 'ok' && pool.length > 0
            ? await pairwiseVsPriorBest(asPriorCandidate(input.userId, v, input.completedAt, ''), pool, variantBrief, config, deps.llm)
            : null;
        judged.set(v.id, { ...v, creativeRubric, ...(creativePairwise ? { creativePairwise } : {}) });
      }),
    );

    const variants = input.variants.map((v) => judged.get(v.id) ?? v);
    const saved = await save(
      () => (deps.saveImageVariants ?? defaultSaveImageVariants)(input.userId, input.completedAt, variants),
      'the ad image run',
    );
    return saved ? variants : null;
  } catch (err) {
    warn('image rubric hook failed (non-fatal)', err);
    return null;
  }
}

function copyOf(v: AdCopyVariant): CreativeCopy {
  return { headline: v.headline, primaryText: v.primaryText, cta: v.cta };
}

/**
 * Judges a ready onboarding copy run's sampled variants: as the full ad with the matching image
 * when that image exists and passed its gates, otherwise the copy on its own. Stores the verdict
 * on each copy variant. Returns the variants as stored, or null. Never throws.
 */
export async function judgeOnboardingAdCopy(
  input: {
    userId: string;
    /** `adCopyCompletedAt` of the stored result being judged. */
    completedAt: string;
    copyVariants: AdCopyVariant[];
    imageVariants: AdImageVariant[];
  },
  deps: OnboardingRubricDeps = {},
): Promise<AdCopyVariant[] | null> {
  try {
    const config = readRubricJudgeConfig(deps.env);
    const sampled = sampledVariants(input.copyVariants, () => true, config, deps.random);
    if (sampled.length === 0) return null;

    const brief = await briefFor(input.userId, deps);
    const judged = new Map<string, AdCopyVariant>();
    await Promise.all(
      sampled.map(async (v) => {
        const image = input.imageVariants.find((i) => i.id === v.id && isRealImage(i) && i.gates?.passed);
        const creativeRubric: CreativeRubricResult = image
          ? await judgeGatedImage(
              { imageUrl: image.imageUrl, gates: image.gates, copy: copyOf(v), surface: 'ad_image' },
              { ...brief, generationRequest: image.prompt },
              config,
              deps.llm,
            )
          : await judgeAdCopy(copyOf(v), brief, { model: config.model, ...(deps.llm ? { llm: deps.llm } : {}) });
        judged.set(v.id, { ...v, creativeRubric });
      }),
    );

    const variants = input.copyVariants.map((v) => judged.get(v.id) ?? v);
    const saved = await save(
      () => (deps.saveCopyVariants ?? defaultSaveCopyVariants)(input.userId, input.completedAt, variants),
      'the ad copy run',
    );
    return saved ? variants : null;
  } catch (err) {
    warn('copy rubric hook failed (non-fatal)', err);
    return null;
  }
}
