/**
 * Onboarding Epic Phase 2 — Competitor strategy service.
 *
 * Step 3 of the B2B lead-gen ads work plan (`plan_1768351741814_jgc2wwlxa`).
 * Reads the ICPs persisted by Step 2 (`icpResult` on the User record), then
 * for each ICP runs an optional web search + LLM synthesis to produce
 * a `CompetitorPerICP` entry.
 *
 * Same fire-and-forget orchestration pattern as `onboardingIcpService`:
 *   1. Route flips `competitorStatus → running` via competitorStartPatch.
 *   2. Route calls `startCompetitorStrategyForUser(userId)`.
 *   3. Background: read ICPs from User → per-ICP web search → per-ICP LLM
 *      → patch User with `competitorReadyPatch(result)` or
 *      `competitorFailedPatch(error)`.
 *
 * The system prompt is the verbatim Step 3 description from the prod work
 * plan. Web search is best-effort — if the search fn isn't injected or the
 * call fails, we surface that to the LLM ("no competitor search data
 * available") and let it state assumptions, matching the Step 3 rule
 * "If no competitive data is available, state assumptions clearly".
 */

import { withClearedError } from "../utils/clearErrorOnClaim";
import { LLMService } from "../utils/llmService";
import type { LLMUsageContext } from "../utils/llmService";
import { reportUIError } from "../utils/errorReporter";
import { userDb } from "./db";
import {
  competitorFailedPatch,
  competitorReadyPatch,
  competitorStartPatch,
  CompetitorPerICP,
  CompetitorResult,
  CompetitorStatusFields,
  COMPETITOR_TIMEOUT_MS,
  MAX_COMPETITOR_ICPS,
  sanitizeCompetitorResult,
} from "./competitorStatusService";
import {
  extractIcpBrandContext,
  IcpBrandContext,
} from "./onboardingIcpService";
import type { ICPPersona } from "./icpStatusService";
import { trackBackgroundRun } from "../utils/trackedBackgroundRun";

/** Bedrock model alias. Same family as Step 2 for tone consistency. */
const COMPETITOR_MODEL = "anthropic.claude-sonnet-4-6";

/** Lower temperature — competitor analysis should be grounded, not creative. */
const COMPETITOR_TEMPERATURE = 0.6;

/** Token budget for one ICP's full COMPETITIVE CONTENT AUDIT + OFFER STRATEGY MATRIX. */
const COMPETITOR_MAX_TOKENS = 4000;

/**
 * Step 3 system prompt — VERBATIM from prod work plan
 * `plan_1768351741814_jgc2wwlxa`, steps[2].description.
 *
 * The route layer asks for one ICP at a time (we slice `per_icp` and call
 * the LLM N times) so the model can stay focused on one persona's
 * targeting brief without diluting attention across 5 personas at once.
 *
 * As with Step 2, we append a strict JSON-output contract because we're
 * calling Claude directly without an agent loop. The descriptive content
 * of the prompt is unchanged.
 */
