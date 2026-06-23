/**
 * Onboarding Epic Phase 2 — ICP discovery service.
 *
 * Step 2 of the B2B lead-gen ads work plan (`plan_1768351741814_jgc2wwlxa`).
 * Mirrors the per-axis onboarding service pattern: pure LLM call exported for
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
import { reportUIError } from "../utils/errorReporter";
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
 * Delay before firing the cascade trigger to the competitor step after
 * persisting `icpStatus: 'ready'`. Lets the UserIdIndex GSI propagate
 * the just-written row so the competitor service's gate read sees
 * `icpStatus === 'ready'` instead of stale `running`. 2s is generous —
 * DynamoDB GSI propagation is typically <1s in us-west-2.
 *
 * Override to 0 in tests via `process.env.CASCADE_TRIGGER_DELAY_MS=0`
 * so unit assertions can fire synchronously.
 */
export const CASCADE_TRIGGER_DELAY_MS =
  process.env.CASCADE_TRIGGER_DELAY_MS !== undefined
    ? Number(process.env.CASCADE_TRIGGER_DELAY_MS)
    : 2_000;

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
  seedContext?: string;
  seedFilenames?: string[];
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
  onboardingSeedContext?: {
    files?: Array<{
      filename?: string;
      content?: string;
    }>;
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
  const seedFiles = Array.isArray(user.onboardingSeedContext?.files)
    ? user.onboardingSeedContext.files
    : [];
  const seedChunks = seedFiles
    .map((file) => {
      const filename = typeof file.filename === "string" ? file.filename.trim() : "";
      const content = typeof file.content === "string" ? file.content.trim() : "";
      if (!filename || !content) return "";
      return `### ${filename}\n${content}`;
    })
    .filter(Boolean);
  if (seedChunks.length > 0) {
    ctx.seedContext = seedChunks.join("\n\n").slice(0, 36_000);
    ctx.seedFilenames = seedFiles
      .map((file) => (typeof file.filename === "string" ? file.filename.trim() : ""))
      .filter(Boolean);
  }
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
  if (brand.seedContext) {
    lines.push("");
    lines.push("User-uploaded onboarding seed context (highest priority):");
    if (brand.seedFilenames?.length) {
      lines.push(`Files: ${brand.seedFilenames.join(", ")}`);
    }
    lines.push(brand.seedContext);
    lines.push("");
    lines.push(
      "Use the uploaded seed context as the source of truth when it conflicts with the website, company name, or generic industry inference.",
    );
    lines.push(
      "If the seed names target accounts, categories, buyer types, or market participants, make those the first ICPs before considering broader personas.",
    );
  }
  lines.push("");
  lines.push(
    "For each ICP, capture: name (evocative), pain (one sentence), desire (one sentence), objection (one sentence), meta_targeting_brief (one sentence summarising who to target on Meta).",
  );
  lines.push("Return JSON matching the schema in the system prompt.");
  return lines.join("\n");
}

/**
 * Inverse of `mapMarketIcpToResult` in `onboardingBrandBuildService.ts`.
 * Mirrors the v2 onboarding ICP result back to `User.marketStrategy.icp[]`
 * shape so the rest of the product (Agent Mode, chatbot, etc.) sees the
 * ICPs the onboarding flow generated.
 *
 * Without this mirror, v2 onboarding writes to `User.icpResult` only and
 * `marketStrategy.icp[]` stays empty — the user finishes onboarding with
 * an apparently-blank market strategy. See agentweb-customer-portal#687
 * companion fix for value-prop hydration; this fixes the ICP half.
 *
 * Exported for unit testing.
 */
