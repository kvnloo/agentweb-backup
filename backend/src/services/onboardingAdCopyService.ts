/**
 * Onboarding Epic Phase 2 — Ad copy service.
 *
 * Step 6 of the B2B lead-gen ads work plan (`plan_1768351741814_jgc2wwlxa`).
 * REPLACES the legacy `onboardingAdGenerator.ts` (single-shot generic 3-angle).
 *
 * The new flow:
 *   1. Wait for `adImageStatus === 'ready'` (images come from Step 5 / Gemini).
 *   2. For each image variant (up to 3), pick a distinct Brick 10 variety
 *      (Problem Agitation / Competitor Contrast / Social Proof Led /
 *      Passive Benefit / Direct Response / Pain Point).
 *   3. LLM call per variant with the Brick 10 system prompt — enforces the
 *      first-125-char hook rule.
 *   4. Attach the generated copy to the matching image variant id, return
 *      `{ variants: [{id, headline, primaryText, cta, variety}] }`.
 *   5. Patch User via `adCopyReadyPatch`.
 *
 * Same fire-and-forget orchestration pattern as the other onboarding
 * services. The route layer wraps with `adCopyStartPatch` synchronously and
 * launches the background work via `startAdCopyForUser`.
 *
 * The system prompt is the verbatim Step 6 description from the prod work
 * plan. Do NOT rewrite it locally — if Step 6 changes, update the prod plan
 * via `manage_predefined_work_plan` and re-pull. The unit test asserts the
 * prompt contains "Brick 10" + the 125-character hook rule.
 */

import { withClearedError } from "../utils/clearErrorOnClaim";
import { LLMService } from "../utils/llmService";
import type { LLMUsageContext } from "../utils/llmService";
import { reportUIError } from "../utils/errorReporter";
import { userDb } from "./db";
import {
  adCopyFailedPatch,
  adCopyReadyPatch,
  adCopyStartPatch,
  AdCopyResult,
  AdCopyStatusFields,
  AdCopyVariant,
  AD_COPY_TIMEOUT_MS,
} from "./adCopyStatusService";
import {
  extractIcpBrandContext,
  IcpBrandContext,
} from "./onboardingIcpService";
import type { ICPPersona } from "./icpStatusService";
import type { CreativeDirResult } from "./creativeDirStatusService";
import type { AdImageVariant } from "./adImageStatusService";
import {
  AdVariantRatingFields,
  recentRejectedRatings,
} from "./adVariantRatingService";
import { trackBackgroundRun } from "../utils/trackedBackgroundRun";

/** Bedrock model alias. Same family as Steps 2 / 3 / 4. */
const AD_COPY_MODEL = "anthropic.claude-sonnet-4-6";

/** Higher temperature — copy benefits from variety. */
const AD_COPY_TEMPERATURE = 0.85;

/** Token budget per variant — headline + primary text + CTA. */
const AD_COPY_MAX_TOKENS = 1200;

/**
 * The 5 Brick 10 varieties (Meta ad copy section 10.1) — VERBATIM from prod
 * work plan `plan_1768351741814_jgc2wwlxa`, steps[5].description. The names
 * are exactly as they appear in the plan; do NOT rewrite them.
 *
 * Variants are picked round-robin from the head of this list — for 3
 * images we use the first 3 (Problem Agitation, Competitor Contrast,
 * Social Proof Led), which gives the most decorrelated test set.
 */
export const BRICK_10_VARIETIES: string[] = [
  "Problem Agitation",
  "Competitor Contrast",
  "Social Proof Led",
  "Passive Benefit",
  "Direct Response / Pain Point",
];

/** Per-variety structure note, referenced inside per-variant user prompts. */
const BRICK_10_STRUCTURES: Record<string, string> = {
  "Problem Agitation":
    "Open with a painful scenario → agitate → introduce solution → proof points → CTA",
  "Competitor Contrast":
    "Call out the competitor advantage the reader is missing → flip the narrative → CTA",
  "Social Proof Led":
    "Open with credibility/results → explain mechanism → CTA",
  "Passive Benefit":
    'Aspirational "what if" opener → mechanism → proof → CTA',
  "Direct Response / Pain Point":
    "Hyper-specific relatable scenario → solution → emoji benefit list → CTA",
};

