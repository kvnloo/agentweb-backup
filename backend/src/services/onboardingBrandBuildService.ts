import { populateEmptyBrandGuidelines } from './brandGuidelinesPopulation';
/**
 * Onboarding brand-build service.
 *
 * Thin wrapper around Emma's existing chat-session entry points. We do NOT
 * fork Emma's tools or rebuild scrape logic — we hand Emma a tight prompt
 * and let her use her existing toolkit (`update_brand_guidelines`,
 * `update_market_strategy`, `you_search_web`, Playwright/fetch, etc.) the same
 * way she does in the prod work plan. The onboarding UI is just a
 * user-friendly wrapper around that process.
 *
 * Pipeline:
 *   1. Create an agent-mode chat session (no work plan binding).
 *   2. Send Emma a single message: "scrape this URL, populate brand +
 *      market strategy, do NOT ask me to verify anything mid-flight,
 *      reply DONE when done." She runs her tool loop until terminated.
 *   3. After her loop returns, mirror `marketStrategy.icp[]` →
 *      `icpResult` and `marketStrategy.competitors[]` → `competitorResult`
 *      so downstream services (creative-dir, ad-image, ad-copy) and the
 *      brandReview UI hydrate correctly without further changes.
 *   4. The existing `update_brand_guidelines` write-path hook in
 *      agentModeService already flips `brandBuildStatus → ready`, so we
 *      don't need to set it ourselves. We DO flip `icpStatus` and
 *      `competitorStatus` to `ready` after mirroring.
 *
 * Verification of brand+ICP+competitor happens on the brandReview screen,
 * NOT mid-flight. Emma is instructed to skip the work-plan-style "ask the
 * user" prompts.
 */

import { userDb } from "./db";
import {
  buildFailedPatch,
  buildStartPatch,
  logCompletionMetric,
} from "./brandBuildStatusService";
import { logStepMetric } from "./onboardingMetricsService";
import { withClearedError } from "../utils/clearErrorOnClaim";
import {
  BRAND_BUILD_PROMPT_SENTINEL,
  brandBuildOwnershipCondition,
  brandBuildSessionPageIdentifier,
  isClaimSuperseded,
} from "./brandBuildSessionMarker";

const BRAND_BUILD_MODEL = "anthropic.claude-sonnet-4-6";

/**
 * Hard wall-clock for the Emma session. Web research + scrape + multiple
 * `update_*` tool calls take real time; 300s gives Emma enough headroom
 * to do real work even on slow site renders. The previous 180s budget
 * was hitting the wall in normal usage when Playwright was unavailable
 * and Emma fell back to web search (slower per query). With Chrome now
 * installed in the Dockerfile, normal builds should land well under 90s
 * — this 300s ceiling is the safety net for genuinely slow runs.
 */
const BRAND_BUILD_TIMEOUT_MS = 300_000;

/**
 * Persona shape consumed by the brandReview UI and downstream ad services.
 * Mirrors `ICPPersona` from icpStatusService — duplicated here so this file
 * doesn't depend on the per-step ICP service that may eventually be deleted.
 */
interface ICPPersonaLite {
  id?: string;
  name: string;
  pain: string;
  desire: string;
  objection: string;
  meta_targeting_brief: string;
  // Passed through from the source marketStrategy.icp entry when present —
  // lets routes/crm.ts's icp/filters cache-hit check work the same way for
  // marketStrategy-derived personas as it does for icpResult ones (ENG-1955).
  extractedFilters?: any;
}

interface CompetitorEntry {
  id?: string;
  name: string;
  description: string;
}