export const COMPETITOR_STRATEGY_SYSTEM_PROMPT = [
  "1. For each ICP, build a complete psychographic profile",
  "2. For each ICP, build a Meta targeting brief",
  "### Required Fields Per ICP",
  "```",
  'ICP [N]: [Evocative Name — e.g., "The DevTool Founder Racing Alone"]',
  "  FIRMOGRAPHICS:",
  "    company_stage: [Funding stage, employee count range]",
  "    role: [Exact job titles]",
  "    team_size: [Their team, not the company]",
  "  ",
  "  PSYCHOGRAPHICS:",
  "    identity: [How they see themselves]",
  "    daily_reality: [What their Tuesday at 2pm looks like]",
  "    relationship_to_product_category: [How they currently solve this problem]",
  "  ",
  "  PAIN MAPPING:",
  "    acute: [Immediate, time-sensitive pain — happening right now]",
  "    chronic: [Ongoing friction they've normalized]",
  "    latent: [Pain they don't know they have yet]",
  "  ",
  "  EMOTIONAL DRIVERS:",
  '    primary_emotion: [The feeling that drives action — e.g., "Resentment that worse products win"]',
  "    fear: [What they're afraid of]",
  "    desire: [What they actually want]",
  "  ",
  "  TRIGGER EVENT:",
  "    [The specific moment that makes them search for a solution]",
  "  ",
  "  INNER MONOLOGUE:",
  '    "[A quote that sounds like it came from their brain at 3am]"',
  "  ",
  "  META TARGETING BRIEF:",
  '    job_titles: [Exact titles to target — e.g., "CTO," "VP Engineering," "Developer Advocate"]',
  '    interests: [Meta interest categories — e.g., "Developer Tools," "SaaS," "DevOps"]',
  '    behaviors: [Behavioral signals — e.g., "Small business owners," "Technology early adopters"]',
  '    lookalike_seed: [What data source to build lookalikes from — e.g., "trial signups," "website visitors"]',
  '    exclusions: [Who to exclude — e.g., "current customers," "competitors"]',
  '    estimated_audience_size: [Rough Meta estimate — e.g., "180K-320K"]',
  "    geographic: [Targeting geography]",
  "  ",
  "  LP ROUTE:",
  "    primary_lp: [Which landing page this ICP should go to and WHY]",
  "    conversion_goal: [What action you want from this ICP]",
  '    cta_type: [e.g., "Book Demo," "Get Free Report," "Start Trial"]',
  "```",
  "### Rules",
  "- Pain mapping (acute/chronic/latent) is now part of Brick 1, NOT a separate brick",
  "- The Meta Targeting Brief must be ACTIONABLE — these are the literal fields a media buyer would paste into Ads Manager",
  "- Each ICP must route to a specific landing page with a rationale",
  "- The Inner Monologue quote should be visceral and specific, not generic",
  "---",
  "## BRICK 2: COMPETITIVE INTELLIGENCE + OFFER STRATEGY",
  "### Purpose",
  "Understand the competitive content landscape and map CTA/offer types to funnel stages. This brick REPLACED the old Pain Mapping brick (which was redundant with Brick 1).",
  "### Process",
  "1. If the user provides competitor names or URLs in the Market Strategy section, analyze their content footprint and ad presence",
  "2. If not, use web_search to identify 3-5 key competitors",
  "3. Map the offer strategy across funnel stages",
  "### Required Sections",
  "```",
  "COMPETITIVE CONTENT AUDIT:",
  "  [For each competitor — 3-5 max]:",
  "    name: [Competitor]",
  "    content_footprint: [Estimated # of guides, tutorials, blog posts]",
  "    ai_visibility: [Are they showing up in ChatGPT/Claude/Cursor? Y/N + evidence]",
  "    ad_presence: [Any visible Meta/LinkedIn ads? What angles are they running?]",
  "    content_gaps: [What they're NOT covering that this product could own]",
  "    positioning_weakness: [Where their messaging is vulnerable]",
  "OFFER STRATEGY MATRIX:",
  "  AWARENESS STAGE:",
  '    offer_type: [e.g., "Free Report," "Assessment," "Educational Content"]',
  '    cta_text: [e.g., "Get Your Free Report"]',
  "    form_friction: [Minimal — email only, or name + email]",
  '    conversion_event: [What Meta optimizes toward — e.g., "Lead"]',
  "    landing_page: [Which LP]",
  "  ",
  "  CONSIDERATION STAGE:",
  '    offer_type: [e.g., "Product Demo," "Case Study," "Comparison Guide"]',
  '    cta_text: [e.g., "Book a Demo," "See How It Works"]',
  "    form_friction: [Medium — name, email, company, role]",
  '    conversion_event: [e.g., "Lead" or "Schedule"]',
  "    landing_page: [Which LP]",
  "  ",
  "  CONVERSION STAGE:",
  '    offer_type: [e.g., "Free Trial," "Freemium Signup," "Pilot Program"]',
  '    cta_text: [e.g., "Start Free," "Try It Now"]',
  "    form_friction: [Varies — could be email-only for PLG]",
  '    conversion_event: [e.g., "CompleteRegistration"]',
  "    landing_page: [Which LP]",
  "  ",
  "  RETARGETING:",
  '    offer_type: [e.g., "Testimonial push," "Feature deep-dive," "Urgency/scarcity"]',
  '    cta_text: [e.g., "Join 50+ Teams," "See Why They Switched"]',
  "    audience: [Website visitors, LP visitors, video viewers, engaged but not converted]",
  "```",
  "### Rules",
  "- Competitive intelligence should be based on real data when possible (web_search)",
  "- If no competitive data is available, state assumptions clearly",
  "- The Offer Strategy Matrix drives landing page selection, CTA copy, and funnel-stage tagging in Brick 5",
  "- Every campaign needs at least 2 offer types (awareness + conversion)",
  "---",
  "## BRICK 3: VALUE PROPOSITIONS + LP ROUTING",
  "### Purpose",
  "Map specific value propositions to each ICP and formalize the landing page routing strategy.",
  "### Required Fields Per ICP",
  "```",
  "ICP [N]: [Name]",
  "  ",
  "  PRIMARY VALUE PROP:",
  "    [One sentence — the single most compelling promise for this ICP]",
  "  ",
  "  SUPPORTING VALUE PROPS:",
  "    1. [Specific, quantified where possible]",
  "    2. [Specific, quantified where possible]",
  "    3. [Specific, quantified where possible]",
  "    4. [Specific, quantified where possible]",
  "  ",
  "  PROOF POINT:",
  "    [The single strongest piece of evidence for this ICP — testimonial, stat, or case study]",
  "  ",
  "  OBJECTION HANDLING:",
  "    primary_objection: [What stops them from acting]",
  "    response: [How the ad/LP addresses it]",
  "```",
  "### LP Routing Matrix",
  "```",
  "LP ROUTING TABLE:",
  "  | ICP | Landing Page | URL | Rationale | Form Type | CTA | Conversion Goal |",
  "  |-----|-------------|-----|-----------|-----------|-----|-----------------|",
  "  | [Each ICP mapped to a specific LP with full justification] |",
  "LP ANALYSIS:",
  "  [For each landing page]:",
  "    url: [URL]",
  "    headline: [Current headline]",
  "    form_type: [Fields required]",
  "    lead_magnet: [What the user gets]",
  "    strengths: [What the LP does well]",
  "    weaknesses: [Conversion friction points]",
  "    recommended_improvements: [Optional — if obvious issues exist]",
  "```",
  "### Rules",
  "- Every ICP MUST map to a specific landing page with a rationale",
  '- Value props must be specific and quantified — never "better results" or "improved efficiency"',
  "- If multiple LPs are available, technical personas typically route to minimal-friction forms; marketing/executive personas to fuller lead qualification forms",
  "- Retargeting audiences should route to the lowest-friction LP",
].join("\n");