/**
 * Step 6 system prompt — VERBATIM from prod work plan
 * `plan_1768351741814_jgc2wwlxa`, steps[5].description (Brick 10 Ads
 * Copywriting Skill, Meta section 10.1). Sourced via
 * `aws dynamodb get-item --table-name AW-WorkPlans --key '{"planId":{"S":"plan_1768351741814_jgc2wwlxa"}}'`.
 *
 * The descriptive content is unchanged. We append a strict JSON-output
 * contract because we're calling Claude directly (no agent loop).
 */
export const AD_COPY_SYSTEM_PROMPT = [
  "### Brick 10 Ads Copywriting Skill",
  "###### 10.1 Apply the following if users answer Meta ads in Step 1:",
  "Write copy for each image following these rules:",
  "## 📝 Body Text (Primary Text)",
  "### Format Rules",
  "- **First 125 characters = The Hook** — this is what appears before \"See More\" on mobile",
  "- Short paragraphs — 1–2 lines max",
  "- Pattern interrupt opening line",
  "- One clear CTA at the end",
  "- **Emojis: ✅ Yes** — used for visual breaks, benefit callouts, and CTAs (not as bullet point replacements)",
  "### 5 Varieties",
  "| # | Variety | Structure |",
  "|---|---------|-----------|",
  "| 1 | **Problem Agitation** | Open with a painful scenario → agitate → introduce solution → proof points → CTA |",
  "| 2 | **Competitor Contrast** | Call out the competitor advantage the reader is missing → flip the narrative → CTA |",
  "| 3 | **Social Proof Led** | Open with credibility/results → explain mechanism → CTA |",
  "| 4 | **While You Sleep / Passive Benefit** | Aspirational \"what if\" opener → mechanism → proof → CTA |",
  "| 5 | **Direct Response / Pain Point** | Hyper-specific relatable scenario → solution → emoji benefit list → CTA |",
  "### Body Text Template",
  "[HOOK — must land in first 125 chars]",
  "[Agitate or expand the problem — 1-2 short paragraphs]",
  "[Solution statement — what you do and how]",
  "[Proof points with emojis]",
  "📊 Stat or result",
  "⚡ Speed/ease benefit",
  "🏆 Credibility signal",
  "✓ Social proof",
  "[CTA — single line, action-oriented]",
  "## 🔠 Headlines",
  "### Format Rules",
  "- **27 characters = ideal**",
  "- **40 characters = hard max**",
  "- **Emojis: ✅ Yes** — one leading emoji works well (👉 🚀 ⚡ 🏆 ✓ 🛑 📈)",
  "- Punchy fragments only — no full sentences",
  "- Should create curiosity or urgency on their own",
  "## 🔘 CTA",
  "Pick a single CTA matching the funnel goal — \"Learn More,\" \"Sign Up,\" \"Get Offer,\" \"Book Now,\" \"Start Free,\" etc.",
  "",
  "OUTPUT CONTRACT — return ONLY valid JSON for ONE ad copy variant, no markdown:",
  "{",
  '  "headline": "Punchy headline (≤40 chars, one leading emoji ok)",',
  '  "primaryText": "Body text — first 125 chars MUST be the hook in isolation",',
  '  "cta": "Learn More" | "Sign Up" | "Get Offer" | "Book Now" | "Start Free" | "Try Free"',
  "}",
  "Return ONE variant matching the assigned variety. No commentary outside the JSON.",
].join("\n");

/**
 * One per-variant LLM response shape — the orchestrator merges the variety
 * tag + the image id back in.
 */
interface PerVariantLlmResponse {
  headline?: string;
  primaryText?: string;
  cta?: string;
}

/**
 * Pick N distinct Brick 10 varieties for N image variants. Cap at 5
 * (we only have 5 varieties). N === 0 → empty array.
 */
export function pickDistinctVarieties(n: number): string[] {
  if (!Number.isFinite(n) || n <= 0) return [];
  const cap = Math.min(n, BRICK_10_VARIETIES.length);
  return BRICK_10_VARIETIES.slice(0, cap);
}

