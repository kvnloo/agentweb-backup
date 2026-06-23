/**
 * Onboarding Epic Phase 2 — Creative direction service.
 *
 * Step 4 of the B2B lead-gen ads work plan (`plan_1768351741814_jgc2wwlxa`).
 * Reads the ICPs (Step 2) and the competitor result (Step 3) persisted on
 * the User record, then runs a single LLM call to produce the 6 psychological
 * concepts, 5 copy angles, and visual format archetypes (Brick 4 — Creative
 * Direction + Format Archetypes).
 *
 * Same fire-and-forget orchestration pattern as `onboardingIcpService` and
 * `onboardingCompetitorService`:
 *   1. Route flips `creativeDirStatus → running` via creativeDirStartPatch.
 *   2. Route calls `startCreativeDirForUser(userId)`.
 *   3. Background: read ICPs + competitor result + brand context → LLM call
 *      → patch User with `creativeDirReadyPatch(result)` or
 *      `creativeDirFailedPatch(error)`.
 *
 * The system prompt is the verbatim Step 4 description from the prod work
 * plan. Do NOT rewrite it locally — if Step 4 changes, update the prod plan
 * via `manage_predefined_work_plan` and re-pull. The unit test asserts the
 * prompt contains BRICK 4 markers from the prod copy.
 */

import { LLMService } from "../utils/llmService";
import { reportUIError } from "../utils/errorReporter";
import { userDb } from "./db";
import {
  creativeDirFailedPatch,
  creativeDirReadyPatch,
  creativeDirStartPatch,
  CreativeDirResult,
  sanitizeCreativeDirResult,
} from "./creativeDirStatusService";
import {
  extractIcpBrandContext,
  IcpBrandContext,
} from "./onboardingIcpService";
import type { ICPPersona } from "./icpStatusService";
import type { CompetitorResult } from "./competitorStatusService";

/** Bedrock model alias. Same family as Steps 2 + 3 for tone consistency. */
const CREATIVE_DIR_MODEL = "anthropic.claude-sonnet-4-6";

/** Slightly higher temperature than competitor — creative direction benefits from variety. */
const CREATIVE_DIR_TEMPERATURE = 0.8;

/** Token budget for 6 concepts + 5 angles + multiple format archetypes. */
const CREATIVE_DIR_MAX_TOKENS = 4000;

/**
 * Step 4 system prompt — VERBATIM from prod work plan
 * `plan_1768351741814_jgc2wwlxa`, steps[3].description (Brick 4: Creative
 * Direction + Format Archetypes). Sourced via
 * `aws dynamodb get-item --table-name AW-WorkPlans --key '{"planId":{"S":"plan_1768351741814_jgc2wwlxa"}}'`.
 *
 * The descriptive content is unchanged. We append a strict JSON-output
 * contract because we're calling Claude directly (no agent loop), but the
 * concept / angle / archetype taxonomy is exactly as defined in the plan.
 */
