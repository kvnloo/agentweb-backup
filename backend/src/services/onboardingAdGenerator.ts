/**
 * Onboarding v2 Phase 4 — ad creative generator.
 *
 * The missing half of PR #1300. That PR shipped the state machine + REST
 * endpoints (`generating → ready | failed` on the User record, variants
 * persisted back) but left the actual LLM invocation as a deliberate
 * follow-up slice. This module is that slice.
 *
 * Flow the caller (the `/ad-gen/start` route) orchestrates:
 *   1. `adGenStartPatch` → User flagged `generating`, status returned to UI.
 *   2. `triggerAdGenerationForUser(userId)` kicks off an async LLM call that
 *      reads whatever context the onboarding flow has captured so far
 *      (brand data, picked channel + ad goal + ICP hint from onboarding
 *      events) and asks Claude for 3 variants.
 *   3. On success the generator patches the User with
 *      `adGenReadyPatch(..., variants)` so subsequent `/status` polls see
 *      the persisted variants. On failure it patches with
 *      `adGenFailedPatch(...)` so the UI can render the retry state.
 *
 * Why a separate file instead of extending adGenStatusService:
 *   - adGenStatusService is pure state-machine math — no I/O. Keep it that
 *     way so it stays trivially unit-testable.
 *   - The LLM call has a different failure surface (network, rate limit,
 *     malformed JSON) and deserves its own sanitisation + retry logic.
 *
 * The generator uses the same Bedrock / Claude model the rest of the app
 * routes through `LLMService` so we get the shared usage/metrics plumbing
 * without wiring a separate SDK.
 */

import { LLMService } from "../utils/llmService";
import { userDb } from "./db";
import {
  adGenFailedPatch,
  adGenReadyPatch,
  adGenStartPatch,
  AdVariant,
  MAX_AD_VARIANTS,
} from "./adGenStatusService";

/** Bedrock model alias. Matches the rest of the onboarding-v2 flow. */
const AD_GEN_MODEL = "anthropic.claude-sonnet-4-6";

/** Temperature — higher than default because ad copy benefits from some variety. */
const AD_GEN_TEMPERATURE = 0.9;

/** Max tokens — enough for 3 variants × (headline + 2-sentence body + CTA). */
const AD_GEN_MAX_TOKENS = 2000;

/**
 * Shape extracted from the User record's brandGuidelines field. Kept loose
 * (everything optional) because early in onboarding the brand build may
 * have only populated a subset before Phase 4 fires.
 */
export interface AdGenBrandContext {
  companyName?: string;
  companyUrl?: string;
  tagline?: string;
  toneOfVoice?: string;
  valueProposition?: string;
  targetAudience?: string;
}

/**
 * Picks channel + ad goal + ICP hint + value-prop override out of the
 * onboarding event log. The event log is the source of truth for what the
 * user answered in Phase 2 + Phase 3 (see `onboardingEvents.ts`).
 */
export interface AdGenOnboardingContext {
  channel?: "meta" | "linkedin" | string;
  adGoal?: "demo" | "page_views" | "purchases" | string;
  icp?: string;
  valuePropOverride?: string;
}

/**
 * Shape the LLM is required to return. Parsed via JsonOutputParser — any
 * shape drift is caught at sanitise time (the route layer runs
 * `sanitizeAdVariants` on the return value before persisting).
 */
interface LlmResponse {
  variants: Array<{
    id?: string;
    headline: string;
    primaryText: string;
    cta: string;
  }>;
}

function buildSystemPrompt(): string {
  return [
    "You are a senior performance-marketing copywriter specialising in B2B",
    "SaaS direct-response ads on Meta and LinkedIn. You write ads that hook",
    "on a specific pain, promise one concrete outcome, and end with a single",
    "clear CTA. You never write vague brand-speak (e.g. 'unlock potential'",
    "'next-gen platform'). You prefer active voice and specific nouns.",
    "",
    "You always return exactly 3 distinct variants that test different angles",
    "(pain-first, outcome-first, curiosity-first). Each variant must be",
    "tonally aligned with the brand's voice if one is provided.",
    "",
    "Output a single JSON object with this exact shape:",
    '  { "variants": [',
    '    { "id": "v1", "headline": "...", "primaryText": "...", "cta": "..." },',
    '    { "id": "v2", ... },',
    '    { "id": "v3", ... }',
    "  ] }",
    "",
    "Constraints:",
    "- headline: max 40 characters, punchy, no emoji, no trailing punctuation.",
    "- primaryText: 2-3 sentences, max 400 characters. Lead with the hook.",
    "- cta: one of 'Learn more', 'Get started', 'Book a demo', 'Try free', 'Sign up' — pick based on ad goal.",
    "- ids are v1, v2, v3 in that order.",
    "- Return ONLY valid JSON. No markdown fences, no commentary.",
  ].join("\n");
}