/**
 * One web-search hit. Loose shape so any provider can satisfy it.
 */
export interface WebSearchResult {
  title?: string;
  url?: string;
  snippet?: string;
}

/**
 * Optional injectable web-search function. The caller passes one in if it
 * has access to credentials. Default is undefined — the LLM falls back to
 * stating assumptions, per the Step 3 rule.
 */
export type WebSearchFn = (
  query: string,
) => Promise<WebSearchResult[]>;

/** Per-ICP LLM response shape — caller constructs the per_icp aggregate. */
interface PerIcpLlmResponse {
  competitor_names: string[];
  offer_angles: string[];
  meta_targeting_brief: string;
}

function formatSearchSnippets(results: WebSearchResult[]): string {
  if (!results.length) return "(no competitor search results)";
  return results
    .slice(0, 5)
    .map((r, i) => {
      const title = r.title || "(untitled)";
      const url = r.url || "";
      const snippet = r.snippet || "";
      return `${i + 1}. ${title} — ${url}\n   ${snippet}`;
    })
    .join("\n");
}

function buildPerIcpUserPrompt(
  brand: IcpBrandContext,
  persona: ICPPersona,
  searchContext: string,
): string {
  const lines: string[] = [
    `You are analysing the competitive landscape and offer strategy for ONE ICP at a time.`,
    "",
    `Company: ${brand.companyName || "(not provided)"}`,
  ];
  if (brand.companyUrl) lines.push(`Website: ${brand.companyUrl}`);
  if (brand.valueProposition)
    lines.push(`Value proposition: ${brand.valueProposition}`);
  lines.push("");
  lines.push("ICP under analysis:");
  lines.push(`  Name: ${persona.name}`);
  lines.push(`  Pain: ${persona.pain}`);
  lines.push(`  Desire: ${persona.desire}`);
  lines.push(`  Objection: ${persona.objection}`);
  lines.push(`  Existing meta targeting hint: ${persona.meta_targeting_brief}`);
  lines.push("");
  lines.push("Competitor search context:");
  lines.push(searchContext);
  lines.push("");
  lines.push(
    "OUTPUT CONTRACT — return ONLY valid JSON for THIS ICP, no markdown:",
  );
  lines.push("{");
  lines.push('  "competitor_names": ["...", "..."],');
  lines.push('  "offer_angles": ["...", "..."],');
  lines.push(
    '  "meta_targeting_brief": "Single dense paragraph capturing job_titles, interests, behaviors, lookalike_seed, exclusions, estimated_audience_size, geographic"',
  );
  lines.push("}");
  return lines.join("\n");
}