export const CREATIVE_DIR_SYSTEM_PROMPT = [
  "## BRICK 4: CREATIVE DIRECTION + FORMAT ARCHETYPES",
  "### Purpose",
  "Define the 6 psychological concepts, 5 copy angles, AND the visual format archetypes that ensure Andromeda-level creative diversity.",
  "### The 6 Psychological Concepts",
  "1. VISCERAL MOMENT (VM)",
  "   Capture the exact moment of pain. The 3am realization, the lost deal, the screenshot that reveals the problem. Emotion-first, data-second.",
  "2. TRANSFORMATION (TR)",
  "   Before/after contrast. Show the gap between current state and desired state. The journey from problem to solution, visualized.",
  "3. SOCIAL PROOF (SP)",
  "   Leverage existing customers, testimonials, logos, stats from the Brand Guidelines. Build trust through volume and specificity of evidence.",
  "4. COMPETITIVE EDGE (CE)",
  "   Frame the product against competitors. Show what the viewer is losing by NOT using the product. Urgency through competitive loss.",
  "5. CALCULATOR (CA)",
  "   Quantified value. Lead with numbers — hours saved, revenue gained, percentage improved. Make the ROI undeniable with specific metrics.",
  "6. PATTERN INTERRUPT (PI)",
  "   Unexpected framing. Contrarian statements, surprising stats, format-breaking creative. Anything that violates feed expectations and forces attention.",
  "### The 5 Copy Angles",
  "1. PAIN AGITATION (PA)",
  "   Lead with the wound. Make it sting. Then offer the fix. Structure: Pain → Amplification → Solution",
  "2. OUTCOME VISION (OV)",
  "   Lead with the dream state. What life looks like after. Structure: Future State → How → Proof",
  "3. SOCIAL PROOF LEAD (SPL)",
  "   Open with a testimonial, stat, or customer name. Structure: Evidence → Context → CTA",
  "4. CURIOSITY HOOK (CH)",
  "   Create an information gap. Make them need to know. Structure: Question/Tease → Partial Reveal → CTA to learn more",
  "5. DIRECT CHALLENGE (DC)",
  "   Call them out. Challenge their current approach. Structure: Challenge → Evidence → Alternative",
  "### The Format Archetypes",
  "Assign each ad variant to one of these visual format categories:",
  "A. NATIVE UI FORMAT — UI element / screenshot dominant. Minimal text, edge-placed product badge.",
  "B. DATA / COMPARISON FORMAT — Hero stat or simple chart. Numbers + labels only.",
  "C. LIFESTYLE / ASPIRATIONAL FORMAT — Full-bleed environmental photography. Cinematic crop.",
  "D. TYPOGRAPHIC / MANIFESTO FORMAT — Atmospheric background, oversized headline, dark gradient overlay.",
  "E. USP + Triple Benefit Stack — Star rating + USP + 3 benefit blocks.",
  "F. Unique Advantage Vertical List — Logo + headline + 3 icon/label rows.",
  "G. Testimonial + Social Proof — Pull quote + attribution + media logos.",
  "H. CTA-Focused Grid — Logo + headline + CTA + 2x2 image grid.",
  "I. Before/After Split Panel — Two panels with vertical/horizontal divider.",
  "J. Problem-Solution Highlight — Before / After with outcome headline overlay.",
  "K. Typology/Category Before-After — 2x2 grid (before / after pairs).",
  "L. Competitor Pain/Benefit Matrix — Others vs Brand columns with ✗/✓ rows.",
  "M. Multi-Image Solution Showcase — Hero image + 2 supporting + media logos.",
  "N. Product Usage Comparison Table — Feature rows × your-brand vs alternative columns.",
  "Within a single ad set, ensure AT LEAST 3 of the format archetypes are represented.",
  "### The Math",
  "5 ICPs × 6 Concepts × 5 Angles = 150 base variants",
  "Distributed across the format archetypes = diverse visual execution.",
  "",
  "OUTPUT CONTRACT — return ONLY valid JSON matching this exact shape:",
  "{",
  '  "concepts": ["...", "...", "...", "...", "...", "..."],',
  '  "copy_angles": ["...", "...", "...", "...", "..."],',
  '  "format_archetypes": ["A", "B", "C", "D", ...]',
  "}",
  "Return EXACTLY 6 concepts, EXACTLY 5 copy angles, and AT LEAST 3 distinct format archetypes from the list above. Each entry is one short string capturing the concept/angle/archetype as it applies to this brand. No markdown, no commentary.",
].join("\n");

/** LLM response shape — validated then sanitised at the boundary. */
interface LlmResponse {
  concepts: unknown;
  copy_angles: unknown;
  format_archetypes: unknown;
}

function summarizeCompetitorResult(result: CompetitorResult): string {
  if (!result || !Array.isArray(result.per_icp) || result.per_icp.length === 0) {
    return "(no competitor analysis available — proceed with general best practices)";
  }
  const lines: string[] = [];
  for (const entry of result.per_icp.slice(0, 5)) {
    const competitors = (entry.competitor_names || []).slice(0, 5).join(", ");
    const angles = (entry.offer_angles || []).slice(0, 5).join("; ");
    lines.push(
      `  ICP "${entry.icp_id}": competitors=[${competitors}]; offer_angles=[${angles}]`
    );
  }
  return lines.join("\n");
}

function summarizePersonas(personas: ICPPersona[]): string {
  if (!Array.isArray(personas) || personas.length === 0) {
    return "(no ICPs available — generate creative direction at the brand level)";
  }
  return personas
    .slice(0, 5)
    .map((p, i) => `  ${i + 1}. ${p.name} — pain: ${p.pain}; desire: ${p.desire}`)
    .join("\n");
}

