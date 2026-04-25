/**
 * Onboarding Epic Phase 2 — ICP discovery service.
 *
 * Step 2 of the B2B lead-gen ads work plan (`plan_1768351741814_jgc2wwlxa`).
 * Mirrors the `onboardingAdGenerator` pattern: pure LLM call exported for
 * unit-testing, plus a fire-and-forget orchestrator that patches the User
 * record's per-axis state machine on the way in (`running`) and out
 * (`ready` | `failed`).
 *
 * Flow the route layer orchestrates:
 *   1. POST /api/onboarding/icp/start
 *   2. Route flips `icpStatus → running` via icpStartPatch.
 *   3. Route calls `startIcpDiscoveryForUser(userId)` (background work).
 *   4. Route returns the running snapshot to the UI.
 *   5. Background: read brand context → call Claude Sonnet-4-6 → patch
 *      User with `icpReadyPatch(personas)` or `icpFailedPatch(error)`.
 *
 * The system prompt is the verbatim Step 2 description from the prod work
 * plan. Do NOT rewrite it locally — if Step 2 changes, update the prod plan
 * via `manage_predefined_work_plan` and re-pull. The unit test asserts the
 * prompt contains a distinctive phrase from the prod copy.
 */

import { LLMService } from "../utils/llmService";
import { userDb } from "./db";
import {
  icpFailedPatch,
  icpReadyPatch,
  icpStartPatch,
  ICPPersona,
  MAX_ICP_PERSONAS,
  sanitizeICPPersonas,
} from "./icpStatusService";

/** Bedrock model alias. Matches the rest of the onboarding-v2 flow. */
const ICP_MODEL = "anthropic.claude-sonnet-4-6";

/** Slightly conservative temperature — ICP personas should be specific, not creative drift. */
const ICP_TEMPERATURE = 0.7;

/** Token budget for 5 personas × ~6 fields each + meta brief. */
const ICP_MAX_TOKENS = 4000;

/**
 * Step 2 system prompt — VERBATIM from prod work plan
 * `plan_1768351741814_jgc2wwlxa`, steps[1].description. Sourced via
 * `aws dynamodb get-item --table-name AW-WorkPlans --key '{"planId":{"S":"plan_1768351741814_jgc2wwlxa"}}'`.
 *
 * We append a strict JSON-output contract because we're calling Claude
 * directly (no agent loop / function calls), but the descriptive content
 * of the prompt itself is unchanged.
 */
export const ICP_DISCOVERY_SYSTEM_PROMPT = [
  "Show each of the Ideal Customer Profiles (ICP) and persona in the Market Strategy Section, provide the following description on three elements. Each consists of 1 sentence, short and to-the-point:",
  "- List out up to 5 distinct ICPs with illustrative avatars (emoji-based, gradient colors)",
  "- Firmographics: Company size, revenue, industry, geography",
  "- Psychographics: Goals, fears, values",
  "- Key Personas per ICP with motivations",
  "- Expandable cards for each ICP",
  "Ask the user to verify the output. Update their comments to the Market Strategy Section as needed.",
  "IF there is no Brand Guideline or Market Strategy setup, then redirect user to complete the Onboarding Workflow.",
  "",
  "OUTPUT CONTRACT — return ONLY valid JSON matching this exact shape:",
  "{",
  '  "icps": [',
  '    { "name": "...", "pain": "...", "desire": "...", "objection": "...", "meta_targeting_brief": "..." }',
  "  ]",
  "}",
  "Return up to 5 ICPs. Each field is one short sentence. No markdown, no commentary.",
].join("\n");

/**
 * Brand context projected from the User record. All optional — early
 * onboarding may have only a subset populated.
 */
export interface IcpBrandContext {
  companyName?: string;
  companyUrl?: string;
  tagline?: string;
  toneOfVoice?: string;
  valueProposition?: string;
  targetAudience?: string;
}

interface LlmResponse {
  icps: unknown;
}

/**
 * Project the IcpBrandContext from the persisted User record. Tolerant of
 * partial data — every field is optional.
 */