export function mapIcpResultToMarketStrategy(
  personas: ICPPersona[],
): Array<{
  title: string;
  description: string;
  valueProposition: string;
  buyerPersonas: string[];
}> {
  if (!Array.isArray(personas)) return [];
  return personas.map((p) => ({
    title: typeof p.name === "string" ? p.name : "",
    description: typeof p.pain === "string" ? p.pain : "",
    valueProposition: typeof p.desire === "string" ? p.desire : "",
    buyerPersonas: typeof p.meta_targeting_brief === "string" && p.meta_targeting_brief
      ? [p.meta_targeting_brief]
      : [],
  }));
}

/**
 * Merge the freshly-generated ICPs into `User.marketStrategy.icp[]`,
 * preserving whatever else (competitors, businessOverview, etc.) is
 * already on the record. Best-effort: errors are logged but do NOT roll
 * back the icpResult write — the user still gets ICPs in the onboarding
 * review flow, the rest of the product just won't see them until the
 * next time something touches marketStrategy.
 *
 * Read-merge-write done in this single function to keep the call-site
 * tidy. The eventual-consistency window we already navigated for the
 * cascade trigger doesn't apply here — we're writing to the base table
 * by email via updateUser, which is strongly consistent.
 */
async function mirrorIcpsToMarketStrategy(
  userId: string,
  personas: ICPPersona[],
): Promise<void> {
  try {
    const fresh: any = await userDb.getUserById(userId);
    if (!fresh) return;
    const now = new Date().toISOString();
    const existing = (fresh.marketStrategy ?? {}) as {
      businessOverview?: string;
      competitors?: Array<{ name: string; description: string }>;
      icp?: Array<{
        title: string;
        description: string;
        valueProposition: string;
        buyerPersonas: string[];
      }>;
      createdAt?: string;
      updatedAt?: string;
    };
    const merged = {
      businessOverview: existing.businessOverview ?? "",
      competitors: existing.competitors ?? [],
      icp: mapIcpResultToMarketStrategy(personas),
      createdAt: existing.createdAt ?? now,
      updatedAt: now,
    };
    await userDb.updateUser(userId, { marketStrategy: merged } as any);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      "[onboardingIcpService] mirror to marketStrategy failed",
      { userId, err: msg },
    );
    // Non-fatal: don't fire reportUIError here either, this is best-effort
    // backfill — the primary icpResult write already succeeded.
  }
}

/**
 * Pure LLM call — exported for unit-testing with an injected LLMService.
 *
 * Uses `generateJsonRobust` (not `generateJSONContent`) so a stray prose
 * preamble in the model's response no longer cascade-fails the entire
 * Phase 4 ad-gen pipeline. See `services/util/extractJson.ts`.
 */