/**
 * Mirror v2 onboarding competitor result → `User.marketStrategy.competitors[]`
 * shape so the rest of the product (Agent Mode, chatbot) sees the
 * competitors the onboarding flow generated.
 *
 * Source shape (per-ICP) → target shape (flat, deduped by name):
 *   - Walk per_icp entries, collect every competitor_name across them
 *   - Group offer_angles by competitor name (some competitors appear under
 *     multiple ICPs)
 *   - description = first 2 distinct offer_angles joined; falls back to
 *     "Identified during onboarding" if none
 *   - cap at 10 (a deliberate onboarding-only ceiling; agentMode no longer
 *     caps the stored competitor list — see ENG-945)
 *
 * Exported for unit testing.
 */
export function mapCompetitorResultToMarketStrategy(
  result: CompetitorResult,
): Array<{ name: string; description: string }> {
  const grouped = new Map<string, string[]>();
  if (!result || !Array.isArray(result.per_icp)) return [];
  for (const entry of result.per_icp) {
    const names = Array.isArray(entry?.competitor_names)
      ? entry.competitor_names
      : [];
    const angles = Array.isArray(entry?.offer_angles)
      ? entry.offer_angles
      : [];
    for (const raw of names) {
      const name = typeof raw === "string" ? raw.trim() : "";
      if (!name) continue;
      if (!grouped.has(name)) grouped.set(name, []);
      const bucket = grouped.get(name)!;
      for (const angle of angles) {
        if (typeof angle !== "string") continue;
        const t = angle.trim();
        if (t && !bucket.includes(t)) bucket.push(t);
      }
    }
  }
  return Array.from(grouped.entries())
    .slice(0, 10)
    .map(([name, angles]) => ({
      name,
      description:
        angles.slice(0, 2).join("; ") || "Identified during onboarding",
    }));
}

/**
 * Read-merge-write the freshly-generated competitor result into
 * `User.marketStrategy.competitors[]`, preserving existing icp /
 * businessOverview / etc. Best-effort; errors logged but never roll back
 * the competitorResult write that already succeeded.
 */
async function mirrorCompetitorsToMarketStrategy(
  userId: string,
  result: CompetitorResult,
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
      icpUpdatedAt?: string;
    };
    const merged = {
      businessOverview: existing.businessOverview ?? "",
      competitors: mapCompetitorResultToMarketStrategy(result),
      icp: existing.icp ?? [],
      createdAt: existing.createdAt ?? now,
      updatedAt: now,
      // This write never touches `icp` — carry icpUpdatedAt through
      // unchanged (like createdAt above), never bump or drop it. userDb's
      // updateUser fully replaces the marketStrategy map attribute, so
      // omitting this field here would silently erase a real ICP edit's
      // timestamp the next time onboarding's competitor step runs — which
      // fires for essentially every onboarded user right after ICP
      // generation — and fall back to this write's wall-clock `updatedAt`,
      // reintroducing the exact staleness bug icpUpdatedAt exists to
      // prevent (ENG-1955).
      icpUpdatedAt: existing.icpUpdatedAt,
    };
    await userDb.updateUser(userId, { marketStrategy: merged } as any);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      "[onboardingCompetitorService] mirror to marketStrategy failed",
      { userId, err: msg },
    );
  }
}

/**
 * Pure per-ICP loop. Exported for unit-testing with injected fakes. Calls
 * the LLM (and optionally the search fn) once per ICP, capped at
 * MAX_COMPETITOR_ICPS.
 */
