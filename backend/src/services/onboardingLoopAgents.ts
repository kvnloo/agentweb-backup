/**
 * Onboarding loop agents — six pure functions forming the daily improvement pipeline.
 *
 * LLM model: anthropic.claude-sonnet-4-6 for both Generator and Critic.
 * (claude-opus-4-7 is the intended fallback if sonnet is unavailable, but
 * LLMService will throw on construction if the Bedrock ARN doesn't resolve —
 * the caller in onboardingLoop.ts handles that by skipping the cycle.)
 *
 * NO PII flows into any LLM call — only aggregated stats (step, variantId, n,
 * completion_rate, lift_pct). userId / email / names must never appear in prompts.
 */

import { v4 as uuidv4 } from 'uuid';
import { OnboardingLoopConfig, Variant, resolveVariant } from './onboardingLoopConfig';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StepStats {
  step: string;
  variantId: string;
  /** Users seen in last 7d who were assigned this variant for this step. */
  n: number;
  /** How many of those completed onboarding. */
  completions: number;
  /** completions / n */
  completion_rate: number;
  /** Lift vs the control variant for this step, null if this IS the control. */
  lift_pct: number | null;
}

export interface LLMServiceInterface {
  callLLM(system: string, user: string, format: 'json' | 'text'): Promise<string>;
}

// ---------------------------------------------------------------------------
// sensorScan — pure aggregation, no LLM
// ---------------------------------------------------------------------------

/**
 * Aggregates raw user records (from last 7d) into per-step per-variant stats.
 * A user "completed onboarding" if their onboardingEvents array contains an
 * entry with event === 'onboarding_completed'.
 * Variant assignment is derived deterministically via resolveVariant().
 */