export interface BrandBuildDeps {
  /**
   * Override for Emma's chat-session creator. Defaults to the real
   * `chatbotService.createChatSession`. Tests inject a fake.
   */
  createChatSession?: (
    userId: string,
    opts?: { pageIdentifier?: string },
  ) => Promise<{ sessionId: string }>;
  /**
   * Override for Emma's response generator. Defaults to the real
   * `agentModeController.generateSessionResponse`. Tests inject a fake
   * that pretends the loop ran and returns a stub response.
   */
  generateSessionResponse?: (
    sessionId: string,
    userMessage: string,
    userId: string,
    llmModel: string,
  ) => Promise<unknown>;
  /** Override for the wall-clock timeout. */
  timeoutMs?: number;
  /** Inject `() => new Date()` for deterministic tests. */
  now?: () => Date;
  /**
   * Override for the deterministic post-scrape logo step (ENG-326).
   * Defaults to `ensureBrandLogoPersisted` from services/agentMode/brandLogo.
   */
  ensureBrandLogo?: (
    userId: string,
    companyUrl: string,
  ) => Promise<{ persisted: boolean; logoUrl: string | null; reason: string }>;
  /**
   * The `brandBuildStartedAt` THIS run's own `claimBrandBuildRun` minted
   * (ENG-2308 review follow-up). Conditions `persistFailure`'s writes on
   * it so a reclaimed, merely-slow run's zombie failure can't stomp a
   * reclaiming run's own in-progress or already-completed state — same
   * ownership-token pattern applied to icp/competitor/creativeDir/adCopy.
   * Optional for backward compatibility with direct callers/tests that
   * bypass the claim; only callers that hold a fresh claim should pass it.
   * The Emma session is created with a `pageIdentifier` naming this claim, so
   * the `update_brand_guidelines` hook can tell a superseded session from the
   * current one (see `brandBuildSessionPageIdentifier`).
   */
  expectedStartedAt?: string;
  /**
   * ENG-2782: skip the WS3 Slack Connect side effect below. Set by callers that
   * provision Slack Connect themselves at a later point (the public Slack-start
   * intake does it on completion), so the two never race into a double invite.
   */
  skipSlackConnect?: boolean;
}

function buildBrandPrompt(input: {
  companyName: string;
  companyUrl: string;
  goal: string;
}): string {
  const { companyName, companyUrl, goal } = input;
  // Scoped to BRAND ONLY. ICPs and competitors get their own dedicated
  // per-step generation steps (onboardingIcpService /
  // onboardingCompetitorService) so each one is small, fast, and
  // reliable. Combining all three into a single Emma session was
  // unreliable — Emma frequently produced a brand but failed to populate
  // marketStrategy.icp / .competitors before exiting, leaving the user
  // staring at a half-empty review screen.
  return [
    `You are Emma, ${BRAND_BUILD_PROMPT_SENTINEL}. Do NOT ask the user any questions — they will verify your output on a dedicated review screen after you finish.`,
    "",
    `Company name: ${companyName}`,
    `Company website: ${companyUrl}`,
    `User's marketing goal: ${goal}`,
    "",
    `Your only job in this session: produce the brand DNA. Then stop.`,
    "",
    `1. Scrape the company website (use your Playwright / fetch / web tools as needed; render JS-heavy pages). Read the homepage and at least one of /about, /company, /team, /pricing if they exist.`,
    "",
    `2. Call update_brand_guidelines exactly once with the full brand object: brandName, tagline, primaryColor, secondaryColor, fontFamily, toneOfVoice, brandPersonality, brandValues, keyMessages, targetAudience, valueProposition, founders, logoUrl. Ground every field in what the site actually says — do not invent.`,
    "",
    `Constraints:`,
    `- Do NOT call update_market_strategy or regenerate_market_strategy in this session, and do NOT offer to regenerate the market strategy. ICPs and competitor research are handled by separate steps after the user reviews the brand.`,
    `- Do NOT ask the user to verify anything mid-flight.`,
    `- Do NOT call any work-plan tools, do NOT create GTM plans, email campaigns, or landing pages.`,
    `- logoUrl must be a direct link to an image the SITE ITSELF serves — the <img> in its header, an og:image, or its own /favicon.ico. NEVER substitute a third-party favicon proxy such as https://www.google.com/s2/favicons?domain=<domain>. That service returns 404 for any domain it has not crawled, and the dead URL then breaks every ad-image generation for this account.`,
    `- If the site's logo is an inline SVG or otherwise has no linkable image URL, OMIT logoUrl entirely rather than approximating it. A deterministic step after this session discovers and pins a logo whenever you leave one unset — an omitted logoUrl self-heals, a wrong one does not.`,
    `- After update_brand_guidelines succeeds, reply with a single line "DONE" and stop.`,
    `- If a step is impossible (e.g. site is unreachable), reply "FAILED: <reason>" and stop. Do NOT loop indefinitely.`,
  ].join("\n");
}