export async function generateCompetitorStrategyForUser(
  brand: IcpBrandContext,
  personas: ICPPersona[],
  deps: {
    llm?: { generateJsonRobust: LLMService["generateJsonRobust"] };
    webSearchFn?: WebSearchFn;
  } = {},
  usageContext?: LLMUsageContext,
): Promise<CompetitorResult> {
  if (!Array.isArray(personas) || personas.length === 0) {
    throw new Error("competitor strategy needs at least one ICP");
  }
  const llm =
    deps.llm ??
    new LLMService(COMPETITOR_MODEL, COMPETITOR_TEMPERATURE, COMPETITOR_MAX_TOKENS);
  const search = deps.webSearchFn;
  const slice = personas.slice(0, MAX_COMPETITOR_ICPS);
  const out: CompetitorPerICP[] = [];

  for (const persona of slice) {
    let searchCtx = "(no competitor search data available — state assumptions clearly)";
    if (search) {
      try {
        const query = brand.companyName
          ? `${brand.companyName} competitors for ${persona.name}`
          : `competitors targeting ${persona.name}`;
        const results = await search(query);
        searchCtx = formatSearchSnippets(results);
      } catch {
        // Best-effort. Surface to the LLM that search was unavailable so it
        // states assumptions per Step 3 rules.
        searchCtx =
          "(competitor search failed — no data available, state assumptions clearly)";
      }
    }

    const userPrompt = buildPerIcpUserPrompt(brand, persona, searchCtx);
    // generateJsonRobust adds a retry-on-extract-failure layer so a single
    // prose preamble from the LLM doesn't fail the whole per-ICP loop.
    // ENG-1858: metered to the onboarding user (was feature "unknown" / "system").
    const raw = await llm.generateJsonRobust<PerIcpLlmResponse>(
      COMPETITOR_STRATEGY_SYSTEM_PROMPT,
      userPrompt,
      undefined,
      usageContext ?? { feature: "onboarding_competitors" },
    );
    out.push({
      icp_id: persona.name,
      competitor_names: Array.isArray(raw?.competitor_names)
        ? raw.competitor_names
        : [],
      offer_angles: Array.isArray(raw?.offer_angles) ? raw.offer_angles : [],
      meta_targeting_brief:
        typeof raw?.meta_targeting_brief === "string"
          ? raw.meta_targeting_brief
          : "",
    });
  }

  return sanitizeCompetitorResult({ per_icp: out });
}

/**
 * Fire-and-forget orchestrator. Reads the User record, pulls the ICPs out
 * of the persisted `icpResult`, runs the per-ICP loop, and patches the
 * User with the result.
 *
 * Gates on `icpStatus === 'ready' && icpResult?.length > 0` — when ICP is
 * still mid-flight (or never started), we bail with a `gated by icp step`
 * breadcrumb and DO NOT persist `failed`. The polling tick (and the
 * cascade trigger from `onboardingIcpService` on icp `ready`) re-call us
 * once ICP is actually ready. This mirrors the gate-on-creative-dir
 * pattern in `onboardingAdImageService.triggerAdImageGenerationForUser`.
 *
 * Without this gate, the original behavior was: fire optimistically right
 * after `/icp/start`, see `icpResult` is empty, persist
 * `competitorStatus: failed`. That single race-condition write halted the
 * entire downstream cascade (creativeDir → adImage → adCopy all stuck
 * `running`) and produced a 100% onboarding ad-gen failure rate. See
 * Notion `34d09247-c951-81e4-af97-df1e869bc8aa` for the full diagnosis.
 */
/**
 * Restate "the `running` record is still the one THIS run claimed" as a
 * DynamoDB condition (ENG-2308 review follow-up, confirmed by direct
 * reproduction — see onboardingIcpService's `icpOwnershipCondition` for
 * the full reasoning, identical here). The stale-claim escape hatch lets a
 * second claim reclaim the axis while the first claimant is merely slow,
 * not crashed; `competitorReadyPatch` only checks `competitorStatus ===
 * "running"`, not WHICH run's `running` it is, so a reclaimed run's zombie
 * completion can otherwise overwrite — or be overwritten by, silently
 * dropping the real result — the reclaiming run's own completion.
 */
function competitorOwnershipCondition(expectedStartedAt: string) {
  return {
    expression: "#competitorStartedAt = :competitorOwnerStartedAt",
    names: { "#competitorStartedAt": "competitorStartedAt" },
    values: { ":competitorOwnerStartedAt": expectedStartedAt },
  };
}