function buildUserPrompt(
  brand: IcpBrandContext,
  personas: ICPPersona[],
  competitor: CompetitorResult
): string {
  const lines: string[] = [
    "Generate the creative direction (6 concepts, 5 copy angles, 3+ format archetypes) for:",
    "",
    `Company: ${brand.companyName || "(not provided)"}`,
  ];
  if (brand.companyUrl) lines.push(`Website: ${brand.companyUrl}`);
  if (brand.tagline) lines.push(`Tagline: ${brand.tagline}`);
  if (brand.valueProposition)
    lines.push(`Value proposition: ${brand.valueProposition}`);
  if (brand.toneOfVoice) lines.push(`Tone of voice: ${brand.toneOfVoice}`);
  lines.push("");
  lines.push("ICPs (from Step 2):");
  lines.push(summarizePersonas(personas));
  lines.push("");
  lines.push("Competitor analysis (from Step 3):");
  lines.push(summarizeCompetitorResult(competitor));
  lines.push("");
  lines.push(
    "For this brand, name how each of the 6 psychological concepts and 5 copy angles will be expressed concretely. Then pick at least 3 format archetypes (A-N) that fit the brand's strongest assets (UI, stats, lifestyle imagery, manifesto-style claims, social proof, etc.)."
  );
  lines.push("Return JSON matching the schema in the system prompt.");
  return lines.join("\n");
}

/**
 * Pure LLM call — exported for unit-testing with an injected LLMService.
 */
export async function generateCreativeDirectionForUser(
  brand: IcpBrandContext,
  personas: ICPPersona[],
  competitor: CompetitorResult,
  deps: { llm?: { generateJsonRobust: LLMService["generateJsonRobust"] } } = {}
): Promise<CreativeDirResult> {
  const llm =
    deps.llm ??
    new LLMService(CREATIVE_DIR_MODEL, CREATIVE_DIR_TEMPERATURE, CREATIVE_DIR_MAX_TOKENS);
  const system = CREATIVE_DIR_SYSTEM_PROMPT;
  const user = buildUserPrompt(brand, personas, competitor);
  // generateJsonRobust: retries once with a strict suffix on parse failure.
  const raw = await llm.generateJsonRobust<LlmResponse>(system, user);
  const result = sanitizeCreativeDirResult(raw);
  if (
    result.concepts.length === 0 &&
    result.copy_angles.length === 0
  ) {
    throw new Error(
      "LLM returned no concepts or copy_angles — creative direction failed"
    );
  }
  return result;
}

/**
 * Fire-and-forget orchestrator. Reads the User record, pulls ICPs and
 * competitor result out of the persisted state, runs the LLM, and patches
 * the User with the result.
 */
export async function triggerCreativeDirForUser(
  userId: string,
  deps: { llm?: { generateJsonRobust: LLMService["generateJsonRobust"] } } = {}
): Promise<void> {
  const user = await userDb.getUserById(userId);
  if (!user) return;
  const personas: ICPPersona[] = Array.isArray((user as any).icpResult)
    ? ((user as any).icpResult as ICPPersona[])
    : [];
  const competitor: CompetitorResult =
    (user as any).competitorResult &&
    typeof (user as any).competitorResult === "object"
      ? ((user as any).competitorResult as CompetitorResult)
      : { per_icp: [] };
  const brand = extractIcpBrandContext(user as any);
  try {
    const result = await generateCreativeDirectionForUser(
      brand,
      personas,
      competitor,
      deps
    );
    const current = await userDb.getUserById(userId);
    const patch = creativeDirReadyPatch((current as any) || {}, result);
    if (!patch) {
      // User is no longer in `running` (stale completion) — drop silently.
      return;
    }
    await userDb.updateUser(userId, patch as any);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const current = await userDb.getUserById(userId);
    await userDb.updateUser(
      userId,
      creativeDirFailedPatch((current as any) || {}, msg) as any
    );
    console.error("[onboardingCreativeDirService] generation failed", {
      userId,
      err: msg,
    });
    void reportUIError({
      operation: "onboarding:creative-dir:llm-generation",
      errorMessage: msg,
      userId,
      context: {
        Source: "backend",
        Step: "creativeDir",
        Stack: err instanceof Error ? (err.stack ?? "").slice(0, 1000) : "",
      },
    });
  }
}

/**
 * Synchronous entry point for routes — flips status to `running` and
 * launches background work. Returns once the start patch has been
 * persisted so the route can return the running snapshot.
 */
export async function startCreativeDirForUser(
  userId: string,
  deps: { llm?: { generateJsonRobust: LLMService["generateJsonRobust"] } } = {}
): Promise<void> {
  await userDb.updateUser(userId, creativeDirStartPatch() as any, { removeUndefined: true });
  // Eager DAG sub-task 2: orchestrator owns step ordering for opted-in
  // users; cheap no-op gated inside the orchestrator for everyone else.
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
    return;
  }
  void triggerCreativeDirForUser(userId, deps);
}