/**
 * Pull a usable companyUrl off the User record. Mirrors the precedence the
 * route layer uses — body-supplied value first (already merged in via the
 * route's PATCH), then brandGuidelines.brandData.domain, then companyUrl.
 */
function pickCompanyUrl(user: any): string | null {
  if (!user) return null;
  if (typeof user.productDomain === "string" && user.productDomain.trim()) {
    return user.productDomain.trim();
  }
  const bdDomain = user.brandGuidelines?.brandData?.domain;
  if (typeof bdDomain === "string" && bdDomain.trim()) return bdDomain.trim();
  if (typeof user.companyUrl === "string" && user.companyUrl.trim()) {
    return user.companyUrl.trim();
  }
  return null;
}

function pickCompanyName(user: any): string {
  if (!user) return "";
  if (typeof user.companyName === "string" && user.companyName.trim()) {
    return user.companyName.trim();
  }
  const bdName = user.brandGuidelines?.brandData?.brandName;
  if (typeof bdName === "string" && bdName.trim()) return bdName.trim();
  return "";
}

function pickGoal(user: any): string {
  if (!user) return "paid_ads";
  if (typeof user.goal === "string" && user.goal.trim()) {
    return user.goal.trim();
  }
  return "paid_ads";
}

/**
 * Mirror Emma's `marketStrategy.icp[]` (as written by `update_market_strategy`)
 * into the `icpResult` shape consumed by the brandReview UI and the per-step
 * ICP service's downstream readers (creative-dir, ad-image, ad-copy).
 *
 * Exported for unit testing.
 */
export function mapMarketIcpToResult(
  marketIcp: any,
): ICPPersonaLite[] {
  if (!Array.isArray(marketIcp)) return [];
  return marketIcp
    .filter((p) => p && typeof p === "object")
    .map((p, idx): ICPPersonaLite => {
      const personas = Array.isArray(p.buyerPersonas) ? p.buyerPersonas : [];
      const firstPersona = personas[0] || "";
      return {
        id: typeof p.id === "string" && p.id ? p.id : `icp-${idx + 1}`,
        name: stringOr(p.title, `ICP ${idx + 1}`),
        pain: stringOr(p.description, ""),
        desire: stringOr(p.valueProposition, ""),
        objection: "",
        meta_targeting_brief: stringOr(firstPersona, ""),
        ...(p.extractedFilters ? { extractedFilters: p.extractedFilters } : {}),
      };
    })
    .slice(0, 5);
}

/**
 * Mirror Emma's `marketStrategy.competitors[]` into the `competitorResult`
 * shape used by the per-step competitor service's downstream readers.
 *
 * Exported for unit testing.
 */