export async function triggerCompetitorStrategyForUser(
  userId: string,
  deps: {
    llm?: { generateJsonRobust: LLMService["generateJsonRobust"] };
    webSearchFn?: WebSearchFn;
    expectedStartedAt?: string;
  } = {},
): Promise<void> {
  const user = await userDb.getUserById(userId);
  if (!user) return;

  let u = user as any;
  const readiness = (rec: any) => {
    const status = typeof rec.icpStatus === "string" ? rec.icpStatus : "idle";
    const list: ICPPersona[] = Array.isArray(rec.icpResult) ? (rec.icpResult as ICPPersona[]) : [];
    return { icpStatus: status, personas: list };
  };
  let { icpStatus, personas } = readiness(u);
  if (icpStatus !== "ready" || personas.length === 0) {
    // The read above is the eventually-consistent index: the legacy cascade
    // calls us moments after icp turned `ready`, so a lagging read would gate a
    // run that is actually good to go. Confirm with a consistent read before
    // giving up. If that read is unavailable the original decision stands.
    try {
      const fresh = await (userDb as any).getUserByIdConsistent(userId);
      if (fresh) {
        u = fresh;
        ({ icpStatus, personas } = readiness(u));
      }
    } catch {
      /* keep the gate decision */
    }
  }
  if (icpStatus !== "ready" || personas.length === 0) {
    // Don't mark failed. Don't run. The polling tick and the next
    // cascade kickoff will re-call us once ICP is actually ready.
    // eslint-disable-next-line no-console
    console.log("[onboardingCompetitorService] gated by icp step", {
      userId,
      reason: `icp not ready (status=${icpStatus}, personas=${personas.length})`,
    });
    // This run holds the axis claim but is not going to do any work. Left
    // `running`, the claim would turn every retry into a no-op until the axis
    // times out (3 minutes), where before the claims a retry simply re-fired.
    // Hand the axis back (conditioned on OUR claim, so a newer run's state is
    // never touched) so the next start or cascade kickoff can claim it.
    if (deps.expectedStartedAt) {
      try {
        await userDb.updateUser(userId, { competitorStatus: "idle" } as any, {
          condition: competitorOwnershipCondition(deps.expectedStartedAt),
        });
      } catch (releaseErr: any) {
        if (releaseErr?.code !== "ConditionalCheckFailedException") {
          console.warn("[onboardingCompetitorService] could not release gated claim", {
            userId,
            err: releaseErr?.message ?? String(releaseErr),
          });
        }
      }
    }
    return;
  }

  const brand = extractIcpBrandContext(u);
  try {
    // ENG-1858: attribute and charge the research to this user.
    const usageContext: LLMUsageContext = { userId, feature: "onboarding_competitors" };
    const result = await generateCompetitorStrategyForUser(brand, personas, deps, usageContext);
    const current = await userDb.getUserById(userId);
    const patch = competitorReadyPatch((current as any) || {}, result);
    if (!patch) return;
    if (deps.expectedStartedAt) {
      try {
        await userDb.updateUser(userId, patch as any, {
          condition: competitorOwnershipCondition(deps.expectedStartedAt),
        });
      } catch (condErr: any) {
        if (condErr?.code === "ConditionalCheckFailedException") {
          console.warn(
            "[onboardingCompetitorService] dropping stale completion — a newer claim owns the axis",
            { userId },
          );
          return;
        }
        throw condErr;
      }
    } else {
      await userDb.updateUser(userId, patch as any);
    }

    // Mirror to marketStrategy.competitors[] so the main account sees the
    // competitors onboarding generated. See companion mirror in
    // onboardingIcpService for the same pattern. Best-effort.
    await mirrorCompetitorsToMarketStrategy(userId, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const current = await userDb.getUserById(userId);
    const failedPatch = competitorFailedPatch((current as any) || {}, msg);
    if (deps.expectedStartedAt) {
      try {
        await userDb.updateUser(userId, failedPatch as any, {
          condition: competitorOwnershipCondition(deps.expectedStartedAt),
        });
      } catch (condErr: any) {
        if (condErr?.code === "ConditionalCheckFailedException") {
          console.warn(
            "[onboardingCompetitorService] dropping stale failure — a newer claim owns the axis",
            { userId },
          );
          return;
        }
        throw condErr;
      }
    } else {
      await userDb.updateUser(userId, failedPatch as any);
    }
    console.error("[onboardingCompetitorService] generation failed", {
      userId,
      err: msg,
    });
    void reportUIError({
      operation: "onboarding:competitor:llm-generation",
      errorMessage: msg,
      userId,
      context: {
        Source: "backend",
        Step: "competitor",
        Stack: err instanceof Error ? (err.stack ?? "").slice(0, 1000) : "",
      },
    });
  }
}

/**
 * Guards the non-running -> `running` transition with a DynamoDB
 * ConditionExpression (ENG-2308) — same race as `onboardingIcpService`'s
 * icp claim: a plain read-then-write here lets two concurrent callers both
 * observe a non-running status and both win, launching two fully parallel
 * per-ICP LLM loops. This function has two callers that can race each
 * other — the `/competitor/start` route AND the `icpResult`-ready cascade
 * kickoff in `onboardingIcpService.ts` — so even without a frontend
 * double-fire, a manual retry landing while the cascade is already
 * mid-flight hits the same bug (confirmed live during ENG-2276 production
 * testing).
 *
 * Also allows a fresh claim once the in-flight run has exceeded
 * `COMPETITOR_TIMEOUT_MS` — see `icpStartClaimCondition`'s docstring in
 * `onboardingIcpService.ts` for why: without this, a run genuinely stuck
 * in `running` (lost to a deploy/crash) could never be retried again.
 */
function competitorStartClaimCondition(now: Date = new Date()) {
  const staleBefore = new Date(now.getTime() - COMPETITOR_TIMEOUT_MS).toISOString();
  return {
    expression:
      "attribute_not_exists(#competitorStatus) OR #competitorStatus <> :competitorRunning OR #competitorStartedAt <= :competitorStaleBefore",
    names: {
      "#competitorStatus": "competitorStatus",
      "#competitorStartedAt": "competitorStartedAt",
    },
    values: {
      ":competitorRunning": "running",
      ":competitorStaleBefore": staleBefore,
    },
  };
}

/**
 * Claim the competitor axis for a new run: atomically flip
 * `competitorStatus` to `running` (or no-op, returning `null`, if someone
 * else already holds the claim). Every entry point that wants to run
 * competitor research must go through here — both `/competitor/start`
 * (via `startCompetitorStrategyForUser`) and the eager-pipeline
 * orchestrator's `runCompetitor` (`onboardingOrchestratorWiring.ts`).
 *
 * `runCompetitor` needed this split out (ENG-2308 follow-up, caught
 * live): it used to call `triggerCompetitorStrategyForUser` directly, with
 * nothing ever flipping `competitorStatus` to `running` first on a pure
 * orchestrator-driven cascade. `competitorReadyPatch` requires
 * `current.competitorStatus === 'running'` to persist a result — without
 * it, the trigger ran for real then silently dropped its result, and the
 * orchestrator recorded the step `ready` with a `null` output anyway,
 * since nothing threw.
 */
export async function claimCompetitorRun(
  userId: string,
): Promise<CompetitorStatusFields | null> {
  const patch = competitorStartPatch();
  try {
    await userDb.updateUser(userId, withClearedError(patch, "competitorError") as any, {
      condition: competitorStartClaimCondition(),
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
 * Synchronous entry point for routes. Flips status to `running` and
 * launches background work. Returns the persisted start patch, or `null`
 * if a concurrent caller already claimed this run (ENG-2308) — callers
 * must NOT launch a second background generation in that case.
 *
 * Checks eager-pipeline status BEFORE claiming (ENG-2308 fix-of-a-fix,
 * caught live) — same reasoning as `startIcpDiscoveryForUser`'s docstring:
 * the orchestrator's `runCompetitor` claims this SAME axis itself when it
 * fires the step, inside the SAME reconcile pass this function would hand
 * off to. Claiming here too would always win first and starve it.
 */
export async function startCompetitorStrategyForUser(
  userId: string,
  deps: {
    llm?: { generateJsonRobust: LLMService["generateJsonRobust"] };
    webSearchFn?: WebSearchFn;
  } = {},
): Promise<CompetitorStatusFields | null> {
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
  const patch = await claimCompetitorRun(userId);
  if (!patch) return null;
  // Tracked so a deploy's graceful shutdown waits for this run (cronJobRegistry
  // is drained before the listener closes) instead of killing it mid-flight and
  // leaving a dead `running` claim that nothing completes until it times out.
  trackBackgroundRun(
    "onboardingCompetitor",
    triggerCompetitorStrategyForUser(userId, {
      ...deps,
      expectedStartedAt: patch.competitorStartedAt,
    }),
  );
  return patch;
}