export async function generateIcpsForUser(
  brand: IcpBrandContext,
  deps: { llm?: { generateJsonRobust: LLMService["generateJsonRobust"] } } = {},
  userId?: string,
): Promise<ICPPersona[]> {
  const llm =
    deps.llm ?? new LLMService(ICP_MODEL, ICP_TEMPERATURE, ICP_MAX_TOKENS);
  const system = ICP_DISCOVERY_SYSTEM_PROMPT;
  const user = buildUserPrompt(brand);
  // Shadow usage metering attribution only — no behavior change.
  const raw = await llm.generateJsonRobust<LlmResponse>(system, user, undefined, {
    userId,
    feature: 'onboarding',
  });
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
  deps: { llm?: { generateJsonRobust: LLMService["generateJsonRobust"] } } = {},
): Promise<void> {
  const user = await userDb.getUserById(userId);
  if (!user) return;
  const brand = extractIcpBrandContext(user as any);
  try {
    const personas = await generateIcpsForUser(brand, deps, userId);
    const current = await userDb.getUserById(userId);
    const patch = icpReadyPatch((current as any) || {}, personas);
    if (!patch) {
      // User no longer in `running` (UI navigated away or watchdog flipped).
      // Stale completion is not an error — drop silently.
      return;
    }
    await userDb.updateUser(userId, patch as any);

    // Mirror to marketStrategy.icp[] so the main account (Agent Mode,
    // chatbot, etc.) sees the ICPs the onboarding flow generated. Without
    // this, v2 onboarding writes to User.icpResult only and the user
    // finishes onboarding with an apparently-blank market strategy.
    // Best-effort — errors logged but do NOT block the cascade.
    await mirrorIcpsToMarketStrategy(userId, personas);

    // Cascade kickoff: fire-and-forget the competitor step now that ICPs
    // are persisted and `icpStatus === 'ready'`. Without this, the user
    // had to wait for the next FE polling tick before competitor research
    // started — adding 20s+ of dead time to onboarding. Combined with
    // the gate inside `triggerCompetitorStrategyForUser`, this makes the
    // ICP→Competitor handoff race-free. We intentionally `require` here
    // (not `import`) to avoid a circular module dep —
    // onboardingCompetitorService imports `extractIcpBrandContext` from
    // this file. Errors are swallowed by the competitor service itself
    // (it has its own try/catch).
    //
    // We use `startCompetitorStrategyForUser` (NOT `trigger`) because
    // `competitorReadyPatch` is gated on `competitorStatus === 'running'`
    // — the start variant flips status to `running` before invoking the
    // background work. Without that prior flip the LLM result is silently
    // dropped on completion (`competitorReadyPatch` returns null).
    //
    // We delay the cascade kickoff by `CASCADE_TRIGGER_DELAY_MS` to let
    // the UserIdIndex GSI propagate the icpReadyPatch we just wrote —
    // without this, the immediate read inside the cascade sees the
    // pre-update row and the gate inside
    // `triggerCompetitorStrategyForUser` trips with `gated by icp step`
    // even though icp is genuinely ready. Default is 2s (generous;
    // DynamoDB GSI propagation is typically <1s in us-west-2). Tests
    // inject 0 to assert the cascade synchronously.
    //
    // Eager DAG sub-task 2: when the user is on `useEagerPipeline`, the
    // OnboardingPipelineOrchestrator owns step ordering — skip the
    // legacy cross-call cascade entirely. The orchestrator's reconcile
    // loop will pick up `competitor` once `icp` is `ready` in the
    // `User.steps` table. For everyone else (the default path), keep
    // the legacy cascade so this PR is a pure no-op for non-flag users.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {
      isEagerPipelineActiveFor,
    } = require("./onboardingOrchestratorWiring");
    if (!isEagerPipelineActiveFor(current as any)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { startCompetitorStrategyForUser } = require("./onboardingCompetitorService");
      const delay = CASCADE_TRIGGER_DELAY_MS;
      if (delay > 0) {
        setTimeout(() => {
          void startCompetitorStrategyForUser(userId);
        }, delay);
      } else {
        void startCompetitorStrategyForUser(userId);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const current = await userDb.getUserById(userId);
    await userDb.updateUser(
      userId,
      icpFailedPatch((current as any) || {}, msg) as any,
    );
    console.error("[onboardingIcpService] generation failed", { userId, err: msg });
    void reportUIError({
      operation: "onboarding:icp:llm-generation",
      errorMessage: msg,
      userId,
      context: {
        Source: "backend",
        Step: "icp",
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
export async function startIcpDiscoveryForUser(
  userId: string,
  deps: { llm?: { generateJsonRobust: LLMService["generateJsonRobust"] } } = {},
): Promise<void> {
  await userDb.updateUser(userId, icpStartPatch() as any, { removeUndefined: true });
  // Eager DAG sub-task 2: kick the orchestrator. No-op for users not on
  // `useEagerPipeline`; for opted-in users the orchestrator drives the
  // ICP runner (which delegates to triggerIcpDiscoveryForUser), so we
  // do NOT invoke the legacy trigger directly to avoid running the
  // step twice in parallel. For everyone else, the legacy trigger is
  // the source of truth.
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
  // Intentionally not awaited — the route returns immediately.
  // Errors inside triggerIcpDiscoveryForUser are caught + persisted there.
  void triggerIcpDiscoveryForUser(userId, deps);
}