function buildUserPrompt(
  brand: AdGenBrandContext,
  onboarding: AdGenOnboardingContext,
): string {
  const lines: string[] = [
    `Generate 3 ${onboarding.channel === "linkedin" ? "LinkedIn" : "Meta"} ad variants for:`,
    "",
    `Company: ${brand.companyName || "(not provided)"}`,
  ];
  if (brand.companyUrl) lines.push(`Website: ${brand.companyUrl}`);
  if (brand.tagline) lines.push(`Tagline: ${brand.tagline}`);
  if (brand.valueProposition)
    lines.push(`Value proposition: ${brand.valueProposition}`);
  if (brand.targetAudience)
    lines.push(`Target audience: ${brand.targetAudience}`);
  if (brand.toneOfVoice) lines.push(`Tone of voice: ${brand.toneOfVoice}`);
  if (onboarding.icp) lines.push(`Specific ICP: ${onboarding.icp}`);
  if (onboarding.valuePropOverride)
    lines.push(`Value prop (user override): ${onboarding.valuePropOverride}`);

  lines.push("");
  lines.push(`Ad goal: ${describeAdGoal(onboarding.adGoal)}`);
  lines.push(
    `Channel-specific guidance: ${describeChannelGuidance(onboarding.channel)}`,
  );
  lines.push("");
  lines.push(
    "Write 3 distinct variants. Return JSON matching the schema in the system prompt.",
  );
  return lines.join("\n");
}

function describeAdGoal(goal?: string): string {
  switch (goal) {
    case "demo":
      return "Drive booked demos. CTA should map to 'Book a demo'. Primary text should promise a specific value shown in the demo.";
    case "page_views":
      return "Drive page views for awareness / top-of-funnel. CTA should map to 'Learn more'. Primary text should tease a curiosity-gap insight.";
    case "purchases":
      return "Drive direct purchases / signups. CTA should map to 'Get started' or 'Try free'. Primary text should lead with the outcome the user gets after paying.";
    default:
      return "Generic direct response — lead with pain, close with outcome. CTA: 'Learn more'.";
  }
}

function describeChannelGuidance(channel?: string): string {
  if (channel === "linkedin") {
    return "LinkedIn feed — assume a B2B decision-maker reading during work hours. First-person POV lands well. Reference industry / role when it fits. No hype.";
  }
  return "Meta feed — assume scrolling on mobile between distractions. First 6 words must hook. Specific numbers beat adjectives.";
}

/**
 * Read the onboarding event log on the User record and project the fields
 * Phase 4 cares about. Picks the MOST RECENT occurrence of each event
 * type so a user who backtracked + changed their answer gets their latest
 * choice reflected.
 */
export function extractOnboardingContext(
  onboardingEvents: Array<{ event: string; ts: string; data?: Record<string, unknown> }> | undefined,
): AdGenOnboardingContext {
  if (!onboardingEvents || onboardingEvents.length === 0) return {};
  const byEvent: Record<string, Record<string, unknown> | undefined> = {};
  // Sort oldest → newest so later writes win.
  const sorted = [...onboardingEvents].sort((a, b) =>
    (a.ts || "") < (b.ts || "") ? -1 : 1,
  );
  for (const e of sorted) {
    byEvent[e.event] = e.data;
  }
  const channelSel = byEvent["channel_selected"];
  const icpSel = byEvent["icp_selected"];
  const valueProp = byEvent["value_prop_edited"];
  return {
    channel: typeof channelSel?.["channel"] === "string" ? (channelSel!["channel"] as string) : undefined,
    adGoal: typeof channelSel?.["adGoal"] === "string" ? (channelSel!["adGoal"] as string) : pickAdGoal(byEvent),
    icp: typeof icpSel?.["icp"] === "string" ? (icpSel!["icp"] as string) : undefined,
    valuePropOverride:
      typeof valueProp?.["value"] === "string"
        ? (valueProp!["value"] as string)
        : undefined,
  };
}