/**
 * Build the "User has rejected these directions" negative-example block
 * for the per-variant prompt. Reads the latest 5 rejects from the User's
 * `adVariantsRated` log and looks up the matching headline / primaryText
 * on the previous `adCopyResult`. Variants that are no longer present
 * (e.g. because the user re-rolled) are silently dropped.
 *
 * Returns an empty string if no negative examples are available; the
 * caller appends only when this is non-empty so the prompt stays clean
 * on the first run.
 *
 * Exported for unit testing.
 */
export function buildNegativeExamplesBlock(
  ratings: AdVariantRatingFields,
  previousVariants: Array<{ id: string; headline: string; primaryText: string; variety?: string }>,
  limit = 5
): string {
  const rejects = recentRejectedRatings(ratings, limit);
  if (rejects.length === 0) return "";
  const lines: string[] = [];
  for (const r of rejects) {
    const prev = previousVariants.find((v) => v.id === r.variantId);
    if (!prev) continue;
    const head = (prev.headline || "").slice(0, 100);
    const body = (prev.primaryText || "").slice(0, 200);
    const tag = prev.variety ? ` [${prev.variety}]` : "";
    lines.push(`- "${head}"${tag} — ${body}`);
  }
  if (lines.length === 0) return "";
  return [
    "User REJECTED these recent ad copy directions — do NOT mimic the angle, hook, or tone:",
    ...lines,
    "Steer toward a different angle and a clearly different hook.",
  ].join("\n");
}

function buildUserPrompt(
  brand: IcpBrandContext,
  personas: ICPPersona[],
  creativeDir: CreativeDirResult,
  image: AdImageVariant,
  variety: string,
  negativeExamples = ""
): string {
  const lines: string[] = [
    `You are writing ONE Meta ad copy variant in the "${variety}" variety.`,
    `Variety structure: ${BRICK_10_STRUCTURES[variety] || "(see system prompt)"}`,
    "",
    `Company: ${brand.companyName || "(not provided)"}`,
  ];
  if (brand.companyUrl) lines.push(`Website: ${brand.companyUrl}`);
  if (brand.valueProposition)
    lines.push(`Value proposition: ${brand.valueProposition}`);
  if (brand.toneOfVoice) lines.push(`Tone of voice: ${brand.toneOfVoice}`);
  lines.push("");
  if (personas.length > 0) {
    const p = personas[0];
    lines.push("Primary ICP:");
    lines.push(`  Name: ${p.name}`);
    lines.push(`  Pain: ${p.pain}`);
    lines.push(`  Desire: ${p.desire}`);
    lines.push(`  Objection: ${p.objection}`);
  }
  lines.push("");
  lines.push("Creative direction (from Step 4):");
  if (creativeDir.concepts.length)
    lines.push(`  Concepts: ${creativeDir.concepts.slice(0, 6).join(" | ")}`);
  if (creativeDir.copy_angles.length)
    lines.push(`  Copy angles: ${creativeDir.copy_angles.slice(0, 5).join(" | ")}`);
  lines.push("");
  lines.push("Image this copy will sit beside:");
  lines.push(`  Image id: ${image.id}`);
  lines.push(`  Image prompt / description: ${image.prompt}`);
  lines.push("");
  if (negativeExamples) {
    lines.push("");
    lines.push(negativeExamples);
  }
  lines.push("");
  lines.push(
    `Write ONE variant in the "${variety}" variety. The first 125 characters of primaryText MUST stand alone as the hook (mobile users see only that before "See More"). Headline ≤ 40 chars. Return JSON matching the schema in the system prompt.`
  );
  return lines.join("\n");
}

/**
 * Pure LLM loop — one call per image variant, each tagged with a distinct
 * Brick 10 variety. Exported for unit-testing with injected fakes.
 */