export function mapMarketCompetitorsToResult(
  marketCompetitors: any,
): CompetitorEntry[] {
  if (!Array.isArray(marketCompetitors)) return [];
  return marketCompetitors
    .filter((c) => c && typeof c === "object")
    .map((c, idx): CompetitorEntry => ({
      id: typeof c.id === "string" && c.id ? c.id : `comp-${idx + 1}`,
      name: stringOr(c.name, `Competitor ${idx + 1}`),
      description: stringOr(c.description, ""),
    }))
    .slice(0, 5);
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

/**
 * Race a promise against a wall-clock timeout. Rejects with a timeout error
 * if the promise doesn't settle in `ms`. The Emma session itself does NOT
 * abort — it keeps running server-side until the agent loop terminates —
 * but our orchestrator stops waiting and marks the build failed. The next
 * status read of `marketStrategy` will pick up Emma's eventual writes if
 * she does finish, but we won't block the user any longer.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Lazy-loaded default deps. Required from inside the function so the
 * onboardingBrandBuildService module doesn't pull agentModeController +
 * chatbotService at import time (those modules pull JSDOM, csstools, etc.
 * which Jest's CommonJS transform can't parse). Tests inject deps and
 * never trigger this path.
 */
function defaultDeps(): {
  createChatSession: (
    userId: string,
    opts?: { pageIdentifier?: string },
  ) => Promise<{ sessionId: string }>;
  generateSessionResponse: (
    sessionId: string,
    userMessage: string,
    userId: string,
    llmModel: string,
  ) => Promise<unknown>;
} {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { chatbotDb } = require("./chatbotService");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { generateSessionResponse } = require("../controllers/agentModeController");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { cronJobRegistry } = require("../utils/cronJobRegistry");
  return {
    createChatSession: async (userId: string, opts?: { pageIdentifier?: string }) => {
      const session = await chatbotDb.createChatSession(
        userId,
        undefined,
        "agent",
        opts?.pageIdentifier ?? "agent-mode",
        undefined,
        undefined,
        undefined,
        undefined,
        "regular",
      );
      return { sessionId: session.sessionId };
    },
    // ENG-1189: this turn's tool calls self-call back into this process via
    // mcpFetch — tracked so a deploy mid-run waits for it instead of
    // abandoning it against a closed listener. Only the real (default)
    // implementation is tracked — tests inject their own fake via
    // BrandBuildDeps and never go through this function.
    generateSessionResponse: (sessionId, userMessage, userId, llmModel) =>
      cronJobRegistry.track('onboardingBrandBuildAgentTurn', generateSessionResponse(sessionId, userMessage, userId, llmModel)),
  };
}

/**
 * Guards the non-building -> `building` transition with a DynamoDB
 * ConditionExpression (ENG-2308 follow-up), same shape as the per-step
 * axes' `claim<Axis>Run` functions. Also allows a fresh claim once the
 * in-flight run has exceeded `BRAND_BUILD_TIMEOUT_MS`, matching the
 * snapshot's own `timedOut` flag.
 */
function brandBuildStartClaimCondition(now: Date = new Date()) {
  const staleBefore = new Date(now.getTime() - BRAND_BUILD_TIMEOUT_MS).toISOString();
  return {
    expression:
      "attribute_not_exists(#brandBuildStatus) OR #brandBuildStatus <> :building OR #brandBuildStartedAt <= :staleBefore",
    names: {
      "#brandBuildStatus": "brandBuildStatus",
      "#brandBuildStartedAt": "brandBuildStartedAt",
    },
    values: { ":building": "building", ":staleBefore": staleBefore },
  };
}

/**
 * Claim the brand-dna axis for a new run: atomically flip `brandBuildStatus`
 * to `building` (or no-op, returning `null`, if someone else already holds
 * the claim). Every entry point that wants to run a brand build must go
 * through here — both `/brand-build/start` and the eager-pipeline
 * orchestrator's `runBrandDna` (`onboardingOrchestratorWiring.ts`).
 *
 * `runBrandDna` needed this (ENG-2308 follow-up, caught live): it used to
 * call `triggerBrandBuildForUser` directly, with nothing ever flipping
 * `brandBuildStatus` to `building` first on a pure orchestrator-driven
 * cascade (the normal case for brandDna — it has no deps, so it's the
 * very first thing an eager-pipeline user's reconcile pass ever fires,
 * with no reason `/brand-build/start` would have been hit separately).
 * The `update_brand_guidelines` tool-call hook
 * (`emma/impl/brandMarketStrategy.ts`) only flips `brandBuildStatus` to
 * `ready` "if we were building" — without a prior claim, Emma's session
 * ran for real, called the tool for real, and the flip to `ready` was
 * silently skipped, so `triggerBrandBuildForUser`'s own final check saw
 * `brandBuildStatus` still unset and reported "Emma finished but did not
 * call update_brand_guidelines" — a false negative, not a real Emma
 * failure. Confirmed live: this is the exact failure observed before this
 * fix, on every attempt that didn't happen to also call
 * `/brand-build/start` manually first.
 */
export async function claimBrandBuildRun(
  userId: string,
): Promise<ReturnType<typeof buildStartPatch> | null> {
  const patch = buildStartPatch();
  try {
    await userDb.updateUser(userId, withClearedError(patch, "brandBuildError") as any, {
      condition: brandBuildStartClaimCondition(),
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
 * Fire-and-forget orchestrator. The route flips `brandBuildStatus → building`
 * synchronously, then calls this. Resolves immediately on the request path
 * (the caller does NOT await this); Emma's tool loop runs in the background
 * and patches the User record on completion.
 *
 * Tests can `await` the returned promise to assert persisted state.
 */
export async function triggerBrandBuildForUser(
  userId: string,
  deps: BrandBuildDeps = {},
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? BRAND_BUILD_TIMEOUT_MS;

  const user = await userDb.getUserById(userId);
  if (!user) return;

  // WS2 telemetry — record brand-scrape lifecycle onto the onboarding loop so
  // a flaky scrape / degraded LLM clusters on the health endpoint. Lazy-
  // required to keep this module importable in tests without pulling the loop
  // registry. Best-effort.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const brandTelemetry = require("./onboardingTelemetry");
  void brandTelemetry.recordOnboardingEvent(
    userId,
    brandTelemetry.ONBOARDING_TELEMETRY_EVENTS.brandScrapeStarted,
  );

  const companyUrl = pickCompanyUrl(user);
  if (!companyUrl) {
    await persistFailure(
      userId,
      user,
      "no companyUrl on User record — cannot brand-build",
      now(),
      deps.expectedStartedAt,
    );
    return;
  }
  const companyName = pickCompanyName(user);
  const goal = pickGoal(user);

  // WS3 (flag-gated via SLACK_CONNECT_ENABLED, OFF by default): provision a
  // Slack Connect channel for this account. Best-effort + fire-and-forget —
  // never blocks the brand build, and inert until the flag + a bot token with
  // the conversations.connect scope are configured. See slackConnectService.
  void (async () => {
    if (deps.skipSlackConnect) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { provisionOnboardingSlackConnect } = require("./slackConnectService");
      // One platform per customer (ENG-273): an account that is on WhatsApp is not
      // also given a Slack Connect channel.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { hasWhatsApp } = require("./customerChannelPolicy");
      if (hasWhatsApp(user)) return;
      await provisionOnboardingSlackConnect({
        userId,
        companyName,
        companyEmail: (user as any).email ?? "",
        existingChannelId: (user as any).slackConnectChannelId,
      });
    } catch {
      /* best-effort */
    }
  })();

  // Resolve deps lazily so importing this module in tests doesn't pull
  // agentModeController + chatbotService.
  const { createChatSession, generateSessionResponse } = {
    ...defaultDeps(),
    ...(deps.createChatSession ? { createChatSession: deps.createChatSession } : {}),
    ...(deps.generateSessionResponse
      ? { generateSessionResponse: deps.generateSessionResponse }
      : {}),
  };

  let sessionId: string;
  try {
    // The session names the claim it serves so the update_brand_guidelines
    // hook can tell it from a later run's session (see
    // brandBuildSessionPageIdentifier). Without a claim (direct callers) it
    // keeps the default identifier.
    const session = await createChatSession(
      userId,
      deps.expectedStartedAt
        ? { pageIdentifier: brandBuildSessionPageIdentifier(deps.expectedStartedAt) }
        : undefined,
    );
    sessionId = session.sessionId;
  } catch (e: any) {
    await persistFailure(
      userId,
      user,
      `failed to create Emma session: ${e?.message ?? String(e)}`,
      now(),
      deps.expectedStartedAt,
    );
    return;
  }

  const prompt = buildBrandPrompt({ companyName, companyUrl, goal });

  try {
    await withTimeout(
      generateSessionResponse(sessionId, prompt, userId, BRAND_BUILD_MODEL),
      timeoutMs,
      "brand-build Emma session",
    );
  } catch (e: any) {
    await persistFailure(
      userId,
      // re-read so the failure patch's startedAt math is fresh
      (await userDb.getUserById(userId)) || user,
      `Emma session failed: ${e?.message ?? String(e)}`,
      now(),
      deps.expectedStartedAt,
    );
    return;
  }

  // Emma should have written brandGuidelines (which fires the existing
  // ready-patch hook in agentModeService) and marketStrategy. Re-read the
  // user record and mirror marketStrategy → icpResult/competitorResult so
  // downstream UI + services hydrate.
  //
  // A run that was reclaimed while its session was still going (the client-side
  // timeout calls /brand-build/fail then /start, which reclaims immediately)
  // must not carry on and write for a build it no longer owns: its session was
  // already refused by the update_brand_guidelines hook, and the writes below
  // would otherwise mirror stale results over the newer run's.
  if (deps.expectedStartedAt) {
    const latest = (await userDb.getUserById(userId)) as any;
    if (isClaimSuperseded(deps.expectedStartedAt, latest?.brandBuildStartedAt)) {
      console.warn("[onboardingBrandBuildService] run superseded while its session ran; skipping post-session writes", {
        userId,
        ours: deps.expectedStartedAt,
        current: latest?.brandBuildStartedAt,
      });
      return;
    }
  }
  await populateEmptyBrandGuidelines(userId);
  const updated = (await userDb.getUserById(userId)) as any;
  if (!updated) return;

  const market = updated.marketStrategy ?? {};
  const icpResult = mapMarketIcpToResult(market.icp);
  const competitorResult = mapMarketCompetitorsToResult(market.competitors);

  const mirrorPatch: Record<string, unknown> = {};
  if (icpResult.length > 0) {
    mirrorPatch.icpResult = icpResult;
    mirrorPatch.icpStatus = "ready";
    mirrorPatch.icpCompletedAt = now().toISOString();
  }
  if (competitorResult.length > 0) {
    mirrorPatch.competitorResult = { competitors: competitorResult };
    mirrorPatch.competitorStatus = "ready";
    mirrorPatch.competitorCompletedAt = now().toISOString();
  }
  if (Object.keys(mirrorPatch).length > 0) {
    if (deps.expectedStartedAt) {
      try {
        await userDb.updateUser(userId, mirrorPatch as any, {
          condition: brandBuildOwnershipCondition(deps.expectedStartedAt),
        });
      } catch (err: any) {
        if (err?.code === "ConditionalCheckFailedException") {
          // Reclaimed since the check above: the newer run owns these fields.
          console.warn("[onboardingBrandBuildService] dropping stale mirror write: a newer claim owns the build", { userId });
          return;
        }
        throw err;
      }
    } else {
      await userDb.updateUser(userId, mirrorPatch as any);
    }
  }

  // brandBuildStatus is flipped to ready by the agentModeService hook when
  // update_brand_guidelines is called. If Emma somehow finished without
  // calling it, fail the build so the UI surfaces a clear error rather
  // than spinning forever.
  const finalUser = (await userDb.getUserById(userId)) as any;
  const finalStatus = finalUser?.brandBuildStatus;
  if (finalStatus !== "ready") {
    await persistFailure(
      userId,
      finalUser || updated,
      `Emma finished but did not call update_brand_guidelines (final brandBuildStatus=${finalStatus ?? "unset"})`,
      now(),
      deps.expectedStartedAt,
    );
    return;
  }

  // ENG-326 AC-1: Emma's session VOLUNTARILY persists the logo — and often
  // doesn't. Run the deterministic post-scrape step: if the account still has
  // no persisted brand logo, discover one with the cssExtractor heuristics,
  // pin it to S3, and persist brandData.logoUrl + a 'logo' brand asset.
  // Best-effort — a logo failure must never fail a brand build that already
  // succeeded — but every outcome is logged loudly.
  try {
    const ensureBrandLogo =
      deps.ensureBrandLogo ??
      // Lazy require — brandLogo's default deps pull cssExtractor (JSDOM) and
      // agentModeService; tests inject a fake and never trigger this path.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      (require("./agentMode/brandLogo")
        .ensureBrandLogoPersisted as NonNullable<BrandBuildDeps["ensureBrandLogo"]>);
    const logoOutcome = await ensureBrandLogo(userId, companyUrl);
    // eslint-disable-next-line no-console
    console.log("[onboardingBrandBuildService] brand-logo step", {
      userId,
      ...logoOutcome,
    });
  } catch (logoErr) {
    // eslint-disable-next-line no-console
    console.warn("[onboardingBrandBuildService] brand-logo step crashed", {
      userId,
      error: logoErr instanceof Error ? logoErr.message : String(logoErr),
    });
  }

  // Happy-path metric. Pull the started/completed timestamps from the
  // freshly-flipped User record so we measure end-to-end (including the
  // mirror writes we just did), not just the Emma session itself.
  const startedAt = finalUser?.brandBuildStartedAt as string | undefined;
  const completedAt = finalUser?.brandBuildCompletedAt as string | undefined;
  if (startedAt && completedAt) {
    void logStepMetric({
      userId,
      step: "brand-build",
      startedAt,
      completedAt,
      durationMs: Math.max(
        0,
        Date.parse(completedAt) - Date.parse(startedAt),
      ),
      status: "ready",
    });
  }

  // WS2 telemetry — successful brand-scrape.
  void brandTelemetry.recordOnboardingEvent(
    userId,
    brandTelemetry.ONBOARDING_TELEMETRY_EVENTS.brandScrapeCompleted,
    {
      durationMs:
        startedAt && completedAt
          ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
          : null,
    },
  );
}

async function persistFailure(
  userId: string,
  current: any,
  message: string,
  now: Date,
  expectedStartedAt?: string,
): Promise<void> {
  const patch = buildFailedPatch(current || {}, message, now);
  if (expectedStartedAt) {
    try {
      await userDb.updateUser(userId, patch as any, {
        condition: brandBuildOwnershipCondition(expectedStartedAt),
      });
    } catch (err: any) {
      if (err?.code === "ConditionalCheckFailedException") {
        // A reclaim superseded THIS run while it was failing. Reporting
        // our failure here would stomp whatever the reclaiming run has
        // since done — drop it, the reclaiming run owns the axis's fate.
        console.warn(
          "[onboardingBrandBuildService] dropping stale failure — a newer claim owns the axis",
          { userId },
        );
        return;
      }
      throw err;
    }
  } else {
    await userDb.updateUser(userId, patch as any);
  }
  // ENG-848: ONE durable row per outcome.
  //
  // This used to call logCompletionMetric AND write its own OnboardingMetrics
  // row, on the stated premise that "logCompletionMetric only writes a
  // structured log line that rotates". That premise was false — it writes a
  // durable row too (brandBuildStatusService), so every failure landed twice.
  //
  // The heartbeat reads row counts, so the duplication doubled the denominator:
  // 74 rows for 39 real attempts. It did not distort the failure RATE, because
  // both copies carried the same status, but it made the sample look twice as
  // large as it was — and at ~5 attempts in the last active week, that
  // difference decides whether a "below 10%" claim means anything.
  logCompletionMetric(
    userId,
    message.includes("timed out") ? "timeout" : "failed",
    patch.brandBuildDurationMs ?? 0,
    message,
  );
  // eslint-disable-next-line no-console
  console.warn("[onboardingBrandBuildService] failed", {
    userId,
    message,
  });
  // WS2 telemetry — brand-scrape failure with a semantic errorClass derived
  // from the message. Best-effort.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const brandTelemetry = require("./onboardingTelemetry");
  void brandTelemetry.recordOnboardingFailure(
    userId,
    brandTelemetry.ONBOARDING_TELEMETRY_EVENTS.brandScrapeFailed,
    message,
    { durationMs: patch.brandBuildDurationMs ?? 0 },
  );
}