/** The ad-goal is tracked on its own event type in some flows — check both. */
function pickAdGoal(byEvent: Record<string, Record<string, unknown> | undefined>): string | undefined {
  const dedicated = byEvent["ad_goal_selected"];
  if (typeof dedicated?.["adGoal"] === "string") {
    return dedicated!["adGoal"] as string;
  }
  return undefined;
}

/**
 * Project brand context out of the persisted `brandGuidelines` field on
 * the User record. Tolerant of partial data — any field may be absent
 * early in onboarding.
 */
export function extractBrandContext(user: {
  companyName?: string;
  productDomain?: string;
  brandGuidelines?: {
    brandData?: {
      brandName?: string;
      tagline?: string;
      domain?: string;
      toneOfVoice?: string;
      valueProposition?: string;
      targetAudience?: string;
    };
  };
}): AdGenBrandContext {
  const bd = user.brandGuidelines?.brandData || {};
  return {
    companyName: bd.brandName || user.companyName || undefined,
    companyUrl: bd.domain || user.productDomain || undefined,
    tagline: bd.tagline,
    toneOfVoice: bd.toneOfVoice,
    valueProposition: bd.valueProposition,
    targetAudience: bd.targetAudience,
  };
}

/**
 * Core LLM call. Exported for unit-testing with an injected LLMService.
 */
export async function generateAdVariants(
  brand: AdGenBrandContext,
  onboarding: AdGenOnboardingContext,
  deps: { llm?: LLMService } = {},
): Promise<AdVariant[]> {
  const llm =
    deps.llm ?? new LLMService(AD_GEN_MODEL, AD_GEN_TEMPERATURE, AD_GEN_MAX_TOKENS);
  const system = buildSystemPrompt();
  const user = buildUserPrompt(brand, onboarding);
  const raw = await llm.generateJSONContent<LlmResponse>(system, user, "json");
  if (!raw || !Array.isArray(raw.variants)) {
    throw new Error("LLM returned no variants");
  }
  // Map + normalize ids before handing off to the route's sanitiser.
  return raw.variants.slice(0, MAX_AD_VARIANTS).map((v, i) => ({
    id: v.id || `v${i + 1}`,
    headline: v.headline || "",
    primaryText: v.primaryText || "",
    cta: v.cta || "Learn more",
  }));
}

/**
 * Fire-and-forget orchestrator. Intended to be called from the
 * `/ad-gen/start` route AFTER the status has been flipped to `generating`.
 * Resolves immediately so the route can respond; the LLM work runs in
 * the background and patches the User record on completion.
 *
 * Returns a promise that resolves when the LLM round-trip finishes — most
 * callers should NOT await it (onboarding UX polls /status instead). Tests
 * can await it to assert the persisted variants.
 */
export async function triggerAdGenerationForUser(
  userId: string,
  deps: { llm?: LLMService } = {},
): Promise<void> {
  const user = await userDb.getUserById(userId);
  if (!user) {
    // Nothing to do — the caller should have validated before reaching us.
    return;
  }
  const brand = extractBrandContext(user as any);
  const onboarding = extractOnboardingContext((user as any).onboardingEvents);
  try {
    const variants = await generateAdVariants(brand, onboarding, deps);
    // Re-read the user to compute the patch off the latest state.
    const current = await userDb.getUserById(userId);
    const patch = adGenReadyPatch(current || {}, variants);
    if (!patch) {
      // User is no longer in `generating` (they may have navigated away + we
      // flipped to failed elsewhere). Drop silently — a stale completion is
      // not an error.
      return;
    }
    await userDb.updateUser(userId, patch);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const current = await userDb.getUserById(userId);
    await userDb.updateUser(userId, adGenFailedPatch(current || {}, msg));
    // Log for metrics but don't rethrow — the failure is already persisted.
    console.error("[onboardingAdGenerator] generation failed", { userId, err: msg });
  }
}

/**
 * Synchronous entry point for routes — flips the status to `generating`
 * and launches the async generation in the background. Returns once the
 * status patch has been persisted so the caller can respond with the
 * snapshot the UI expects.
 */
export async function startAdGenerationForUser(userId: string, deps: { llm?: LLMService } = {}): Promise<void> {
  await userDb.updateUser(userId, adGenStartPatch());
  // Intentionally not awaited — the route returns immediately.
  // Errors inside triggerAdGenerationForUser are already caught + persisted.
  void triggerAdGenerationForUser(userId, deps);
}