export async function generateAdCopyForUser(
  images: AdImageVariant[],
  creativeDir: CreativeDirResult,
  personas: ICPPersona[],
  brand: IcpBrandContext,
  deps: { llm?: { generateJsonRobust: LLMService["generateJsonRobust"] } } = {},
  negativeExamples = "",
  usageContext?: LLMUsageContext
): Promise<AdCopyResult> {
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error("ad copy requires at least one image variant");
  }
  const llm =
    deps.llm ??
    new LLMService(AD_COPY_MODEL, AD_COPY_TEMPERATURE, AD_COPY_MAX_TOKENS);
  const varieties = pickDistinctVarieties(images.length);
  const out: AdCopyVariant[] = [];

  for (let i = 0; i < images.length && i < varieties.length; i++) {
    const image = images[i];
    const variety = varieties[i];
    const userPrompt = buildUserPrompt(
      brand,
      personas,
      creativeDir,
      image,
      variety,
      negativeExamples
    );
    // generateJsonRobust: retry-once on prose preambles. Per-variant loop
    // means one bad call won't cascade-fail the whole ad-copy step.
    // ENG-1858: metered to the onboarding user (was feature "unknown" / "system").
    const raw = await llm.generateJsonRobust<PerVariantLlmResponse>(
      AD_COPY_SYSTEM_PROMPT,
      userPrompt,
      undefined,
      usageContext ?? { feature: "onboarding_ad_copy" },
    );
    out.push({
      id: image.id,
      headline: typeof raw?.headline === "string" ? raw.headline : "",
      primaryText: typeof raw?.primaryText === "string" ? raw.primaryText : "",
      cta: typeof raw?.cta === "string" && raw.cta.length > 0 ? raw.cta : "Learn More",
      variety,
    });
  }

  return { variants: out };
}

/**
 * Fire-and-forget orchestrator. Reads the User record, requires
 * `adImageStatus === 'ready'` with non-empty `adImageResult.variants`, and
 * runs the per-variant LLM loop. Patches the User with the result.
 *
 * If images aren't ready, fails the run with a clear error so the UI can
 * render the "waiting for images" state.
 */
/**
 * Restate "the `running` record is still the one THIS run claimed" as a
 * DynamoDB condition (ENG-2308 review follow-up, confirmed by direct
 * reproduction — see onboardingIcpService's `icpOwnershipCondition` for
 * the full reasoning, identical here).
 */
function adCopyOwnershipCondition(expectedStartedAt: string) {
  return {
    expression: "#adCopyStartedAt = :adCopyOwnerStartedAt",
    names: { "#adCopyStartedAt": "adCopyStartedAt" },
    values: { ":adCopyOwnerStartedAt": expectedStartedAt },
  };
}

/**
 * Write a patch on behalf of THIS claimed run only, dropping it silently
 * (instead of writing) when a later reclaim already owns the axis. No-ops
 * to a plain unconditional write when the caller has no claim identity
 * (backward compatible with direct callers/tests that bypass the claim).
 */
async function writeIfStillOurs(
  userId: string,
  patch: Record<string, unknown>,
  expectedStartedAt: string | undefined,
  logLabel: string,
): Promise<boolean> {
  if (!expectedStartedAt) {
    await userDb.updateUser(userId, patch as any);
    return true;
  }
  try {
    await userDb.updateUser(userId, patch as any, {
      condition: adCopyOwnershipCondition(expectedStartedAt),
    });
    return true;
  } catch (err: any) {
    if (err?.code === "ConditionalCheckFailedException") {
      console.warn(
        `[onboardingAdCopyService] dropping stale ${logLabel} — a newer claim owns the axis`,
        { userId },
      );
      return false;
    }
    throw err;
  }
}

