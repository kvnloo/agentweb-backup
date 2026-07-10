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
  logCompletionMetric,
} from "./brandBuildStatusService";
import { logStepMetric } from "./onboardingMetricsService";

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
  createChatSession?: (userId: string) => Promise<{ sessionId: string }>;
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
    `You are Emma, running an autonomous brand-build for an onboarding flow. Do NOT ask the user any questions — they will verify your output on a dedicated review screen after you finish.`,
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
  createChatSession: (userId: string) => Promise<{ sessionId: string }>;
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
  return {
    createChatSession: async (userId: string) => {
      const session = await chatbotDb.createChatSession(
        userId,
        undefined,
        "agent",
        "agent-mode",
        undefined,
        undefined,
        undefined,
        undefined,
        "regular",
      );
      return { sessionId: session.sessionId };
    },
    generateSessionResponse: (sessionId, userMessage, userId, llmModel) =>
      generateSessionResponse(sessionId, userMessage, userId, llmModel),
  };
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
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { provisionOnboardingSlackConnect } = require("./slackConnectService");
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
    const session = await createChatSession(userId);
    sessionId = session.sessionId;
  } catch (e: any) {
    await persistFailure(
      userId,
      user,
      `failed to create Emma session: ${e?.message ?? String(e)}`,
      now(),
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
    );
    return;
  }

  // Emma should have written brandGuidelines (which fires the existing
  // ready-patch hook in agentModeService) and marketStrategy. Re-read the
  // user record and mirror marketStrategy → icpResult/competitorResult so
  // downstream UI + services hydrate.
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
    await userDb.updateUser(userId, mirrorPatch as any);
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
    );
    return;
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
): Promise<void> {
  const patch = buildFailedPatch(current || {}, message, now);
  await userDb.updateUser(userId, patch as any);
  logCompletionMetric(userId, "failed", patch.brandBuildDurationMs ?? 0);
  // Durable metric — logCompletionMetric only writes a structured log line
  // that rotates with the container. The OnboardingMetrics row survives.
  const startedAt = (current?.brandBuildStartedAt as string | undefined) ??
    new Date(now.getTime() - (patch.brandBuildDurationMs ?? 0)).toISOString();
  void logStepMetric({
    userId,
    step: "brand-build",
    startedAt,
    completedAt: now.toISOString(),
    durationMs: patch.brandBuildDurationMs ?? 0,
    status: message.includes("timed out") ? "timeout" : "failed",
    errorMessage: message,
  });
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