export function extractIcpBrandContext(user: {
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
}): IcpBrandContext {
  const bd = user.brandGuidelines?.brandData || {};
  const ctx: IcpBrandContext = {};
  const companyName = bd.brandName || user.companyName;
  if (companyName) ctx.companyName = companyName;
  const companyUrl = bd.domain || user.productDomain;
  if (companyUrl) ctx.companyUrl = companyUrl;
  if (bd.tagline) ctx.tagline = bd.tagline;
  if (bd.toneOfVoice) ctx.toneOfVoice = bd.toneOfVoice;
  if (bd.valueProposition) ctx.valueProposition = bd.valueProposition;
  if (bd.targetAudience) ctx.targetAudience = bd.targetAudience;
  return ctx;
}

function buildUserPrompt(brand: IcpBrandContext): string {
  const lines: string[] = [
    "Generate up to 5 distinct Ideal Customer Profiles (ICPs) for:",
    "",
    `Company: ${brand.companyName || "(not provided)"}`,
  ];
  if (brand.companyUrl) lines.push(`Website: ${brand.companyUrl}`);
  if (brand.tagline) lines.push(`Tagline: ${brand.tagline}`);
  if (brand.valueProposition)
    lines.push(`Value proposition: ${brand.valueProposition}`);
  if (brand.targetAudience)
    lines.push(`Target audience hint: ${brand.targetAudience}`);
  if (brand.toneOfVoice) lines.push(`Tone of voice: ${brand.toneOfVoice}`);
  lines.push("");
  lines.push(
    "For each ICP, capture: name (evocative), pain (one sentence), desire (one sentence), objection (one sentence), meta_targeting_brief (one sentence summarising who to target on Meta).",
  );
  lines.push("Return JSON matching the schema in the system prompt.");
  return lines.join("\n");
}

/**
 * Pure LLM call — exported for unit-testing with an injected LLMService.
 */
export async function generateIcpsForUser(
  brand: IcpBrandContext,
  deps: { llm?: { generateJSONContent: LLMService["generateJSONContent"] } } = {},
): Promise<ICPPersona[]> {
  const llm =
    deps.llm ?? new LLMService(ICP_MODEL, ICP_TEMPERATURE, ICP_MAX_TOKENS);
  const system = ICP_DISCOVERY_SYSTEM_PROMPT;
  const user = buildUserPrompt(brand);
  const raw = await llm.generateJSONContent<LlmResponse>(system, user, "json");
  if (!raw || !Array.isArray((raw as LlmResponse).icps)) {
    throw new Error("LLM returned no icps");
  }
  // Use the same sanitiser the route layer uses on /complete bodies — keeps
  // the persistence shape consistent regardless of which path wrote it.
  return sanitizeICPPersonas(raw.icps).slice(0, MAX_ICP_PERSONAS);
}

/**
 * Fire-and-forget orchestrator. Called from `/icp/start` AFTER the status
 * has been flipped to `running`. Resolves immediately — the LLM work runs
 * in the background and patches the User record on completion.
 *
 * Tests can `await` the returned promise to assert persisted state.
 */
export async function triggerIcpDiscoveryForUser(
  userId: string,
  deps: { llm?: { generateJSONContent: LLMService["generateJSONContent"] } } = {},
): Promise<void> {
  const user = await userDb.getUserById(userId);
  if (!user) return;
  const brand = extractIcpBrandContext(user as any);
  try {
    const personas = await generateIcpsForUser(brand, deps);
    const current = await userDb.getUserById(userId);
    const patch = icpReadyPatch((current as any) || {}, personas);
    if (!patch) {
      // User no longer in `running` (UI navigated away or watchdog flipped).
      // Stale completion is not an error — drop silently.
      return;
    }
    await userDb.updateUser(userId, patch as any);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const current = await userDb.getUserById(userId);
    await userDb.updateUser(
      userId,
      icpFailedPatch((current as any) || {}, msg) as any,
    );
    console.error("[onboardingIcpService] generation failed", { userId, err: msg });
  }
}

/**
 * Synchronous entry point for routes — flips status to `running` and
 * launches background work. Returns once the start patch has been
 * persisted so the route can return the running snapshot.
 */
export async function startIcpDiscoveryForUser(
  userId: string,
  deps: { llm?: { generateJSONContent: LLMService["generateJSONContent"] } } = {},
): Promise<void> {
  await userDb.updateUser(userId, icpStartPatch() as any);
  // Intentionally not awaited — the route returns immediately.
  // Errors inside triggerIcpDiscoveryForUser are caught + persisted there.
  void triggerIcpDiscoveryForUser(userId, deps);
}