export async function triggerAdCopyForUser(
  userId: string,
  deps: {
    llm?: { generateJsonRobust: LLMService["generateJsonRobust"] };
    expectedStartedAt?: string;
  } = {}
): Promise<void> {
  const user = await userDb.getUserById(userId);
  if (!user) return;

  const u = user as any;
  const adImageStatus = typeof u.adImageStatus === "string" ? u.adImageStatus : "idle";
  const imageVariants: AdImageVariant[] =
    u.adImageResult && Array.isArray(u.adImageResult.variants)
      ? (u.adImageResult.variants as AdImageVariant[])
      : [];

  // Wait-for-image gate. Until task 4 (Gemini image gen) ships, this will
  // never be 'ready' — the route returns failed and the UI waits.
  if (adImageStatus !== "ready" || imageVariants.length === 0) {
    const reason =
      adImageStatus !== "ready"
        ? `image generation not ready (status=${adImageStatus})`
        : "image generation completed with no variants";
    const current = await userDb.getUserById(userId);
    await writeIfStillOurs(
      userId,
      adCopyFailedPatch((current as any) || {}, reason) as any,
      deps.expectedStartedAt,
      "gated-by-image-step failure",
    );
    console.error("[onboardingAdCopyService] gated by image step", {
      userId,
      reason,
    });
    void reportUIError({
      operation: "onboarding:ad-copy:gated-ad-image",
      errorMessage: reason,
      userId,
      context: {
        Source: "backend",
        Step: "adCopy",
        adImageStatus,
        variantCount: String(imageVariants.length),
      },
    });
    return;
  }

  const personas: ICPPersona[] = Array.isArray(u.icpResult)
    ? (u.icpResult as ICPPersona[])
    : [];
  const creativeDir: CreativeDirResult =
    u.creativeDirResult && typeof u.creativeDirResult === "object"
      ? (u.creativeDirResult as CreativeDirResult)
      : { concepts: [], copy_angles: [], format_archetypes: [] };
  const brand = extractIcpBrandContext(u);

  // Pull existing copy variants (if any) so we can map rejected variantId
  // back to the headline / primaryText that the user swiped left on.
  // First-run users have no previousVariants and no ratings — the negative
  // block is empty.
  const previousVariants = Array.isArray(u.adCopyResult?.variants)
    ? (u.adCopyResult.variants as Array<{
        id: string;
        headline: string;
        primaryText: string;
        variety?: string;
      }>)
    : [];
  const negativeExamples = buildNegativeExamplesBlock(
    { adVariantsRated: u.adVariantsRated },
    previousVariants
  );

  try {
    // ENG-1858: attribute and charge the copy generation to this user.
    const usageContext: LLMUsageContext = { userId, feature: "onboarding_ad_copy" };
    const result = await generateAdCopyForUser(
      imageVariants,
      creativeDir,
      personas,
      brand,
      deps,
      negativeExamples,
      usageContext
    );
    const current = await userDb.getUserById(userId);
    const patch = adCopyReadyPatch((current as any) || {}, result);
    if (!patch) {
      // Stale completion — drop silently.
      return;
    }
    const wrote = await writeIfStillOurs(
      userId,
      patch as any,
      deps.expectedStartedAt,
      "completion",
    );
    if (!wrote) return;
    // ENG-2192: advisory rubric verdicts on the stored copy, with each variant's image when it
    // has one (inert unless CREATIVE_RUBRIC_JUDGE_ENABLED + sample rate). Not awaited; never throws.
    const { adCopyCompletedAt, adCopyResult } = patch;
    if (adCopyCompletedAt && adCopyResult) {
      void import("./creativeRubricOnboarding")
        .then((m) =>
          m.judgeOnboardingAdCopy({
            userId,
            completedAt: adCopyCompletedAt,
            copyVariants: adCopyResult.variants,
            imageVariants,
          })
        )
        .catch(() => undefined);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const current = await userDb.getUserById(userId);
    await writeIfStillOurs(
      userId,
      adCopyFailedPatch((current as any) || {}, msg) as any,
      deps.expectedStartedAt,
      "failure",
    );
    console.error("[onboardingAdCopyService] generation failed", {
      userId,
      err: msg,
    });
    void reportUIError({
      operation: "onboarding:ad-copy:llm-generation",
      errorMessage: msg,
      userId,
      context: {
        Source: "backend",
        Step: "adCopy",
        Stack: err instanceof Error ? (err.stack ?? "").slice(0, 1000) : "",
      },
    });
  }
}

/**
 * Guards the non-running -> `running` transition with a DynamoDB
 * ConditionExpression (ENG-2308) — same race as the icp/competitor axes: a
 * plain read-then-write here lets two concurrent callers both observe a
 * non-running status and both win, launching two fully parallel LLM calls.
 *
 * Also allows a fresh claim once the in-flight run has exceeded
 * `AD_COPY_TIMEOUT_MS` — see `icpStartClaimCondition`'s docstring in
 * `onboardingIcpService.ts` for why: without this, a run genuinely stuck
 * in `running` (lost to a deploy/crash) could never be retried again.
 */
function adCopyStartClaimCondition(now: Date = new Date()) {
  const staleBefore = new Date(now.getTime() - AD_COPY_TIMEOUT_MS).toISOString();
  return {
    expression:
      "attribute_not_exists(#adCopyStatus) OR #adCopyStatus <> :adCopyRunning OR #adCopyStartedAt <= :adCopyStaleBefore",
    names: { "#adCopyStatus": "adCopyStatus", "#adCopyStartedAt": "adCopyStartedAt" },
    values: { ":adCopyRunning": "running", ":adCopyStaleBefore": staleBefore },
  };
}

/**
 * Claim the ad-copy axis for a new run: atomically flip `adCopyStatus` to
 * `running` (or no-op, returning `null`, if someone else already holds
 * the claim). Every entry point that wants to run ad-copy generation must
 * go through here — both `/ad-copy/start` (via `startAdCopyForUser`) and
 * the eager-pipeline orchestrator's `runAdCopy`
 * (`onboardingOrchestratorWiring.ts`).
 *
 * `runAdCopy` needed this split out (ENG-2308 follow-up, caught live): it
 * used to call `triggerAdCopyForUser` directly, with nothing ever flipping
 * `adCopyStatus` to `running` first on a pure orchestrator-driven cascade.
 * `adCopyReadyPatch` requires `current.adCopyStatus === 'running'` to
 * persist a result — without it, the trigger ran for real then silently
 * dropped its result, and the orchestrator recorded the step `ready` with
 * a `null` output anyway, since nothing threw.
 */
export async function claimAdCopyRun(
  userId: string,
): Promise<AdCopyStatusFields | null> {
  const patch = adCopyStartPatch();
  try {
    await userDb.updateUser(userId, withClearedError(patch, "adCopyError") as any, {
      condition: adCopyStartClaimCondition(),
    });
  } catch (err: any) {
    if (err?.code === "ConditionalCheckFailedException") {
      return null;
    }
    throw err;
  }
  return patch;
}

/**
 * Synchronous entry point for routes — flips status to `running` and
 * launches background work. Returns the persisted start patch, or `null`
 * if a concurrent caller already claimed this run (ENG-2308) — callers
 * must NOT launch a second background generation in that case.
 *
 * Checks eager-pipeline status BEFORE claiming (ENG-2308 fix-of-a-fix,
 * caught live) — same reasoning as `startIcpDiscoveryForUser`'s docstring:
 * the orchestrator's `runAdCopy` claims this SAME axis itself when it
 * fires the step, inside the SAME reconcile pass this function would hand
 * off to. Claiming here too would always win first and starve it.
 */
export async function startAdCopyForUser(
  userId: string,
  deps: { llm?: { generateJsonRobust: LLMService["generateJsonRobust"] } } = {}
): Promise<AdCopyStatusFields | null> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    isEagerPipelineActiveFor,
    reconcileForUser,
  } = require("./onboardingOrchestratorWiring");
  const current = (await userDb.getUserById(userId)) as
    | { useEagerPipeline?: boolean }
    | null;
  if (isEagerPipelineActiveFor(current)) {
    void reconcileForUser(userId);
    return null;
  }
  const patch = await claimAdCopyRun(userId);
  if (!patch) return null;
  // Tracked so a deploy's graceful shutdown waits for this run (cronJobRegistry
  // is drained before the listener closes) instead of killing it mid-flight and
  // leaving a dead `running` claim that nothing completes until it times out.
  trackBackgroundRun(
    "onboardingAdCopy",
    triggerAdCopyForUser(userId, {
      ...deps,
      expectedStartedAt: patch.adCopyStartedAt,
    }),
  );
  return patch;
}