export async function sensorScan(
  users: any[],
  config: OnboardingLoopConfig,
): Promise<StepStats[]> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const recentUsers = users.filter((u) => {
    const created = u.createdAt ?? '';
    return created >= cutoff;
  });

  // Accumulate counts: key = `${step}::${variantId}`
  const counts: Map<string, { n: number; completions: number }> = new Map();

  const stepNames = Object.keys(config.steps);

  for (const user of recentUsers) {
    const completed = Array.isArray(user.onboardingEvents)
      ? user.onboardingEvents.some((e: any) => e.event === 'onboarding_completed')
      : false;

    for (const step of stepNames) {
      const variant = resolveVariant(config, step, user.userId);
      if (!variant) continue;

      const key = `${step}::${variant.variantId}`;
      const existing = counts.get(key) ?? { n: 0, completions: 0 };
      existing.n += 1;
      if (completed) existing.completions += 1;
      counts.set(key, existing);
    }
  }

  // Build StepStats, compute lift vs control
  const result: StepStats[] = [];

  for (const step of stepNames) {
    const stepCfg = config.steps[step];
    if (!stepCfg?.active_variants?.length) continue;

    const controlVariant = stepCfg.active_variants.find((v) => v.type === 'control');
    const controlKey = controlVariant ? `${step}::${controlVariant.variantId}` : null;
    const controlData = controlKey ? counts.get(controlKey) : null;
    const controlRate =
      controlData && controlData.n > 0
        ? controlData.completions / controlData.n
        : null;

    for (const variant of stepCfg.active_variants) {
      const key = `${step}::${variant.variantId}`;
      const data = counts.get(key) ?? { n: 0, completions: 0 };
      const completion_rate = data.n > 0 ? data.completions / data.n : 0;

      let lift_pct: number | null = null;
      if (variant.type !== 'control' && controlRate !== null && controlRate > 0) {
        lift_pct = ((completion_rate - controlRate) / controlRate) * 100;
      }

      result.push({
        step,
        variantId: variant.variantId,
        n: data.n,
        completions: data.completions,
        completion_rate,
        lift_pct,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// diagnoseUnderperforming — pure computation, no LLM
// ---------------------------------------------------------------------------

/**
 * Returns step names where at least one non-control variant has
 * lift_pct < 0 AND n >= promote_min_n.
 * These are candidates for copy mutation.
 */
export function diagnoseUnderperforming(
  stats: StepStats[],
  config: OnboardingLoopConfig,
): string[] {
  const { promote_min_n } = config.thresholds;

  const underperformingSteps = new Set<string>();

  for (const s of stats) {
    if (
      s.lift_pct !== null &&
      s.lift_pct < 0 &&
      s.n >= promote_min_n
    ) {
      underperformingSteps.add(s.step);
    }
  }

  return [...underperformingSteps];
}

// ---------------------------------------------------------------------------
// generateMutations — LLM call
// ---------------------------------------------------------------------------

interface GeneratedVariantsResponse {
  variants: Array<{
    heading?: string;
    description?: string;
    cta?: string;
    ctaSkip?: string;
  }>;
}

/**
 * Calls LLM to generate 2–3 new copy variants for an underperforming step.
 * Returns Variant objects with variantId='generated-{uuid}', type='treatment', weight=0.1.
 */
export async function generateMutations(
  step: string,
  currentVariants: Variant[],
  stats: StepStats[],
  llmService: LLMServiceInterface,
): Promise<Variant[]> {
  const stepStats = stats
    .filter((s) => s.step === step)
    .map((s) => ({
      variantId: s.variantId,
      n: s.n,
      completion_rate: (s.completion_rate * 100).toFixed(1) + '%',
      lift_pct: s.lift_pct !== null ? s.lift_pct.toFixed(1) + '%' : 'control',
    }));

  const currentCopy = currentVariants.map((v) => ({
    variantId: v.variantId,
    type: v.type,
    copy: v.copy,
  }));

  const system =
    'You are an onboarding copy optimizer. Generate concise, clear copy variants ' +
    'that improve user onboarding completion. Focus on clarity and motivation. ' +
    'Respond with JSON only — no preamble, no markdown fences.';

  const user =
    `Step: "${step}"\n\n` +
    `Current variants:\n${JSON.stringify(currentCopy, null, 2)}\n\n` +
    `Completion stats (aggregated, no PII):\n${JSON.stringify(stepStats, null, 2)}\n\n` +
    'Generate 2-3 new copy variants as a JSON object with key "variants": ' +
    'an array of objects, each with optional fields: heading, description, cta, ctaSkip. ' +
    'Keep each field under 300 characters. Do not include HTML tags.';

  const raw = await llmService.callLLM(system, user, 'json');
  let parsed: GeneratedVariantsResponse;

  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed?.variants)) return [];

  return parsed.variants.slice(0, 3).map((v) => ({
    variantId: `generated-${uuidv4()}`,
    type: 'treatment' as const,
    weight: 0.1,
    copy: {
      ...(typeof v.heading === 'string' ? { heading: v.heading } : {}),
      ...(typeof v.description === 'string' ? { description: v.description } : {}),
      ...(typeof v.cta === 'string' ? { cta: v.cta } : {}),
      ...(typeof v.ctaSkip === 'string' ? { ctaSkip: v.ctaSkip } : {}),
    },
  }));
}

// ---------------------------------------------------------------------------
// validateBusinessRules — pure computation
// ---------------------------------------------------------------------------

const HTML_TAG_RE = /<[^>]+>/;
const MAX_COPY_FIELD_LEN = 300;

export interface ValidationResult {
  valid: Variant[];
  rejected: { variant: Variant; reason: string }[];
}

/**
 * Enforces business rules:
 * 1. Step must be in allowlist (if allowlist is non-empty).
 * 2. All copy field values must be strings ≤ 300 chars.
 * 3. No HTML tags in copy values.
 * 4. heading and cta fields, if present, must not be empty strings.
 */
export function validateBusinessRules(
  mutations: Variant[],
  step: string,
  allowlist: string[],
): ValidationResult {
  const valid: Variant[] = [];
  const rejected: { variant: Variant; reason: string }[] = [];

  if (allowlist.length > 0 && !allowlist.includes(step)) {
    return {
      valid: [],
      rejected: mutations.map((variant) => ({
        variant,
        reason: `Step "${step}" is not in the mutation allowlist`,
      })),
    };
  }

  for (const variant of mutations) {
    let rejectReason: string | null = null;

    for (const [field, value] of Object.entries(variant.copy)) {
      if (value === undefined) continue;

      if (typeof value !== 'string') {
        rejectReason = `Copy field "${field}" is not a string`;
        break;
      }
      if (value.length > MAX_COPY_FIELD_LEN) {
        rejectReason = `Copy field "${field}" exceeds ${MAX_COPY_FIELD_LEN} chars (got ${value.length})`;
        break;
      }
      if (HTML_TAG_RE.test(value)) {
        rejectReason = `Copy field "${field}" contains HTML tags`;
        break;
      }
      if ((field === 'heading' || field === 'cta') && value.trim() === '') {
        rejectReason = `Copy field "${field}" must not be empty`;
        break;
      }
    }

    if (rejectReason) {
      rejected.push({ variant, reason: rejectReason });
    } else {
      valid.push(variant);
    }
  }

  return { valid, rejected };
}

// ---------------------------------------------------------------------------
// critiqueMutations — LLM call
// ---------------------------------------------------------------------------

interface CritiqueItem {
  variantId: string;
  clarity: number;
  specificity: number;
  tone: number;
  feedback: string;
}

interface CritiqueResponse {
  critiques: CritiqueItem[];
}

/**
 * Scores each mutation on clarity (1–5), specificity (1–5), tone (1–5).
 * Returns variants sorted by score desc. Only variants scoring >= 8/15 pass.
 */
export async function critiqueMutations(
  mutations: Variant[],
  step: string,
  llmService: LLMServiceInterface,
): Promise<{ variant: Variant; score: number; feedback: string }[]> {
  if (mutations.length === 0) return [];

  const system =
    'You are an expert UX copywriter evaluating onboarding copy quality. ' +
    'Score each variant on three dimensions: clarity (1-5), specificity (1-5), ' +
    'tone (1-5). Respond with JSON only — no preamble, no markdown fences.';

  const variantSummaries = mutations.map((v) => ({
    variantId: v.variantId,
    copy: v.copy,
  }));

  const user =
    `Step: "${step}"\n\n` +
    `Variants to score:\n${JSON.stringify(variantSummaries, null, 2)}\n\n` +
    'Return a JSON object with key "critiques": an array where each element has: ' +
    'variantId (string), clarity (1-5), specificity (1-5), tone (1-5), feedback (string).';

  const raw = await llmService.callLLM(system, user, 'json');
  let parsed: CritiqueResponse;

  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed?.critiques)) return [];

  const variantMap = new Map(mutations.map((v) => [v.variantId, v]));

  const scored = parsed.critiques
    .map((c) => {
      const variant = variantMap.get(c.variantId);
      if (!variant) return null;

      const clarity = Math.min(5, Math.max(1, Number(c.clarity) || 1));
      const specificity = Math.min(5, Math.max(1, Number(c.specificity) || 1));
      const tone = Math.min(5, Math.max(1, Number(c.tone) || 1));
      const score = clarity + specificity + tone;

      return { variant, score, feedback: c.feedback ?? '' };
    })
    .filter((x): x is { variant: Variant; score: number; feedback: string } => x !== null)
    .filter((x) => x.score >= 8)
    .sort((a, b) => b.score - a.score);

  return scored;
}
