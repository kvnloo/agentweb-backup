import { v4 as uuidv4 } from "uuid";
import AWS from "aws-sdk";
import axios from "axios";
import fs from "fs";
import path from "path";
import { getV0ApiKey, getGitHubOrgToken, getVercelToken, getLandingPagesConfig } from "../utils/secretsManager";
import { resolveLandingPageGa4 } from "../utils/landingPageGa4";
import { injectGtmIntoLayoutFiles } from "../utils/gtmInjection";
import { injectPixelIntoLayoutFiles } from "../utils/pixelInjection";
import { metaService } from "./metaService";
import { userDb, orgDb } from "./db";
import { canEditItem } from "./orgShareService";
import { addSubdomain, generateSubdomain, listDomains, SUBDOMAIN_BASE } from "./customDomainService";
import { settingsService } from "./settingsService";
import { paginatedQuery } from "../utils/dynamoPagination";
import { guardedV0ChatCreate, guardedV0CorrectionMessage, clearV0UsageForPage, hashV0Prompt } from "./v0UsageGuard";
// Type-only imports from durableLandingService live elsewhere; this constant import is
// runtime-safe because durableLandingService only imports a TYPE from this module.
import { STUCK_CEILING_MS } from "./durableLandingService";
import { enqueueAutoHumanEval } from "./autoHumanEvalService";
import { getPersistedBrandLogoUrl } from "./agentMode/brandLogo";

// Note: global fetch (undici) timeouts are managed by httpClient.ts (15 min headersTimeout/bodyTimeout).
// No setGlobalDispatcher call here — duplicate calls cause the last-loaded config to win unpredictably.

// Timeout constants for external API calls
const GITHUB_API_TIMEOUT_MS = 60_000;
const VERCEL_API_TIMEOUT_MS = 60_000;
const VERCEL_POLL_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Retry helper — exponential backoff for transient network failures
// ---------------------------------------------------------------------------
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2_000; // 2s, 4s, 8s

// Hard ceiling for a single external-API network call inside withRetry. Node's
// global fetch (undici) can otherwise wait up to the 15-min headersTimeout set in
// httpClient.ts, so a v0 request that connects but never responds hangs the whole
// generation with no output and no error (ENG-158). Bounding each attempt turns
// that silent hang into a loud, retryable timeout. 5 minutes comfortably exceeds
// any healthy single v0/GitHub call (generation progress is polled separately).
const V0_ATTEMPT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Build a diagnostic message from an error, unwrapping the undici `cause` chain.
 *
 * Node's global fetch (undici) throws a bare `TypeError: fetch failed` and stashes
 * the REAL reason (Connect Timeout, ECONNREFUSED, ENOTFOUND, TLS failure, …) on
 * `error.cause` — often itself an `AggregateError` whose `errors[]` hold the codes.
 * Persisting only `error.message` gave users a useless "fetch failed" with zero
 * detail (ENG-135), and the same swallowing hid v0's HTTP error bodies behind a
 * bare status (ENG-159). This walks message → code → cause → aggregate errors and
 * joins the distinct pieces so callers surface WHY a call failed. Safe on any input.
 */
export function describeError(err: any): string {
  const parts: string[] = [];
  const seen = new Set<any>();
  const push = (s: unknown) => {
    if (typeof s === "string" && s.trim() && !parts.includes(s)) parts.push(s);
  };

  let cur: any = err;
  let depth = 0;
  while (cur && depth < 10) {
    if (typeof cur === "string") {
      push(cur);
      break;
    }
    if (typeof cur === "object") {
      if (seen.has(cur)) break;
      seen.add(cur);
      push(cur.message);
      // Surface a distinct error code (e.g. ECONNRESET, UND_ERR_CONNECT_TIMEOUT)
      // when it isn't already visible in the message text.
      if (typeof cur.code === "string" && !parts.some((p) => p.includes(cur.code))) {
        push(cur.code);
      }
      // AggregateError (multiple connect attempts) carries the real codes here.
      if (Array.isArray(cur.errors)) {
        for (const e of cur.errors) push(describeError(e));
      }
    }
    cur = cur?.cause;
    depth++;
  }

  return parts.join(" | ") || (err == null ? "Unknown error" : String(err));
}

/**
 * Reject if `promise` has not settled within `ms`. The timeout error message
 * contains "timed out" so withRetry treats it as retryable, and it surfaces
 * clearly to the caller after retries are exhausted (never a silent hang).
 * The underlying request is not aborted — undici's socket-level timeouts still
 * apply — we just stop waiting on it so generation can fail loudly.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e: any = new Error(`${label} timed out after ${Math.round(ms / 1000)}s`);
      e.code = "V0_CALL_TIMEOUT";
      reject(e);
    }, ms);
    // Don't keep the event loop alive solely for this guard timer.
    if (typeof timer.unref === "function") timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Poll intervals for waiting on v0 generation to complete. With chat creation in
// async responseMode the create call returns in seconds and THIS loop absorbs the
// real generation time — prod evidence (ENG-287, AW-V0Usage 2026-07-10) shows
// brand-enriched generations routinely take 3–15 min, so the budget must exceed
// that. Ramps to a steady 30s cadence, ~16 min total.
let v0PollIntervalsMs = [0, 10_000, 15_000, 20_000, 30_000, 45_000, ...Array(28).fill(30_000)];

/** Override poll intervals (for testing) */
export function setV0PollIntervals(intervals: number[]) {
  v0PollIntervalsMs = intervals;
}

/**
 * A status read is a cheap GET. Bounding it at the full 300s attempt ceiling meant the
 * poll loop's real wall-clock was `sum(sleeps) + 34 × 300s ≈ 3 hours`, not the ~16 min its
 * own error message claimed — and nothing refreshed the record while it ran, so the
 * abandoned-build janitor (30-min `updatedAt` ceiling) would mark a LIVE build failed.
 * (ENG-287 residual)
 */
const V0_STATUS_POLL_TIMEOUT_MS = 30_000;

/**
 * ABSOLUTE wall-clock budget for a generation — the sleep table alone bounds only the time
 * we spend *sleeping*. Sits above prod p99 (~15 min) and below `STUCK_CEILING_MS` (30 min),
 * so a build that blows this budget fails loudly on its own terms before the janitor ever
 * has to consider it. (ENG-287 residual)
 */
const V0_GENERATION_BUDGET_MS = 20 * 60 * 1000;

/**
 * Is this failure a DEAD END for the v0 chat that produced it — i.e. will retrying against
 * the same chat fail identically, forever?
 *
 * This is the line between the two halves of the reuse contract:
 *  - dead end  → free the route identity so the retry mints a FRESH chat;
 *  - anything else (slow v0, transient read, poll budget exhausted while still `pending`)
 *    → KEEP the identity so the retry RESUMES the same chat for free. Freeing it there
 *    would mint a second full-cost chat while the first is still generating — the exact
 *    orphan-chat credit burn this issue is about.
 * (ENG-287 residual)
 */
export function isDeadEndV0Failure(error: any): boolean {
  // A Vercel build ERROR is also a dead end, but that path RETURNS a failed record instead
  // of throwing, so it frees the identity inline rather than through this predicate — there
  // is deliberately no VERCEL_BUILD_ERROR arm here, because nothing throws one and a dead
  // arm would imply coverage that does not exist.
  return (
    error?.code === "V0_VERSION_FAILED" || // v0 itself marked the version failed
    error?.code === "V0_OUTPUT_INVALID"    // v0 keeps emitting output we cannot ship
  );
}

/** Refresh a record's `updatedAt` without touching its status — a liveness heartbeat. */
async function touchLandingPageRecord(id: string): Promise<void> {
  try {
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: "SET updatedAt = :now",
        // UpdateItem is an UPSERT. Without this, a heartbeat racing a hard delete would
        // resurrect a stub record with no userId/status — invisible to every owner check.
        ConditionExpression: "attribute_exists(id)",
        ExpressionAttributeValues: { ":now": new Date().toISOString() },
      })
      .promise();
  } catch (err: any) {
    // Best-effort: a missed heartbeat costs liveness, never correctness.
    if (err?.code === "ConditionalCheckFailedException") return; // record is gone — nothing to keep alive
    console.warn(`[V0 SERVICE] heartbeat failed for ${id}: ${err?.message}`);
  }
}

/**
 * Keep a record's `updatedAt` fresh for the WHOLE of `fn`, not just the v0 poll.
 *
 * The version poll is only the first phase of a build. The zip download, the correction
 * sends, the GitHub push and the 5-min Vercel poll all follow it, each with their own
 * multi-minute retry budgets — and none of them writes `updatedAt`. So the `deploying`
 * phase could plausibly run past the janitor's 30-min ceiling in total silence, and the
 * janitor would mark a LIVE build failed (after which a retry runs a SECOND build into the
 * same repo, and `deliverStuckFailure` burns the one-shot completion claim so the real
 * success can never be delivered). Heartbeating for the entire build closes that hole.
 * (ENG-287 residual)
 */
const BUILD_HEARTBEAT_INTERVAL_MS = 60_000;
function startBuildHeartbeat(id: string): () => void {
  const timer = setInterval(() => { void touchLandingPageRecord(id); }, BUILD_HEARTBEAT_INTERVAL_MS);
  // Never hold the process open just for a heartbeat.
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

/**
 * Poll a v0 chat until its latest version reaches a terminal state and return the
 * completed version id.
 *
 * Async-mode chats expose the version immediately with `status: 'pending'` while
 * generation runs, so readiness is the version's status — NOT its existence
 * (grabbing a pending version downloads a half-generated page). A missing status
 * field (older sync-mode responses) is treated as completed, preserving the
 * pre-async behavior. A transient poll-read failure only costs that attempt — a
 * 15-minute generation must not die because one status read timed out; the loop's
 * budget bounds the total wait and the exit is loud.
 */
async function waitForCompletedV0Version(
  v0: any,
  chatId: string,
  label: string,
  opts: {
    heartbeat?: () => Promise<void>;
    /**
     * Absolute epoch-ms deadline for the WHOLE build. Passed in so the budget is spent
     * once across the initial wait AND every correction round — computing it per call would
     * re-arm it each time, letting one build poll 3 × 20 min and outlive both the janitor
     * ceiling and the chat-reuse ceiling the guard depends on. (ENG-287 residual)
     */
    deadline?: number;
    /**
     * The version we already have. A correction produces a NEW version, but v0 may still be
     * reporting the OLD (completed) one for a moment — returning it would re-download the
     * identical broken zip and silently waste the correction round. Treat it as not-ready.
     */
    afterVersionId?: string;
  } = {}
): Promise<string> {
  const intervals = v0PollIntervalsMs;
  const deadline = opts.deadline ?? Date.now() + V0_GENERATION_BUDGET_MS;
  let lastReadError: string | undefined;
  for (let pollAttempt = 0; pollAttempt < intervals.length; pollAttempt++) {
    if (intervals[pollAttempt] > 0) {
      console.log(
        `[V0 SERVICE] ${label}: generation not ready yet, waiting ${intervals[pollAttempt] / 1000}s (attempt ${pollAttempt + 1}/${intervals.length})...`
      );
      await new Promise((resolve) => setTimeout(resolve, intervals[pollAttempt]));
    }

    // Tell the world this build is alive. Without it, nothing refreshes the record for the
    // whole generation and the janitor marks a LIVE build failed at 30 min — after which a
    // retry runs a SECOND build against the same chat and repo. (ENG-287 residual)
    if (opts.heartbeat) await opts.heartbeat();

    // Bound the real wall-clock, not just the time spent sleeping.
    if (Date.now() >= deadline) break;

    let chat: any;
    try {
      chat = await withRetry(
        () => v0.chats.getById({ chatId }),
        `${label} (status poll)`,
        undefined, undefined, V0_STATUS_POLL_TIMEOUT_MS,
        { retryOnTimeout: false }
      );
    } catch (err: any) {
      lastReadError = describeError(err);
      console.warn(`[V0 SERVICE] ${label}: status poll failed (${lastReadError}), continuing...`);
      continue;
    }

    const version = chat?.latestVersion;
    if (version?.status === "failed") {
      // Typed so callers can distinguish "this chat is a dead end" (clear the
      // idempotency identity — a retry must mint a FRESH chat, not reuse this one)
      // from a transient/poll-budget failure (where reusing the chat is free and right).
      const failedErr: any = new Error(
        `v0 reported the generation as failed (version ${version.id}). Retry the generation — failed attempts do not block retries.`
      );
      failedErr.code = "V0_VERSION_FAILED";
      throw failedErr;
    }
    if (version?.id && version.status !== "pending") {
      // Still the version we came in with — v0 has not published the correction's new one
      // yet. Returning it would re-download the identical zip and waste the round.
      if (opts.afterVersionId && version.id === opts.afterVersionId) continue;
      console.log(`[V0 SERVICE] ${label}: version ${version.id} ready (poll attempt ${pollAttempt + 1})`);
      return version.id;
    }
  }

  const budgetMin = Math.round(
    Math.min(intervals.reduce((a, b) => a + b, 0), V0_GENERATION_BUDGET_MS) / 60_000
  );
  // NOT a dead end: v0 may still be generating and finish in the background. The chat is
  // deliberately left reusable so a retry RESUMES it instead of paying for a second one.
  // `isDeadEndV0Failure` returns false for this code — that is the whole point.
  const timeoutErr: any = new Error(
    `No completed version in v0 chat after ~${budgetMin} minutes — v0 is still generating or has stalled. ` +
    `Retry: the generation resumes on the same chat and is not charged again.` +
    (lastReadError ? ` (last poll error: ${lastReadError})` : "")
  );
  timeoutErr.code = "V0_GENERATION_TIMEOUT";
  throw timeoutErr;
}

// Vercel deployment polling config
let vercelPollIntervalMs = 5_000;
let vercelPollMaxAttempts = 60;

/** Override Vercel polling config (for testing) */
export function setVercelPollConfig(intervalMs: number, maxAttempts: number) {
  vercelPollIntervalMs = intervalMs;
  vercelPollMaxAttempts = maxAttempts;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = MAX_RETRIES,
  baseDelayMs = BASE_DELAY_MS,
  timeoutMs = V0_ATTEMPT_TIMEOUT_MS,
  opts: { retryOnTimeout?: boolean } = {}
): Promise<T> {
  // Whether to retry OUR synthetic per-attempt timeout (V0_CALL_TIMEOUT). Retrying
  // it re-waits the full `timeoutMs` budget each time — e.g. 3 × 300s ≈ 15 min,
  // which reproduces the hang ENG-158 set out to kill. Callers on an interactive
  // path (chat-create) pass `false` to fail fast with a clean retry path; other
  // callers keep the default so a genuinely transient hang still gets a retry.
  const retryOnTimeout = opts.retryOnTimeout ?? true;
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Bound each attempt so a request that never responds fails loudly instead
      // of hanging until undici's 15-min headersTimeout (ENG-158).
      return await withTimeout(Promise.resolve().then(fn), timeoutMs, label);
    } catch (err: any) {
      lastError = err;
      // Unwrap the full failure reason (undici hides it on `err.cause`) so both the
      // retry decision and the surfaced error see the REAL problem, not "fetch failed".
      const detail = describeError(err);
      // Our own per-attempt timeout: we already waited the full budget. Only retry it
      // when the caller opted in (default). 5xx/network errors below are unaffected —
      // those recover in seconds and stay retryable regardless. (ENG-287)
      const isOurTimeout = err.code === "V0_CALL_TIMEOUT";
      // The v0 SDK throws `Error("HTTP <status>: <body>")` on any non-2xx response.
      // Transient server-side failures (5xx) and rate limiting (429) should be
      // retried with backoff — a v0 500 is the documented symptom of a v0 outage
      // that often recovers within seconds.
      const isRetryableHttpStatus = /\bHTTP (429|408|5\d\d)\b/.test(detail);
      const isRetryable =
        (isOurTimeout
          ? retryOnTimeout
          : isRetryableHttpStatus ||
            /fetch failed|ECONNREFUSED|ENOTFOUND|network error|NetworkError|ETIMEDOUT|socket hang up|Connect Timeout|timed out|UND_ERR/i.test(
              detail
            ) ||
            err.code === "ECONNRESET" ||
            err.code === "UND_ERR_HEADERS_TIMEOUT");

      if (!isRetryable || attempt === maxRetries) {
        console.error(`[V0 SERVICE] ${label} failed after ${attempt} attempt(s):`, detail);
        // Surface the unwrapped detail to the caller (who persists it as the page's
        // errorMessage and returns it to the user) — never a bare "fetch failed"/422.
        if (err && typeof err === "object" && detail && detail !== err.message) {
          try { err.message = detail; } catch { /* frozen error — leave as-is */ }
        }
        throw err;
      }

      const jitter = Math.random() * 500;
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + jitter;
      console.warn(
        `[V0 SERVICE] ${label} attempt ${attempt}/${maxRetries} failed (${detail}), retrying in ${delay}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  httpOptions: {
    // AWS SDK v2 defaults to 0 (no timeout), which can cause indefinite hangs on network issues.
    timeout: 30_000,
    connectTimeout: 5_000,
  },
});

const TABLE_PREFIX =
  process.env.NODE_ENV === "development" ? "Dev-" : "";
const TABLE_NAME = `${TABLE_PREFIX}AW-LandingPages`;

/** Convert a page name to a URL-safe slug, max 30 chars, no leading/trailing hyphens. */
export function buildPageSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 30)
    .replace(/^-|-$/g, "");
}

/**
 * An iteration v0 has ACCEPTED but not yet published a version for.
 *
 * Recorded the moment `chats.sendMessage` returns, so a retry whose HTTP response the user
 * lost does not re-send the same instruction — v0 would apply it TWICE ("add a testimonials
 * section" becomes two sections, charged twice). `baseVersionId` is the chat's latest
 * version at send time: once v0 publishes something newer, the edit has landed and the retry
 * adopts it instead of re-sending. v0's own state is the source of truth, not our guess.
 * (ENG-287 follow-up)
 */
export interface PendingIteration {
  baseVersionId: string;
  messageHash: string;
  startedAt: string;
}

export interface GeneratedLandingPage {
  id: string;
  userId: string;
  name: string;
  prompt: string;
  status: "generating" | "draft" | "deploying" | "deployed" | "failed";
  pendingIteration?: PendingIteration;
  v0ProjectId?: string;
  v0ChatId?: string;
  vercelProjectId?: string;
  deployedUrl?: string;
  customDomainUrl?: string;
  githubRepoUrl?: string;
  previewImageUrl?: string;
  iterations: number;
  errorMessage?: string;
  leadListId?: string;
  templateHtml?: string;
  isRootPage?: boolean;
  /**
   * The site this page belongs to. A site = the repo/Vercel project/subdomain a
   * page is deployed into. The site's root record has `siteId === id`; sub-pages
   * carry their root's id. Explicit identity that replaces the old "guess the
   * user's oldest repo" heuristic in {@link findSiteById} / generateLandingPage.
   */
  siteId?: string;
  /**
   * The agent-mode chat session that spawned this generation. Set when a page is
   * generated from a session so a long-running build can be reconnected to that
   * session on completion (durable execution — see durableLandingService).
   */
  originatingSessionId?: string;
  /**
   * Set, exactly once, when a completion has been delivered back to the
   * originating session. Written via a conditional `attribute_not_exists` update
   * so the in-process completion hook and the redeploy-backstop poller can never
   * both deliver (idempotency). See durableLandingService.claimCompletion.
   */
  claimedCompletionAt?: string;
  /**
   * True once a build's run timed out and a "still building" message was shown to
   * the user — i.e. this build still owes the session a completion. The redeploy
   * poller only ever acts on records with this flag, so builds that completed
   * normally (within the run timeout, already delivered over HTTP) are never
   * re-delivered. Cleared implicitly by claimedCompletionAt being set.
   */
  awaitingReconnect?: boolean;
  slug?: string;
  archived?: boolean;
  archivedAt?: string;
  gtmContainerId?: string;
  /**
   * Whether conversion tracking (the site's GTM container) was injected into the
   * generated layout at push time. `false` means the lander shipped with NO tracking — an
   * explicit, machine-readable signal so this can be surfaced/alerted on without reading the
   * generated code. Never implies a fallback to AgentWeb's own GA4 property.
   */
  trackingInstalled?: boolean;
  /**
   * The resolved (or manually-set) Meta pixel id, site-level (root record only),
   * mirroring `gtmContainerId`. Used directly as the CAPI dataset id too — Meta unified
   * pixel + dataset in Graph v25.
   */
  metaPixelId?: string;
  /**
   * Which connected Meta ad account `metaPixelId` was resolved from — needed later
   * so `forward-lead` can look up a fresh access token for the server-side CAPI send.
   */
  metaAdAccountId?: string;
  /**
   * Whether the Meta Pixel base snippet was injected into the generated layout at
   * push time. Mirrors `trackingInstalled`'s "fail loud, never silently skip" contract — false
   * means the lander shipped with no Meta conversion tracking at all.
   */
  metaTrackingInstalled?: boolean;
  /**
   * Per-page (not site-level) — whether the generated form component was confirmed,
   * via the validation-retry check, to actually call fbq('track','Lead') on submit. v0 authors
   * the form freeform, so unlike layout-level injection this can only be checked, not guaranteed.
   */
  pixelLeadEventVerified?: boolean;
  /**
   * Per-page. When set, the generated form redirects the visitor to a THIRD-PARTY
   * destination (e.g. a booking page) after a successful submit, forwarding the
   * submitted email as a query param — for landers that hand off to an external
   * booking/scheduling surface rather than showing an inline success state. Set only
   * at generation time (mirrors leadListId); no manual-override path for v1 (Harsha,
   * ENG-449, 2026-07-24).
   */
  bridgeOutUrl?: string;
  /**
   * Whether the generated form component was confirmed, via the validation-retry
   * check, to actually redirect to bridgeOutUrl with the email appended. Same
   * "verify not guarantee" contract as pixelLeadEventVerified — v0 authors the form
   * freeform, so this can only be checked, never platform-guaranteed.
   */
  bridgeOutVerified?: boolean;
  /**
   * ENG-449 gap #3: result of the automated post-deploy Playwright smoke test
   * (loads the live page, submits the lead form for real, confirms the lead lands in
   * the CRM and — if a pixel is configured — that a real facebook.com/tr request
   * fired). Unlike pixelLeadEventVerified/bridgeOutVerified (static code checks at
   * generation time), this verifies the actually-deployed, actually-live page.
   * Written by runGenerationSmokeTest (landingPageSmokeTest.ts), fire-and-forget
   * after deploy — absent until that first run completes.
   */
  smokeTestResult?: {
    ok: boolean;
    leadCaptured?: boolean;
    pixelFired?: boolean;
    checkedAt: string;
    error?: string;
  };
  context?: string;
  /**
   * State captured at the most recent publish, used to revert it. The pre-merge
   * `main` SHA is the exact byte-perfect rollback target — reverting simply
   * force-resets `main` back to it. Marked with `revertedAt` once consumed.
   */
  lastPublish?: LandingPagePublishRecord;
  createdAt: string;
  updatedAt: string;
}

export interface LandingPagePublishRecord {
  /** The `main` SHA immediately before the publish merge — the revert target. */
  preMergeSha: string;
  /** The merge (or force-advanced) commit SHA that became the new `main`. */
  mergeSha: string;
  /** The draft branch that was published. */
  branch: string;
  /** ISO timestamp of the publish. */
  publishedAt: string;
  /** ISO timestamp set when a revert consumes this record (undefined = revertable). */
  revertedAt?: string;
}

/**
 * Resolve the canonical live URL to report to the user for a landing page.
 *
 * `customDomainUrl` (the user's custom domain or the managed *.agentwebforms.com
 * subdomain) is the public-facing address the user knows their page by, so it
 * takes priority over the raw Vercel `deployedUrl`. Falls back to `deployedUrl`
 * when no custom domain is set, and to an empty string when neither exists.
 */
export function getLandingPageLiveUrl(
  page: Pick<GeneratedLandingPage, "deployedUrl" | "customDomainUrl">
): string {
  return page.customDomainUrl || page.deployedUrl || "";
}

/**
 * Resolve a page's live URL against the domain ACTUALLY attached to its Vercel
 * project (AW-CustomDomains is the source of truth), then fall back to
 * {@link getLandingPageLiveUrl}.
 *
 * `customDomainUrl` is persisted at deploy time and can go stale: a managed
 * `*.agentwebforms.com` subdomain may silently detach from the project (e.g. a
 * re-deploy or a 409 collision that re-added the subdomain with a different
 * suffix), leaving the page with an old subdomain that now serves a Vercel
 * DEPLOYMENT_NOT_FOUND 404. The list endpoint (`GET /generated`) already
 * corrects this in bulk; this is the single-page equivalent so the publish and
 * edit endpoints report the live, attached URL instead of the stale one.
 *
 * Correction rules (mirroring the list endpoint):
 *   - Only MANAGED subdomains (`*.agentwebforms.com`) are corrected. A real
 *     custom domain stored on the page is user-managed and left untouched.
 *   - Among the project's attached domains, prefer a verified custom domain
 *     over a managed subdomain; break ties by most-recently-updated.
 *   - Lookups are scoped to the page OWNER (page.userId), not the caller, so an
 *     org member editing a shared page sees the same attached URL the owner does.
 *
 * Never throws: any failure (no project, no owner, domain lookup error) falls
 * back to the stored value via {@link getLandingPageLiveUrl}.
 */
export async function resolveLandingPageLiveUrl(
  page: Pick<
    GeneratedLandingPage,
    "deployedUrl" | "customDomainUrl" | "vercelProjectId" | "userId" | "slug"
  >
): Promise<string> {
  const fallback = getLandingPageLiveUrl(page);
  if (!page.vercelProjectId || !page.userId) return fallback;

  try {
    const domains = await listDomains(page.userId, page.vercelProjectId);
    if (domains.length === 0) return fallback;

    const rank = (d: { type: string }) => (d.type === "custom" ? 1 : 0);
    let best = domains[0];
    for (const d of domains) {
      if (
        rank(d) > rank(best) ||
        (rank(d) === rank(best) && d.updatedAt > best.updatedAt)
      ) {
        best = d;
      }
    }

    const targetUrl = page.slug
      ? `https://${best.domain}/${page.slug}`
      : `https://${best.domain}`;

    // No stored URL → adopt the attached domain.
    if (!page.customDomainUrl) return targetUrl;

    // Only correct stored managed subdomains that have gone stale; leave real
    // custom domains and already-correct values as-is.
    let storedHost: string | null = null;
    try {
      storedHost = new URL(page.customDomainUrl).host;
    } catch {
      return fallback;
    }
    if (
      storedHost &&
      storedHost.endsWith(`.${SUBDOMAIN_BASE}`) &&
      storedHost !== best.domain
    ) {
      return targetUrl;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export interface BrandContext {
  brandName?: string;
  primaryColor?: string;
  primaryColorEnd?: string;
  isGradient?: boolean;
  secondaryColor?: string;
  fontFamily?: string;
  tagline?: string;
  toneOfVoice?: string;
  logoUrl?: string;
  brandPersonality?: string;
  keyMessages?: string[];
  brandValues?: string[];
  targetAudience?: string;
  founders?: Array<{ name: string; jobTitle: string; styleTone: string }>;
  // Market strategy fields
  businessOverview?: string;
  icp?: Array<{ title: string; description: string; valueProposition: string; buyerPersonas: string[] }>;
  competitors?: Array<{ name: string; description: string }>;
}

/**
 * Project the BrandContext for landing-page generation off a persisted User
 * record (ENG-326). One shared implementation for every v0 entry point so the
 * persisted brand logo — resolved attachments-first via the shared brandLogo
 * module — always reaches the generation prompt.
 *
 * `brandGuidelinesOverride` carries the effective brand record when it does
 * NOT live on the user: org members' brandGuidelines (incl. the persisted /
 * uploaded logo) live on the ORG record, so callers pass
 * `org.brandGuidelines` for them. marketStrategy always comes from the user.
 */
export function buildBrandContextFromUser(
  user: any,
  brandGuidelinesOverride?: any,
): BrandContext {
  const brandContext: BrandContext = {};
  if (!user) return brandContext;

  const bg: any = brandGuidelinesOverride ?? user.brandGuidelines;
  if (bg) {
    const bd = bg.brandData || {};
    brandContext.brandName = bd.brandName;
    brandContext.primaryColor = bd.primaryColor;
    brandContext.primaryColorEnd = bd.primaryColorEnd;
    brandContext.isGradient = bd.isGradient;
    brandContext.secondaryColor = bd.secondaryColor;
    brandContext.fontFamily = bd.fontFamily;
    brandContext.tagline = bd.tagline;
    brandContext.toneOfVoice = bd.toneOfVoice;
    brandContext.brandPersonality = bd.brandPersonality;
    brandContext.keyMessages = bd.keyMessages;
    brandContext.brandValues = bd.brandValues;
    brandContext.targetAudience = bd.targetAudience;
    brandContext.founders = bd.founders;

    const logoUrl = getPersistedBrandLogoUrl(bg);
    if (logoUrl) brandContext.logoUrl = logoUrl;
  }

  // Market strategy — gives v0 real business context for landing page copy
  if (user.marketStrategy) {
    brandContext.businessOverview = user.marketStrategy.businessOverview;
    brandContext.icp = user.marketStrategy.icp;
    brandContext.competitors = user.marketStrategy.competitors;
  }

  return brandContext;
}

/**
 * Extract a condensed outline from the full HTML template (~55KB → ~3KB).
 * Sends section structure, CSS variables, and key patterns to v0 as inspiration
 * without overwhelming its prompt limits.
 */
export function extractTemplateOutline(fullHtml: string): string {
  const sections: string[] = [];

  // Extract CSS variables block (design tokens)
  const cssVarMatch = fullHtml.match(/:root\s*\{([^}]+)\}/);
  if (cssVarMatch) {
    sections.push('/* CSS Design Tokens */\n:root {' + cssVarMatch[1] + '}');
  }

  // Extract section hierarchy from comments
  const hierarchyMatch = fullHtml.match(/SECTION HIERARCHY:[\s\S]*?={3,}/);
  if (hierarchyMatch) {
    sections.push('/* ' + hierarchyMatch[0]);
  }

  // Extract body section structure (class names and IDs give v0 the layout)
  const sectionHeaders = fullHtml.match(/<section[^>]*(?:id|class)="[^"]*"[^>]*>/g) || [];
  if (sectionHeaders.length > 0) {
    sections.push('<!-- Section structure -->\n' + sectionHeaders.join('\n'));
  }

  // Extract key template variables used (gives v0 an idea of what content to generate)
  const variables = new Set<string>();
  const varRegex = /\{\{([^}]+)\}\}/g;
  let match;
  while ((match = varRegex.exec(fullHtml)) !== null) {
    variables.add(match[1].trim());
  }
  if (variables.size > 0) {
    sections.push('<!-- Template variables (content structure) -->\n' +
      Array.from(variables).map(v => `{{${v}}}`).join(', '));
  }

  return sections.join('\n\n');
}

/**
 * Build an enriched prompt that includes brand guidelines context
 */
export function buildBrandEnrichedPrompt(
  userPrompt: string,
  brand: BrandContext,
  leadListId?: string,
  templateHtml?: string,
  /**
   * When set, instructs v0 to fire the Meta Pixel `Lead` event on successful form
   * submit. This is the ONLY way to get that event into the generated form — unlike the
   * layout-level Pixel base snippet (platform-injected, guaranteed), the form component
   * itself is entirely v0-authored freeform code with no platform-owned seam. The
   * validation-retry loop in generateFirstPage/addPageToExistingRepo is the safety net if
   * v0 doesn't comply; this prompt instruction is the primary mechanism.
   */
  metaPixelId?: string,
  /**
   * When set (alongside leadListId), instructs v0 to redirect the visitor to this
   * third-party URL after a successful submit, forwarding the submitted email as a query
   * param — for landers that hand off to an external booking/scheduling page rather than
   * showing an inline success state. Same "prompt instruction + validation-retry safety
   * net" pattern as metaPixelId (see bridgeOutVerified/validateBridgeOutRedirect).
   */
  bridgeOutUrl?: string,
): string {
  const parts: string[] = [];

  parts.push(userPrompt);

  const brandParts: string[] = [];
  if (brand.brandName) brandParts.push(`Brand: ${brand.brandName}`);
  if (brand.primaryColor && brand.isGradient && brand.primaryColorEnd) {
    brandParts.push(`Primary color: gradient from ${brand.primaryColor} to ${brand.primaryColorEnd}`);
  } else if (brand.primaryColor) {
    brandParts.push(`Primary color: ${brand.primaryColor}`);
  }
  if (brand.secondaryColor) brandParts.push(`Secondary color: ${brand.secondaryColor}`);
  if (brand.fontFamily) brandParts.push(`Font: ${brand.fontFamily}`);
  if (brand.tagline) brandParts.push(`Tagline: "${brand.tagline}"`);
  if (brand.toneOfVoice) brandParts.push(`Tone of voice: ${brand.toneOfVoice}`);
  if (brand.logoUrl) brandParts.push(`Logo URL: ${brand.logoUrl}`);
  if (brand.brandPersonality) brandParts.push(`Brand personality: ${brand.brandPersonality}`);
  if (brand.keyMessages && brand.keyMessages.length > 0)
    brandParts.push(`Key messages: ${brand.keyMessages.join(", ")}`);
  if (brand.brandValues && brand.brandValues.length > 0)
    brandParts.push(`Brand values: ${brand.brandValues.join(", ")}`);
  if (brand.targetAudience) brandParts.push(`Target audience: ${brand.targetAudience}`);
  if (brand.founders && brand.founders.length > 0) {
    const founderLines = brand.founders.map(f => `  - ${f.name}, ${f.jobTitle}`).join("\n");
    brandParts.push(`Founders:\n${founderLines}`);
  }

  if (brandParts.length > 0) {
    parts.push("\n\nBrand Guidelines:\n" + brandParts.join("\n"));
  }

  // Market strategy — gives v0 real business context for landing page copy
  const marketParts: string[] = [];
  if (brand.businessOverview) marketParts.push(`Business overview: ${brand.businessOverview}`);
  if (brand.icp && brand.icp.length > 0) {
    const icpLines = brand.icp.map(p =>
      `  - ${p.title}: ${p.description}${p.valueProposition ? ` | Value prop: ${p.valueProposition}` : ""}`
    ).join("\n");
    marketParts.push(`Ideal Customer Profiles:\n${icpLines}`);
  }
  if (brand.competitors && brand.competitors.length > 0) {
    const compLines = brand.competitors.map(c => `  - ${c.name}: ${c.description}`).join("\n");
    marketParts.push(`Competitors (differentiate from these):\n${compLines}`);
  }

  if (marketParts.length > 0) {
    parts.push("\n\nMarket Context:\n" + marketParts.join("\n"));
  }

  if (leadListId) {
    parts.push(
      `\n\nLEAD CAPTURE FORM — IMPORTANT ARCHITECTURE:\n` +
      `1. Build a lead capture form component collecting: email (required), firstName, lastName, company, phone.\n` +
      `   The form MUST submit via fetch('/api/capture', { method: 'POST', ... }) using the RELATIVE path — never hardcode any backend URL in client-side code.\n` +
      `   Show a success message after submission. Show an error message on failure.\n` +
      `2. Do NOT create app/api/capture/route.ts yourself — the platform injects this API route automatically. Only build the form component that posts to the relative /api/capture path.\n` +
      `3. NEVER put absolute backend URLs in any client-side .tsx file.`
    );
  }

  if (leadListId && (metaPixelId || bridgeOutUrl)) {
    parts.push(
      `\n\nLEAD TRACKING — IMPORTANT ARCHITECTURE:\n` +
      `1. In the lead capture form component, generate a shared event id ONCE per submit: const eventId = crypto.randomUUID();\n` +
      `2. Include that same value as an "eventId" field in the JSON body of the fetch('/api/capture', ...) call.\n` +
      `3. On a SUCCESSFUL submission response, call: await fireLeadTracking({ email, eventId, ` +
        `${metaPixelId ? `pixelId: ${JSON.stringify(metaPixelId)}, ` : ""}` +
        `${bridgeOutUrl ? `bridgeOutUrl: ${JSON.stringify(bridgeOutUrl)}` : ""} });\n` +
      `   Import it via: import { fireLeadTracking } from "@/lib/agentweb-track";\n` +
      `4. Do NOT hand-author your own fbq('track', ...) call or window.location.href redirect — ` +
        `fireLeadTracking already does both correctly (including the required flush delay before any redirect). Only call fireLeadTracking; do not duplicate its logic.\n` +
      `5. Do NOT call fbq('init', ...) yourself — the platform already injects the Meta Pixel base code in the root layout.`
    );
  }

  if (templateHtml) {
    parts.push(
      '\n\nDESIGN INSPIRATION:\nThe following HTML template is provided as design inspiration. Use it as a reference for layout structure, section ordering, and content patterns — but feel free to improve the visual design, use modern components, and adapt it to look polished and professional. Do NOT copy the HTML verbatim; instead, build a superior React/Next.js version inspired by its structure.\n\n```html\n' +
      templateHtml +
      '\n```'
    );
  }

  parts.push(
    '\n\nIMPORTANT: Create a complete, production-ready landing page. Use modern design patterns, responsive layout, and the brand colors/fonts specified above.' +
    '\n\nCRITICAL Next.js Rules:' +
    '\n- Any component that uses onClick, onChange, onSubmit, useState, useEffect, or any other event handler or React hook MUST have "use client" at the very top of the file.' +
    '\n- Do NOT use <style jsx> anywhere. Use Tailwind CSS classes or CSS modules instead. styled-jsx causes Turbopack build failures in Next.js 15+.' +
    '\n- For CSS animations (like marquee), define @keyframes in globals.css and reference via Tailwind arbitrary values or className, never via <style jsx>.' +
    '\n- Never pass event handler props (onClick, onChange, etc.) from a Server Component to a Client Component — instead, make the parent a Client Component too, or wrap the interactive part in its own "use client" component.' +
    '\n- The main page.tsx can be a Server Component, but any interactive sections (forms, buttons with handlers, navigation with click handlers) must be extracted into separate Client Components with "use client".' +
    '\n\nCRITICAL Build Rules:' +
    '\n- Do NOT use @import "shadcn" in CSS files. Use standard Tailwind CSS imports instead: @tailwind base; @tailwind components; @tailwind utilities;' +
    '\n- Ensure all imports resolve to actual files in the project. Do not reference modules or paths that do not exist.' +
    '\n- The project must pass `npm run build` cleanly with zero errors.'
  );

  return parts.join("");
}

/**
 * Load the landing-page-v2 template outline as a fallback design inspiration for v0.
 * Checks email_templates_public → templates_public → filesystem, in that order.
 */
async function loadDefaultTemplateOutline(): Promise<string | undefined> {
  const parseArr = (s: any): any[] => {
    if (!s?.settingValue) return [];
    try { return JSON.parse(s.settingValue); } catch { return []; }
  };

  try {
    const oldPublicSetting = await settingsService.getSetting("email_templates_public");
    const oldMatch = parseArr(oldPublicSetting).find((t: any) => t.template_name === "landing-page-v2");
    if (oldMatch?.html_content) {
      const outline = extractTemplateOutline(oldMatch.html_content);
      console.log(`[V0 SERVICE] Loaded landing-page-v2 outline from email_templates_public (${outline.length} chars)`);
      return outline;
    }
  } catch (err) {
    console.warn("[V0 SERVICE] Could not load from email_templates_public:", err);
  }

  try {
    const newPublicSetting = await settingsService.getSetting("templates_public");
    const newMatch = parseArr(newPublicSetting).find((t: any) => t.template_name === "landing-page-v2");
    if (newMatch?.html_content) {
      const outline = extractTemplateOutline(newMatch.html_content);
      console.log(`[V0 SERVICE] Loaded landing-page-v2 outline from templates_public (${outline.length} chars)`);
      return outline;
    }
  } catch (err) {
    console.warn("[V0 SERVICE] Could not load from templates_public:", err);
  }

  try {
    const fallbackPath = path.join(__dirname, "..", "templates", "landing-page-v2.html");
    if (fs.existsSync(fallbackPath)) {
      const outline = extractTemplateOutline(fs.readFileSync(fallbackPath, "utf-8"));
      console.log(`[V0 SERVICE] Loaded landing-page-v2 outline from filesystem (${outline.length} chars)`);
      return outline;
    }
  } catch (fsErr) {
    console.warn("[V0 SERVICE] Filesystem template fallback failed:", fsErr);
  }

  return undefined;
}

/**
 * Create a v0 client using the stored API key.
 * Uses dynamic import since v0-sdk is an ESM package.
 */
async function getV0Client() {
  const apiKey = await getV0ApiKey();
  const { createClient } = await import("v0-sdk");
  return createClient({ apiKey });
}

/**
 * Generate a landing page.
 *
 * Strategy:
 * - If user has NO deployed landing page with a GitHub repo → call v0 (the only v0 call),
 *   create a GitHub repo, deploy to Vercel. This is the "first page" path.
 * - If user ALREADY has a deployed landing page → add a new page route to the EXISTING
 *   GitHub repo via the GitHub Contents API. No v0 call, no new repo. Vercel auto-redeploys.
 */
/**
 * Find a page at the SAME route (slug) that is already live or being built, so a
 * repeated "build the X page" reuses it instead of producing a duplicate. Matches
 * non-archived pages (listLandingPages already excludes archived) on their effective
 * slug, in a deployed/in-flight status — explicitly NOT `failed`, because a retry
 * after a failed build must be allowed to rebuild. Legitimate content refreshes of
 * an already-deployed page go through the dedicated iterate endpoint, not here.
 */
export async function findReusablePageForRoute(
  userId: string,
  slug: string,
  siteId?: string
): Promise<GeneratedLandingPage | null> {
  const pages = await listLandingPages(userId);
  const nowMs = Date.now();
  const match = pages.find((p) => {
    // Routes are per-site: /book-a-demo on Site A must never satisfy a request
    // targeting Site B (the guard key is siteId-scoped for the same reason).
    if (siteId && p.siteId !== siteId && p.id !== siteId) return false;
    if ((p.slug || (p.name ? buildPageSlug(p.name) : undefined)) !== slug) return false;
    if (p.status === "deployed") return true;
    // In-flight records are only reusable while plausibly alive. A record stuck in
    // generating/deploying past the stuck ceiling was abandoned by a crash/redeploy —
    // reusing it would let one wedged record swallow every future build of this
    // route forever (the ENG-277 wedge). The janitor will mark it failed; a fresh
    // build must be allowed to proceed now.
    if (p.status !== "generating" && p.status !== "deploying") return false;
    const ageMs = nowMs - new Date(p.updatedAt || p.createdAt).getTime();
    return Number.isFinite(ageMs) && ageMs <= STUCK_CEILING_MS;
  });
  return match || null;
}

export type LandingSiteMode = "unified" | "separate";

/**
 * Resolve the effective landing-site mode, enforcing the WRITE-ONCE lock.
 *
 * Behavioral contract (single page vs multi page):
 * - "single page" = `unified` (new pages become sub-pages of one site).
 * - "multi page"  = `separate` (each page its own site/domain).
 * The choice is LOCKED once made: switching would mean physically re-homing
 * already-deployed pages across repos/projects/domains (broken URLs + SEO). So:
 * - If the user already has a saved mode, it is authoritative and immutable
 *   (a conflicting request is ignored), and `lockNow` is false.
 * - If no saved mode and the request explicitly picks one, that pick becomes the
 *   mode and `lockNow` is true (persist it write-once).
 * - If neither, fall back to `unified` without locking (no explicit choice yet).
 */
export function resolveLockedSiteMode(
  savedMode: LandingSiteMode | undefined,
  requestedMode: unknown
): { mode: LandingSiteMode; lockNow: boolean } {
  if (savedMode === "unified" || savedMode === "separate") {
    return { mode: savedMode, lockNow: false };
  }
  if (requestedMode === "unified" || requestedMode === "separate") {
    return { mode: requestedMode, lockNow: true };
  }
  return { mode: "unified", lockNow: false };
}

export interface GenerateLandingPageOptions {
  /**
   * Target a specific existing site — add this page/variant to its repo. Wins over
   * `mode`. When omitted, `mode` decides whether to reuse the user's site or make
   * a new one.
   */
  siteId?: string;
  /**
   * `unified` (cost-safe default): add the page to the user's existing site (a
   * route under the shared subdomain) — only the first page spends a v0 site
   * generation. `separate`: each campaign gets its own site/subdomain (a fresh v0
   * generation + repo + project) — costlier, opt-in. Resolved from the user's
   * landingSiteMode preference, overridable per request by the agent.
   */
  mode?: "unified" | "separate";
  /** The agent-mode session that spawned this build (durable-execution marker). */
  originatingSessionId?: string;
  /** See GeneratedLandingPage.bridgeOutUrl's own doc comment. */
  bridgeOutUrl?: string;
}

/**
 * Add a page to an existing site. Picks the engine: with CODING_AGENT_SUBPAGES on,
 * the coding agent writes the page into the repo (no v0 call — cheaper, matches the
 * existing design); off, the v0 path (addPageToExistingRepo) is used unchanged.
 * The coding-agent module is loaded via a dynamic import to break the
 * v0Service <-> codingAgentService import cycle.
 */
async function addSubPage(
  site: GeneratedLandingPage,
  userId: string,
  prompt: string,
  name: string,
  brandContext: BrandContext,
  leadListId?: string,
  templateHtml?: string,
  originatingSessionId?: string,
  bridgeOutUrl?: string
): Promise<GeneratedLandingPage> {
  if (process.env.CODING_AGENT_SUBPAGES === "true") {
    const { addPageViaCodingAgent } = await import("./codingAgentSubpageService");
    return addPageViaCodingAgent(site, userId, prompt, name, brandContext, {
      leadListId,
      originatingSessionId,
    });
  }
  return addPageToExistingRepo(
    site, userId, prompt, name, brandContext, leadListId, templateHtml, originatingSessionId, bridgeOutUrl
  );
}

export async function generateLandingPage(
  userId: string,
  prompt: string,
  name: string,
  brandContext: BrandContext,
  leadListId?: string,
  templateHtml?: string,
  opts?: GenerateLandingPageOptions
): Promise<GeneratedLandingPage> {
  const multiSite = process.env.DURABLE_LANDING_GENERATION === "true";
  const originatingSessionId = opts?.originatingSessionId;
  const mode = opts?.mode ?? "unified";
  const bridgeOutUrl = opts?.bridgeOutUrl;

  if (multiSite) {
    // 1. Explicit target site → add a page/variant to it (shares the subdomain).
    if (opts?.siteId) {
      const site = await findSiteById(opts.siteId, userId);
      if (site?.githubRepoUrl) {
        const slug = buildPageSlug(name);
        const reuse = await findReusablePageForRoute(userId, slug, site.siteId ?? site.id);
        if (reuse) {
          console.log(`[V0 SERVICE] Route /${slug} is already ${reuse.status} (${reuse.id}) — reusing, skipping duplicate build`);
          return reuse;
        }
        return addSubPage(
          site, userId, prompt, name, brandContext, leadListId, templateHtml, originatingSessionId, bridgeOutUrl
        );
      }
      // siteId given but not a usable site (deleted / never deployed) → fall through.
    }

    // 2. "separate" → each campaign gets its OWN site (fresh v0 generation + repo +
    //    subdomain). The costlier, opt-in path (e.g. distinct campaign URLs).
    if (mode === "separate") {
      return generateFirstPage(
        userId, prompt, name, brandContext, leadListId, templateHtml, undefined, originatingSessionId, bridgeOutUrl
      );
    }

    // 3. "unified" (cost-safe default) → add the page to the user's existing site;
    //    only the first page spends a v0 site generation, later pages are routes
    //    under it. Falls back to creating the first site if none exists yet.
    const existing = await findUserSiteRecord(userId);
    if (existing?.githubRepoUrl) {
      const slug = buildPageSlug(name);
      const reuse = await findReusablePageForRoute(userId, slug, existing.siteId ?? existing.id);
      if (reuse) {
        console.log(`[V0 SERVICE] Route /${slug} is already ${reuse.status} (${reuse.id}) — reusing, skipping duplicate build`);
        return reuse;
      }
      return addSubPage(
        existing, userId, prompt, name, brandContext, leadListId, templateHtml, originatingSessionId, bridgeOutUrl
      );
    }
    return generateFirstPage(
      userId, prompt, name, brandContext, leadListId, templateHtml, undefined, originatingSessionId, bridgeOutUrl
    );
  }

  // ── Legacy single-site behavior (flag off). DEPRECATED: delete this whole
  // block (plus findUserSiteRecord's guess + the orphan-scavenging helpers) when
  // DURABLE_LANDING_GENERATION defaults on. The guessing and recycling below exist
  // ONLY because site and job identity were implicit; the multi-site branch above
  // needs none of it — the controller's retry-reconnect (findInFlightJobForSession)
  // and the redeploy poller subsume the reusable/recyclable scans. ──
  const siteRecord = await findUserSiteRecord(userId);

  if (siteRecord) {
    // Route-level idempotency: if this user already has a live or in-flight page at
    // this exact route (slug), reuse it instead of building a duplicate. Re-asking
    // to "build the X page" must not produce a second build of X — the dedicated
    // iterate endpoint handles legitimate content refreshes. Telemetry: 11 routes
    // were built >1x, every one from a DIFFERENT chat session re-asking the same
    // route — so route identity, not session, is the right key.
    const slug = buildPageSlug(name);
    const reuse = await findReusablePageForRoute(userId, slug);
    if (reuse) {
      console.log(`[V0 SERVICE] Route /${slug} is already ${reuse.status} (${reuse.id}) — reusing, skipping duplicate build`);
      return reuse;
    }
    // ── Add new page route to existing repo (no v0 call) ──
    return addPageToExistingRepo(siteRecord, userId, prompt, name, brandContext, leadListId, templateHtml, undefined, bridgeOutUrl);
  }

  const existingPages = await listLandingPages(userId);
  const reusable = existingPages.find(
    (p) => p.v0ChatId && ["generating", "draft", "deploying"].includes(p.status)
  );
  if (reusable) {
    console.log(`[V0 SERVICE] Reusing existing page ${reusable.id} (status: ${reusable.status}, v0ChatId: ${reusable.v0ChatId}) — skipping new v0 chat`);
    return reusable;
  }

  const recyclable = existingPages.find(isOrphanedFailedPage);
  if (recyclable) {
    console.log(`[V0 SERVICE] Recycling failed page record ${recyclable.id} (no v0 chat) for retry`);
    await cleanupOrphanedFailedPages(userId, existingPages, recyclable.id);
  }

  return generateFirstPage(userId, prompt, name, brandContext, leadListId, templateHtml, recyclable?.id, undefined, bridgeOutUrl);
}

/**
 * Resolve a site (the record that owns the repo/Vercel project) by id, scoped to
 * the owner. Accepts either a site-root id or a sub-page id (resolves to its
 * site root via `siteId`). Returns null if not found, not owned, or not yet
 * deployed (no repo). Replaces the old "guess the user's oldest repo" heuristic
 * with an explicit, unambiguous lookup.
 */
export async function findSiteById(
  siteId: string,
  userId: string
): Promise<GeneratedLandingPage | null> {
  const record = await getLandingPage(siteId, userId);
  if (!record) return null;
  if (record.githubRepoUrl) return record;
  // A sub-page id was passed and it isn't the repo owner — resolve to its root.
  if (record.siteId && record.siteId !== record.id) {
    const root = await getLandingPage(record.siteId, userId);
    if (root?.githubRepoUrl) return root;
  }
  return null;
}

/**
 * An orphaned failed page is a first-page record whose generation failed before a v0 chat
 * was ever created: status "failed", no v0ChatId, no githubRepoUrl, and not a sub-page (no
 * slug). These can never be recovered via deploy_landing_page, so they only clutter the
 * user's page list. (listLandingPages already excludes archived records.)
 */
export function isOrphanedFailedPage(p: GeneratedLandingPage): boolean {
  return p.status === "failed" && !p.v0ChatId && !p.githubRepoUrl && !p.slug;
}

/**
 * Archive orphaned failed page records (see {@link isOrphanedFailedPage}), optionally keeping
 * one — the record being recycled for the current retry. Without this, a backlog of dead
 * "failed" pages from repeated past failures lingers on the user's page list. Best-effort:
 * a failure to archive one record is logged and skipped so it never blocks generation.
 * Returns the number of records archived.
 */
export async function cleanupOrphanedFailedPages(
  userId: string,
  pages: GeneratedLandingPage[],
  keepId?: string
): Promise<number> {
  const orphans = pages.filter((p) => isOrphanedFailedPage(p) && p.id !== keepId);
  if (orphans.length === 0) return 0;

  console.log(
    `[V0 SERVICE] Archiving ${orphans.length} orphaned failed page(s) for user ${userId}: ${orphans
      .map((o) => o.id)
      .join(", ")}`
  );

  let archived = 0;
  for (const orphan of orphans) {
    try {
      await dynamodb
        .update({
          TableName: TABLE_NAME,
          Key: { id: orphan.id },
          UpdateExpression:
            "SET archived = :archived, archivedAt = :archivedAt, updatedAt = :updatedAt",
          ExpressionAttributeValues: {
            ":archived": true,
            ":archivedAt": new Date().toISOString(),
            ":updatedAt": new Date().toISOString(),
          },
        })
        .promise();
      archived++;
    } catch (err: any) {
      console.error(
        `[V0 SERVICE] Failed to archive orphaned page ${orphan.id}: ${err.message}`
      );
    }
  }
  return archived;
}

/**
 * First-ever landing page for this user. Calls v0 once, creates GitHub repo, deploys to Vercel.
 */
async function generateFirstPage(
  userId: string,
  prompt: string,
  name: string,
  brandContext: BrandContext,
  leadListId?: string,
  templateHtml?: string,
  existingId?: string,
  originatingSessionId?: string,
  bridgeOutUrl?: string
): Promise<GeneratedLandingPage> {
  // Reuse a recyclable failed record's id when retrying, otherwise mint a new one.
  const id = existingId ?? uuidv4();
  const now = new Date().toISOString();

  // Auto-load the HTML template structure as design inspiration for v0.
  // We send a condensed outline (not the full 55KB HTML) to avoid exceeding v0 prompt limits.
  const effectiveTemplate = templateHtml ?? await loadDefaultTemplateOutline();

  // Resolve the Meta pixel BEFORE building the prompt — the client-side Lead-event
  // instruction must be in the prompt sent to v0 at chat-creation time, which is earlier than
  // the layout-injection push step in deployLandingPage. A Meta API hiccup (or an
  // unconnected/ambiguous account) must never fail generation — it just means no pixel
  // instruction is included, same as GTM's "absent id" path.
  let metaPixelId: string | undefined;
  let metaAdAccountId: string | undefined;
  try {
    const user = await userDb.getUserById(userId);
    const resolution = await metaService.resolveMetaPixelForUser(user, userId);
    if ("pixelId" in resolution) {
      metaPixelId = resolution.pixelId;
      metaAdAccountId = resolution.accountId;
    } else {
      console.warn(`[V0 SERVICE] Meta Pixel not auto-resolved for user ${userId}: ${resolution.reason}`);
    }
  } catch (err: any) {
    console.error(`[V0 SERVICE] Meta Pixel resolution threw unexpectedly (continuing without it): ${err?.message}`);
  }

  const enrichedPrompt = buildBrandEnrichedPrompt(prompt, brandContext, leadListId, effectiveTemplate, metaPixelId, bridgeOutUrl);

  const record: GeneratedLandingPage = {
    id,
    userId,
    name,
    prompt,
    status: "generating",
    iterations: 0,
    isRootPage: true,
    // A new site's root record IS its own site — explicit identity that replaces
    // the old "guess the oldest repo" heuristic.
    siteId: id,
    createdAt: now,
    updatedAt: now,
  };

  if (leadListId) record.leadListId = leadListId;
  if (templateHtml) record.templateHtml = templateHtml;
  if (originatingSessionId) record.originatingSessionId = originatingSessionId;
  if (metaPixelId) { record.metaPixelId = metaPixelId; record.metaAdAccountId = metaAdAccountId; }
  if (bridgeOutUrl) record.bridgeOutUrl = bridgeOutUrl;

  await dynamodb.put({ TableName: TABLE_NAME, Item: record }).promise();

  try {
    const v0 = await getV0Client();

    const chatResponse = await guardedV0ChatCreate({
      userId,
      operation: "first_page_chat_create",
      scopeId: id,
      prompt: enrichedPrompt,
      // responseMode async: sync mode blocks the HTTP call for the FULL generation
      // (3–15 min in prod), guaranteeing a loss against the 300s attempt timeout and
      // minting an orphan, credit-burning chat on every "timeout". Async returns the
      // chatId in seconds; waitForCompletedV0Version absorbs the generation time. (ENG-287)
      create: () => withRetry(
        () => v0.chats.create({ message: enrichedPrompt, responseMode: "async" }),
        "v0 chat creation",
        // Interactive path: fail fast on a timeout instead of re-burning 3 × 300s
        // ≈ 15 min. 5xx/network still retry. The guard makes the user's retry clean. (ENG-287)
        undefined, undefined, undefined,
        { retryOnTimeout: false }
      ),
    });

    if (!("id" in chatResponse) || !chatResponse.id) {
      throw new Error("v0 chat creation did not return a ChatDetail with an id");
    }
    const chatId = chatResponse.id;

    let updateExpression =
      "SET #status = :status, v0ChatId = :chatId, updatedAt = :updatedAt";
    const expressionAttributeValues: Record<string, any> = {
      // Stay `generating` — the ~16-min version poll happens inside deployLandingPage
      // below, so flipping to `draft` here parked the record in a status that
      // IN_FLIGHT_STATUSES, the abandoned-build janitor and route-reuse all ignore for
      // the entire generation. Agent mode then could not find the in-flight job at its
      // 10-min timeout, told the user it FAILED, and the retry started a duplicate build
      // with a second repo and Vercel project. `draft` means "has an undeployed version
      // ready", which is not true yet. (ENG-287 residual)
      ":status": "generating",
      ":chatId": chatId,
      ":updatedAt": new Date().toISOString(),
    };

    if (leadListId) {
      updateExpression += ", leadListId = :leadListId";
      expressionAttributeValues[":leadListId"] = leadListId;
    }

    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: expressionAttributeValues,
      })
      .promise();

    console.log(`[V0 SERVICE] v0 chat created (${chatId}), auto-deploying...`);
    // fromGeneration: this record is legitimately still `generating` (see above) — the
    // public deploy route must keep refusing an actively-generating record.
    const deployed = await deployLandingPage(id, userId, { fromGeneration: true });
    return deployed;
  } catch (error: any) {
    console.error("[V0 SERVICE] Generation failed:", error);

    if (isDeadEndV0Failure(error)) {
      // The chat is a dead end — v0 marked it failed, its output will not validate, or its
      // code will not build. Retrying against it fails identically forever, and since the
      // prompt is not part of the key, a DIFFERENT prompt would reuse it too. Free the
      // identity so the retry mints a fresh chat. A merely-slow generation
      // (V0_GENERATION_TIMEOUT) deliberately does NOT land here: that chat stays reusable
      // so the retry resumes it for free. Best-effort; the failed-status write below is
      // the critical step. (ENG-287 residual)
      await clearV0UsageForPage({ userId, pageId: id });
    }

    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression:
          "SET #status = :status, errorMessage = :error, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "failed",
          ":error": error.message || "Unknown error during generation",
          ":updatedAt": new Date().toISOString(),
        },
      })
      .promise();

    return {
      ...record,
      status: "failed",
      errorMessage: error.message || "Unknown error during generation",
    };
  }
}

/**
 * Add a new page route to an existing deployed landing page's GitHub repo.
 * Calls v0 to generate a full-quality page, extracts files, and commits them
 * under app/<slug>/ in the existing repo. Vercel auto-redeploys.
 */
/** A file to commit: repo-relative path + raw bytes. */
interface RepoFileToCommit {
  path: string;
  /** Omitted for a deletion — the tree entry carries `sha: null` instead of a blob. */
  content?: Buffer;
  /** Remove this path from the repo in the same commit. */
  deleted?: boolean;
}

/** Whether a GitHub-push error is worth retrying (transient network/server) or a
 * fast-forward race (someone else committed to main between our read and write). */
export function isRetryableGithubPushError(err: any): { retryable: boolean; reason: string } {
  const status: number | undefined = err?.response?.status;
  const body = (() => {
    try { return JSON.stringify(err?.response?.data || ""); } catch { return ""; }
  })();
  // 422 "Update is not a fast forward" / 409 conflict = a concurrent commit landed.
  if ((status === 422 && /fast[ -]?forward/i.test(body)) || status === 409) {
    return { retryable: true, reason: "non-fast-forward race" };
  }
  if (status !== undefined && (status >= 500 || status === 429 || status === 408)) {
    return { retryable: true, reason: `http ${status}` };
  }
  const msg = err?.message || "";
  if (
    err?.code === "ECONNRESET" || err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT" ||
    /fetch failed|network error|socket hang up|timeout/i.test(msg)
  ) {
    return { retryable: true, reason: err?.code || "transient network" };
  }
  return { retryable: false, reason: status ? `http ${status}` : (err?.code || "non-retryable") };
}

/**
 * Commit files to a repo's `main` and advance the ref, with retry + rebase.
 *
 * Every attempt re-reads the current `main` SHA and bases the new commit on it,
 * so when two pages are generated into the SAME repo concurrently (the common
 * case under unified multi-site), the second push rebases onto the first instead
 * of failing as a non-fast-forward. Transient network/5xx failures are retried
 * with backoff. This replaces the previous bare-axios sequence, which had no
 * retry and was the dominant source of "fetch failed" generation failures.
 *
 * Returns the pushed commit SHA and the post-push timestamp (used to scope the
 * Vercel deployment poll).
 */
export async function commitFilesToRepoMain(
  repoFullName: string,
  ghHeaders: Record<string, string>,
  filesToCommit: RepoFileToCommit[],
  commitMessage: string,
  maxAttempts = 4
): Promise<{ pushedCommitSha: string; pushTimestampMs: number }> {
  const getMainSha = async (): Promise<string> => {
    const refRes = await axios.get<any>(
      `https://api.github.com/repos/${repoFullName}/git/ref/heads/main`,
      { headers: ghHeaders, timeout: GITHUB_API_TIMEOUT_MS }
    );
    return refRes.data.object.sha;
  };

  let lastErr: any;
  // The commit SHA we last tried to advance main to. The idempotency anchor: if a
  // retry sees main already AT this SHA, our patch actually landed (we just lost the
  // response) — we must NOT re-commit, or we'd build the same page twice.
  let pendingCommitSha: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const latestCommitSha = await getMainSha();

      // Idempotency: a prior attempt's patch already landed (lost-response case).
      if (pendingCommitSha && latestCommitSha === pendingCommitSha) {
        return { pushedCommitSha: pendingCommitSha, pushTimestampMs: Date.now() };
      }

      const treeItems = await Promise.all(
        filesToCommit.map(async (file) => {
          // A deletion carries no blob — GitHub removes a path when its tree entry has a
          // null sha. Routing it through here (rather than the contents API) means deletes
          // inherit this function's rebase/idempotency retry, which matters when another
          // page is being committed into the same repo concurrently.
          if (file.deleted) {
            return { path: file.path, mode: "100644" as const, type: "blob" as const, sha: null };
          }
          const blobRes = await axios.post<any>(
            `https://api.github.com/repos/${repoFullName}/git/blobs`,
            { content: file.content!.toString("base64"), encoding: "base64" },
            { headers: ghHeaders, timeout: GITHUB_API_TIMEOUT_MS }
          );
          return { path: file.path, mode: "100644" as const, type: "blob" as const, sha: blobRes.data.sha };
        })
      );

      const treeRes = await axios.post<any>(
        `https://api.github.com/repos/${repoFullName}/git/trees`,
        { base_tree: latestCommitSha, tree: treeItems },
        { headers: ghHeaders, timeout: GITHUB_API_TIMEOUT_MS }
      );

      const commitRes = await axios.post<any>(
        `https://api.github.com/repos/${repoFullName}/git/commits`,
        { message: commitMessage, tree: treeRes.data.sha, parents: [latestCommitSha] },
        { headers: ghHeaders, timeout: GITHUB_API_TIMEOUT_MS }
      );
      const pushedCommitSha: string = commitRes.data.sha;
      // Mark BEFORE the mutating patch so the catch can tell if it landed.
      pendingCommitSha = pushedCommitSha;

      // The ref update is where a concurrent commit surfaces as a non-fast-forward.
      await axios.patch<any>(
        `https://api.github.com/repos/${repoFullName}/git/refs/heads/main`,
        { sha: pushedCommitSha },
        { headers: ghHeaders, timeout: GITHUB_API_TIMEOUT_MS }
      );

      return { pushedCommitSha, pushTimestampMs: Date.now() };
    } catch (err: any) {
      lastErr = err;

      // Did the patch actually land despite this error? (lost response after a
      // successful write.) If main is already at our commit, STOP — re-committing
      // would create a duplicate page build. Best-effort: a failed check just falls
      // through to the normal retry decision.
      if (pendingCommitSha) {
        try {
          if ((await getMainSha()) === pendingCommitSha) {
            return { pushedCommitSha: pendingCommitSha, pushTimestampMs: Date.now() };
          }
        } catch {
          // ignore — the next attempt's top-of-loop check will catch it too
        }
      }

      const { retryable, reason } = isRetryableGithubPushError(err);
      if (!retryable || attempt === maxAttempts) {
        console.error(`[V0 SERVICE] commit to ${repoFullName} failed after ${attempt} attempt(s) (${reason}): ${err?.message}`);
        throw err;
      }
      const delay = 800 * Math.pow(2, attempt - 1) + Math.random() * 400;
      console.warn(`[V0 SERVICE] commit to ${repoFullName} attempt ${attempt} failed (${reason}); rebasing + retrying in ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function addPageToExistingRepo(
  existingPage: GeneratedLandingPage,
  userId: string,
  prompt: string,
  name: string,
  brandContext: BrandContext,
  leadListId?: string,
  templateHtml?: string,
  originatingSessionId?: string,
  bridgeOutUrl?: string
): Promise<GeneratedLandingPage> {
  const id = uuidv4();
  const now = new Date().toISOString();

  // Create a slug for the new page route
  const slug = buildPageSlug(name);

  const repoMatch = existingPage.githubRepoUrl!.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!repoMatch) throw new Error("Invalid GitHub repo URL on existing page");
  const [, owner, repo] = repoMatch;
  const repoName = repo.replace(".git", "");
  const repoFullName = `${owner}/${repoName}`;

  console.log(`[V0 SERVICE] Adding new page /${slug} to existing repo ${repoFullName} via v0 generation`);

  // Use the custom domain if available, otherwise the vercel deployed URL origin.
  // customDomainUrl takes priority because it's the public-facing address.
  let baseUrl = `https://${repoName}.vercel.app`;
  const urlForBase = existingPage.customDomainUrl || existingPage.deployedUrl;
  if (urlForBase) {
    try {
      const parsed = new URL(urlForBase);
      baseUrl = parsed.origin;
    } catch {
      // URL parse failed — fall back to repo-name-based URL
    }
  }

  const record: GeneratedLandingPage = {
    id,
    userId,
    name,
    prompt,
    status: "generating",
    iterations: 0,
    slug,
    githubRepoUrl: existingPage.githubRepoUrl,
    vercelProjectId: existingPage.vercelProjectId,
    // Belongs to the same site as the page it was added to. A site's root has
    // siteId === id, so a sub-page inherits the root's siteId (or the root's id).
    siteId: existingPage.siteId ?? existingPage.id,
    ...(originatingSessionId ? { originatingSessionId } : {}),
    deployedUrl: baseUrl ? `${baseUrl}/${slug}` : undefined,
    createdAt: now,
    updatedAt: now,
  };

  if (leadListId) record.leadListId = leadListId;
  if (templateHtml) record.templateHtml = templateHtml;
  if (bridgeOutUrl) record.bridgeOutUrl = bridgeOutUrl;

  await dynamodb.put({ TableName: TABLE_NAME, Item: record }).promise();

  // Covers the WHOLE build, not just the v0 poll: the zip download, the corrections, the
  // GitHub push and the 5-min Vercel poll each carry multi-minute retry budgets and write
  // nothing, so without this the record can go silent past the janitor's 30-min ceiling and
  // a LIVE build gets marked failed. (ENG-287 residual)
  const stopHeartbeat = startBuildHeartbeat(id);
  // One budget for the whole build, shared by the initial wait and every correction round.
  const buildDeadline = Date.now() + V0_GENERATION_BUDGET_MS;
  try {
    // ── Step 1: Call v0 to generate proper page content ──
    // If no template provided, fall back to landing-page-v2 (same behaviour as generateFirstPage)
    const effectiveTemplate = templateHtml ?? await loadDefaultTemplateOutline();

    // Sub-pages never re-resolve or re-inject the pixel (the layout is inherited,
    // untouched, from the first page's push) — but the Lead-event prompt instruction is still
    // needed here since each page has its OWN form component. Just read whatever the site's
    // root already resolved, no fresh Meta API call.
    const enrichedPrompt = buildBrandEnrichedPrompt(prompt, brandContext, leadListId, effectiveTemplate, existingPage.metaPixelId, bridgeOutUrl);
    const v0 = await getV0Client();

    console.log(`[V0 SERVICE] Creating v0 chat for additional page /${slug}...`);
    const chatResponse = await guardedV0ChatCreate({
      userId,
      operation: "additional_page_chat_create",
      scopeId: existingPage.siteId ?? existingPage.id,
      slug,
      prompt: enrichedPrompt,
      // responseMode async — see the first-page call site for why sync mode cannot
      // survive the 300s attempt timeout. (ENG-287)
      create: () => withRetry(
        () => v0.chats.create({ message: enrichedPrompt, responseMode: "async" }),
        "v0 chat creation (additional page)",
        // Interactive path: fail fast on a timeout instead of re-burning 3 × 300s
        // ≈ 15 min. 5xx/network still retry. The guard makes the user's retry clean. (ENG-287)
        undefined, undefined, undefined,
        { retryOnTimeout: false }
      ),
    });

    if (!("id" in chatResponse) || !chatResponse.id) {
      throw new Error("v0 chat creation did not return a ChatDetail with an id");
    }
    const chatId = chatResponse.id;

    // Save v0ChatId so the record can be retried/iterated later
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: "SET v0ChatId = :chatId, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":chatId": chatId,
          ":updatedAt": new Date().toISOString(),
        },
      })
      .promise();

    // ── Step 2: Poll for v0 version completion (status-gated — a pending version
    // must not be downloaded half-generated) ──
    let versionId: string | undefined = await waitForCompletedV0Version(
      v0,
      chatId,
      `v0 generation for /${slug}`,
      { heartbeat: () => touchLandingPageRecord(id), deadline: buildDeadline }
    );

    // ── Step 3: Download and validate v0 output ──
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "deploying",
          ":updatedAt": new Date().toISOString(),
        },
      })
      .promise();

    const V0_VALIDATION_MAX_RETRIES = 2;
    let zipBuffer: any;
    // Per-page signal — see the equivalent block in deployLandingPage.
    let pixelLeadEventVerified: boolean | undefined;
    let bridgeOutVerified: boolean | undefined;

    for (let validationAttempt = 0; validationAttempt <= V0_VALIDATION_MAX_RETRIES; validationAttempt++) {
      console.log(`[V0 SERVICE] Downloading v0 files for /${slug} (version ${versionId}, attempt ${validationAttempt + 1})`);
      zipBuffer = await withRetry(
        () => v0.chats.downloadVersion({
          chatId,
          versionId: versionId!,
          // @ts-ignore — SDK types may not include these yet
          format: "zip",
          includeDefaultFiles: true,
        }),
        "v0 zip download (additional page)",
        // Fail fast on OUR synthetic 300s ceiling. The default re-burns it 3× and this call
        // sits inside a 3-round validation loop — worst case 3 × 3 × 300s = 45 min, worse
        // than the hang that started this and past the MCP tool's 25-min budget. 5xx and
        // network errors stay retryable. (ENG-287 residual)
        undefined, undefined, undefined,
        { retryOnTimeout: false }
      );

      const previewFiles = await unzipBuffer(zipBuffer);
      autoFixV0Files(previewFiles);
      // Repair v0's mis-rooted imports BEFORE validating: otherwise check 7 flags them as
      // "missing" and burns the retry loop on a v0 self-heal that keeps timing out, instead of
      // this deterministic fix silently resolving them. A genuinely-missing file has no repair
      // target, so it still (correctly) trips check 7 below.
      repairMisrootedImports(previewFiles);

      try {
        validateV0Output(previewFiles);

        // Same verify-and-retry as deployLandingPage — a sub-page has its OWN form
        // component, so the Lead event must be checked here too, not just on the first page.
        if (existingPage.metaPixelId) {
          // ENG-482: validate against the file set that ACTUALLY ships (post-remap), not
          // previewFiles (v0's raw, unfiltered zip). remapFilesForSubPage's skip-list drops
          // files like app/layout.tsx — v0's own scaffold layout.tsx can independently
          // contain something matching the fbq('track','Lead') regex, which used to make
          // this check pass against code that never reaches the deployed site at all.
          const pixelCheck = validatePixelLeadEvent(remapFilesForSubPage(previewFiles, slug, name));
          if (!pixelCheck.ok && validationAttempt < V0_VALIDATION_MAX_RETRIES) {
            console.warn(`[V0 SERVICE] Meta Pixel Lead event missing for /${slug} (attempt ${validationAttempt + 1}): ${pixelCheck.reason}`);

            await guardedV0CorrectionMessage({
              userId,
              scopeId: existingPage.siteId ?? existingPage.id,
              chatId,
              attempt: validationAttempt,
              send: () => withRetry(
                () => v0.chats.sendMessage({
                  chatId,
                  message:
                    "The lead capture form is missing the Meta Pixel Lead event. In the form's submit handler: " +
                    "generate `const eventId = crypto.randomUUID();`, include it as an \"eventId\" field in the " +
                    "fetch('/api/capture', ...) JSON body, and on a successful response call " +
                    "`window.fbq && window.fbq('track', 'Lead', {}, { eventID: eventId });`. " +
                    `Issue: ${pixelCheck.reason}`,
                }),
                "v0 correction message (pixel lead event, additional page)",
                undefined, undefined, undefined,
                { retryOnTimeout: false }
              ),
            });

            versionId = await waitForCompletedV0Version(
              v0,
              chatId,
              `v0 correction (pixel lead event) for /${slug}`,
              {
                heartbeat: () => touchLandingPageRecord(id),
                deadline: buildDeadline,
                afterVersionId: versionId,
              }
            );

            continue;
          }
          pixelLeadEventVerified = pixelCheck.ok;
          if (!pixelCheck.ok) {
            console.warn(`[V0 SERVICE] Meta Pixel Lead event still missing for /${slug} after retries — proceeding without it: ${pixelCheck.reason}`);
          }
        }

        if (leadListId && bridgeOutUrl) {
          // Same post-remap file set rationale as the pixel check above (ENG-482).
          const bridgeCheck = validateBridgeOutRedirect(remapFilesForSubPage(previewFiles, slug, name), bridgeOutUrl);
          if (!bridgeCheck.ok && validationAttempt < V0_VALIDATION_MAX_RETRIES) {
            console.warn(`[V0 SERVICE] Bridge-out redirect missing for /${slug} (attempt ${validationAttempt + 1}): ${bridgeCheck.reason}`);

            await guardedV0CorrectionMessage({
              userId,
              scopeId: existingPage.siteId ?? existingPage.id,
              chatId,
              attempt: validationAttempt,
              send: () => withRetry(
                () => v0.chats.sendMessage({
                  chatId,
                  message:
                    "The lead capture form is missing the bridge-out redirect. On a SUCCESSFUL submission, " +
                    `redirect the visitor via window.location.href to ${bridgeOutUrl} with the submitted email ` +
                    "appended as an email= query param (URL-encoded). " +
                    `Issue: ${bridgeCheck.reason}`,
                }),
                "v0 correction message (bridge-out redirect, additional page)",
                undefined, undefined, undefined,
                { retryOnTimeout: false }
              ),
            });

            versionId = await waitForCompletedV0Version(
              v0,
              chatId,
              `v0 correction (bridge-out redirect) for /${slug}`,
              {
                heartbeat: () => touchLandingPageRecord(id),
                deadline: buildDeadline,
                afterVersionId: versionId,
              }
            );

            continue;
          }
          bridgeOutVerified = bridgeCheck.ok;
          if (!bridgeCheck.ok) {
            console.warn(`[V0 SERVICE] Bridge-out redirect still missing for /${slug} after retries — proceeding without it: ${bridgeCheck.reason}`);
          }
        }

        break;
      } catch (valErr: any) {
        if (valErr instanceof V0OutputValidationError && validationAttempt < V0_VALIDATION_MAX_RETRIES) {
          console.warn(`[V0 SERVICE] v0 output validation failed for /${slug} (attempt ${validationAttempt + 1}): ${valErr.reason}`);

          await guardedV0CorrectionMessage({
            userId,
            scopeId: existingPage.siteId ?? existingPage.id,
            chatId,
            // Each round of the loop is a genuinely different send. Without this the key was
            // (user, scope, chatId), so round 2 returned {skipped:true}, the loop re-fetched
            // the SAME version and re-downloaded the SAME broken zip — a 3-attempt self-heal
            // that was really 1. (ENG-287 residual)
            attempt: validationAttempt,
            send: () => withRetry(
              () => v0.chats.sendMessage({
                chatId,
                message:
                  "The previous output was not valid code. Please generate actual React/Next.js code — " +
                  "not markdown, not a prompt description, not empty files. " +
                  "Output must include .tsx files with real React components using export and function/const. " +
                  `Issue: ${valErr.reason}`,
              }),
              "v0 correction message (additional page)",
              // A correction that outlives the attempt timeout must fail once, not be
              // re-sent 3× — each retry could double-apply the correction at full cost. (ENG-287)
              undefined, undefined, undefined,
              { retryOnTimeout: false }
            ),
          });

          // Status-gated, like the initial wait: reading `latestVersion.id` straight off the
          // chat is the exact mistake waitForCompletedV0Version exists to prevent — a
          // correction's version is `pending` for a while, and downloading it ships a
          // half-generated page. (ENG-287 residual)
          versionId = await waitForCompletedV0Version(
            v0,
            chatId,
            `v0 correction for /${slug}`,
            {
              heartbeat: () => touchLandingPageRecord(id),
              deadline: buildDeadline,
              afterVersionId: versionId, // must be the correction's NEW version, not the old one
            }
          );

          continue;
        }
        throw valErr;
      }
    }

    // ── Step 4: Extract and remap files for the new page route ──
    const allFiles = await unzipBuffer(zipBuffer);
    autoFixV0Files(allFiles);
    const filesToCommit = remapFilesForSubPage(allFiles, slug, name);

    // ENG-449 follow-up: unlike the capture-route/middleware sync below (best-effort,
    // fire-and-forget — a stale LIST_BY_PATH only breaks a lead SUBMIT, not the BUILD), this
    // page's own form imports `@/lib/agentweb-track` (per the updated buildBrandEnrichedPrompt
    // instruction) ONLY when that instruction was actually included — same gate
    // buildBrandEnrichedPrompt itself uses (leadListId && (metaPixelId || bridgeOutUrl)). When
    // it applies, the import is a genuine build-time dependency: a repo created before this
    // file existed (or one whose deferred sync hasn't landed yet) fails this page's Vercel
    // build OUTRIGHT with "Module not found" if the file isn't in THIS commit — live-repro'd
    // exactly this by adding a page to a pre-existing test-env repo. Must ride in the SAME
    // commit whose build status this function actually checks, not a later async sync.
    if (leadListId && (existingPage.metaPixelId || bridgeOutUrl)) {
      filesToCommit.push({ path: "lib/agentweb-track.ts", content: Buffer.from(buildTrackingHelper()) });
    }

    // Deterministically fix v0's mis-rooted relative imports (e.g. a landing/ component importing
    // `./landing/Sibling` instead of `./Sibling`) against the FINAL committed set — no v0
    // round-trip, so it heals what check 7 catches but v0's self-heal correction keeps timing out.
    const importRepairs = repairMisrootedImports(filesToCommit);
    if (importRepairs > 0) {
      console.log(`[V0 SERVICE] Repaired ${importRepairs} mis-rooted relative import(s) in /${slug} files`);
    }

    console.log(`[V0 SERVICE] Extracted ${filesToCommit.length} files for /${slug}: ${filesToCommit.map(f => f.path).join(", ")}`);

    // ── Step 5: Commit files to existing repo using Git Trees API ──
    const { token: ghToken } = await getGitHubOrgToken();
    const ghHeaders = {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github.v3+json",
    };

    // Commit the new page's files to main with retry + rebase. Each attempt
    // re-reads the latest main SHA, so a concurrent commit (another page being
    // generated into the SAME repo) is rebased onto rather than rejected as a
    // non-fast-forward. Transient network/5xx failures are retried too — this
    // path was previously bare axios, the dominant source of "fetch failed".
    // Heal sub-pages the PRE-FIX remap poisoned. `next build` type-checks the whole project,
    // so one sibling page with an unresolvable import fails the deployment for every page —
    // our correct new page included. Repairs ride in the SAME commit, so a single Vercel
    // build validates both. Best-effort: a repo we cannot scan must not block the page add.
    let repairs: RepoFileToCommit[] = [];
    try {
      repairs = await repairPoisonedSubPagesInRepo(
        repoFullName,
        ghHeaders,
        new Set(filesToCommit.map((f) => f.path)),
      );
      if (repairs.length > 0) {
        console.log(
          `[V0 SERVICE] Repairing ${repairs.length} poisoned import(s) in ${repoFullName}: ${repairs.map((f) => f.path).join(", ")}`
        );
      }
    } catch (repairErr: any) {
      console.warn(`[V0 SERVICE] Import repair scan failed for ${repoFullName} (continuing): ${repairErr?.message}`);
    }

    const { pushedCommitSha, pushTimestampMs } = await commitFilesToRepoMain(
      repoFullName,
      ghHeaders,
      [...filesToCommit, ...repairs],
      repairs.length > 0
        ? `Add new page: ${name} (/${slug}) + repair ${repairs.length} broken import(s)`
        : `Add new page: ${name} (/${slug})`
    );

    console.log(`[V0 SERVICE] Pushed ${filesToCommit.length} files for /${slug} to ${repoFullName} (${pushedCommitSha.substring(0, 7)}) — polling Vercel for build status`);

    // Poll Vercel deployment to verify the build succeeds before marking as deployed.
    // Match on the exact commit we just pushed so a stale build that lacks the new
    // app/<slug>/ route is never mistaken for a successful deploy (the 404 bug).
    const vercelToken = await getVercelToken();
    const deploymentResult = await pollVercelDeployment(existingPage.vercelProjectId!, vercelToken, pushTimestampMs, pushedCommitSha);

    if (deploymentResult.buildStatus === "error" || deploymentResult.buildStatus === "timeout") {
      const errorMsg = `Vercel build failed for /${slug}: ${deploymentResult.buildError || "Unknown build error"}`;
      console.error(`[V0 SERVICE] ${errorMsg}`);

      // ONLY a real build `error` is a dead end. `timeout` means "we stopped waiting after
      // 5 min", NOT "this code will never compile" — a normal Next.js cold build can outrun
      // that poll, and pollVercelDeployment also degrades API flakiness to `timeout`. Freeing
      // the identity there would be the orphan double-spend this whole split exists to
      // prevent: the page goes live a minute later, the user retries the `failed` card, and
      // we mint a second full-cost chat and push a second commit to the same repo.
      //
      // A genuine build error IS a dead end: this chat's code does not compile and will not
      // compile next time either, so every retry would reuse it, re-download the same broken
      // version and fail identically, forever — and because the prompt is not part of the
      // key, even a NEW prompt would reuse it. Cleared inline because this path RETURNS
      // rather than throwing, so the catch below never runs. (ENG-287 residual)
      if (deploymentResult.buildStatus === "error") {
        await clearV0UsageForPage({
          userId,
          pageId: id,
          siteId: existingPage.siteId ?? existingPage.id,
          slug,
        });
      }

      await dynamodb
        .update({
          TableName: TABLE_NAME,
          Key: { id },
          UpdateExpression: "SET #status = :status, errorMessage = :error, updatedAt = :updatedAt",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": "failed",
            ":error": errorMsg,
            ":updatedAt": new Date().toISOString(),
          },
        })
        .promise();

      return {
        ...record,
        status: "failed" as const,
        errorMessage: errorMsg,
      };
    }

    // Register this new page's own path in the repo-level capture route (ENG-483).
    // Without this, a new sub-page's lead form 422s forever ("no lead list configured")
    // until some UNRELATED action (a GTM/Pixel manual override) happens to resync the
    // whole-site LIST_BY_PATH map as a side effect. Best-effort: a site whose sibling
    // lookup or GitHub sync fails must still keep its just-deployed page. Reuses the
    // exact ENG-310 mechanism (`syncLeadCaptureForPage` in routes/landingPageGeneration.ts)
    // which does this same thing when a lead list is attached after the fact.
    try {
      // ENG-485: re-derived FRESH by syncLeadCaptureFilesToRepo on every retry attempt, not
      // just once here — see that function's own doc comment on why a static snapshot isn't
      // safe to reuse across a rebase retry.
      const buildListByPath = async (): Promise<Record<string, string>> => {
        const siblings = await getLandingPagesByOwner(userId);
        const listByPath: Record<string, string> = {};
        for (const p of siblings) {
          if (p.id === id) continue;
          if (p.githubRepoUrl !== existingPage.githubRepoUrl) continue;
          if (!p.leadListId) continue;
          listByPath[p.slug ? `/${p.slug}` : "/"] = p.leadListId;
        }
        if (leadListId) listByPath[`/${slug}`] = leadListId;
        return listByPath;
      };

      // ENG-489: syncLeadCaptureFilesToRepo fully regenerates app/api/capture/route.ts,
      // so a sync that omits the site's pixelId/metaAdAccountId would silently strip an
      // already-configured Meta pixel back out of the route. existingPage IS the site's
      // root record (passed in by the caller), so its own metaPixelId/metaAdAccountId are
      // already the right values — no extra lookup needed.
      const syncResult = await syncLeadCaptureFilesToRepo(
        repoFullName,
        buildListByPath,
        existingPage.metaPixelId,
        existingPage.metaAdAccountId,
      );
      if (!syncResult.committed && syncResult.reason !== "up-to-date") {
        console.warn(
          `[V0 SERVICE] ENG-483: lead-capture route sync did not commit for new page /${slug}: ${syncResult.reason}`
        );
      } else if (syncResult.committed && syncResult.pushedCommitSha) {
        // Fire-and-forget: never block returning this page as deployed on a SECOND
        // Vercel build. A concurrent sub-page add is the common case ENG-483 exists
        // for, and it routinely supersedes this exact commit before Vercel ever
        // finishes building it — awaiting this poll here would hang every bulk/rapid
        // page add for up to the full poll window (production: up to 5 minutes) for a
        // build result that, in the common case, will never resolve to this commit at
        // all. Visibility only: the page's OWN content already deployed successfully
        // above, so nothing here can change this page's outcome, only get logged.
        const { pushedCommitSha, pushTimestampMs } = syncResult;
        void pollVercelDeployment(existingPage.vercelProjectId!, vercelToken, pushTimestampMs, pushedCommitSha)
          .then((syncDeployResult) => {
            if (syncDeployResult.buildStatus === "error") {
              console.error(
                `[V0 SERVICE] ENG-483: capture-route sync build FAILED for ${repoFullName} ` +
                  `(commit ${pushedCommitSha.substring(0, 7)}): ${syncDeployResult.buildError}. ` +
                  `Page /${slug} is deployed, but its lead form (and possibly siblings') may still 422 ` +
                  `until the route resyncs.`
              );
            } else if (syncDeployResult.buildStatus === "timeout") {
              console.warn(
                `[V0 SERVICE] ENG-483: capture-route sync build for ${repoFullName} (commit ` +
                  `${pushedCommitSha.substring(0, 7)}) did not confirm READY within the poll window — ` +
                  `likely just slow, or superseded by a newer concurrent commit; not treated as a failure.`
              );
            }
          })
          .catch((pollErr: any) => {
            console.error(
              `[V0 SERVICE] ENG-483: capture-route sync build poll itself failed for ${repoFullName}:`,
              pollErr?.message || pollErr
            );
          });
      }
    } catch (syncErr: any) {
      console.error(
        `[V0 SERVICE] ENG-483: lead-capture route sync failed for new page /${slug}:`,
        syncErr?.message || syncErr
      );
    }

    // Update record to deployed, re-persisting repo fields in case they were missing
    const deployedSubPage: GeneratedLandingPage = {
      ...record,
      status: "deployed",
      updatedAt: new Date().toISOString(),
      ...(pixelLeadEventVerified !== undefined ? { pixelLeadEventVerified } : {}),
      ...(bridgeOutVerified !== undefined ? { bridgeOutVerified } : {}),
    };

    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression:
          "SET #status = :status, updatedAt = :updatedAt, githubRepoUrl = :repoUrl, vercelProjectId = :vercelId" +
          (pixelLeadEventVerified !== undefined ? ", pixelLeadEventVerified = :pixelLeadEventVerified" : "") +
          (bridgeOutVerified !== undefined ? ", bridgeOutVerified = :bridgeOutVerified" : ""),
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "deployed",
          ":updatedAt": new Date().toISOString(),
          ":repoUrl": existingPage.githubRepoUrl ?? record.githubRepoUrl,
          ":vercelId": existingPage.vercelProjectId ?? record.vercelProjectId,
          ...(pixelLeadEventVerified !== undefined ? { ":pixelLeadEventVerified": pixelLeadEventVerified } : {}),
          ...(bridgeOutVerified !== undefined ? { ":bridgeOutVerified": bridgeOutVerified } : {}),
        },
      })
      .promise();

    void enqueueLandingPageHumanEval(deployedSubPage);
    // Dynamic import: landingPageSmokeTest.ts imports FROM this module (GeneratedLandingPage,
    // updateLandingPageSmokeTestResult), so a static import here would be circular.
    void import("./landingPageSmokeTest")
      .then((m) => m.runGenerationSmokeTest(deployedSubPage))
      .catch((err) => console.warn(`[V0 SERVICE] Smoke test dispatch failed: ${err?.message}`));

    return deployedSubPage;
  } catch (error: any) {
    console.error("[V0 SERVICE] Failed to add page to repo:", error);

    if (isDeadEndV0Failure(error)) {
      // Dead-end chat (see generateFirstPage catch) — free the route identity so the retry
      // creates a fresh chat rather than reusing one that can never deliver. A merely-slow
      // generation (V0_GENERATION_TIMEOUT) deliberately keeps its chat so the retry resumes
      // it for free. (ENG-287 residual)
      await clearV0UsageForPage({
        userId,
        pageId: id,
        siteId: existingPage.siteId ?? existingPage.id,
        slug,
      });
    }

    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression:
          "SET #status = :status, errorMessage = :error, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "failed",
          ":error": error.message || "Failed to add page to repo",
          ":updatedAt": new Date().toISOString(),
        },
      })
      .promise();

    return {
      ...record,
      status: "failed",
      errorMessage: error.message || "Failed to add page to repo",
    };
  } finally {
    stopHeartbeat();
  }
}

/**
 * Inject or replace a Next.js App Router `metadata` export in a page.tsx so the
 * resolved `<title>` reflects the new page instead of inheriting the root
 * layout's stale title (e.g. a hardcoded "xCures® | HIMSS 2026…" from an
 * earlier generation). Next.js per-page metadata takes precedence over
 * layout metadata, so this is sufficient to fix the rendered <title>.
 *
 * Behaviour:
 * - A CLIENT component is left completely alone — see below.
 * - If the file already exports a `metadata` object, rewrite its `title`
 *   field (or insert one) to the provided title.
 * - Otherwise, prepend a new `export const metadata = { title: "…" }` block.
 */
export function ensurePageMetadataTitle(content: string, title: string): string {
  if (!title || !title.trim()) return content;

  // A CLIENT component must never export `metadata` — Next.js hard-fails the build with
  // "You are attempting to export metadata from a component marked with use client". We used
  // to inject it right after the directive and call that defensive; it is the opposite. It
  // manufactures a page that can never build, and because `next build` type-checks the whole
  // project, that ONE page bricks the entire site — every sibling page included. Seen in prod
  // on a shared site whose sub-pages "illegally exported metadata from client components".
  //
  // A missing <title> is cosmetic. An undeployable site is not. So when v0 emits a client
  // component, leave it entirely alone — no injection, and no rewrite of an existing export
  // either, since touching it would only relabel code that cannot compile.
  if (/^\s*(?:'use client'|"use client")/.test(content)) return content;

  const escaped = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  // Case 1: existing `export const metadata = { ... }` — rewrite its title field
  const existingMetadataRegex = /export\s+const\s+metadata\s*(?::\s*[^=]+)?=\s*\{([\s\S]*?)\}\s*;?/;
  const match = content.match(existingMetadataRegex);
  if (match) {
    const body = match[1];
    let newBody: string;
    if (/\btitle\s*:/.test(body)) {
      // Replace existing title field value (string or template literal)
      newBody = body.replace(
        /(\btitle\s*:\s*)(?:`[^`]*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/,
        `$1"${escaped}"`
      );
    } else {
      // Insert a title field at the top of the metadata object
      newBody = `\n  title: "${escaped}",` + body;
    }
    const replacement = `export const metadata = {${newBody}}`;
    return content.replace(existingMetadataRegex, replacement);
  }

  // Case 2: no existing metadata export — prepend a fresh one after any
  // 'use client' directive. In practice page.tsx should be a server component
  // so the directive is unusual here, but we handle it defensively.
  return `export const metadata = { title: "${escaped}" };\n\n` + content;
}

/**
 * Remap files from a v0 zip for a sub-page route.
 * - app/page.tsx → app/<slug>/page.tsx
 * - components/*.tsx → app/<slug>/_components/*.tsx (avoids conflicts with root page)
 * - app/api/* → app/api/* (shared API routes, kept as-is)
 * - Config files, layout.tsx, globals.css → skipped (use existing project's)
 *
 * Also rewrites import paths in the page file to point to the relocated components.
 * If `pageTitle` is provided, injects/overrides a Next.js `metadata.title` export
 * on the remapped page.tsx so the rendered <title> reflects the new page rather
 * than inheriting a stale title from the root layout.
 */
export function remapFilesForSubPage(
  files: Array<{ path: string; content: Buffer }>,
  slug: string,
  pageTitle?: string
): Array<{ path: string; content: Buffer }> {
  // Files to skip — the existing project already has these
  const skipPatterns = [
    /^package\.json$/,
    /^package-lock\.json$/,
    /^tsconfig\.json$/,
    /^next\.config\.(ts|js|mjs)$/,
    /^next-env\.d\.ts$/,
    /^tailwind\.config\.(ts|js)$/,
    /^postcss\.config\.(ts|js|mjs|cjs)$/,
    /^\.gitignore$/,
    /^README\.md$/,
    /^app\/layout\.tsx$/,
    /^app\/globals\.css$/,
    /^lib\/utils\.ts$/,
    /^components\/ui\//,   // shadcn UI primitives — already in root project
  ];

  const result: Array<{ path: string; content: Buffer }> = [];
  const componentRenames = new Map<string, string>(); // old import path → new import path
  // Where each emitted file CAME FROM. A relative import is only meaningful against the
  // file's original location, so resolving one after the move needs this.
  const originalPathOf = new Map<string, string>(); // new path → original path

  for (const file of files) {
    // Skip config and shared files
    if (skipPatterns.some((p) => p.test(file.path))) continue;

    if (file.path === "app/page.tsx") {
      // Main page → sub-route page
      result.push({ path: `app/${slug}/page.tsx`, content: file.content });
      originalPathOf.set(`app/${slug}/page.tsx`, file.path);
    } else if (file.path.startsWith("components/") && !file.path.startsWith("components/ui/")) {
      // Custom components → namespaced under the sub-route to avoid conflicts
      const relativeName = file.path.replace("components/", "");
      const newPath = `app/${slug}/_components/${relativeName}`;
      result.push({ path: newPath, content: file.content });
      originalPathOf.set(newPath, file.path);
      // Track rename: @/components/foo → ./_components/foo (relative from app/<slug>/)
      const oldImport = `@/components/${relativeName.replace(/\.tsx$/, "")}`;
      const newImport = `./_components/${relativeName.replace(/\.tsx$/, "")}`;
      componentRenames.set(oldImport, newImport);
    } else if (file.path.startsWith("app/api/")) {
      // Skip app/api/ routes — the existing root repo already has its own API routes
      // (possibly in a route group like (frontend)/api/capture/route.ts), and adding a
      // duplicate would cause a Turbopack "conflicting routes" build error.
    } else if (file.path.startsWith("app/") && file.path !== "app/page.tsx") {
      // Other app files (e.g. app/loading.tsx) → namespace under slug
      const relativeName = file.path.replace("app/", "");
      result.push({ path: `app/${slug}/${relativeName}`, content: file.content });
      originalPathOf.set(`app/${slug}/${relativeName}`, file.path);
    }
    // Skip everything else (public/, lib/, etc.) — root project already has them
  }

  // Rewrite imports in all committed .tsx/.ts files
  for (const file of result) {
    if (!file.path.endsWith(".tsx") && !file.path.endsWith(".ts")) continue;
    let content = file.content.toString("utf-8");
    let changed = false;

    // 0. Normalize RELATIVE imports to the `@/` alias, resolved against the file's ORIGINAL
    //    location.
    //
    //    v0 does not always emit the `@/` alias — it also emits plain relative paths, which
    //    are perfectly correct at the repo root. They break the instant we move the file:
    //    `../components/landing/nav` from `app/page.tsx` means `components/landing/nav`, but
    //    from `app/<slug>/page.tsx` it means `app/components/landing/nav`, which does not
    //    exist. The component has ALSO moved (to `_components/`), so the path is wrong twice
    //    over. Observed in prod as `Module not found: '../components/landing/nav'` — a failed
    //    Vercel build and a dead sub-page.
    //
    //    Resolving against the original directory and re-emitting as `@/...` (which always
    //    resolves from the repo root) makes step 1 below handle moved components uniformly,
    //    and fixes the same latent break for `../lib/...`, `../hooks/...` and
    //    `../components/ui/...`, none of which move.
    const origPath = originalPathOf.get(file.path);
    if (origPath) {
      const origDir = path.posix.dirname(origPath);
      content = content.replace(
        /(from\s+['"])(\.\.?\/[^'"]+)(['"])/g,
        (whole, pre: string, spec: string, post: string) => {
          const resolved = path.posix.normalize(path.posix.join(origDir, spec));
          // Escapes the repo root — we cannot say what it points at; leave it untouched
          // rather than emit something confidently wrong.
          if (resolved.startsWith("..")) return whole;
          changed = true;
          return `${pre}@/${resolved}${post}`;
        }
      );
    }

    // 1. Rewrite @/components/foo → ./_components/foo (absolute → relative)
    for (const [oldImport, newImport] of componentRenames) {
      const regex = new RegExp(
        `(from\\s+['"])${oldImport.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(['"])`,
        "g"
      );
      if (regex.test(content)) {
        content = content.replace(regex, `$1${newImport}$2`);
        changed = true;
      }
    }

    // 2. Fix relative imports inside _components/ files.
    //    When v0 generates a component at components/foo.tsx that imports
    //    from "./_components/bar", after remapping to _components/foo.tsx
    //    the sibling is at _components/bar.tsx — so strip the extra "_components/" prefix.
    if (file.path.includes(`/_components/`)) {
      const fixedContent = content.replace(
        /(from\s+['"])\.?\/_components\//g,
        "$1./"
      );
      if (fixedContent !== content) {
        content = fixedContent;
        changed = true;
      }
    }

    if (changed) {
      file.content = Buffer.from(content);
    }
  }

  // Inject per-page metadata title so sub-pages don't inherit the root
  // layout's (possibly stale) <title>. See ensurePageMetadataTitle for details.
  if (pageTitle && pageTitle.trim()) {
    const pagePath = `app/${slug}/page.tsx`;
    const pageFile = result.find((f) => f.path === pagePath);
    if (pageFile) {
      const updated = ensurePageMetadataTitle(pageFile.content.toString("utf-8"), pageTitle);
      pageFile.content = Buffer.from(updated);
    }
  }

  return result;
}

/** Extensions Next/TS will try when an import omits one. */
const MODULE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];

/** Does `target` (repo-root-relative, extensionless) name a file that actually exists? */
function moduleExists(target: string, existingPaths: Set<string>): boolean {
  if (existingPaths.has(target)) return true;
  for (const ext of MODULE_EXTENSIONS) {
    if (existingPaths.has(`${target}${ext}`)) return true;
    if (existingPaths.has(`${target}/index${ext}`)) return true;
  }
  return false;
}

/**
 * Invert remapFilesForSubPage: where did this committed file live when v0 emitted it?
 * A relative import is only meaningful against the file's ORIGINAL directory, so healing
 * one after the fact requires undoing the move.
 *
 * Returns null for anything that was never moved (the root page, layout, etc.) — those
 * files' relative imports are correct and must not be touched.
 */
function originalPathOfSubPageFile(filePath: string): { slug: string; original: string } | null {
  const m = filePath.match(/^app\/([^/]+)\/(.+)$/);
  if (!m) return null; // app/page.tsx, app/layout.tsx — never moved
  const [, slug, rest] = m;
  if (rest.startsWith("_components/")) {
    // app/<slug>/_components/x.tsx  ←  components/x.tsx
    return { slug, original: `components/${rest.slice("_components/".length)}` };
  }
  // app/<slug>/page.tsx ← app/page.tsx;  app/<slug>/loading.tsx ← app/loading.tsx
  return { slug, original: `app/${rest}` };
}

/**
 * Repair sub-page files already committed to a repo by the PRE-FIX remap, which moved files
 * without rewriting their plain relative imports.
 *
 * Why this exists at all: `next build` type-checks the whole project, so a SINGLE page with an
 * unresolvable import fails the deployment for EVERY page on the site. A site poisoned while
 * that bug was live is permanently undeployable — regenerating cannot save it, because the
 * broken file is still in the repo. remapFilesForSubPage stops new poisoning; this undoes the
 * damage already done.
 *
 * The invariant that makes it safe to rewrite files we did not generate this run:
 *
 *   ONLY rewrite an import that does not CURRENTLY resolve.
 *
 * A healthy repo is untouched. A broken one can only move toward compiling — we never
 * "fix" something that already works, and when no file in the repo could satisfy an import we
 * leave it alone rather than emit a confident guess. It follows that the pass is idempotent.
 *
 * Pure: `existingPaths` is the repo's file list, so this is fully testable without GitHub.
 * Returns ONLY the files whose content changed.
 */
export function repairSubPageImports(
  files: Array<{ path: string; content: string }>,
  existingPaths: Set<string>,
): Array<{ path: string; content: string }> {
  const repaired: Array<{ path: string; content: string }> = [];

  for (const file of files) {
    if (!file.path.endsWith(".tsx") && !file.path.endsWith(".ts")) continue;
    const origin = originalPathOfSubPageFile(file.path);
    if (!origin) continue; // never moved → its relative imports were always correct

    const { slug, original } = origin;
    const currentDir = path.posix.dirname(file.path);
    const originalDir = path.posix.dirname(original);
    let changed = false;

    const content = file.content.replace(
      /(from\s+['"])(\.\.?\/[^'"]+)(['"])/g,
      (whole, pre: string, spec: string, post: string) => {
        // Already resolves from where the file sits now? Then it is not broken — hands off.
        const asWritten = path.posix.normalize(path.posix.join(currentDir, spec));
        if (moduleExists(asWritten, existingPaths)) return whole;

        // Broken. Read it the way v0 meant it — against the file's ORIGINAL directory.
        const intended = path.posix.normalize(path.posix.join(originalDir, spec));
        if (intended.startsWith("..")) return whole; // escapes the repo root — unknowable

        // The remap relocates components/* (but not components/ui/*) into the page's
        // _components/. Look there first, then at the untouched root.
        const candidates: string[] = [];
        if (intended.startsWith("components/") && !intended.startsWith("components/ui/")) {
          candidates.push(`app/${slug}/_components/${intended.slice("components/".length)}`);
        }
        candidates.push(intended);

        const target = candidates.find((c) => moduleExists(c, existingPaths));
        if (!target) return whole; // nothing in the repo satisfies it — do not guess

        changed = true;
        return `${pre}@/${target}${post}`;
      },
    );

    if (changed) repaired.push({ path: file.path, content });
  }

  return repaired;
}

/** Upper bound on files read during a repair scan, so a huge repo can't stall a page add. */
const REPAIR_SCAN_MAX_FILES = 200;

/**
 * Scan a repo's existing sub-pages for imports poisoned by the pre-fix remap and return the
 * repaired files, ready to ride along in the caller's commit.
 *
 * Adding a page to a poisoned site is precisely when we can heal it — we are already listing
 * the repo and pushing a commit, and a repair in that SAME commit means one Vercel build
 * validates both. Without this, the new page is correct and the site still cannot deploy,
 * because a sibling page's broken import fails the build for everything.
 *
 * `skipPaths` are the files the caller is committing this run: they are correct by
 * construction, and re-reading the stale copies from the repo would clobber them.
 */
export async function repairPoisonedSubPagesInRepo(
  repoFullName: string,
  ghHeaders: Record<string, string>,
  skipPaths: Set<string>,
): Promise<RepoFileToCommit[]> {
  const tree = await listRepoTree(repoFullName, ghHeaders);
  const existingPaths = new Set(tree);

  const candidates = tree.filter(
    (p) => /^app\/[^/]+\/.+\.(tsx|ts)$/.test(p) && !skipPaths.has(p),
  );
  if (candidates.length === 0) return [];

  const scanned = candidates.slice(0, REPAIR_SCAN_MAX_FILES);
  if (scanned.length < candidates.length) {
    console.warn(
      `[V0 SERVICE] Import repair scanned ${scanned.length} of ${candidates.length} files in ${repoFullName} — ` +
        `${candidates.length - scanned.length} skipped by the ${REPAIR_SCAN_MAX_FILES}-file cap`,
    );
  }

  const files = await Promise.all(
    scanned.map(async (p) => {
      const res = await axios.get<any>(
        `https://api.github.com/repos/${repoFullName}/contents/${p}`,
        { headers: ghHeaders, timeout: GITHUB_API_TIMEOUT_MS },
      );
      return { path: p, content: Buffer.from(res.data.content, "base64").toString("utf-8") };
    }),
  );

  return repairSubPageImports(files, existingPaths).map((f) => ({
    path: f.path,
    content: Buffer.from(f.content),
  }));
}

/**
 * Deploy a generated landing page: download from v0 → create GitHub repo → connect to Vercel.
 * v0 is only used for initial code generation. All future edits go through GitHub → Vercel auto-deploys.
 */
export async function deployLandingPage(
  id: string,
  userId: string,
  opts: { fromGeneration?: boolean } = {}
): Promise<GeneratedLandingPage> {
  const record = await getLandingPage(id, userId);
  if (!record) {
    throw new Error("Landing page not found");
  }

  if (!record.v0ChatId) {
    // This record never got a v0 chat (generation failed upstream before chat creation).
    // It cannot be deployed/iterated; the recovery path is a fresh generate_landing_page
    // call, which recycles this record and archives any other stale failed records.
    throw new Error(
      "Landing page has no v0 chat — generation did not complete. Retry with generate_landing_page (the stale record is reused automatically)."
    );
  }

  // `generating` is accepted in exactly two cases:
  //  1. generateFirstPage's own auto-deploy — that record is legitimately mid-generation and
  //     THIS call is the thing driving it;
  //  2. the build is abandoned (no progress past the stuck ceiling), so there is no live
  //     process to race. Without this, a crashed build would refuse a manual deploy until
  //     the janitor flips it to `failed`, leaving the user stuck for up to 30 min.
  // A user-initiated deploy of an ACTIVELY-generating record is still refused — otherwise
  // two builds race commits into the same repo. The heartbeat is what keeps a live build
  // looking live here. (ENG-287 residual)
  const lastMovedMs = new Date(record.updatedAt || record.createdAt).getTime();
  const abandoned =
    Number.isFinite(lastMovedMs) && Date.now() - lastMovedMs > STUCK_CEILING_MS;
  const deployableStatuses =
    opts.fromGeneration || abandoned
      ? ["generating", "draft", "failed", "deploying"]
      : ["draft", "failed", "deploying"];
  if (!deployableStatuses.includes(record.status)) {
    throw new Error(`Cannot deploy a landing page with status: ${record.status}`);
  }

  // Sub-pages (those with a slug) are always added to the existing repo — they must
  // never go through the first-page deploy path which creates a brand-new GitHub repo
  // and Vercel project, orphaning the existing site.
  if (record.slug) {
    throw new Error(
      "Cannot re-deploy a sub-page via deploy_landing_page — sub-pages are added to the existing repo. " +
      "Use generate_landing_page with the same prompt to retry."
    );
  }

  // Covers the whole deploy (download → corrections → GitHub push → 5-min Vercel poll), not
  // just the v0 poll — see startBuildHeartbeat. (ENG-287 residual)
  const stopHeartbeat = startBuildHeartbeat(id);
  // One budget for the whole deploy, shared by the initial wait and every correction round.
  const buildDeadline = Date.now() + V0_GENERATION_BUDGET_MS;
  try {
    const v0 = await getV0Client();

    // Step 1: Wait for the latest version to complete (status-gated — async-mode
    // chats expose a pending version immediately; downloading it would ship a
    // half-generated page)
    console.log(`[V0 SERVICE] Step 1: Getting latest version for chat ${record.v0ChatId}`);
    let versionId: string | undefined = await waitForCompletedV0Version(
      v0,
      record.v0ChatId!,
      "v0 generation",
      { heartbeat: () => touchLandingPageRecord(id), deadline: buildDeadline }
    );

    // Step 2: Download + validate v0 output (with retry on bad output)
    const V0_VALIDATION_MAX_RETRIES = 2;
    let zipBuffer: any;
    // Per-page signal — was the client-side fbq('track','Lead') call confirmed
    // present in the generated form? Only meaningful when a pixel is actually configured.
    let pixelLeadEventVerified: boolean | undefined;
    let bridgeOutVerified: boolean | undefined;

    for (let validationAttempt = 0; validationAttempt <= V0_VALIDATION_MAX_RETRIES; validationAttempt++) {
      console.log(`[V0 SERVICE] Step 2: Downloading files from v0 (version ${versionId}, attempt ${validationAttempt + 1})`);
      zipBuffer = await withRetry(
        () => v0.chats.downloadVersion({
          chatId: record.v0ChatId!,
          versionId: versionId!,
          // @ts-ignore — SDK types may not include these yet
          format: "zip",
          includeDefaultFiles: true,
        }),
        "v0 zip download",
        // Fail fast on our synthetic 300s ceiling — see the sub-page download for why the
        // default (3× re-burn, inside a 3-round loop) is a 45-minute hang. (ENG-287 residual)
        undefined, undefined, undefined,
        { retryOnTimeout: false }
      );

      // Unzip and validate before pushing to GitHub
      const previewFiles = await unzipBuffer(zipBuffer);
      autoFixV0Files(previewFiles);
      // Repair v0's mis-rooted imports BEFORE validating — see addPageToExistingRepo for why
      // (check 7 would otherwise reject them and lean on the flaky v0 self-heal correction).
      repairMisrootedImports(previewFiles);

      try {
        validateV0Output(previewFiles);

        // v0 authors the form component freeform — there's no platform-owned seam
        // to guarantee the Lead event the way layout.tsx injection guarantees the base pixel.
        // Verify it, and retry (same correction-message mechanism as validateV0Output) if
        // missing. Exhausted retries must NOT fail generation — just record the miss.
        if (record.metaPixelId) {
          const pixelCheck = validatePixelLeadEvent(previewFiles);
          if (!pixelCheck.ok && validationAttempt < V0_VALIDATION_MAX_RETRIES) {
            console.warn(`[V0 SERVICE] Meta Pixel Lead event missing (attempt ${validationAttempt + 1}): ${pixelCheck.reason}`);

            await guardedV0CorrectionMessage({
              userId,
              scopeId: record.siteId ?? record.id,
              chatId: record.v0ChatId!,
              attempt: validationAttempt,
              send: () => withRetry(
                () => v0.chats.sendMessage({
                  chatId: record.v0ChatId!,
                  message:
                    "The lead capture form is missing the Meta Pixel Lead event. In the form's submit handler: " +
                    "generate `const eventId = crypto.randomUUID();`, include it as an \"eventId\" field in the " +
                    "fetch('/api/capture', ...) JSON body, and on a successful response call " +
                    "`window.fbq && window.fbq('track', 'Lead', {}, { eventID: eventId });`. " +
                    `Issue: ${pixelCheck.reason}`,
                }),
                "v0 correction message (pixel lead event)",
                undefined, undefined, undefined,
                { retryOnTimeout: false }
              ),
            });

            versionId = await waitForCompletedV0Version(
              v0,
              record.v0ChatId!,
              "v0 correction (pixel lead event)",
              {
                heartbeat: () => touchLandingPageRecord(id),
                deadline: buildDeadline,
                afterVersionId: versionId,
              }
            );

            continue;
          }
          pixelLeadEventVerified = pixelCheck.ok;
          if (!pixelCheck.ok) {
            console.warn(`[V0 SERVICE] Meta Pixel Lead event still missing after retries — proceeding without it (never fails generation): ${pixelCheck.reason}`);
          }
        }

        if (record.leadListId && record.bridgeOutUrl) {
          const bridgeCheck = validateBridgeOutRedirect(previewFiles, record.bridgeOutUrl);
          if (!bridgeCheck.ok && validationAttempt < V0_VALIDATION_MAX_RETRIES) {
            console.warn(`[V0 SERVICE] Bridge-out redirect missing (attempt ${validationAttempt + 1}): ${bridgeCheck.reason}`);

            await guardedV0CorrectionMessage({
              userId,
              scopeId: record.siteId ?? record.id,
              chatId: record.v0ChatId!,
              attempt: validationAttempt,
              send: () => withRetry(
                () => v0.chats.sendMessage({
                  chatId: record.v0ChatId!,
                  message:
                    "The lead capture form is missing the bridge-out redirect. On a SUCCESSFUL submission, " +
                    `redirect the visitor via window.location.href to ${record.bridgeOutUrl} with the submitted email ` +
                    "appended as an email= query param (URL-encoded). " +
                    `Issue: ${bridgeCheck.reason}`,
                }),
                "v0 correction message (bridge-out redirect)",
                undefined, undefined, undefined,
                { retryOnTimeout: false }
              ),
            });

            versionId = await waitForCompletedV0Version(
              v0,
              record.v0ChatId!,
              "v0 correction (bridge-out redirect)",
              {
                heartbeat: () => touchLandingPageRecord(id),
                deadline: buildDeadline,
                afterVersionId: versionId,
              }
            );

            continue;
          }
          bridgeOutVerified = bridgeCheck.ok;
          if (!bridgeCheck.ok) {
            console.warn(`[V0 SERVICE] Bridge-out redirect still missing after retries — proceeding without it (never fails generation): ${bridgeCheck.reason}`);
          }
        }

        break; // validation passed
      } catch (valErr: any) {
        if (valErr instanceof V0OutputValidationError && validationAttempt < V0_VALIDATION_MAX_RETRIES) {
          console.warn(`[V0 SERVICE] v0 output validation failed (attempt ${validationAttempt + 1}): ${valErr.reason}`);

          // Send correction message to v0 and re-download
          await guardedV0CorrectionMessage({
            userId,
            scopeId: record.siteId ?? record.id,
            chatId: record.v0ChatId!,
            // Each loop round is a different send — without this discriminator round 2 was
            // skipped and we re-downloaded the same broken zip. (ENG-287 residual)
            attempt: validationAttempt,
            send: () => withRetry(
              () => v0.chats.sendMessage({
                chatId: record.v0ChatId!,
                message:
                  "The previous output was not valid code. Please generate actual React/Next.js code — " +
                  "not markdown, not a prompt description, not empty files. " +
                  "Output must include .tsx files with real React components using export and function/const. " +
                  `Issue: ${valErr.reason}`,
              }),
              "v0 correction message",
              // A correction that outlives the attempt timeout must fail once, not be
              // re-sent 3× — each retry could double-apply the correction at full cost. (ENG-287)
              undefined, undefined, undefined,
              { retryOnTimeout: false }
            ),
          });

          // Status-gated: a correction's version is `pending` for a while, and reading
          // `latestVersion.id` straight off the chat downloads it half-generated — the exact
          // mistake waitForCompletedV0Version exists to prevent. (ENG-287 residual)
          versionId = await waitForCompletedV0Version(
            v0,
            record.v0ChatId!,
            "v0 correction",
            {
              heartbeat: () => touchLandingPageRecord(id),
              deadline: buildDeadline,
              afterVersionId: versionId, // must be the correction's NEW version, not the old one
            }
          );

          continue;
        }
        // Out of retries or not a validation error — rethrow
        throw valErr;
      }
    }

    // Step 3: Create GitHub repo and push files (validation already passed)
    console.log("[V0 SERVICE] Step 3: Creating GitHub repo and pushing files");
    const slug = buildPageSlug(record.name);
    const repoName = `lp-${slug}-${id.slice(0, 8)}`;
    // NB: `slug` above names the REPO. The page PATH is the record's own slug — the same
    // convention routes/domains.ts uses to build its domain map (`p.slug ? "/"+p.slug : "/"`).
    const pagePath = record.slug ? `/${record.slug}` : "/";
    const listByPath: Record<string, string> = record.leadListId ? { [pagePath]: record.leadListId } : {};

    // Resolve the Meta pixel to use, if one wasn't already manually set on this
    // record. A Meta API hiccup (or an unconnected/ambiguous account) must never fail
    // generation — it just means no pixel gets injected, same as GTM's "absent id" path.
    let metaPixelId = record.metaPixelId;
    let metaAdAccountId = record.metaAdAccountId;
    if (!metaPixelId) {
      try {
        const user = await userDb.getUserById(userId);
        const resolution = await metaService.resolveMetaPixelForUser(user, userId);
        if ("pixelId" in resolution) {
          metaPixelId = resolution.pixelId;
          metaAdAccountId = resolution.accountId;
        } else {
          console.warn(`[V0 SERVICE] Meta Pixel not auto-resolved for user ${userId}: ${resolution.reason}`);
        }
      } catch (err: any) {
        console.error(`[V0 SERVICE] Meta Pixel resolution threw unexpectedly (continuing without it): ${err?.message}`);
      }
    }

    const { githubRepoUrl, repoFullName, commitSha, gtmInjected, pixelInjected } = await createGitHubRepoAndPush(
      repoName,
      zipBuffer,
      record.name,
      listByPath,
      record.gtmContainerId,
      metaPixelId,
      metaAdAccountId,
    );
    // Reflect the tracking signals on the in-memory record so every downstream return
    // (deployed or build-failed) carries them consistently with what we persisted.
    record.trackingInstalled = gtmInjected;
    record.metaTrackingInstalled = pixelInjected;
    record.metaPixelId = metaPixelId;
    record.metaAdAccountId = metaAdAccountId;
    if (pixelLeadEventVerified !== undefined) record.pixelLeadEventVerified = pixelLeadEventVerified;
    if (bridgeOutVerified !== undefined) record.bridgeOutVerified = bridgeOutVerified;

    // Save GitHub repo URL immediately so it's not lost if Vercel step fails.
    // Persist explicit tracking signals so "shipped with no conversion
    // tracking" is detectable from the record itself, without reading the generated code.
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression:
          "SET #status = :status, githubRepoUrl = :repoUrl, trackingInstalled = :trackingInstalled, " +
          "metaTrackingInstalled = :metaTrackingInstalled, updatedAt = :updatedAt" +
          (metaPixelId ? ", metaPixelId = :metaPixelId, metaAdAccountId = :metaAdAccountId" : "") +
          (pixelLeadEventVerified !== undefined ? ", pixelLeadEventVerified = :pixelLeadEventVerified" : "") +
          (bridgeOutVerified !== undefined ? ", bridgeOutVerified = :bridgeOutVerified" : ""),
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "deploying",
          ":repoUrl": githubRepoUrl,
          ":trackingInstalled": gtmInjected,
          ":metaTrackingInstalled": pixelInjected,
          ...(pixelLeadEventVerified !== undefined ? { ":pixelLeadEventVerified": pixelLeadEventVerified } : {}),
          ...(bridgeOutVerified !== undefined ? { ":bridgeOutVerified": bridgeOutVerified } : {}),
          ":updatedAt": new Date().toISOString(),
          ...(metaPixelId ? { ":metaPixelId": metaPixelId, ":metaAdAccountId": metaAdAccountId } : {}),
        },
      })
      .promise();

    // Step 4: Create Vercel project linked to the GitHub repo
    console.log(`[V0 SERVICE] Step 4: Creating Vercel project linked to ${repoFullName}`);
    const { deployedUrl, vercelProjectId, buildStatus, buildError } = await createVercelProject(repoFullName, repoName, commitSha);

    // Step 5: Update DB record
    const now = new Date().toISOString();
    const finalStatus = buildStatus === "success" ? "deployed" : "failed";

    let updateExpression =
      "SET #status = :status, deployedUrl = :url, vercelProjectId = :vercelId, githubRepoUrl = :repoUrl, updatedAt = :updatedAt";
    const exprValues: Record<string, any> = {
      ":status": finalStatus,
      ":url": deployedUrl,
      ":vercelId": vercelProjectId,
      ":repoUrl": githubRepoUrl,
      ":updatedAt": now,
    };

    if (buildError) {
      updateExpression += ", errorMessage = :error";
      exprValues[":error"] = buildError;
    }

    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: exprValues,
      })
      .promise();

    if (buildStatus !== "success") {
      console.error(`[V0 SERVICE] Build failed for ${id}: ${buildError}`);
      return {
        ...record,
        status: finalStatus,
        deployedUrl,
        vercelProjectId,
        githubRepoUrl,
        errorMessage: buildError,
        updatedAt: now,
      };
    }

    console.log(`[V0 SERVICE] Deployment complete: ${deployedUrl} | GitHub: ${githubRepoUrl}`);

    // Auto-assign an agentwebforms.com subdomain after successful deploy. Retried:
    // a transient Vercel domains-API blip here used to be swallowed, leaving the
    // page on its raw *.vercel.app URL permanently (≈30% of deployed pages showed
    // "vercel junk" instead of the clean subdomain). addSubdomain already handles
    // 409 collisions; withRetry covers fetch-failed/5xx/timeout.
    const customDomain = await assignManagedSubdomain(id, userId, vercelProjectId, record.name);

    // Auto-configure GSC domain + GA4 property when deployed to a managed subdomain.
    // resolveLandingPageGa4 picks the right mapping for the deployed host so audit
    // pages on agentweb.pro get the audit GA4 property, form pages get the forms one.
    if (customDomain) {
      try {
        const lpConfig = await getLandingPagesConfig();
        const mapping = resolveLandingPageGa4(lpConfig, customDomain);
        if (mapping) {
          const user = await userDb.getUserById(userId);
          if (user) {
            const updates: Record<string, any> = {};

            // Ensure root GSC domain property is configured (covers all subdomains)
            const seoDomains: string[] = user.seoDomains ?? [];
            if (!seoDomains.includes(mapping.gscDomain)) {
              updates.seoDomains = [...seoDomains, mapping.gscDomain];
            }

            // Ensure our GA4 property is in the user's configured properties
            const gaProps: Array<{ propertyId: string; label: string }> = user.googleAnalyticsProperties ?? [];
            if (!gaProps.some(p => p.propertyId === mapping.ga4PropertyId)) {
              updates.googleAnalyticsProperties = [
                ...gaProps,
                { propertyId: mapping.ga4PropertyId, label: mapping.gscDomain },
              ];
            }

            if (Object.keys(updates).length > 0) {
              await userDb.updateUser(userId, updates as any);
              console.log(`[V0 SERVICE] Auto-configured analytics for user ${userId}: ${JSON.stringify(Object.keys(updates))}`);
            } else {
              console.log(`[V0 SERVICE] Analytics already configured for user ${userId} — no update needed`);
            }
          }
        }
      } catch (configErr: any) {
        // Non-fatal — deploy succeeded, analytics config can be set up manually
        console.warn(`[V0 SERVICE] Could not auto-configure analytics: ${configErr.message}`);
      }
    }

    const deployedRecord: GeneratedLandingPage = {
      ...record,
      status: "deployed",
      deployedUrl,
      customDomainUrl: customDomain ? `https://${customDomain}` : undefined,
      vercelProjectId,
      githubRepoUrl,
      updatedAt: now,
    };

    void enqueueLandingPageHumanEval(deployedRecord);
    // Dynamic import: landingPageSmokeTest.ts imports FROM this module (GeneratedLandingPage,
    // updateLandingPageSmokeTestResult), so a static import here would be circular.
    void import("./landingPageSmokeTest")
      .then((m) => m.runGenerationSmokeTest(deployedRecord))
      .catch((err) => console.warn(`[V0 SERVICE] Smoke test dispatch failed: ${err?.message}`));

    return deployedRecord;
  } catch (error: any) {
    console.error("[V0 SERVICE] Deployment failed:", error);

    // Update DB record to "failed" so user/Emma knows what happened and can retry
    try {
      await dynamodb
        .update({
          TableName: TABLE_NAME,
          Key: { id },
          UpdateExpression:
            "SET #status = :status, errorMessage = :error, updatedAt = :updatedAt",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": "failed",
            ":error": error.message || "Unknown deployment error",
            ":updatedAt": new Date().toISOString(),
          },
        })
        .promise();
    } catch (dbError) {
      console.error("[V0 SERVICE] Failed to update DB after deploy error:", dbError);
    }

    // Re-wrapping with a bare `new Error(...)` destroyed `error.code`. deployLandingPage is
    // the ONLY place the first-page path reaches waitForCompletedV0Version, so the lost code
    // made generateFirstPage's dead-end branch unreachable — the safety net did not exist.
    // Preserve the code (and the cause) so callers can still tell a dead-end chat from a
    // slow one. (ENG-287 residual)
    const wrapped: any = new Error(`Deployment failed: ${error.message}`);
    if (error?.code) wrapped.code = error.code;
    wrapped.cause = error;
    throw wrapped;
  } finally {
    stopHeartbeat();
  }
}

function enqueueLandingPageHumanEval(page: GeneratedLandingPage): void {
  if (page.status !== "deployed") return;
  const artifactUrl = getLandingPageLiveUrl(page);
  void enqueueAutoHumanEval({
    reviewType: "landing_page",
    userId: page.userId,
    sessionId: page.originatingSessionId,
    artifactUrl: artifactUrl || undefined,
    originalRequest: page.prompt,
    outputSummary: `Landing page generated: ${page.name}. URL: ${artifactUrl || "not available"}.`,
    sourceKey: `landing-page:${page.id}:iteration:${page.iterations || 0}:url:${artifactUrl || "none"}`,
    action: {
      type: "landing_page_iteration_deploy",
      landingPageId: page.id,
      userId: page.userId,
    },
  });
}

/**
 * Unzip a buffer and return file entries as { path, content } pairs.
 * Uses the built-in zlib + manual ZIP parsing to avoid extra dependencies.
 */
async function unzipBuffer(buffer: Buffer | ArrayBuffer): Promise<Array<{ path: string; content: Buffer }>> {
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  const entries = zip.getEntries();
  const files: Array<{ path: string; content: Buffer }> = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!entry.entryName) continue;
    files.push({ path: entry.entryName, content: entry.getData() });
  }

  return files;
}

/**
 * Auto-fix common v0-generated code issues that cause Next.js build failures.
 * Modifies files in-place before they are pushed to GitHub.
 *
 * Known issues:
 * 1. `<style jsx>` in Server Components → add 'use client' directive
 * 2. Missing 'use client' for files using hooks (useState, useEffect, etc.)
 *    or any JSX event handler (onClick, onMouseEnter, onMouseLeave, onFocus, ...)
 * 3. @import "shadcn" in CSS → replace with standard Tailwind imports
 */
export function autoFixV0Files(files: Array<{ path: string; content: Buffer }>): number {
  let fixCount = 0;

  for (const file of files) {
    if (!file.path.endsWith(".tsx") && !file.path.endsWith(".ts")) continue;

    const content = file.content.toString("utf-8");
    const hasUseClient = content.trimStart().startsWith("'use client'") || content.trimStart().startsWith('"use client"');

    if (hasUseClient) continue;

    // Check if file needs 'use client'
    const needsClient =
      /<style jsx/.test(content) ||
      /\buseState\b/.test(content) ||
      /\buseEffect\b/.test(content) ||
      /\buseRef\b/.test(content) ||
      /\buseCallback\b/.test(content) ||
      /\buseMemo\b/.test(content) ||
      // Any JSX event-handler prop (onClick, onChange, onSubmit, onMouseEnter,
      // onMouseLeave, onFocus, onKeyDown, ...) makes a component interactive and
      // therefore requires "use client". v0 frequently emits onMouseEnter/onMouseLeave
      // for hover effects on otherwise-server components, which triggers the Next.js
      // prerender error: "Event handlers cannot be passed to Client Component props."
      // The `=\s*\{` guard matches only JSX usage, not type annotations like `onClick?: ...`.
      /\bon[A-Z][a-zA-Z]*\s*=\s*\{/.test(content);

    if (needsClient) {
      file.content = Buffer.from("'use client'\n\n" + content);
      fixCount++;
      console.log(`[V0 SERVICE] Auto-fix: added 'use client' to ${file.path}`);
    }
  }

  // Fix CSS issues
  for (const file of files) {
    if (!file.path.endsWith(".css")) continue;

    let content = file.content.toString("utf-8");
    let changed = false;

    // Replace @import "shadcn" with nothing (it's not a real CSS import)
    if (content.includes('@import "shadcn"') || content.includes("@import 'shadcn'")) {
      content = content.replace(/@import\s+['"]shadcn['"];?\s*/g, "");
      changed = true;
      console.log(`[V0 SERVICE] Auto-fix: removed @import "shadcn" from ${file.path}`);
    }

    if (changed) {
      file.content = Buffer.from(content);
      fixCount++;
    }
  }

  return fixCount;
}

// ---------------------------------------------------------------------------
// v0 output validation — catches "prompts instead of code", empty files, garbage
// ---------------------------------------------------------------------------

export class V0OutputValidationError extends Error {
  /**
   * Carried as a `code` (not just a prototype) so it survives being re-wrapped across a
   * throw boundary — `instanceof` does not, and deployLandingPage re-wraps. This is what
   * lets `isDeadEndV0Failure` still recognise it. (ENG-287 residual)
   */
  readonly code = "V0_OUTPUT_INVALID";
  constructor(public readonly reason: string) {
    super(`v0 output validation failed: ${reason}`);
    this.name = "V0OutputValidationError";
  }
}

// ENG-374: bare-import denylist and the patterns that extract an import/export specifier
// from source text. Module-scoped (not rebuilt per validateV0Output call) — see that
// function's check 6 for the detection logic and why a denylist was chosen over an allowlist.
const NEVER_REAL_BARE_IMPORT_SPECIFIERS = new Set(["layout", "page", "app", "components", "styles"]);
const STATIC_IMPORT_EXPORT_PATTERN = /\b(?:import|export)\s+(?:[\w*{}\s,]+from\s+)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

// Template literals and comments only — deliberately NOT single/double-quoted strings. A real
// import specifier IS a plain quoted string ('layout' or "layout"), so blanket-stripping every
// quoted string would strip the exact thing the detector needs to find, breaking detection
// entirely. Template literals and comments have no such conflict: per the ES module spec an
// import specifier can never be a template literal (`import x from \`layout\`` is a syntax
// error, not valid JS), and obviously never lives inside a comment — so stripping those two is
// unambiguous and cannot hide a genuine bad import, only prevents false-positiving on example
// code shown as JSX text or a comment that happens to mention the pattern.
//
// One alternation, one left-to-right pass: matches whichever of template literal / line
// comment / block comment starts first at each position, consuming the WHOLE construct
// (including any nested quotes, `//`, or `/*` inside it) before the scan continues. That
// ordering is what makes a `//` inside a template literal safe — it's consumed as part of the
// template match, so the line-comment alternative never gets a chance to misfire on it.
//
// Known, accepted limitation: regex literals (e.g. `/https:\/\//`) are not specially
// tokenized — full JS lexing is out of scope for a narrow validation heuristic. Landing-page
// component code essentially never contains regex literals, and even a mishandled one can only
// affect scanning of code adjacent to it, not create a false NEGATIVE on a real import far
// from it.
const STRIP_TEMPLATES_AND_COMMENTS_PATTERN =
  /`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/**
 * Remove the CONTENTS of template literals and comments from source text before scanning for
 * import statements (ENG-374 follow-up, Greptile review PR #2121). See
 * STRIP_TEMPLATES_AND_COMMENTS_PATTERN's comment for why this — and specifically not regular
 * quoted strings — is safe: it cannot hide a genuine bad import, only prevents
 * false-positiving on example code or a comment that happens to mention the pattern.
 */
function stripTemplatesAndComments(content: string): string {
  return content.replace(STRIP_TEMPLATES_AND_COMMENTS_PATTERN, " ");
}

// ENG-384: module paths the deploy pipeline ALWAYS materialises into the final commit, even
// when v0's zip omits them — the tsconfig scaffold block (the `if (!hasFile(...))` injections)
// and injectLeadCaptureAttribution. The missing-import check below runs on v0's raw download, so a
// legitimate import of one of these must not be flagged just because this particular zip left
// it out. Extensionless, repo-root-relative — compared against a resolved import target.
const GUARANTEED_SCAFFOLD_MODULE_PATHS = new Set([
  "lib/utils",
  "app/layout",
  "middleware",
  "domainMap",
]);

// ENG-384: import specifiers whose extension marks them as a NON-JS/TS asset (stylesheet,
// data, image, font, media). These are not resolved as JS/TS modules — a missing stylesheet is
// a different failure class, and `./globals.css` is scaffold-provided, so treating it as a
// module would false-positive. Only extensionless / .ts(x) / .js(x) specifiers are checked.
const NON_MODULE_IMPORT_EXTENSION = /\.(css|scss|sass|less|styl|json|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav|txt|md|mdx|wasm|glb|gltf)$/i;

/**
 * ENG-384: collect internal imports that reference a file v0 never actually generated.
 *
 * The failure this catches (distinct from ENG-374's bare-import denylist): v0 emits a
 * SYNTACTICALLY legitimate intra-project import — a relative path or the `@/` alias — pointing
 * at a component it forgot to include in the zip. e.g. `compare-page.tsx` imports
 * `@/components/compare-table`, but no `compare-table.tsx` exists. The alias resolves correctly;
 * the target simply does not exist, so `next build` dies with "Module not found". ENG-374's
 * denylist structurally cannot see this — the specifier is exactly how a real import looks.
 *
 * Runs against v0's OWN output (downloaded with `includeDefaultFiles: true`, so shadcn `ui/`
 * primitives, `lib/utils`, layout, etc. are present), plus GUARANTEED_SCAFFOLD_MODULE_PATHS for
 * the few files the caller injects later — this is the self-contained "does v0's deliverable
 * reference anything it didn't deliver" question, answerable before any remap/scaffold step.
 *
 * Resolution follows this codebase's fixed generated-repo convention `@/* -> ./*` (see the
 * tsconfig scaffold block's `paths` mapping): `@/x/y` -> repo-root `x/y`; a relative specifier resolves
 * against the importing file's directory. Extension/`index` probing reuses `moduleExists`.
 *
 * Conservative by construction — anything it cannot judge (bare packages, non-JS assets,
 * specifiers escaping the repo root) is skipped, so it can only ever flag an import that is
 * genuinely unresolvable within v0's self-contained output. Pure and exported for direct
 * unit testing of the resolution logic, separate from the throw trigger in validateV0Output.
 */
export function collectMissingInternalImports(
  files: Array<{ path: string; content: Buffer }>
): Array<{ path: string; specifier: string }> {
  const existingPaths = new Set(files.map((f) => f.path));
  const missing: Array<{ path: string; specifier: string }> = [];

  for (const file of files) {
    if (!file.path.endsWith(".tsx") && !file.path.endsWith(".ts")) continue;

    const fileDir = path.posix.dirname(file.path);
    const content = stripTemplatesAndComments(file.content.toString("utf-8"));
    const specifiers = new Set<string>();
    for (const match of content.matchAll(STATIC_IMPORT_EXPORT_PATTERN)) specifiers.add(match[1]);
    for (const match of content.matchAll(DYNAMIC_IMPORT_PATTERN)) specifiers.add(match[1]);

    for (const specifier of specifiers) {
      const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
      const isAlias = specifier.startsWith("@/");
      // Only intra-project imports are ours to resolve. Bare package specifiers are left to
      // ENG-374's denylist; a scoped `@scope/pkg` (not `@/`) is a real npm package.
      if (!isRelative && !isAlias) continue;
      // Non-JS/TS asset imports (css/json/images/…) are not module-resolved here.
      if (NON_MODULE_IMPORT_EXTENSION.test(specifier)) continue;

      // Resolve to a repo-root-relative, extensionless module path.
      const target = isAlias
        ? specifier.slice(2)
        : path.posix.normalize(path.posix.join(fileDir, specifier));

      // Escapes the repo root (or is absolute) — we cannot say what it points at; skip rather
      // than emit a confident false positive.
      if (target.startsWith("..") || target.startsWith("/") || target === "" || target === ".") continue;

      const normalized = target.replace(/\/+$/, "");
      if (GUARANTEED_SCAFFOLD_MODULE_PATHS.has(normalized)) continue;
      if (moduleExists(normalized, existingPaths)) continue;

      missing.push({ path: file.path, specifier });
    }
  }

  return missing;
}

// ENG-467: v0's literal name for a synthetic deployment stub. When a generation's deliverable is
// component(s) with no designated page route, v0 emits an `app/page.tsx` whose default export is
// `SyntheticV0PageForDeployment`, rendering only ONE component (typically the nav) as a preview
// harness — orphaning every section it generated. The build SUCCEEDS (the stub is valid,
// compilable React with resolvable imports), so no other check fires, but the deployed page is
// blank but for the top bar. Matching v0's exact identifier keeps the check from ever touching a
// legitimately-named page (a real page is `Home`/`Page`/`LandingPage`, never this).
const SYNTHETIC_V0_PAGE_MARKER = "SyntheticV0PageForDeployment";

// ENG-467: a generated component whose basename matches this is a provider/hook/util/type/config —
// NOT a visible "section" whose absence blanks the page. Orphaning one of these is normal, so it
// must not trip the incomplete-page check; only orphaned SECTION components (hero, features, …) do.
const NON_SECTION_COMPONENT_NAME = /(provider|context|store|hooks?|use-|config|constants?|types?|utils?|helpers?|^lib$|theme|schema|validation)/i;

/**
 * ENG-467: resolve a relative/`@/` import specifier (from a file in `fromDir`) to the ACTUAL
 * repo-root-relative file path it names within `existingPaths`, or null if it is not an internal,
 * resolvable JS/TS module (bare package, non-JS asset, escapes the repo root, or resolves to no
 * real file). Same `@/* -> ./*` convention and extension/`index` probing as the ENG-384 checks.
 */
function resolveInternalImportFile(
  specifier: string,
  fromDir: string,
  existingPaths: Set<string>
): string | null {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  const isAlias = specifier.startsWith("@/");
  if (!isRelative && !isAlias) return null;
  if (NON_MODULE_IMPORT_EXTENSION.test(specifier)) return null;

  const target = isAlias
    ? specifier.slice(2)
    : path.posix.normalize(path.posix.join(fromDir, specifier));
  if (target.startsWith("..") || target.startsWith("/") || target === "" || target === ".") return null;

  const normalized = target.replace(/\/+$/, "");
  if (existingPaths.has(normalized)) return normalized;
  for (const ext of MODULE_EXTENSIONS) {
    if (existingPaths.has(`${normalized}${ext}`)) return `${normalized}${ext}`;
    if (existingPaths.has(`${normalized}/index${ext}`)) return `${normalized}/index${ext}`;
  }
  return null;
}

/**
 * ENG-467: detect the "synthetic stub" incomplete page — an `app/page.tsx` that v0 emitted as a
 * `SyntheticV0PageForDeployment` placeholder rendering only a fraction of what it generated,
 * leaving real section components orphaned so the deployed page is blank but for the top bar.
 * Returns the entry path + the orphaned section files, or null when the page is fine.
 *
 * Conservative by construction — TWO gates that must BOTH hold:
 *   1. the entry `app/page.*` default export is v0's literal synthetic-stub marker, AND
 *   2. ≥1 generated SECTION component is unreachable from that entry via transitive local imports.
 * Gate 1 alone would false-positive when the stub renders a single component that itself composes
 * the whole page (then nothing is orphaned → gate 2 fails → not flagged). Gate 2 alone would
 * false-positive on a real, well-named page that merely leaves a stray component unused. Together
 * they fire only on the actual blank-page bug. Pure and exported for direct unit testing.
 */
export function detectIncompleteSyntheticPage(
  files: Array<{ path: string; content: Buffer }>
): { entryPath: string; orphaned: string[] } | null {
  const existingPaths = new Set(files.map((f) => f.path));
  const byPath = new Map(files.map((f) => [f.path, f]));

  // The entry Next.js routes to for the site root. (Sub-page generations are validated in their
  // own project's raw layout too, where the entry is likewise `app/page.*`, pre-remap.)
  const entryPath = MODULE_EXTENSIONS.map((ext) => `app/page${ext}`).find((p) => existingPaths.has(p));
  if (!entryPath) return null;

  // Gate 1: is the entry v0's synthetic deployment stub?
  if (!byPath.get(entryPath)!.content.toString("utf-8").includes(SYNTHETIC_V0_PAGE_MARKER)) return null;

  // Walk transitive local imports from the entry to collect every reachable file.
  const reachable = new Set<string>([entryPath]);
  const queue = [entryPath];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (!/\.(tsx|ts|jsx|js)$/.test(current)) continue;
    const file = byPath.get(current);
    if (!file) continue;
    const dir = path.posix.dirname(current);
    const src = stripTemplatesAndComments(file.content.toString("utf-8"));
    const specifiers = new Set<string>();
    for (const m of src.matchAll(STATIC_IMPORT_EXPORT_PATTERN)) specifiers.add(m[1]);
    for (const m of src.matchAll(DYNAMIC_IMPORT_PATTERN)) specifiers.add(m[1]);
    for (const specifier of specifiers) {
      const resolved = resolveInternalImportFile(specifier, dir, existingPaths);
      if (resolved && !reachable.has(resolved)) {
        reachable.add(resolved);
        queue.push(resolved);
      }
    }
  }

  // Gate 2: generated SECTION components the entry never reaches. `components/ui/*` are shadcn
  // primitives (leaf building blocks legitimately imported by sections, not by the page), and
  // provider/util-ish files are not sections — both are excluded so only real orphaned content
  // (hero, features, pricing, …) counts.
  const orphaned: string[] = [];
  for (const file of files) {
    const p = file.path;
    if (!p.endsWith(".tsx")) continue;
    if (!p.startsWith("components/") && !/\/_components\//.test(p)) continue;
    if (/(^|\/)ui\//.test(p)) continue;
    if (reachable.has(p)) continue;
    const base = path.posix.basename(p).replace(/\.tsx$/, "");
    if (NON_SECTION_COMPONENT_NAME.test(base)) continue;
    orphaned.push(p);
  }

  return orphaned.length > 0 ? { entryPath, orphaned } : null;
}

// Rewrites an intra-project import/re-export/dynamic-import specifier — relative (`./`/`../`) or
// the `@/` alias. Both forms occur post-remap: v0 emits `./landing/X`, and the sub-page remap's
// step-0 normalization turns that into `@/components/landing/landing/X`; either can be mis-rooted.
const INTERNAL_IMPORT_REWRITE_PATTERN = /(\bfrom\s*['"]|\bimport\s*\(\s*['"])((?:\.\.?\/|@\/)[^'"]+)(['"])/g;

// A BARE, package-shaped specifier that contains a slash and does NOT start with `.`, `@`, or `/`
// — e.g. `landing/Nav`. v0 sometimes drops the prefix entirely, so this looks like an npm package
// but is really a mis-rooted intra-project import; disambiguated below by whether `components/<it>`
// actually exists (a real package never does). Scoped-package specs (`@scope/pkg`) can't match.
const BARE_INTERNAL_IMPORT_PATTERN = /(\bfrom\s*['"]|\bimport\s*\(\s*['"])([A-Za-z0-9_-]+\/[^'"]+)(['"])/g;

// The component subtree a file belongs to — a sub-page's `app/<slug>/_components`, or a
// first-page's `components`. Repairs only ever point WITHIN a file's own subtree, so a broken
// `./x` in a landing component can never be "repaired" to an unrelated `lib/x` in another tree.
function componentScopeRoot(p: string): string {
  const m = p.match(/^(app\/[^/]+\/_components|components)\//);
  return m ? m[1] : path.posix.dirname(p);
}

// A `@/` specifier that legitimately lives in the ROOT repo (shadcn primitives, the cn helper,
// hooks, and the caller-injected scaffold) and is NOT part of the file set this repair sees for a
// sub-page. It resolves at build time but not here, so it must be preserved, never "repaired".
function isRootScaffoldAlias(spec: string): boolean {
  if (!spec.startsWith("@/")) return false;
  const p = spec.slice(2).replace(/\/+$/, "");
  return (
    p.startsWith("components/ui/") ||
    p.startsWith("lib/") ||
    p.startsWith("hooks/") ||
    p.startsWith("styles/") ||
    GUARANTEED_SCAFFOLD_MODULE_PATHS.has(p)
  );
}

/**
 * ENG-384/467 follow-up — deterministically repair v0's recurring "mis-rooted" imports.
 *
 * v0 frequently writes an intra-folder import as if addressed from the components ROOT rather
 * than from the importing file: a component at `.../landing/FinalCTA.tsx` imports
 * `./landing/LeadCaptureForm` when the sibling is simply `./LeadCaptureForm`. The spurious
 * `landing/` segment makes it resolve to `.../landing/landing/LeadCaptureForm`, which does not
 * exist → `next build` dies with "Module not found". The sub-page remap's rewriting of nested
 * component directories (and its step-0 `@/` normalization) leaves the same shape. Both hit
 * ~every multi-component generation.
 *
 * check 7 (collectMissingInternalImports) *detects* this, but recovery then depends on v0's
 * self-heal correction, which has repeatedly timed out (V0_CALL_TIMEOUT) — so the page fails
 * instead of healing. This repairs it in-place with NO v0 round-trip: run on the FINAL committed
 * file set (where every file's real location is known), for each broken intra-project import find
 * the single file in the importing file's own component subtree whose module basename matches, and
 * rewrite to the correct RELATIVE path.
 *
 * Conservative by construction — only rewrites an import that (a) is relative or a non-scaffold
 * `@/` alias, (b) does NOT already resolve against the committed set, and (c) has EXACTLY ONE
 * basename match within the same subtree; otherwise it is left untouched (a genuinely missing file
 * still trips check 7 upstream, and legit root-repo `@/` refs are skipped outright). It never
 * touches a working import and only ever rewrites to a path that provably resolves. Mutates in
 * place; returns the number of imports repaired.
 */
export function repairMisrootedImports(files: Array<{ path: string; content: Buffer }>): number {
  const existingPaths = new Set(files.map((f) => f.path));

  // module basename -> providers (a `foo/index.tsx` provides the basename `foo`, matching a
  // directory import). Scoped so a repair can only resolve within the importing file's subtree.
  const providers: Array<{ base: string; scope: string; path: string }> = [];
  for (const f of files) {
    if (!/\.(tsx|ts|jsx|js)$/.test(f.path)) continue;
    let base = path.posix.basename(f.path).replace(/\.(tsx|ts|jsx|js)$/, "");
    if (base === "index") base = path.posix.basename(path.posix.dirname(f.path));
    providers.push({ base, scope: componentScopeRoot(f.path), path: f.path });
  }

  let repaired = 0;
  for (const file of files) {
    if (!file.path.endsWith(".tsx") && !file.path.endsWith(".ts")) continue;
    const fileDir = path.posix.dirname(file.path);
    const fileScope = componentScopeRoot(file.path);
    let changed = false;

    let content = file.content.toString("utf-8").replace(
      INTERNAL_IMPORT_REWRITE_PATTERN,
      (whole, pre: string, spec: string, post: string) => {
        if (NON_MODULE_IMPORT_EXTENSION.test(spec)) return whole;
        if (isRootScaffoldAlias(spec)) return whole; // legit root-repo ref — preserve
        const target = spec.startsWith("@/")
          ? spec.slice(2).replace(/\/+$/, "")
          : path.posix.normalize(path.posix.join(fileDir, spec));
        if (target.startsWith("..") || target.startsWith("/")) return whole; // escapes the root
        if (moduleExists(target, existingPaths)) return whole; // already resolves — hands off
        const base = path.posix.basename(spec);
        const matches = providers.filter(
          (p) => p.base === base && p.scope === fileScope && p.path !== file.path
        );
        if (matches.length !== 1) return whole; // missing or ambiguous — leave for check 7
        let rel = path.posix
          .relative(fileDir, matches[0].path)
          .replace(/\.(tsx|ts|jsx|js)$/, "")
          .replace(/\/index$/, "");
        if (!rel.startsWith(".")) rel = "./" + rel;
        changed = true;
        repaired++;
        return `${pre}${rel}${post}`;
      }
    );

    // Bare intra-project imports: v0 sometimes drops the prefix entirely (e.g. `landing/Nav`
    // instead of `@/components/landing/Nav`) — package-shaped but not a package. Only rewrite when
    // `components/<spec>` actually exists in the set (a real npm package never will), so this can't
    // touch a genuine dependency. Rewrites to the `@/` alias, which the sub-page remap then relocates
    // correctly. Runs where `components/` is present (pre-remap / first-page); a no-op otherwise.
    content = content.replace(
      BARE_INTERNAL_IMPORT_PATTERN,
      (whole, pre: string, spec: string, post: string) => {
        if (NON_MODULE_IMPORT_EXTENSION.test(spec)) return whole;
        const asComponent = `components/${spec}`.replace(/\/+$/, "");
        if (!moduleExists(asComponent, existingPaths)) return whole; // real package — leave alone
        changed = true;
        repaired++;
        return `${pre}@/${asComponent}${post}`;
      }
    );

    if (changed) file.content = Buffer.from(content);
  }
  return repaired;
}

/**
 * Validate that unzipped v0 output contains actual React/Next.js code.
 * Rejects: empty output, markdown/prompts echoed back, files too small to be real code.
 */
export function validateV0Output(files: Array<{ path: string; content: Buffer }>): void {
  // 1. Must have at least one .tsx file
  const tsxFiles = files.filter((f) => f.path.endsWith(".tsx"));
  if (tsxFiles.length === 0) {
    throw new V0OutputValidationError("No .tsx files found in v0 output");
  }

  // 2. At least one .tsx file must have meaningful content (>50 chars)
  const meaningfulTsx = tsxFiles.filter((f) => f.content.toString("utf-8").trim().length > 50);
  if (meaningfulTsx.length === 0) {
    throw new V0OutputValidationError("All .tsx files are empty or trivially small (<50 chars)");
  }

  // 3. At least one .tsx file must look like React code (has export + function/const)
  const reactFiles = meaningfulTsx.filter((f) => {
    const content = f.content.toString("utf-8");
    return /\bexport\b/.test(content) && (/\bfunction\b/.test(content) || /\bconst\b/.test(content));
  });
  if (reactFiles.length === 0) {
    throw new V0OutputValidationError(
      "No .tsx file contains React code (missing export + function/const)"
    );
  }

  // 4. Anti-markdown check: reject if >50% of lines in main .tsx files start with # or >
  for (const file of reactFiles) {
    const lines = file.content.toString("utf-8").split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;
    const markdownLines = lines.filter((l) => /^\s*[#>]/.test(l));
    if (markdownLines.length / lines.length > 0.5) {
      throw new V0OutputValidationError(
        `File ${file.path} appears to be markdown, not code (${markdownLines.length}/${lines.length} lines start with # or >)`
      );
    }
  }

  // 5. Anti-prompt-echo check: reject if a .tsx file contains common prompt patterns
  const promptPatterns = [
    /^Create a (?:landing page|website|page)/m,
    /^Build (?:me )?a/m,
    /^Generate a/m,
    /^Design a (?:modern|professional|sleek)/m,
    /^Make a (?:landing page|website)/m,
  ];
  for (const file of reactFiles) {
    const content = file.content.toString("utf-8");
    for (const pattern of promptPatterns) {
      if (pattern.test(content)) {
        throw new V0OutputValidationError(
          `File ${file.path} appears to echo the user's prompt instead of containing code`
        );
      }
    }
  }

  // 6. Bad-import check (ENG-374): v0 occasionally hallucinates an import of an internal
  // Next.js concept as if it were an installable package, e.g. `import RootLayout from
  // "layout"`. That specifier is not relative, not the `@/` alias, and not a real npm
  // package — it fails the build with "Module not found". Denylisted to a small set of words
  // that are never legitimate BARE (unscoped, non-relative) specifiers, rather than trying to
  // validate against the universe of real dependencies — an allowlist would need constant
  // upkeep and risks false-positiving as real packages change.
  //
  // Covers every import/export form v0 could hallucinate the bad specifier into, not just the
  // `import X from "..."` shape actually observed: side-effect-only imports, dynamic
  // `import("...")`, and `export ... from "..."` re-exports. Denylist and patterns are
  // module-scoped constants (above) — matchAll does not mutate a regex's lastIndex, so the
  // shared, hoisted regex objects are safe to reuse across calls.
  //
  // Collected across ALL files before throwing, so a single correction message to v0 can name
  // every offending import at once — reporting only the first found risks the retry fixing
  // just that one and re-failing on the next, burning the limited retry budget.
  const badImports: Array<{ path: string; specifier: string }> = [];
  for (const file of reactFiles) {
    const content = stripTemplatesAndComments(file.content.toString("utf-8"));
    const specifiers = new Set<string>();
    for (const match of content.matchAll(STATIC_IMPORT_EXPORT_PATTERN)) specifiers.add(match[1]);
    for (const match of content.matchAll(DYNAMIC_IMPORT_PATTERN)) specifiers.add(match[1]);
    for (const specifier of specifiers) {
      // Relative (./, ../) and the project's own @/ alias are legitimate regardless of
      // wording — only a BARE specifier (looks like a package name) is suspect here.
      if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("@")) continue;
      if (NEVER_REAL_BARE_IMPORT_SPECIFIERS.has(specifier.toLowerCase())) {
        badImports.push({ path: file.path, specifier });
      }
    }
  }
  if (badImports.length > 0) {
    const details = badImports.map((b) => `${b.path}: "${b.specifier}"`).join("; ");
    throw new V0OutputValidationError(
      `Bare import(s) of internal concepts that are not real npm packages — ${details} ` +
      `(use a relative path or the @/ alias instead)`
    );
  }

  // 7. Missing-file check (ENG-384): v0 sometimes references an intra-project file it never
  // generated — a relative or `@/`-aliased import (syntactically a perfectly real import, so
  // check 6 structurally cannot catch it) that resolves to no file in what v0 actually shipped.
  // `next build` then dies with "Module not found". Collected across ALL files before throwing
  // (mirroring check 6) so ONE correction message can name every missing file and v0 can
  // regenerate them all in a single retry round, rather than burning the budget one at a time.
  const missingImports = collectMissingInternalImports(files);
  if (missingImports.length > 0) {
    const details = missingImports.map((m) => `${m.path}: "${m.specifier}"`).join("; ");
    throw new V0OutputValidationError(
      `Import(s) reference a file that was not generated — ${details}. ` +
      `Generate the missing component/module file(s) so every import resolves.`
    );
  }

  // 8. Incomplete-page check (ENG-467): v0 sometimes emits `app/page.tsx` as a
  // `SyntheticV0PageForDeployment` stub that renders only ONE component (usually the nav),
  // orphaning every section it generated. The build SUCCEEDS — the stub is valid, compilable
  // React with resolvable imports — so checks 1–7 all pass, yet the deployed page is blank but
  // for the top bar. Detect the stub + orphaned sections and reject so the retry loop asks v0 to
  // compose the real page. Distinct failure class from ENG-374/384 (both build FAILURES); this
  // one deploys silently, which is exactly why it recurs unnoticed.
  const incomplete = detectIncompleteSyntheticPage(files);
  if (incomplete) {
    throw new V0OutputValidationError(
      `${incomplete.entryPath} is a placeholder page (${SYNTHETIC_V0_PAGE_MARKER}) that renders only one ` +
      `component; these generated section components are never rendered: ${incomplete.orphaned.join(", ")}. ` +
      `Rewrite ${incomplete.entryPath} to import and render the full page — compose ALL generated sections ` +
      `(e.g. hero, features, how-it-works, testimonials, pricing, signup, footer), not just the nav.`
    );
  }

  console.log(`[V0 SERVICE] Output validation passed: ${tsxFiles.length} .tsx files, ${reactFiles.length} with React code`);
}

/**
 * Check whether v0's generated form component actually fires the Meta Pixel
 * Lead event on submit, per the prompt instruction added to buildBrandEnrichedPrompt.
 *
 * Unlike `validateV0Output` this is not a hard build-breaking check: the form component is
 * entirely v0-authored freeform code (no platform-owned seam to inject into, unlike
 * layout.tsx), so this can only be *verified*, not *guaranteed*. Callers use this to decide
 * whether to send a correction message and retry; if retries are exhausted, generation must
 * still proceed (AC3 — never fail generation over a missing client-side event).
 */
export function validatePixelLeadEvent(files: Array<{ path: string; content: Buffer }>): { ok: boolean; reason?: string } {
  const tsxSource = files
    .filter((f) => f.path.endsWith(".tsx") || f.path.endsWith(".ts"))
    .map((f) => f.content.toString("utf-8"))
    .join("\n");

  // Two valid patterns, checked with OR (not a replacement): the OLD inline fbq() call
  // (pages generated before the ENG-449 follow-up deterministic-helper change), and the NEW
  // fireLeadTracking({ pixelId: ... }) call (buildTrackingHelper/buildBrandEnrichedPrompt).
  // An existing page must keep validating true under whichever pattern it actually shipped
  // with — tightening this to ONLY the new pattern would falsely regress every
  // already-working page the next time validation runs against it (e.g. iterateLandingPage).
  const hasOldPattern = /fbq\(\s*['"]track['"]\s*,\s*['"]Lead['"]/.test(tsxSource);
  const hasNewPattern = /fireLeadTracking\(\s*\{[^}]*pixelId\s*:/.test(tsxSource);

  if (!hasOldPattern && !hasNewPattern) {
    return { ok: false, reason: "No fbq('track', 'Lead') call (or fireLeadTracking({ pixelId }) call) found in the generated form component" };
  }

  return { ok: true };
}

/**
 * Check whether v0's generated form component actually redirects to the configured
 * bridge-out URL with the submitted email forwarded, per the prompt instruction added to
 * buildBrandEnrichedPrompt. Same "verify not guarantee" contract as validatePixelLeadEvent —
 * regex-based, not full parsing, since this is v0-authored freeform code.
 */
export function validateBridgeOutRedirect(files: Array<{ path: string; content: Buffer }>, bridgeOutUrl: string): { ok: boolean; reason?: string } {
  const tsxSource = files
    .filter((f) => f.path.endsWith(".tsx") || f.path.endsWith(".ts"))
    .map((f) => f.content.toString("utf-8"))
    .join("\n");

  // NEW pattern (buildTrackingHelper/buildBrandEnrichedPrompt): v0 calls the platform-owned
  // fireLeadTracking({ bridgeOutUrl: "..." }) helper, which guarantees the email= forwarding
  // internally — no literal "email=" required in v0's own code for this pattern. Checked
  // with OR against the OLD inline pattern (pre-follow-up pages), never as a replacement —
  // an existing page must keep validating true under whichever pattern it actually shipped.
  const escapedUrl = bridgeOutUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasNewPattern = new RegExp(`fireLeadTracking\\(\\s*\\{[^}]*bridgeOutUrl\\s*:\\s*["'\`]${escapedUrl}["'\`]`).test(tsxSource);

  if (hasNewPattern) {
    return { ok: true };
  }

  if (!tsxSource.includes(bridgeOutUrl)) {
    return { ok: false, reason: "Bridge-out URL not found in the generated form component" };
  }

  if (!/email=/.test(tsxSource)) {
    return { ok: false, reason: "Bridge-out redirect found but no email= query param forwarding was detected" };
  }

  return { ok: true };
}

/**
 * Deterministically inject platform-owned lead-capture attribution files into a
 * generated repo's file set, and drop any v0-generated capture route / middleware
 * that would conflict with them.
 *
 * Design: relying on v0 (an LLM) to capture/forward UTM attribution is
 * non-deterministic. Instead we force-inject a server-side middleware that
 * stamps a first-touch cookie, and a capture API route that reads that cookie
 * and forwards `attribution` (top-level, not customFields) to the backend
 * webhook. Any v0-generated `app/api/capture/route.ts` (or route-group
 * variants) and any v0 `middleware.ts` are dropped first so ours are
 * authoritative (avoids "conflicting routes" build errors / duplicate
 * middleware).
 */
/**
 * Normalizes a generated file path to its effective Next.js route by stripping
 * an optional `src/` root prefix and any route-group segments (`(group)`),
 * neither of which affect the resulting URL/route. Used to detect v0 output
 * that is *semantically* the same route as our injected files even when the
 * literal path differs (e.g. `src/app/(marketing)/api/capture/route.tsx`).
 */
function normalizeGeneratedPath(p: string): string {
  return p
    .replace(/^src\//, "")
    .split("/")
    .filter((seg) => !/^\([^)]*\)$/.test(seg))
    .join("/");
}

function isV0CaptureRoute(p: string): boolean {
  return /^app\/api\/capture\/route\.(ts|tsx|js|jsx)$/.test(normalizeGeneratedPath(p));
}

function isV0Middleware(p: string): boolean {
  return /^middleware\.(ts|js)$/.test(normalizeGeneratedPath(p));
}

/** v0 may emit its own domainMap; ours is authoritative (the middleware imports it). */
function isV0DomainMap(p: string): boolean {
  return /^domainMap\.(ts|js)$/.test(normalizeGeneratedPath(p));
}

/** v0 may emit its own tracking-helper file at this path; ours is authoritative. */
function isV0TrackingHelper(p: string): boolean {
  return /^lib\/agentweb-track\.(ts|tsx|js|jsx)$/.test(normalizeGeneratedPath(p));
}

/**
 * Platform-owned, deterministic tracking helper (ENG-449 follow-up). Shrinks the
 * v0-compliance surface: rather than asking v0 to author the `fbq()`/bridge-out-redirect
 * logic itself (freeform code, verified only after the fact — see validatePixelLeadEvent /
 * validateBridgeOutRedirect), v0 is instructed to import this ONE guaranteed function and
 * call it with the page's own pixelId/bridgeOutUrl as literal arguments. pixelId and
 * bridgeOutUrl are CALL-TIME arguments, not baked into this file: the helper is a single
 * repo-level shared module, but bridgeOutUrl (and, for a multi-page site, potentially
 * pixelId) is per-page data — same reason buildCaptureRoute takes a path->list MAP rather
 * than a single baked id.
 */
export function buildTrackingHelper(): string {
  return `// Generated by AgentWeb — DO NOT hand-author fbq()/redirect logic in your form
// component. Call fireLeadTracking(...) instead; it is guaranteed to fire the Meta Pixel
// Lead event (if a pixelId is configured) and perform the bridge-out redirect (if a
// bridgeOutUrl is configured), in the correct order, with the correct 800ms flush.
export async function fireLeadTracking(opts: {
  email: string;
  /** The SAME eventId you generated and sent in the /api/capture POST body — required so
   *  Meta's server-side CAPI event can be deduplicated against this client-side Pixel event. */
  eventId?: string;
  pixelId?: string;
  bridgeOutUrl?: string;
}): Promise<void> {
  if (opts.pixelId) {
    // @ts-ignore — fbq is injected globally by the platform-owned base Pixel snippet in layout.tsx
    if (typeof window !== "undefined" && window.fbq) {
      // @ts-ignore
      window.fbq('track', 'Lead', {}, { eventID: opts.eventId });
    }
    // Give the tracking beacon time to flush before any redirect below.
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  if (opts.bridgeOutUrl) {
    // ENG-449 (Harsha): bridge-out must forward UTMs, not just email — the 3rd-party
    // destination needs the SAME ad-attribution params that got this visitor here, or
    // conversion tracking on THEIR side breaks even though ours is fine. Read them off
    // this page's own URL (they arrived via the ad click that landed here) and pass
    // them straight through, alongside email. Uses the URL API (not manual string
    // building) so a utm_* param the destination URL was explicitly configured with
    // is NEVER clobbered/duplicated — an explicit override on the destination always wins.
    try {
      const url = new URL(opts.bridgeOutUrl);
      url.searchParams.set("email", opts.email);
      if (typeof window !== "undefined") {
        const currentParams = new URLSearchParams(window.location.search);
        for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
          if (url.searchParams.has(key)) continue;
          const value = currentParams.get(key);
          if (value) url.searchParams.set(key, value);
        }
      }
      window.location.href = url.toString();
    } catch (err) {
      // A malformed bridgeOutUrl shouldn't crash the whole submit flow — the lead was
      // already captured via /api/capture before this ever runs. Degrade gracefully
      // (stay on the success state) rather than throw past a caller that isn't expecting it.
      console.error("fireLeadTracking: invalid bridgeOutUrl, skipping redirect", err);
    }
  }
}
`;
}

/**
 * Defense in depth: if a v0-generated file somehow survives the drop-filter above
 * and still collides with our injected route/middleware, fail loudly here
 * (generation time, before any GitHub push) rather than silently at Vercel build
 * time later. Exported standalone so the throw path can be exercised directly,
 * since it is structurally unreachable through injectLeadCaptureAttribution itself
 * (the same filter that would let a duplicate through would also drop it).
 */
export function assertNoDuplicateInjectedRoutes(files: Array<{ path: string; content: Buffer }>): void {
  const captureRouteCount = files.filter((f) => f.path === "app/api/capture/route.ts").length;
  const middlewareCount = files.filter((f) => f.path === "middleware.ts").length;
  const domainMapCount = files.filter((f) => f.path === "domainMap.ts").length;
  const trackingHelperCount = files.filter((f) => f.path === "lib/agentweb-track.ts").length;
  if (captureRouteCount > 1 || middlewareCount > 1 || domainMapCount > 1 || trackingHelperCount > 1) {
    throw new Error(
      `[V0 SERVICE] duplicate route after lead-capture injection (capture routes: ${captureRouteCount}, middleware: ${middlewareCount}, domainMap: ${domainMapCount}, tracking helper: ${trackingHelperCount})`
    );
  }
}

/**
 * The ONE `middleware.ts` a generated landing page ever gets. ENG-308.
 *
 * Next.js allows exactly one middleware at the repo root, and TWO things need to
 * happen there: the per-page subdomain rewrite, and the first-touch attribution
 * capture. They used to be written by two different functions that each emitted the
 * whole file — so `updateSubdomainMiddleware` (fired on any domain attach/detach)
 * committed a routing-only middleware straight over the capture one and **silently
 * destroyed attribution** for that page, permanently, until it was regenerated.
 *
 * Both writers now emit THIS. A test asserts they are byte-identical, which is the
 * only real guarantee they cannot drift apart again.
 *
 * Two things to preserve if you edit this:
 *  - The cookie is set on the SAME response we return, on BOTH paths. Early-returning
 *    the rewrite would skip capture for exactly the pages a customer cared enough
 *    about to give a domain to.
 *  - The `matcher` must exclude `api/` — WITH the trailing slash. The capture route
 *    lives at `app/api/capture/route.ts` and READS this cookie, so it must never be
 *    rewritten. But excluding a bare `api` (no slash) would also strip the middleware
 *    from ordinary page routes that merely begin with those letters — `/api-docs`,
 *    `/apis`, `/api-integration` — and those pages would lose their SUBDOMAIN REWRITE,
 *    i.e. visibly break for the customer. The two middlewares this replaces disagreed
 *    on exactly this; the slash-ful form is the correct one.
 *
 * It imports `./domainMap`, so every writer must also emit a `domainMap.ts`.
 */
export function buildLandingPageMiddleware(): string {
  return `import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { DOMAIN_MAP } from "./domainMap";

const COOKIE = "aw_first_touch";
const MAX_AGE = 60 * 60 * 24 * 90; // 90 days

export function middleware(req: NextRequest) {
  // 1. Per-page subdomain routing: rewrite the host to its mapped path, if any.
  const host = (req.headers.get("host") || "").replace(/:\\d+$/, "");
  const targetPath = DOMAIN_MAP[host];
  let res: NextResponse;
  if (targetPath) {
    const url = req.nextUrl.clone();
    url.pathname = targetPath;
    res = NextResponse.rewrite(url);
  } else {
    res = NextResponse.next();
  }

  // The matcher below cannot practically exclude every static asset path a generated page
  // might reference (v0's own placeholder images, uploaded photos, fonts — arbitrary paths,
  // not a fixed extension list), so a sub-resource request (image, font, stylesheet) also
  // reaches this function. Only a real page navigation should stamp aw_page/aw_first_touch —
  // otherwise an asset request re-stamps aw_page with ITS OWN path, silently misfiling the
  // NEXT lead submitted from that page into no list at all ("no lead list configured").
  // Sec-Fetch-Dest is sent by all modern browsers for every request; absent (older browsers,
  // curl, test tooling) is treated as a real navigation — permissive default, never MORE
  // restrictive than before this fix. The rewrite above still applies to asset requests too.
  const secFetchDest = req.headers.get("sec-fetch-dest");
  // "iframe"/"frame" are a REAL page being loaded for a visitor to view — just nested, not
  // top-level (a widget embed, agency preview tool, AB-test wrapper). Only asset-type dests
  // (image, script, style, font, empty, etc.) are actual sub-resources.
  const isPageNavigation = !secFetchDest || secFetchDest === "document" || secFetchDest === "iframe" || secFetchDest === "frame";
  if (!isPageNavigation) return res;

  // 2. Which page is this, AFTER any rewrite? The capture route needs to know, because
  //    the lead list is per-page while the route is per-repo. We stamp it rather than
  //    letting the route read the Referer: for a rewritten host the browser reports
  //    pathname "/" (e.g. pricing.acme.com/), so a Referer lookup would miss and file
  //    the lead against the wrong page's list. Overwritten every request — a visitor
  //    may land on one page and submit the form on another, and the lead belongs to the
  //    page they submitted from.
  const PAGE_COOKIE = "aw_page";
  res.cookies.set(PAGE_COOKIE, targetPath || req.nextUrl.pathname, { path: "/", sameSite: "lax" });

  // 3. First-touch attribution capture, on WHICHEVER response we are returning.
  //    (Returning the rewrite early here would silently kill attribution on every
  //    page that has a custom domain — which is most of the ones that matter.)
  if (req.cookies.get(COOKIE)) return res;              // first-touch: never overwrite

  const sp = req.nextUrl.searchParams;
  const utm: Record<string, string> = {};
  for (const k of ["source", "medium", "campaign", "content", "term"]) {
    const v = sp.get("utm_" + k); if (v) utm[k] = v;
  }
  const clickIds: Record<string, string> = {};
  for (const [q, key] of [["gclid","gclid"],["fbclid","fbclid"],["ttclid","ttclid"],["li_fat_id","liFatId"]] as const) {
    const v = sp.get(q); if (v) clickIds[key] = v;
  }
  const referrer = req.headers.get("referer") || "";
  const ref = sp.get("ref") || "";

  const touch: Record<string, unknown> = { timestamp: new Date().toISOString(), landingUrl: req.nextUrl.href };
  if (Object.keys(utm).length) touch.utm = utm;
  if (Object.keys(clickIds).length) touch.clickIds = clickIds;
  if (referrer && !referrer.includes(req.nextUrl.host)) touch.referrer = referrer;
  if (ref) touch.ref = ref;

  res.cookies.set(COOKIE, JSON.stringify(touch), { maxAge: MAX_AGE, path: "/", sameSite: "lax" });
  return res;
}

export const config = { matcher: ["/((?!api\\/|_next\\/static|_next\\/image|favicon\\.ico).*)"] };
`;
}

/** `domainMap.ts` for a given host→path map. Emitted alongside every middleware. */
export function buildDomainMapFile(domainMap: Record<string, string> = {}): string {
  return (
    `// Generated by AgentWeb — maps a custom hostname to the page path it serves.\n` +
    `export const DOMAIN_MAP: Record<string, string> = ${JSON.stringify(domainMap, null, 2)};\n`
  );
}

/**
 * The lead-capture API route a generated site ships at `app/api/capture/route.ts`.
 *
 * The route is REPO-level (one per site) but the lead list is PER PAGE — a site can have
 * many pages, each wired to a different list. The old route hardcoded a single
 * `const LIST_ID`, so on any multi-page site the leads from every page would be filed
 * into whichever list happened to be injected last. That is worse than the bug it sits
 * behind: attribution today is merely *missing*, and a naive fix would make it *wrong*.
 * Misfiled leads are far harder to notice and far worse to explain to a customer.
 *
 * So the route takes the whole path→list map and resolves the page from the `aw_page`
 * cookie the middleware stamps. It deliberately does NOT trust the Referer: a page can be
 * served at `pricing.acme.com/` and rewritten to `/pricing` (see
 * `buildLandingPageMiddleware`), so the browser reports pathname `/` and a Referer lookup
 * would miss. The middleware already resolved the real path, so it stamps it. Referer is
 * kept only as a fallback for the (rare) request that arrives with no cookie.
 *
 * A page with no configured list FAILS LOUDLY. It must never fall back to "some other
 * list on this site" — silently filing a lead into the wrong list is the failure this
 * whole design exists to prevent.
 */
export function buildCaptureRoute(
  listByPath: Record<string, string>,
  apiBase: string = process.env.BACKEND_URL || "https://api.agentweb.pro",
  /**
   * The site's resolved Meta pixel id + the connected ad account it came from.
   * Baked in as plain string constants (like LIST_BY_PATH) — neither is a secret (the pixel
   * id is already public in the base snippet itself; the account id is just an identifier
   * `forward-lead` uses to look up a fresh access token server-side). When absent, no
   * pixelId/metaAccountId fields are added to the forwarded body at all.
   */
  pixelId?: string,
  metaAccountId?: string,
): string {
  // Guard the shape. This used to take a bare `leadListId: string`, and passing the old
  // string form here silently produced `const LIST_BY_PATH = "list_xyz"` — a route that
  // compiles, deploys, and files every lead nowhere. ts-jest did not catch it. Fail here
  // instead of shipping a broken route to a customer's site.
  if (listByPath === null || typeof listByPath !== "object" || Array.isArray(listByPath)) {
    throw new Error(
      `[V0 SERVICE] buildCaptureRoute expects a path->leadListId map, got ${typeof listByPath}. ` +
      `(It used to take a single leadListId string; the capture route is repo-level but the ` +
      `lead list is per-page, so it now needs the whole map.)`
    );
  }

  return `import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";

// path -> lead list. One entry per page of this site; the route is shared by all of them.
const LIST_BY_PATH: Record<string, string> = ${JSON.stringify(listByPath, null, 2)};
const FORWARD_URL = "${apiBase}/api/webhooks/forward-lead";
// Not secrets — the pixel id is already public in the base snippet, and the account
// id is just an identifier the backend uses to look up its own stored access token.
const PIXEL_ID = ${pixelId ? JSON.stringify(pixelId) : "undefined"};
const META_ACCOUNT_ID = ${metaAccountId ? JSON.stringify(metaAccountId) : "undefined"};

/** Which page was this form submitted from? */
async function resolvePagePath(): Promise<string | undefined> {
  const jar = await cookies();
  // Stamped by the middleware with the page path AFTER any subdomain rewrite. This is
  // the authoritative answer; the Referer is not (a rewritten host reports "/").
  const stamped = jar.get("aw_page")?.value;
  if (stamped) return stamped;

  // Fallback only: no cookie (blocked, expired, or a direct API call).
  const referer = (await headers()).get("referer");
  if (!referer) return undefined;
  try { return new URL(referer).pathname; } catch { return undefined; }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));

    const path = await resolvePagePath();
    const listId = path ? LIST_BY_PATH[path] : undefined;
    if (!listId) {
      // Fail loudly. Do NOT guess a list: a lead filed into the wrong list is worse than
      // a lead that visibly failed to submit.
      return NextResponse.json(
        { success: false, error: "This page has no lead list configured, so the submission was not saved." },
        { status: 422 }
      );
    }

    let attribution: unknown;
    const raw = (await cookies()).get("aw_first_touch")?.value;
    if (raw) { try { attribution = JSON.parse(raw); } catch {} }

    // Meta's own first-party click-id cookies (set by the base Pixel snippet, already
    // platform-injected). Forwarded deterministically here — no v0-authored client code
    // needs to read or forward these itself.
    const fbp = (await cookies()).get("_fbp")?.value;
    const fbc = (await cookies()).get("_fbc")?.value;

    const res = await fetch(FORWARD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...body,
        listId,
        source: "landing-page",
        ...(attribution ? { attribution } : {}),
        ...(PIXEL_ID ? { pixelId: PIXEL_ID, metaAccountId: META_ACCOUNT_ID } : {}),
        ...(fbp ? { fbp } : {}),
        ...(fbc ? { fbc } : {}),
      }),
    });
    if (!res.ok) return NextResponse.json({ success: false }, { status: 502 });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
`;
}

/**
 * Inject the platform-owned capture files into a generated site's file set.
 *
 * ENG-309: all three files are ALWAYS emitted, even with no lead list. The middleware
 * needs no list (it only stamps cookies), and a capture route that says "this page has no
 * lead list configured" is debuggable where a bare 404 is not. Skipping the injection
 * because no list happened to be attached is what left pages silently unattributable
 * forever.
 *
 * @param listByPath page path -> lead list id, for EVERY page of this site. May be empty.
 */
export function injectLeadCaptureAttribution(
  files: Array<{ path: string; content: Buffer }>,
  listByPath: Record<string, string>,
  /** Threaded through to buildCaptureRoute — see its own doc comment. */
  pixelId?: string,
  metaAccountId?: string,
): Array<{ path: string; content: Buffer }> {
  const filtered = files.filter(
    (f) => !isV0CaptureRoute(f.path) && !isV0Middleware(f.path) && !isV0DomainMap(f.path) && !isV0TrackingHelper(f.path)
  );

  filtered.push({ path: "middleware.ts", content: Buffer.from(buildLandingPageMiddleware()) });
  filtered.push({ path: "app/api/capture/route.ts", content: Buffer.from(buildCaptureRoute(listByPath, undefined, pixelId, metaAccountId)) });
  // The middleware imports ./domainMap, so a fresh page MUST ship one or its very
  // first Vercel build fails. Empty until a subdomain is actually attached, at which
  // point updateSubdomainMiddleware rewrites it with the real map.
  filtered.push({ path: "domainMap.ts", content: Buffer.from(buildDomainMapFile({})) });
  filtered.push({ path: "lib/agentweb-track.ts", content: Buffer.from(buildTrackingHelper()) });

  assertNoDuplicateInjectedRoutes(filtered);

  return filtered;
}

/**
 * Create a GitHub repo under the AgentWebPro org and push all files via the Contents API.
 */
async function createGitHubRepoAndPush(
  repoName: string,
  zipData: any,
  description: string,
  /**
   * Page path -> lead list, for every page of this site. The capture route is repo-level
   * but the lead list is per-page, so it needs the whole map (ENG-310). May be empty —
   * the files are injected regardless (ENG-309).
   */
  listByPath: Record<string, string> = {},
  /**
   * The site's saved GTM container id. When set, the head+noscript snippet is
   * injected into the root layout before the initial commit so paid traffic is measurable
   * from the first deploy. When absent, NOTHING is injected — no fallback to AgentWeb's
   * platform GA4 property on a customer page.
   */
  gtmContainerId?: string,
  /**
   * The site's resolved (or manually-set) Meta pixel id. When set, the pixel base
   * snippet is injected into the root layout before the initial commit, mirroring GTM. When
   * absent, NOTHING is injected — no fallback pixel.
   */
  metaPixelId?: string,
  /** The connected Meta ad account `metaPixelId` was resolved from — baked into the
   *  generated capture route (as a public identifier, not a secret) so `forward-lead` can look
   *  up a fresh access token for the CAPI send. */
  metaAdAccountId?: string,
): Promise<{ githubRepoUrl: string; repoFullName: string; commitSha: string; gtmInjected: boolean; pixelInjected: boolean }> {
  const { token, org } = await getGitHubOrgToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
  };

  // Create the repo — GitHub occasionally returns 422 "Repository creation failed" transiently
  let createRepoRes: any;
  let lastGhCreateError: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      createRepoRes = await axios.post<any>(
        `https://api.github.com/orgs/${org}/repos`,
        {
          name: repoName,
          description: `Landing page: ${description}`,
          private: true,
          auto_init: true, // Creates an initial commit with README
        },
        { headers, timeout: GITHUB_API_TIMEOUT_MS }
      );
      break; // success
    } catch (err: any) {
      const status = err.response?.status;
      const ghMessage = err.response?.data?.message || err.response?.data?.errors?.[0]?.message || err.message;
      lastGhCreateError = err;

      const isTransient422 = status === 422 && (
        !ghMessage || // no message = GitHub internal glitch
        ghMessage.includes("Repository creation failed") ||
        ghMessage.includes("already exists") === false
      );
      // Also retry on 5xx or network errors
      const isRetryable = isTransient422 || status >= 500 ||
        err.message?.includes("fetch failed") || err.message?.includes("ECONNRESET") ||
        err.code === "ECONNRESET";

      if (!isRetryable || attempt === 3) {
        console.error(`[V0 SERVICE] GitHub repo creation failed (HTTP ${status}): ${ghMessage}`);
        throw err;
      }
      const delay = 2000 * attempt;
      console.warn(`[V0 SERVICE] GitHub repo creation failed (HTTP ${status}): ${ghMessage} — retrying in ${delay}ms (attempt ${attempt}/3)`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  const githubRepoUrl = createRepoRes.data.html_url;
  const repoFullName = createRepoRes.data.full_name; // e.g. "AgentWebPro/lp-acme-a1b2c3"

  console.log(`[V0 SERVICE] Created GitHub repo: ${githubRepoUrl}`);

  // Unzip the downloaded files
  const files = await unzipBuffer(zipData);
  console.log(`[V0 SERVICE] Extracted ${files.length} files from v0 zip`);

  // v0 downloads only contain modified files — add standard Next.js scaffolding
  // that's required for the build but not included in the zip
  const scaffoldFiles: Array<{ path: string; content: Buffer }> = [];

  const hasFile = (name: string) => files.some((f) => f.path === name || f.path.endsWith(`/${name}`));

  if (!hasFile("tsconfig.json")) {
    scaffoldFiles.push({
      path: "tsconfig.json",
      content: Buffer.from(JSON.stringify({
        compilerOptions: {
          target: "ES2017",
          lib: ["dom", "dom.iterable", "esnext"],
          allowJs: true,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: "esnext",
          moduleResolution: "bundler",
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: "preserve",
          incremental: true,
          plugins: [{ name: "next" }],
          paths: { "@/*": ["./*"] },
        },
        include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
        exclude: ["node_modules"],
      }, null, 2)),
    });
  }

  if (!hasFile("next.config.ts") && !hasFile("next.config.js") && !hasFile("next.config.mjs")) {
    scaffoldFiles.push({
      path: "next.config.ts",
      content: Buffer.from('import type { NextConfig } from "next";\nconst nextConfig: NextConfig = {};\nexport default nextConfig;\n'),
    });
  }

  if (!hasFile("lib/utils.ts")) {
    scaffoldFiles.push({
      path: "lib/utils.ts",
      content: Buffer.from('import { type ClassValue, clsx } from "clsx"\nimport { twMerge } from "tailwind-merge"\n\nexport function cn(...inputs: ClassValue[]) {\n  return twMerge(clsx(inputs))\n}\n'),
    });
  }

  if (!hasFile("app/layout.tsx")) {
    // No platform-GA4 fallback here — a customer page must never ship AgentWeb's
    // own GA4 property. Conversion tracking comes solely from the site's own GTM container,
    // injected below from `gtmContainerId` (or nothing, flagged as "no tracking installed").
    scaffoldFiles.push({
      path: "app/layout.tsx",
      content: Buffer.from(`import type { Metadata } from "next";\nimport "./globals.css";\n\nexport const metadata: Metadata = {\n  title: "Landing Page",\n  description: "Generated landing page",\n};\n\nexport default function RootLayout({\n  children,\n}: {\n  children: React.ReactNode;\n}) {\n  return (\n    <html lang="en">\n      <head>\n      </head>\n      <body>{children}</body>\n    </html>\n  );\n}\n`),
    });
  }

  if (scaffoldFiles.length > 0) {
    console.log(`[V0 SERVICE] Adding ${scaffoldFiles.length} scaffold files: ${scaffoldFiles.map(f => f.path).join(", ")}`);
    files.push(...scaffoldFiles);
  }

  // Deterministically inject platform-owned lead-capture attribution (middleware.ts +
  // domainMap.ts + app/api/capture/route.ts), force-replacing any v0-generated equivalents.
  //
  // ENG-309: this used to be guarded by `if (leadListId)`. A page generated without a lead
  // list got NO capture at all — silently, with no error — and stayed unattributable
  // forever, even after a list was attached later. The middleware needs no list (it only
  // stamps cookies), and a capture route that reports "this page has no lead list
  // configured" beats a bare 404, so we always inject. The route simply carries an empty
  // map until a list is wired up.
  const finalFiles = injectLeadCaptureAttribution(files, listByPath, metaPixelId, metaAdAccountId);
  const wired = Object.entries(listByPath);
  console.log(
    wired.length
      ? `[V0 SERVICE] Injected lead-capture files; ${wired.map(([p, l]) => `${p} -> ${l}`).join(", ")}`
      : `[V0 SERVICE] Injected lead-capture files with NO lead list — this site will not capture leads until one is attached`
  );

  // Auto-fix common v0 build issues before pushing to GitHub
  const fixCount = autoFixV0Files(finalFiles);
  if (fixCount > 0) {
    console.log(`[V0 SERVICE] Auto-fixed ${fixCount} files for build compatibility`);
  }

  // Deterministically fix v0's mis-rooted relative imports on the first page too (it commits the
  // files at their original paths, so v0's `./landing/Sibling`-style mistakes break here as well).
  const importRepairs = repairMisrootedImports(finalFiles);
  if (importRepairs > 0) {
    console.log(`[V0 SERVICE] Repaired ${importRepairs} mis-rooted relative import(s)`);
  }

  // Auto-inject the site's GTM container into the root layout BEFORE the initial
  // commit, so every generated lander (and its subpages, via the shared layout) is
  // measurable from the first deploy — no manual "Add GTM" step. Absent a container id,
  // nothing is injected and the caller records a "no tracking installed" signal.
  const gtmInjected = injectGtmIntoLayoutFiles(finalFiles, gtmContainerId);
  console.log(
    gtmInjected
      ? `[V0 SERVICE] Injected GTM container ${gtmContainerId} into app/layout.tsx`
      : `[V0 SERVICE] No GTM container configured for this site — pushing WITHOUT conversion tracking`,
  );

  // Auto-inject the site's resolved Meta pixel into the root layout BEFORE the
  // initial commit, mirroring GTM above. Absent a pixel id, nothing is injected and the
  // caller records a "no Meta tracking installed" signal.
  const pixelInjected = injectPixelIntoLayoutFiles(finalFiles, metaPixelId);
  console.log(
    pixelInjected
      ? `[V0 SERVICE] Injected Meta Pixel ${metaPixelId} into app/layout.tsx`
      : `[V0 SERVICE] No Meta Pixel configured for this site — pushing WITHOUT Meta conversion tracking`,
  );

  // Push files to the repo using the Git Trees API (single commit for all files)
  // Step A: Get the default branch SHA
  const refRes = await axios.get<any>(
    `https://api.github.com/repos/${repoFullName}/git/ref/heads/main`,
    { headers, timeout: GITHUB_API_TIMEOUT_MS }
  );
  const latestCommitSha = refRes.data.object.sha;

  // Step B: Create blobs for each file
  const blobPromises = finalFiles.map(async (file) => {
    const blobRes = await axios.post<any>(
      `https://api.github.com/repos/${repoFullName}/git/blobs`,
      {
        content: file.content.toString("base64"),
        encoding: "base64",
      },
      { headers, timeout: GITHUB_API_TIMEOUT_MS }
    );
    return {
      path: file.path,
      mode: "100644" as const,
      type: "blob" as const,
      sha: blobRes.data.sha,
    };
  });
  const treeItems = await Promise.all(blobPromises);

  // Step C: Create a tree
  const treeRes = await axios.post<any>(
    `https://api.github.com/repos/${repoFullName}/git/trees`,
    {
      base_tree: latestCommitSha,
      tree: treeItems,
    },
    { headers, timeout: GITHUB_API_TIMEOUT_MS }
  );

  // Step D: Create a commit
  const commitRes = await axios.post<any>(
    `https://api.github.com/repos/${repoFullName}/git/commits`,
    {
      message: "Initial landing page from v0 generation",
      tree: treeRes.data.sha,
      parents: [latestCommitSha],
    },
    { headers, timeout: GITHUB_API_TIMEOUT_MS }
  );

  // Step E: Update the ref to point to the new commit
  const commitSha: string = commitRes.data.sha;
  await axios.patch<any>(
    `https://api.github.com/repos/${repoFullName}/git/refs/heads/main`,
    { sha: commitSha },
    { headers, timeout: GITHUB_API_TIMEOUT_MS }
  );

  console.log(`[V0 SERVICE] Pushed ${finalFiles.length} files to ${repoFullName} (${commitSha.substring(0, 7)})`);

  return { githubRepoUrl, repoFullName, commitSha, gtmInjected, pixelInjected };
}

/**
 * Create a Vercel project linked to a GitHub repo. Vercel auto-deploys on push.
 * Polls deployment status and returns build errors if the deploy fails.
 */
async function createVercelProject(
  repoFullName: string,
  projectName: string,
  expectedCommitSha?: string
): Promise<{ deployedUrl: string; vercelProjectId: string; buildStatus: string; buildError?: string }> {
  const vercelToken = await getVercelToken();
  const headers = {
    Authorization: `Bearer ${vercelToken}`,
    "Content-Type": "application/json",
  };

  // Create the Vercel project linked to the GitHub repo
  const createRes = await axios.post<any>(
    "https://api.vercel.com/v10/projects",
    {
      name: projectName,
      framework: "nextjs",
      installCommand: "npm install",  // v0 generates package.json for npm, not pnpm
      buildCommand: "npm run build",  // Prevent Vercel from defaulting to pnpm
      gitRepository: {
        type: "github",
        repo: repoFullName,
      },
    },
    { headers, timeout: VERCEL_API_TIMEOUT_MS }
  );

  const vercelProjectId = createRes.data.id;
  // Use the actual alias/domain from Vercel API — Vercel truncates long project names
  const vercelAlias = createRes.data.alias?.[0]?.domain
    || createRes.data.targets?.production?.alias?.[0]
    || `${createRes.data.name || projectName}.vercel.app`;
  const deployedUrl = vercelAlias.startsWith("https://") ? vercelAlias : `https://${vercelAlias}`;

  console.log(`[V0 SERVICE] Created Vercel project: ${vercelProjectId}, URL: ${deployedUrl} (requested name: ${projectName})`);

  // Disable deployment protection so preview deployments are publicly accessible
  try {
    await axios.patch(
      `https://api.vercel.com/v9/projects/${vercelProjectId}`,
      { ssoProtection: null, passwordProtection: null, trustedIps: null },
      { headers, timeout: VERCEL_API_TIMEOUT_MS }
    );
    console.log(`[V0 SERVICE] Disabled deployment protection for ${projectName}`);
  } catch (authErr: any) {
    console.warn(`[V0 SERVICE] Could not disable deployment protection: ${authErr.message}`);
  }

  // Manually trigger a deployment — Vercel doesn't always auto-deploy when linking to an existing repo
  const { token: ghToken } = await getGitHubOrgToken();
  const repoInfoRes = await axios.get<any>(`https://api.github.com/repos/${repoFullName}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github.v3+json" },
    timeout: 30_000,
  });
  const repoId = repoInfoRes.data.id;

  // Capture timestamp immediately before triggering — pollVercelDeployment uses
  // this to ignore any pre-existing READY deployment.
  const deployTriggerMs = Date.now();
  try {
    await axios.post<any>(
      "https://api.vercel.com/v13/deployments",
      {
        name: projectName,
        project: vercelProjectId,
        gitSource: { type: "github", repo: repoFullName, ref: "main", repoId },
      },
      { headers, timeout: VERCEL_API_TIMEOUT_MS }
    );
    console.log(`[V0 SERVICE] Triggered manual deployment for ${projectName}`);
  } catch (deployErr: any) {
    // Non-fatal — Vercel may have already auto-triggered
    console.warn(`[V0 SERVICE] Manual deploy trigger failed (may already be deploying): ${deployErr.message}`);
  }

  // Poll for deployment status — only accept the build for the commit we pushed
  // (created after our trigger), so a stale build is never taken as success.
  const deploymentResult = await pollVercelDeployment(vercelProjectId, vercelToken, deployTriggerMs, expectedCommitSha);

  // After deployment, fetch the project to get the real production alias.
  // Vercel truncates long project names in domains (e.g. our requested name
  // "lp-foo--abc123" may become "lp-foo-ab" in the domain), so we read the
  // actual domain from targets.production.alias[0] which is authoritative.
  let finalUrl = deployedUrl;
  try {
    const projectRes = await axios.get<any>(
      `https://api.vercel.com/v9/projects/${vercelProjectId}`,
      { headers, timeout: VERCEL_API_TIMEOUT_MS }
    );
    const productionAliases: string[] = projectRes.data?.targets?.production?.alias || [];
    const vercelDomain = productionAliases.find((a: string) => a.endsWith(".vercel.app"));
    if (vercelDomain) {
      finalUrl = `https://${vercelDomain}`;
    }
  } catch (aliasErr: any) {
    console.warn(`[V0 SERVICE] Could not fetch project aliases, using constructed URL: ${aliasErr.message}`);
  }

  if (finalUrl !== deployedUrl) {
    console.log(`[V0 SERVICE] URL corrected: ${deployedUrl} → ${finalUrl}`);
  }

  return { deployedUrl: finalUrl, vercelProjectId, ...deploymentResult };
}

/**
 * Read the GitHub commit SHA a Vercel deployment was built from.
 * Vercel exposes this under meta.githubCommitSha (other git providers use
 * gitlabCommitSha / bitbucketCommitSha); we only use GitHub.
 */
function deploymentCommitSha(deployment: any): string | undefined {
  return deployment?.meta?.githubCommitSha || deployment?.meta?.gitCommitSha;
}

/**
 * Poll Vercel for the build of a specific commit.
 *
 * Passing `sinceMs` prevents catching a previously-READY deployment when a new
 * build has just been triggered by a GitHub push.
 *
 * Passing `expectedCommitSha` is critical: the page must only be marked
 * "deployed" when the build *for the commit we just pushed* goes live. Without
 * this guard the newest deployment (often a stale build that predates our push
 * and does NOT contain the new app/<slug>/ route) was accepted as success, so
 * the record was marked deployed while the live site 404'd the route. We now
 * scan recent deployments for the matching commit and ignore everything else.
 */
async function pollVercelDeployment(
  projectId: string,
  vercelToken: string,
  sinceMs?: number,
  expectedCommitSha?: string
): Promise<{ buildStatus: string; buildError?: string }> {
  const headers = { Authorization: `Bearer ${vercelToken}` };
  // When matching a specific commit, look at more than just the newest
  // deployment — a stale build can momentarily be the latest entry.
  const limit = expectedCommitSha ? 10 : 1;

  for (let attempt = 0; attempt < vercelPollMaxAttempts; attempt++) {
    try {
      const sinceParam = sinceMs !== undefined ? `&since=${sinceMs}` : "";
      const deploymentsRes = await axios.get<any>(
        `https://api.vercel.com/v6/deployments?projectId=${projectId}&limit=${limit}${sinceParam}`,
        { headers, timeout: VERCEL_POLL_TIMEOUT_MS }
      );

      const deployments: any[] = deploymentsRes.data?.deployments || [];

      // Pick the deployment to evaluate. With a target commit, only consider the
      // build for that exact commit; otherwise fall back to the newest one.
      const deployment = expectedCommitSha
        ? deployments.find((d) => deploymentCommitSha(d) === expectedCommitSha)
        : deployments[0];

      if (!deployment) {
        console.log(
          `[V0 SERVICE] No deployment found yet` +
            (expectedCommitSha ? ` for commit ${expectedCommitSha.substring(0, 7)}` : "") +
            (sinceMs !== undefined ? ` after ${new Date(sinceMs).toISOString()}` : "") +
            ` (attempt ${attempt + 1})`
        );
        await new Promise(r => setTimeout(r, vercelPollIntervalMs));
        continue;
      }

      const state = deployment.readyState || deployment.state;
      console.log(`[V0 SERVICE] Deployment ${deployment.uid}: state=${state} (attempt ${attempt + 1})`);

      if (state === "READY") {
        return { buildStatus: "success" };
      }

      if (state === "ERROR" || state === "CANCELED") {
        // Fetch build logs to get the error details
        const buildError = await getVercelBuildErrors(deployment.uid, vercelToken);
        return {
          buildStatus: "error",
          buildError: buildError || `Vercel build failed with state: ${state}`,
        };
      }

      // Still building (QUEUED, BUILDING, INITIALIZING) — wait and retry
      await new Promise(r => setTimeout(r, vercelPollIntervalMs));
    } catch (err: any) {
      console.error(`[V0 SERVICE] Error polling deployment (attempt ${attempt + 1}):`, err.message);
      await new Promise(r => setTimeout(r, vercelPollIntervalMs));
    }
  }

  return { buildStatus: "timeout", buildError: "Deployment timed out after 5 minutes. Check Vercel dashboard." };
}

/**
 * A stderr line that is NOT the build failure itself: the Vercel CLI version
 * banner and deprecation/warning notices. These trail real build output, so
 * naively surfacing the last stderr lines can present a benign warning (e.g.
 * "the middleware file convention is deprecated") AS the build error, masking
 * the actual cause. Exported for testing.
 */
export function isNonErrorBuildLine(line: string): boolean {
  const l = line.trim();
  return (
    /^vercel cli\b/i.test(l) ||
    // Vercel/Next.js use ▲ as a general-purpose prefix — including on REAL errors
    // (e.g. "▲ Error: …"). Only treat it as noise on their banner lines.
    /^▲\s+(vercel|next\.js)\b/i.test(l) ||
    /^[⚠►]/.test(l) ||
    // Anchored to line-start: a bare "Deprecation Warning: …" line is noise, but a
    // real error that merely mentions something deprecated must NOT be silenced.
    /^deprecation\b/i.test(l) ||
    /^warn(ing)?\b/i.test(l)
  );
}

/**
 * Fetch build error messages from Vercel deployment events.
 *
 * Prefers lines that carry an actual failure signal over trailing CLI/warning
 * noise; when the logs contain ONLY noise (no explicit error line), says so
 * rather than dressing a deprecation warning up as the build error. Exported
 * for testing.
 */
export async function getVercelBuildErrors(deploymentId: string, vercelToken: string): Promise<string> {
  try {
    const headers = { Authorization: `Bearer ${vercelToken}` };
    const eventsRes = await axios.get<any>(
      `https://api.vercel.com/v3/deployments/${deploymentId}/events?limit=-1`,
      { headers, timeout: VERCEL_POLL_TIMEOUT_MS }
    );

    const events = eventsRes.data || [];
    const errorLines: string[] = [];

    for (const event of events) {
      const type = event.type;
      const text = event.payload?.text || event.text || "";
      if ((type === "stderr" || type === "fatal") && text.trim()) {
        errorLines.push(text);
      }
    }

    if (errorLines.length === 0) {
      return "Build failed — no error details available in logs.";
    }

    // Drop CLI-banner/warning noise so the real failure isn't buried under (or
    // impersonated by) a trailing deprecation notice.
    const meaningful = errorLines.filter((l) => !isNonErrorBuildLine(l));
    if (meaningful.length === 0) {
      // Only noise was captured — don't pass a warning off as the cause.
      return (
        errorLines.slice(-30).join("\n") +
        "\n(No explicit build error was captured in the logs — only warnings/CLI output. Check the Vercel dashboard for the full build log.)"
      );
    }

    // Return the last 30 meaningful error lines (most relevant).
    return meaningful.slice(-30).join("\n");
  } catch (err: any) {
    console.error("[V0 SERVICE] Error fetching build logs:", err.message);
    return "Build failed — could not retrieve error details.";
  }
}

/**
 * Probe a landing page's own public URL to confirm the route is actually live
 * (not 404ing). Used to gate auto-heal so a page is never marked "deployed"
 * while its URL is broken. Returns false on any non-2xx/3xx or network error;
 * returns true if no URL is known (nothing to disprove — fall back to caller's
 * other signals).
 */
async function isLandingPageUrlLive(url?: string): Promise<boolean> {
  if (!url) return true;
  try {
    const res = await axios.get<any>(url, {
      timeout: VERCEL_POLL_TIMEOUT_MS,
      // Resolve (don't throw) for all statuses so we can inspect the code.
      validateStatus: () => true,
    });
    const status = res.status;
    return status >= 200 && status < 400;
  } catch (_e) {
    return false;
  }
}

/**
 * Assign a managed agentwebforms.com subdomain to a root site's Vercel project and
 * persist `customDomainUrl`. Retried: a transient Vercel domains-API blip here used
 * to be swallowed, leaving the page on its raw *.vercel.app URL permanently
 * (≈30% of deployed pages showed "vercel junk" instead of the clean subdomain).
 * `addSubdomain` already handles 409 collisions; `withRetry` covers
 * fetch-failed/5xx/timeout. Non-fatal — the Vercel URL still works if this throws.
 * Returns the assigned domain (no scheme) or undefined.
 */
async function assignManagedSubdomain(
  id: string,
  userId: string,
  vercelProjectId: string,
  name: string | undefined
): Promise<string | undefined> {
  try {
    const subdomain = generateSubdomain(name || "page");
    const domainRecord = await withRetry(
      () => addSubdomain(userId, vercelProjectId, subdomain),
      "assign subdomain"
    );
    const customDomain = domainRecord.domain;
    console.log(`[V0 SERVICE] Auto-assigned subdomain: ${customDomain}`);
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: "SET customDomainUrl = :customUrl, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":customUrl": `https://${customDomain}`,
          ":updatedAt": new Date().toISOString(),
        },
      })
      .promise();
    return customDomain;
  } catch (subdomainErr: any) {
    console.warn(`[V0 SERVICE] Could not auto-assign subdomain: ${subdomainErr.message}`);
    return undefined;
  }
}

/**
 * Get the current deployment status and build logs for a landing page.
 * Exposed as a tool so Emma can check on builds.
 */
export async function getDeploymentStatus(
  id: string,
  userId: string
): Promise<{ status: string; buildStatus?: string; buildError?: string; deployedUrl?: string }> {
  const record = await getLandingPage(id, userId);
  if (!record) throw new Error("Landing page not found");
  if (!record.vercelProjectId) return { status: record.status };

  const vercelToken = await getVercelToken();
  const headers = { Authorization: `Bearer ${vercelToken}` };

  const deploymentsRes = await axios.get<any>(
    `https://api.vercel.com/v6/deployments?projectId=${record.vercelProjectId}&limit=1`,
    { headers }
  );

  const deployment = deploymentsRes.data?.deployments?.[0];
  if (!deployment) return { status: record.status, buildStatus: "no_deployment" };

  const state = deployment.readyState || deployment.state;

  if (state === "ERROR" || state === "CANCELED") {
    const buildError = await getVercelBuildErrors(deployment.uid, vercelToken);
    return { status: record.status, buildStatus: "error", buildError, deployedUrl: record.deployedUrl };
  }

  // Auto-heal: if Vercel shows the project is READY but our record says
  // failed/deploying, sync it — BUT only after confirming the page's own live
  // URL actually resolves. Project-level READY is not enough for sub-pages:
  // the latest build can be READY yet not contain this page's app/<slug>/ route
  // (it built an older commit), so healing on READY alone marked a page
  // "deployed" while its URL 404'd (the empathiaai bug). Verifying the live URL
  // enforces the real user-facing invariant for both root and sub-pages.
  if (state === "READY" && (record.status === "failed" || record.status === "deploying")) {
    const liveUrlOk = await isLandingPageUrlLive(record.deployedUrl);
    if (liveUrlOk) {
      try {
        await dynamodb.update({
          TableName: TABLE_NAME,
          Key: { id },
          UpdateExpression: "SET #status = :status, updatedAt = :updatedAt REMOVE errorMessage",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": "deployed",
            ":updatedAt": new Date().toISOString(),
          },
        }).promise();
      } catch (_e) {
        // Best-effort — don't block the status response
      }
      // A root page healed from failed→deployed here never ran the post-deploy
      // subdomain assignment (that only fires on a first-try success), so it stayed
      // on its raw *.vercel.app URL. Assign the managed subdomain now. Root-only:
      // sub-pages inherit the root's subdomain; skipped if one is already attached.
      const isRoot = record.isRootPage || record.siteId === record.id || !record.slug;
      if (isRoot && !record.customDomainUrl && record.vercelProjectId) {
        await assignManagedSubdomain(record.id, userId, record.vercelProjectId, record.name);
      }
      return {
        status: "deployed",
        buildStatus: "success",
        deployedUrl: record.deployedUrl,
      };
    }
    // Project is READY but this page's route is not live — do not heal.
    return {
      status: record.status,
      buildStatus: "route_not_live",
      deployedUrl: record.deployedUrl,
    };
  }

  return {
    status: record.status,
    buildStatus: state === "READY" ? "success" : state.toLowerCase(),
    deployedUrl: record.deployedUrl,
  };
}

/**
 * Get the Vercel preview deployment URL for a non-main branch.
 * Vercel automatically creates preview deployments for branch pushes.
 * Returns the preview URL and build status.
 */
export async function getPreviewDeploymentUrl(
  vercelProjectId: string,
  branch: string
): Promise<{ previewUrl?: string; buildStatus: string; buildError?: string; prUrl?: string }> {
  const vercelToken = await getVercelToken();
  const headers = { Authorization: `Bearer ${vercelToken}`, "Content-Type": "application/json" };

  // Fetch project info and ensure Vercel Authentication is disabled
  let projRes: any = null;
  try {
    projRes = await axios.get<any>(
      `https://api.vercel.com/v9/projects/${vercelProjectId}`,
      { headers }
    );
    console.log(`[V0 SERVICE] Project ${vercelProjectId} protection settings:`, JSON.stringify({
      ssoProtection: projRes.data?.ssoProtection,
      passwordProtection: projRes.data?.passwordProtection,
      trustedIps: projRes.data?.trustedIps,
    }));

    // Disable all protection types
    const patchRes = await axios.patch(
      `https://api.vercel.com/v9/projects/${vercelProjectId}`,
      { ssoProtection: null, passwordProtection: null, trustedIps: null },
      { headers }
    );
    console.log(`[V0 SERVICE] Disabled deployment protection for project ${vercelProjectId}: ${patchRes.status}`);
  } catch (authErr: any) {
    console.warn(`[V0 SERVICE] Could not disable deployment protection for ${vercelProjectId}: ${authErr.response?.status} ${authErr.response?.data?.error?.message || authErr.message}`);
  }

  // List recent deployments filtered by the branch (meta.githubCommitRef)
  const deploymentsRes = await axios.get<any>(
    `https://api.vercel.com/v6/deployments?projectId=${vercelProjectId}&limit=20`,
    { headers }
  );

  const deployments = deploymentsRes.data?.deployments || [];
  console.log(`[V0 SERVICE] Found ${deployments.length} deployments for project ${vercelProjectId}, looking for branch "${branch}". Branches in deployments: [${deployments.map((d: any) => d.meta?.githubCommitRef || 'none').join(', ')}]`);

  // Find the most recent deployment for this branch
  const branchDeployment = deployments.find((d: any) =>
    d.meta?.githubCommitRef === branch
  );

  if (!branchDeployment) {
    // No deployment found — Vercel deploys on PRs, not branch pushes.
    // Create a draft PR to trigger the Vercel preview deployment.
    const repoLink = projRes?.data?.link;
    if (repoLink?.type === "github" && repoLink.repo) {
      try {
        const repoFullName = `${repoLink.org}/${repoLink.repo}`;
        console.log(`[V0 SERVICE] No deployment found for branch "${branch}", creating draft PR to trigger Vercel preview`);
        const prUrl = await createDraftPrForBranch(repoFullName, branch);
        return { buildStatus: "building", previewUrl: undefined, prUrl };
      } catch (prErr: any) {
        console.warn(`[V0 SERVICE] Failed to create draft PR for branch "${branch}": ${prErr.response?.data?.message || prErr.message}`);
      }
    }
    return { buildStatus: "not_found", previewUrl: undefined };
  }

  const state = branchDeployment.readyState || branchDeployment.state;
  const previewUrl = branchDeployment.url ? `https://${branchDeployment.url}` : undefined;

  if (state === "READY") {
    return { buildStatus: "success", previewUrl };
  }

  if (state === "ERROR" || state === "CANCELED") {
    const buildError = await getVercelBuildErrors(branchDeployment.uid, vercelToken);
    return { buildStatus: "error", buildError, previewUrl };
  }

  // Still building
  return { buildStatus: state.toLowerCase(), previewUrl };
}

/**
 * Create a draft PR for a branch if one doesn't already exist.
 * Vercel's GitHub integration deploys on PRs, so this triggers the preview deployment.
 */
async function createDraftPrForBranch(repoFullName: string, branch: string): Promise<string | undefined> {
  const { token: ghToken } = await getGitHubOrgToken();
  const ghHeaders = { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github.v3+json" };

  // Check if a PR already exists for this branch
  const existingPrs = await axios.get<any>(
    `https://api.github.com/repos/${repoFullName}/pulls?head=${repoFullName.split('/')[0]}:${branch}&state=open`,
    { headers: ghHeaders }
  );
  if (existingPrs.data?.length > 0) {
    console.log(`[V0 SERVICE] Draft PR already exists for branch "${branch}": #${existingPrs.data[0].number}`);
    return existingPrs.data[0].html_url;
  }

  // Create a draft PR
  const prRes = await axios.post<any>(
    `https://api.github.com/repos/${repoFullName}/pulls`,
    {
      title: `Preview: ${branch}`,
      head: branch,
      base: "main",
      draft: true,
      body: "Auto-created draft PR to trigger Vercel preview deployment.",
    },
    { headers: ghHeaders }
  );
  console.log(`[V0 SERVICE] Created draft PR #${prRes.data.number} for branch "${branch}" to trigger Vercel preview`);
  return prRes.data.html_url;
}

/**
 * Trigger a Vercel deployment for a project on a given branch (defaults to "main").
 * Used after merging a draft branch to ensure Vercel picks up the changes.
 */
export async function triggerVercelDeployment(
  vercelProjectId: string,
  repoFullName: string,
  ref: string = "main"
): Promise<void> {
  const vercelToken = await getVercelToken();
  const headers = { Authorization: `Bearer ${vercelToken}`, "Content-Type": "application/json" };

  const { token: ghToken } = await getGitHubOrgToken();
  const repoInfoRes = await axios.get<any>(`https://api.github.com/repos/${repoFullName}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github.v3+json" },
  });
  const repoId = repoInfoRes.data.id;

  // Deployments created via the REST API default to the "preview" environment.
  // For the production branch (main) we must explicitly set target=production,
  // otherwise the production alias is never updated and the live site keeps
  // serving the previous deployment. This normally goes unnoticed because a
  // git PUSH to main fires Vercel's native git integration (which marks main
  // builds as production) — but a force-update of the main ref (used by
  // publish's 409 fallback and by revert-publish) often does NOT fire a fresh
  // push webhook, so this API deployment is the only one — and it must target
  // production itself.
  const body: Record<string, unknown> = {
    name: vercelProjectId,
    project: vercelProjectId,
    gitSource: { type: "github", repo: repoFullName, ref, repoId },
  };
  if (ref === "main") {
    body.target = "production";
  }

  await axios.post<any>(
    "https://api.vercel.com/v13/deployments",
    body,
    { headers }
  );
  console.log(`[V0 SERVICE] Triggered ${ref === "main" ? "production " : ""}deployment for ${repoFullName} on ${ref}`);
}

// ---------------------------------------------------------------------------
// Integrations — maps friendly field names to Vercel env var keys
// ---------------------------------------------------------------------------
export const INTEGRATIONS = {
  recaptcha: {
    siteKey: {
      envKey: "NEXT_PUBLIC_RECAPTCHA_SITE_KEY",
      type: "plain" as const,
      target: ["production", "preview", "development"] as string[],
    },
    secretKey: {
      envKey: "RECAPTCHA_SECRET_KEY",
      type: "encrypted" as const,
      target: ["production", "preview", "development"] as string[],
    },
  },
} as const;

export async function getProjectEnvVars(
  vercelProjectId: string
): Promise<Record<string, { ids: string[]; id: string; value: string; type: string }>> {
  const vercelToken = await getVercelToken();
  const headers = {
    Authorization: `Bearer ${vercelToken}`,
    "Content-Type": "application/json",
  };
  const res = await axios.get<any>(
    `https://api.vercel.com/v10/projects/${vercelProjectId}/env`,
    { headers, timeout: VERCEL_API_TIMEOUT_MS }
  );
  const envs: any[] = res.data?.envs ?? [];
  // Vercel can have multiple records per key (one per environment target).
  // Collect all IDs so we can delete them all before re-creating.
  const result: Record<string, { ids: string[]; id: string; value: string; type: string }> = {};
  for (const env of envs) {
    if (!env.key) continue;
    if (result[env.key]) {
      result[env.key].ids.push(env.id);
    } else {
      result[env.key] = { ids: [env.id], id: env.id, value: env.value ?? "", type: env.type ?? "plain" };
    }
  }
  return result;
}

export async function upsertEnvVar(
  vercelProjectId: string,
  key: string,
  value: string,
  target: string[],
  existingIds?: string[],
  type: "plain" | "encrypted" = "encrypted"
): Promise<string> {
  const vercelToken = await getVercelToken();
  const headers = {
    Authorization: `Bearer ${vercelToken}`,
    "Content-Type": "application/json",
  };
  // Delete all existing records for this key first (avoids per-environment split records).
  const idsToDelete = Array.isArray(existingIds) ? existingIds : existingIds ? [existingIds as string] : [];
  if (idsToDelete.length) {
    await Promise.all(
      idsToDelete.map((id) =>
        axios.delete(`https://api.vercel.com/v10/projects/${vercelProjectId}/env/${id}`, {
          headers,
          timeout: VERCEL_API_TIMEOUT_MS,
        }).catch(() => {})
      )
    );
  }
  const res = await axios.post<any>(
    `https://api.vercel.com/v10/projects/${vercelProjectId}/env`,
    { key, value, type, target },
    { headers, timeout: VERCEL_API_TIMEOUT_MS }
  );
  return res.data.id;
}

export async function deleteEnvVar(
  vercelProjectId: string,
  envId: string
): Promise<void> {
  const vercelToken = await getVercelToken();
  await axios.delete(
    `https://api.vercel.com/v10/projects/${vercelProjectId}/env/${envId}`,
    {
      headers: { Authorization: `Bearer ${vercelToken}` },
      timeout: VERCEL_API_TIMEOUT_MS,
    }
  );
}

/**
 * Refine a landing page with follow-up instructions via v0 chat.
 */
export async function iterateLandingPage(
  id: string,
  userId: string,
  message: string
): Promise<GeneratedLandingPage> {
  const record = await getLandingPage(id, userId);
  if (!record) {
    throw new Error("Landing page not found");
  }

  if (!record.v0ChatId) {
    // This record never got a v0 chat (generation failed upstream before chat creation).
    // It cannot be deployed/iterated; the recovery path is a fresh generate_landing_page
    // call, which recycles this record and archives any other stale failed records.
    throw new Error(
      "Landing page has no v0 chat — generation did not complete. Retry with generate_landing_page (the stale record is reused automatically)."
    );
  }

  const chatId = record.v0ChatId!;
  const deadline = Date.now() + V0_GENERATION_BUDGET_MS;

  try {
    const v0 = await getV0Client();

    // Where the chat stands BEFORE this edit. Everything below is anchored to it: it is both
    // the "don't hand me back the old version" guard and the "did my earlier send land?"
    // question. (ENG-287 follow-up)
    const baseVersionId = await waitForCompletedV0Version(
      v0,
      chatId,
      "v0 iterate (base version)",
      { deadline }
    );

    const messageHash = hashV0Prompt(message);
    const pending = record.pendingIteration;
    const isSameEdit = pending?.messageHash === messageHash;

    if (isSameEdit && pending!.baseVersionId !== baseVersionId) {
      // v0 has published a version SINCE we recorded the send — the edit already landed.
      // Adopt it. Re-sending here is the double-apply bug: the user would get their
      // instruction twice and be charged twice.
      console.log(`[V0 SERVICE] iterate: edit already applied (${pending!.baseVersionId} → ${baseVersionId}), adopting`);
      return await finishIteration(id, record, baseVersionId);
    }

    if (!isSameEdit) {
      // responseMode async: sync mode blocks the HTTP call for the whole edit, which is the
      // 300s race that made a slow iteration fail while v0 applied and CHARGED for it anyway
      // — leaving the edit stranded (the record stayed `deployed`, which deployLandingPage
      // refuses). Async returns in seconds; the version wait below absorbs the real time.
      // Safe now only because that wait is anchored to `afterVersionId` — without it, a deploy
      // could grab the PRE-iteration version and silently ship the page without the edit.
      await withRetry(
        () => v0.chats.sendMessage({ chatId, message, responseMode: "async" }),
        "v0 chat iterate",
        undefined, undefined, undefined,
        { retryOnTimeout: false }
      );

      // Record it the instant v0 accepts, BEFORE the wait — if the wait dies (timeout, crash,
      // lost response), the retry must know the message is already with v0.
      const nowIso = new Date().toISOString();
      await dynamodb
        .update({
          TableName: TABLE_NAME,
          Key: { id },
          UpdateExpression: "SET pendingIteration = :p, updatedAt = :now",
          ExpressionAttributeValues: {
            ":p": { baseVersionId, messageHash, startedAt: nowIso },
            ":now": nowIso,
          },
        })
        .promise();
    } else {
      console.log(`[V0 SERVICE] iterate: message already sent and still generating — resuming the wait, not re-sending`);
    }

    // Do not return until v0 publishes a version that is NOT the one we started from. This is
    // what makes the async send safe: the deploy that follows reads the latest completed
    // version, so returning early would ship the pre-iteration page.
    const newVersionId = await waitForCompletedV0Version(
      v0,
      chatId,
      "v0 iterate",
      { deadline, afterVersionId: pending && isSameEdit ? pending.baseVersionId : baseVersionId }
    );

    return await finishIteration(id, record, newVersionId);
  } catch (error: any) {
    console.error("[V0 SERVICE] Iteration failed:", error);
    // Deliberately NOT flipping the record to `failed`: the page is still live at its URL, and
    // `pendingIteration` is deliberately LEFT in place so the retry resumes instead of
    // re-sending. The status is untouched for the same reason.
    const wrapped: any = new Error(`Iteration failed: ${error.message}`);
    if (error?.code) wrapped.code = error.code;
    wrapped.cause = error;
    throw wrapped;
  }
}

/** Land a completed iteration: clear the pending marker, count it, make it deployable. */
async function finishIteration(
  id: string,
  record: GeneratedLandingPage,
  versionId: string
): Promise<GeneratedLandingPage> {
  // `draft` == "has an undeployed version ready", which is now exactly true. It is also what
  // makes the edit reachable: deployLandingPage accepts `draft` and refuses `deployed`, which
  // is precisely how a timed-out iteration used to get stranded inside v0.
  const newStatus = record.status === "deployed" ? "draft" : record.status;
  const iterations = (record.iterations || 0) + 1;
  const nowIso = new Date().toISOString();

  await dynamodb
    .update({
      TableName: TABLE_NAME,
      Key: { id },
      UpdateExpression:
        "SET #status = :status, iterations = :iterations, updatedAt = :updatedAt REMOVE pendingIteration",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": newStatus,
        ":iterations": iterations,
        ":updatedAt": nowIso,
      },
    })
    .promise();

  console.log(`[V0 SERVICE] iterate: version ${versionId} ready — page is deployable`);
  return { ...record, status: newStatus, iterations, updatedAt: nowIso, pendingIteration: undefined };
}

/**
 * Get a single landing page by ID (scoped to user). Excludes archived unless requested.
 */
export async function getLandingPage(
  id: string,
  userId: string,
  includeArchived = false
): Promise<GeneratedLandingPage | null> {
  const result = await dynamodb
    .get({
      TableName: TABLE_NAME,
      Key: { id },
    })
    .promise();

  const item = result.Item as GeneratedLandingPage | undefined;
  if (!item || item.userId !== userId) {
    return null;
  }
  if (item.archived && !includeArchived) {
    return null;
  }

  return item;
}

/**
 * Resolve the vercelProjectId for a page that is missing it by looking up
 * sibling pages (same user, same githubRepoUrl) that have the field set.
 * If found, backfills the value on the page record so future lookups are fast.
 */
export async function resolveVercelProjectId(
  page: GeneratedLandingPage
): Promise<string | null> {
  if (page.vercelProjectId) return page.vercelProjectId;
  if (!page.githubRepoUrl) return null;

  const siblings = await paginatedQuery<GeneratedLandingPage>(dynamodb, {
    TableName: TABLE_NAME,
    IndexName: "UserIdIndex",
    KeyConditionExpression: "userId = :userId",
    ExpressionAttributeValues: { ":userId": page.userId },
  });

  const donor = siblings.find(
    (s) => s.githubRepoUrl === page.githubRepoUrl && !!s.vercelProjectId
  );
  if (!donor?.vercelProjectId) return null;

  // Backfill so this page won't need resolution again
  await dynamodb
    .update({
      TableName: TABLE_NAME,
      Key: { id: page.id },
      UpdateExpression: "SET vercelProjectId = :vpid, updatedAt = :now",
      ExpressionAttributeValues: {
        ":vpid": donor.vercelProjectId,
        ":now": new Date().toISOString(),
      },
    })
    .promise();
  console.log(
    `[V0 SERVICE] Backfilled vercelProjectId ${donor.vercelProjectId} on page ${page.id} from sibling ${donor.id}`
  );

  return donor.vercelProjectId;
}

/**
 * List all generated landing pages for a user (excludes archived).
 */
export async function listLandingPages(
  userId: string
): Promise<GeneratedLandingPage[]> {
  return await paginatedQuery<GeneratedLandingPage>(dynamodb, {
    TableName: TABLE_NAME,
    IndexName: "UserIdIndex",
    KeyConditionExpression: "userId = :userId",
    FilterExpression: "attribute_not_exists(archived) OR archived = :archivedFalse",
    ExpressionAttributeValues: {
      ":userId": userId,
      ":archivedFalse": false,
    },
    ScanIndexForward: false, // newest first
  });
}

/**
 * Find the user's landing site (GitHub repo + Vercel project).
 * Searches ALL records including archived — the site survives page deletion.
 * Also auto-marks the site record as isRootPage if not already set.
 */
export async function findUserSiteRecord(userId: string): Promise<GeneratedLandingPage | null> {
  const pages = await paginatedQuery<GeneratedLandingPage>(dynamodb, {
    TableName: TABLE_NAME,
    IndexName: "UserIdIndex",
    KeyConditionExpression: "userId = :userId",
    FilterExpression: "attribute_not_exists(archived) OR archived = :archivedFalse",
    ExpressionAttributeValues: { ":userId": userId, ":archivedFalse": false },
  });

  // Prefer: 1) explicit root page, 2) page with v0ChatId (original v0 page), 3) any with githubRepoUrl
  let siteRecord =
    pages.find((p) => p.isRootPage && p.githubRepoUrl) ||
    pages.find((p) => p.v0ChatId && p.githubRepoUrl) ||
    pages.find((p) => !!p.githubRepoUrl);

  if (siteRecord) {
    // ENG-478: the query above reads via a GSI (UserIdIndex), which DynamoDB can only
    // ever serve eventually consistent — ConsistentRead is not supported on GSI
    // queries at all. So instead of trying to strengthen that read, verify the ONE
    // candidate it picked with a strongly-consistent GetItem on the base table's
    // primary key (id). This closes the race where a concurrent delete
    // (deleteLandingPageByRecord sets archived:true on this exact id) lands in the
    // window between the GSI read and this function returning its result — e.g. a
    // fast double-click or a second tab generating a page right after a delete,
    // which would otherwise attach the new page to a site whose GitHub route tree
    // is being/has been torn down.
    const fresh = await dynamodb
      .get({ TableName: TABLE_NAME, Key: { id: siteRecord.id }, ConsistentRead: true })
      .promise();
    if (!fresh.Item || fresh.Item.archived || fresh.Item.userId !== userId) {
      // Archived, hard-deleted, or (defensively) no longer owned by this caller
      // since the GSI read — do not fall back to another candidate in `pages`,
      // every item in it came from the same single, equally stale read. Returning
      // null is safe: the caller treats "no site" as "create a fresh one", the
      // right outcome instead of attaching to a dying repo or someone else's site.
      return null;
    }
    siteRecord = fresh.Item as GeneratedLandingPage;
  }

  if (siteRecord && !siteRecord.isRootPage) {
    // Backfill: mark this as the root page
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id: siteRecord.id },
        UpdateExpression: "SET isRootPage = :val",
        ExpressionAttributeValues: { ":val": true },
      })
      .promise();
    siteRecord.isRootPage = true;
  }

  return siteRecord || null;
}

/**
 * Resolve the landing-page site for a caller, accounting for org membership.
 * Returns the caller's own site if present; otherwise searches org members for
 * a site the caller has edit access to.
 */
export async function resolveSiteForCaller(
  callerUserId: string,
): Promise<GeneratedLandingPage | null> {
  // Call via module exports so jest.spyOn can intercept in tests.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const self: typeof import("./v0Service") = require("./v0Service");
  const own = await self.findUserSiteRecord(callerUserId);
  if (own) return own;

  const user = await userDb.getUserById(callerUserId);
  if (!user?.orgId) return null;

  const [members, org] = await Promise.all([
    orgDb.getOrgMembers(user.orgId),
    orgDb.getOrgById(user.orgId),
  ]);
  for (const m of members) {
    if (m.userId === callerUserId) continue;
    const site = await self.findUserSiteRecord(m.userId);
    if (!site) continue;
    const allowed = canEditItem(
      { userId: site.userId },
      { userId: callerUserId, orgId: user.orgId, orgRole: user.orgRole as any },
      org,
      user.orgId,
      "landingPages",
    );
    if (allowed) return site;
  }
  return null;
}

/**
 * Whether `callerUserId` may EDIT `page`, accounting for org sharing.
 *
 * Single source of truth for the edit decision, shared by the route layer
 * (authorizeLandingPageAccess), the list/get endpoints (to surface an
 * `editable` flag), and the coding agent (to fail fast before spinning up the
 * LLM loop). Mirrors canEditItem: the page owner always passes; otherwise the
 * caller must be in the page owner's org AND be an org owner or a listed
 * landingPages editor. Visibility (canViewItem) is deliberately broader — a
 * plain member can VIEW a shared page but not edit it, which is exactly the
 * gap this helper lets callers report up front.
 *
 * Best-effort and non-throwing: any lookup failure resolves to `false` (deny)
 * so a transient DB error can't accidentally grant edit access.
 */
export async function canUserEditLandingPage(
  page: Pick<GeneratedLandingPage, "userId">,
  callerUserId: string,
): Promise<boolean> {
  try {
    if (page.userId === callerUserId) return true;
    const [user, pageOwner] = await Promise.all([
      userDb.getUserById(callerUserId),
      userDb.getUserById(page.userId),
    ]);
    const ownerOrgId = pageOwner?.orgId;
    const org =
      user?.orgId && user.orgId === ownerOrgId
        ? await orgDb.getOrgById(user.orgId)
        : null;
    return canEditItem(
      { userId: page.userId },
      {
        userId: callerUserId,
        orgId: user?.orgId,
        orgRole: user?.orgRole as "owner" | "member" | undefined,
      },
      org,
      ownerOrgId,
      "landingPages",
    );
  } catch (e) {
    console.warn("[LP] canUserEditLandingPage check failed; denying edit:", e);
    return false;
  }
}

/**
 * Remove a page route file from the GitHub repo.
 */
async function listRepoTree(
  repoFullName: string,
  ghHeaders: Record<string, string>
): Promise<string[]> {
  const res = await axios.get<any>(
    `https://api.github.com/repos/${repoFullName}/git/trees/main?recursive=1`,
    { headers: ghHeaders, timeout: GITHUB_API_TIMEOUT_MS }
  );
  return (res.data?.tree ?? [])
    .filter((e: any) => e.type === "blob")
    .map((e: any) => e.path as string);
}

/**
 * Remove a page's ENTIRE directory (app/<slug>/**) from the repo.
 *
 * This used to delete exactly one file — app/<slug>/page.tsx — and leave
 * app/<slug>/_components/** behind. `next build` type-checks the whole project, so an
 * orphaned component with an unresolvable import still fails the build for EVERY page on
 * the site: "delete the broken page" did not actually unbreak the site.
 */
/**
 * Returns whether any files were actually found and removed under app/<slug>/. `false`
 * means the tree had nothing matching that prefix — the caller decides whether that's
 * worth surfacing (e.g. record.slug diverging from the route actually committed would
 * silently no-op here with no other signal that cleanup did not happen).
 */
async function removePageFromGitHub(githubRepoUrl: string, slug: string): Promise<boolean> {
  const match = githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) return false;
  const [, owner, repo] = match;
  const repoFullName = `${owner}/${repo.replace(".git", "")}`;

  const { token: ghToken } = await getGitHubOrgToken();
  const ghHeaders = {
    Authorization: `Bearer ${ghToken}`,
    Accept: "application/vnd.github.v3+json",
  };

  const prefix = `app/${slug}/`;
  const toDelete = (await listRepoTree(repoFullName, ghHeaders)).filter((p) => p.startsWith(prefix));

  if (toDelete.length === 0) {
    console.log(`[GITHUB] Nothing to remove for /${slug} in ${repoFullName}`);
    return false; // never push an empty commit — it would trigger a pointless rebuild
  }

  await commitFilesToRepoMain(
    repoFullName,
    ghHeaders,
    toDelete.map((path) => ({ path, deleted: true })),
    `Remove page /${slug}`
  );

  console.log(`[GITHUB] Removed ${toDelete.length} file(s) under ${prefix} from ${repoFullName}`);
  return true;
}

/**
 * Delete a landing page. All pages are deletable (including the root).
 * Pages are soft-deleted (archived) and their route file is removed from GitHub.
 *
 * NOTE: not currently called anywhere — the DELETE route uses the sibling
 * `deleteLandingPageByRecord` instead (see that function's own docstring). Kept in sync with
 * it (including the `githubCleanupWarning` signal) so it isn't a silent trap if ever wired up.
 */
export async function deleteLandingPage(
  id: string,
  userId: string
): Promise<{ githubCleanupWarning?: string }> {
  const record = await getLandingPage(id, userId);
  if (!record) {
    throw new Error("Landing page not found");
  }

  // Remove route file from GitHub
  let githubCleanupWarning: string | undefined;
  if (record.githubRepoUrl && record.slug) {
    try {
      const removed = await removePageFromGitHub(record.githubRepoUrl, record.slug);
      if (!removed) {
        githubCleanupWarning =
          "No GitHub files were found matching this page's route — the repo may already be " +
          "clean, or cleanup could not locate them.";
      }
    } catch (err: any) {
      console.error("[V0 SERVICE] Failed to remove route from GitHub:", err.message);
      githubCleanupWarning =
        "GitHub cleanup failed; this page's files may still exist in the repo.";
      // Continue with soft-delete even if GitHub cleanup fails
    }
  }

  // Soft-delete (archive)
  await dynamodb
    .update({
      TableName: TABLE_NAME,
      Key: { id },
      UpdateExpression: "SET archived = :archived, archivedAt = :archivedAt, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":archived": true,
        ":archivedAt": new Date().toISOString(),
        ":updatedAt": new Date().toISOString(),
      },
    })
    .promise();

  // Free the idempotency identity so regenerating this slug creates a NEW page
  // instead of reusing the archived page's chat forever. Best-effort — the delete
  // above already succeeded and must not be un-done by a cleanup failure.
  await clearV0UsageForPage({
    userId,
    pageId: id,
    siteId: record.siteId,
    // Only a REAL slug. A root page has none, and deriving one from its name could match a
    // genuine sub-page route on the same site and free the wrong identity — that sub-page
    // would then pay for a fresh chat on its next build. (ENG-287 residual)
    slug: record.slug,
  });

  return { githubCleanupWarning };
}

export async function updateLandingPageGtm(
  id: string,
  userId: string,
  gtmContainerId: string
): Promise<void> {
  const record = await getLandingPage(id, userId);
  if (!record) throw new Error("Landing page not found");

  if (gtmContainerId) {
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: "SET gtmContainerId = :gtm, updatedAt = :now",
        ExpressionAttributeValues: {
          ":gtm": gtmContainerId,
          ":now": new Date().toISOString(),
        },
      })
      .promise();
  } else {
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: "REMOVE gtmContainerId SET updatedAt = :now",
        ExpressionAttributeValues: { ":now": new Date().toISOString() },
      })
      .promise();
  }
}

/**
 * Update the `trackingInstalled` signal on a single page record. Split out from
 * `updateLandingPageGtm` because a GTM change at the site level (saveGtmForPage) affects
 * EVERY page sharing that site's root layout, not just the one record `gtmContainerId` was
 * written to — callers loop this across siblings rather than calling it once per-page.
 */
export async function updateLandingPageTrackingInstalled(
  id: string,
  trackingInstalled: boolean,
): Promise<void> {
  await dynamodb
    .update({
      TableName: TABLE_NAME,
      Key: { id },
      UpdateExpression: "SET trackingInstalled = :t, updatedAt = :now",
      ExpressionAttributeValues: {
        ":t": trackingInstalled,
        ":now": new Date().toISOString(),
      },
    })
    .promise();
}

/**
 * Mirrors updateLandingPageGtm for the Meta pixel manual-override path.
 */
export async function updateLandingPageMetaPixel(
  id: string,
  userId: string,
  pixelId: string,
  accountId?: string,
): Promise<void> {
  const record = await getLandingPage(id, userId);
  if (!record) throw new Error("Landing page not found");

  if (pixelId) {
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: "SET metaPixelId = :px, metaAdAccountId = :acc, updatedAt = :now",
        ExpressionAttributeValues: {
          ":px": pixelId,
          ":acc": accountId,
          ":now": new Date().toISOString(),
        },
      })
      .promise();
  } else {
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: "REMOVE metaPixelId, metaAdAccountId SET updatedAt = :now",
        ExpressionAttributeValues: { ":now": new Date().toISOString() },
      })
      .promise();
  }
}

/**
 * ENG-449 gap #3: persists the result of the post-deploy Playwright smoke test
 * (runGenerationSmokeTest, landingPageSmokeTest.ts). Fire-and-forget by design — never
 * throws, only warns, since a failed WRITE of the result must not itself become a new
 * unhandled rejection in a background task nobody is awaiting.
 */
export async function updateLandingPageSmokeTestResult(
  id: string,
  result: NonNullable<GeneratedLandingPage["smokeTestResult"]>
): Promise<void> {
  try {
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: "SET smokeTestResult = :result, updatedAt = :now",
        ExpressionAttributeValues: {
          ":result": result,
          ":now": new Date().toISOString(),
        },
      })
      .promise();
  } catch (error: any) {
    console.warn(`[V0 SERVICE] Could not persist smoke test result for page ${id}: ${error?.message}`);
  }
}

/**
 * Mirrors updateLandingPageTrackingInstalled for the Meta pixel signal. Split out
 * the same way, for the same reason: a site-level pixel change affects every page sharing
 * the root layout, not just the record `metaPixelId` was written to.
 */
export async function updateLandingPageMetaTrackingInstalled(
  id: string,
  metaTrackingInstalled: boolean,
): Promise<void> {
  await dynamodb
    .update({
      TableName: TABLE_NAME,
      Key: { id },
      UpdateExpression: "SET metaTrackingInstalled = :t, updatedAt = :now",
      ExpressionAttributeValues: {
        ":t": metaTrackingInstalled,
        ":now": new Date().toISOString(),
      },
    })
    .promise();
}

/**
 * Persist the state needed to revert the most recent publish. Overwrites any
 * prior `lastPublish` — only the latest publish is revertable (single-step).
 */
export async function recordLandingPagePublish(
  id: string,
  publishRecord: LandingPagePublishRecord
): Promise<void> {
  await dynamodb
    .update({
      TableName: TABLE_NAME,
      Key: { id },
      UpdateExpression: "SET lastPublish = :lp, updatedAt = :now",
      ExpressionAttributeValues: {
        ":lp": publishRecord,
        ":now": new Date().toISOString(),
      },
    })
    .promise();
}

/**
 * Mark the recorded publish as reverted so it cannot be reverted twice.
 */
export async function markLandingPagePublishReverted(
  id: string,
  revertedAt: string
): Promise<void> {
  await dynamodb
    .update({
      TableName: TABLE_NAME,
      Key: { id },
      UpdateExpression: "SET lastPublish.revertedAt = :ra, updatedAt = :now",
      ExpressionAttributeValues: {
        ":ra": revertedAt,
        ":now": new Date().toISOString(),
      },
    })
    .promise();
}

export async function updateLandingPageContext(
  id: string,
  userId: string,
  context: string
): Promise<void> {
  const record = await getLandingPage(id, userId);
  if (!record) throw new Error("Landing page not found");

  await dynamodb
    .update({
      TableName: TABLE_NAME,
      Key: { id },
      UpdateExpression: "SET #ctx = :ctx, updatedAt = :now",
      ExpressionAttributeNames: { "#ctx": "context" },
      ExpressionAttributeValues: {
        ":ctx": context,
        ":now": new Date().toISOString(),
      },
    })
    .promise();
}

export async function updateLandingPageLeadList(
  pageId: string,
  ownerUserId: string,
  leadListId: string | null,
): Promise<void> {
  const params: any = {
    TableName: TABLE_NAME,
    Key: { id: pageId },
    ConditionExpression: "userId = :ownerId",
    ExpressionAttributeValues: {
      ":ownerId": ownerUserId,
      ":updatedAt": new Date().toISOString(),
    },
  };
  if (leadListId === null) {
    params.UpdateExpression = "REMOVE leadListId SET updatedAt = :updatedAt";
  } else {
    params.UpdateExpression = "SET leadListId = :leadListId, updatedAt = :updatedAt";
    params.ExpressionAttributeValues[":leadListId"] = leadListId;
  }
  await dynamodb.update(params).promise();
}

/**
 * Get all (non-archived) landing pages for a specific owner.
 * Uses UserIdIndex GSI on AW-LandingPages.
 */
export async function getLandingPagesByOwner(userId: string): Promise<GeneratedLandingPage[]> {
  return await paginatedQuery<GeneratedLandingPage>(dynamodb, {
    TableName: TABLE_NAME,
    IndexName: "UserIdIndex",
    KeyConditionExpression: "userId = :u",
    FilterExpression: "attribute_not_exists(archived) OR archived = :archivedFalse",
    ExpressionAttributeValues: {
      ":u": userId,
      ":archivedFalse": false,
    },
    ScanIndexForward: false,
  });
}

/**
 * Get all landing pages visible to org members (fanout).
 * Returns pages owned by all other org members (caller excluded).
 */
export async function getLandingPagesByOrg(orgId: string, callerUserId: string): Promise<GeneratedLandingPage[]> {
  const members = await orgDb.getOrgMembers(orgId);
  const others = members.map((m) => m.userId).filter((uid) => uid !== callerUserId);
  const perMember = await Promise.all(others.map((uid) => getLandingPagesByOwner(uid)));
  return perMember.flat();
}

/**
 * Get a landing page by ID without scoping to a specific user (for org-share permission checks).
 */
export async function getLandingPageById(id: string): Promise<GeneratedLandingPage | null> {
  const result = await dynamodb
    .get({
      TableName: TABLE_NAME,
      Key: { id },
    })
    .promise();
  const item = result.Item as GeneratedLandingPage | undefined;
  if (!item || item.archived) return null;
  return item;
}

/**
 * Transfer ownership of a landing page to a new user (used when removing a member from an org).
 */
export async function transferLandingPageOwner(id: string, newOwnerId: string): Promise<void> {
  await dynamodb
    .update({
      TableName: TABLE_NAME,
      Key: { id },
      UpdateExpression: "SET userId = :newOwner, updatedAt = :now",
      ExpressionAttributeValues: {
        ":newOwner": newOwnerId,
        ":now": new Date().toISOString(),
      },
    })
    .promise();
}

/**
 * Delete a landing page given an already-fetched record (for org-share flows where
 * the caller may not be the owner). All pages are deletable.
 *
 * `githubCleanupWarning`, when present, means the DB record was archived successfully but
 * the GitHub side either failed outright or found nothing matching `record.slug` to remove
 * (e.g. the stored slug diverging from the route actually committed — see ENG-375). Either
 * way the delete itself must never fail because of this; it's surfaced so a real occurrence
 * is visible instead of silently logged where no one reads it.
 */
export async function deleteLandingPageByRecord(
  record: GeneratedLandingPage,
): Promise<{ githubCleanupWarning?: string }> {
  let githubCleanupWarning: string | undefined;
  if (record.githubRepoUrl && record.slug) {
    try {
      const removed = await removePageFromGitHub(record.githubRepoUrl, record.slug);
      if (!removed) {
        githubCleanupWarning =
          "No GitHub files were found matching this page's route — the repo may already be " +
          "clean, or cleanup could not locate them.";
      }
    } catch (err: any) {
      console.error("[V0 SERVICE] Failed to remove route from GitHub:", err.message);
      githubCleanupWarning =
        "GitHub cleanup failed; this page's files may still exist in the repo.";
    }
  }

  await dynamodb
    .update({
      TableName: TABLE_NAME,
      Key: { id: record.id },
      UpdateExpression: "SET archived = :archived, archivedAt = :archivedAt, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":archived": true,
        ":archivedAt": new Date().toISOString(),
        ":updatedAt": new Date().toISOString(),
      },
    })
    .promise();

  // Free the v0 usage identity. This is the function the DELETE route actually calls —
  // `deleteLandingPage` (which did clear it) is imported by that route and never used, so
  // in practice no user-initiated delete ever freed the identity. Because the fix removed
  // the prompt from the idempotency key, a `succeeded` row silently HIJACKS the next
  // generation of the same route: the user deletes a page, regenerates the same slug with a
  // brand-new prompt, and gets the OLD chat back — their prompt is never sent to v0.
  //
  // NOT for an in-flight build. Deleting the identity of a live build lets the next request
  // for that slug mint a SECOND chat while the first is still running — two builds racing
  // commits into the same app/<slug>/ in the same repo. The archived record is invisible to
  // findReusablePageForRoute, so the guard row is the only thing still deduping them. Such a
  // row is not immortal anyway: the reuse ceiling reclaims it.
  //
  // Best-effort: the archive above already succeeded and must not be undone by a cleanup
  // failure. Pass the slug only when there is a real one — a root page has none, and
  // deriving one from its name would free a SUB-page's identity that merely shares the slug.
  // (ENG-287 residual)
  const inFlight = record.status === "generating" || record.status === "deploying";
  if (!inFlight) {
    await clearV0UsageForPage({
      userId: record.userId,
      pageId: record.id,
      siteId: record.siteId,
      slug: record.slug,
    });
  }

  return { githubCleanupWarning };
}

/**
 * ENG-308: this used to be a routing-ONLY middleware, and `updateSubdomainMiddleware`
 * committed it straight over the generated `middleware.ts` on every domain attach or
 * detach — silently destroying the lead-capture middleware, and with it all
 * attribution for that page, until the page was regenerated.
 *
 * It is now the same canonical middleware generation emits: subdomain rewrite AND
 * first-touch capture. A test asserts the two are byte-identical.
 */
export const MIDDLEWARE_CONTENT = buildLandingPageMiddleware();

/**
 * Commit updated domainMap.ts and middleware.ts to the GitHub repo.
 * Called whenever a per-page subdomain prefix is added or removed.
 * Triggers a Vercel redeploy via the GitHub → Vercel webhook.
 *
 * @param repoFullName - e.g. "AgentWebPro/lp-product-abc12345"
 * @param domainMap - mapping of hostname → Next.js pathname, e.g. { "pricing.mysite.com": "/pricing" }
 */
export async function updateSubdomainMiddleware(
  repoFullName: string,
  domainMap: Record<string, string>
): Promise<void> {
  const { token: ghToken } = await getGitHubOrgToken();
  const ghHeaders = {
    Authorization: `Bearer ${ghToken}`,
    Accept: "application/vnd.github.v3+json",
  };

  const domainMapContent = buildDomainMapFile(domainMap);

  const refRes = await axios.get<any>(
    `https://api.github.com/repos/${repoFullName}/git/ref/heads/main`,
    { headers: ghHeaders, timeout: GITHUB_API_TIMEOUT_MS }
  );
  const latestCommitSha = refRes.data.object.sha;

  const [domainMapBlob, middlewareBlob] = await Promise.all([
    axios.post<any>(
      `https://api.github.com/repos/${repoFullName}/git/blobs`,
      { content: Buffer.from(domainMapContent).toString("base64"), encoding: "base64" },
      { headers: ghHeaders, timeout: GITHUB_API_TIMEOUT_MS }
    ),
    axios.post<any>(
      `https://api.github.com/repos/${repoFullName}/git/blobs`,
      { content: Buffer.from(MIDDLEWARE_CONTENT).toString("base64"), encoding: "base64" },
      { headers: ghHeaders, timeout: GITHUB_API_TIMEOUT_MS }
    ),
  ]);

  const treeRes = await axios.post<any>(
    `https://api.github.com/repos/${repoFullName}/git/trees`,
    {
      base_tree: latestCommitSha,
      tree: [
        { path: "domainMap.ts", mode: "100644", type: "blob", sha: domainMapBlob.data.sha },
        { path: "middleware.ts", mode: "100644", type: "blob", sha: middlewareBlob.data.sha },
      ],
    },
    { headers: ghHeaders, timeout: GITHUB_API_TIMEOUT_MS }
  );

  const commitRes = await axios.post<any>(
    `https://api.github.com/repos/${repoFullName}/git/commits`,
    {
      message: "chore: update subdomain routing map",
      tree: treeRes.data.sha,
      parents: [latestCommitSha],
    },
    { headers: ghHeaders, timeout: GITHUB_API_TIMEOUT_MS }
  );

  await axios.patch<any>(
    `https://api.github.com/repos/${repoFullName}/git/refs/heads/main`,
    { sha: commitRes.data.sha },
    { headers: ghHeaders, timeout: GITHUB_API_TIMEOUT_MS }
  );
}

/**
 * Read a file from a repo's `main`, or `null` if it does not exist.
 * Any status other than 404 is a real failure and is rethrown.
 */
async function readRepoFile(
  repoFullName: string,
  path: string,
  ghHeaders: Record<string, string>
): Promise<string | null> {
  try {
    const res = await axios.get<any>(
      `https://api.github.com/repos/${repoFullName}/contents/${path}?ref=main`,
      { headers: ghHeaders, timeout: GITHUB_API_TIMEOUT_MS }
    );
    const data = res.data;
    if (!data || typeof data.content !== "string") return null;
    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch (err: any) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}

/**
 * Backfill middleware.ts + lib/agentweb-track.ts into an EXISTING repo (ENG-501). Deliberately
 * NARROWER than syncLeadCaptureFilesToRepo below: this function NEVER reads or writes
 * app/api/capture/route.ts, and therefore cannot touch a repo's real lead-routing data
 * (LIST_BY_PATH) at all — by construction, not by care taken at each call site. Built
 * specifically for a one-time bulk backfill across every existing customer repo (ENG-504),
 * where the ONLY thing that needs fixing is middleware.ts's aw_page cookie-clobber bug (and,
 * incidentally, the ENG-449 tracking-helper backfill) — rewriting the capture route there
 * would be pure unrelated risk to real customer lead data for zero benefit.
 *
 * Same idempotence/anti-clobber contract as syncLeadCaptureFilesToRepo: no commit if nothing
 * differs; domainMap.ts is only written when absent (never overwrites a real subdomain map);
 * never throws (returns a result the caller decides how to surface).
 */
export async function syncMiddlewareAndTrackingHelper(
  repoFullName: string,
): Promise<{ committed: boolean; reason?: string; pushedCommitSha?: string; pushTimestampMs?: number }> {
  try {
    const { token: ghToken } = await getGitHubOrgToken();
    const ghHeaders = {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github.v3+json",
    };

    const middlewareContent = buildLandingPageMiddleware();
    const trackingHelperContent = buildTrackingHelper();

    const [existingMiddleware, existingTrackingHelper, existingDomainMap] = await Promise.all([
      readRepoFile(repoFullName, "middleware.ts", ghHeaders),
      readRepoFile(repoFullName, "lib/agentweb-track.ts", ghHeaders),
      readRepoFile(repoFullName, "domainMap.ts", ghHeaders),
    ]);

    const needsDomainMap = existingDomainMap === null;

    if (!needsDomainMap && existingMiddleware === middlewareContent && existingTrackingHelper === trackingHelperContent) {
      console.log(`[V0 SERVICE] middleware/tracking-helper already up to date in ${repoFullName} — skipping commit`);
      return { committed: false, reason: "up-to-date" };
    }

    const filesToCommit: Array<{ path: string; content: string }> = [];
    if (existingMiddleware !== middlewareContent) {
      filesToCommit.push({ path: "middleware.ts", content: middlewareContent });
    }
    if (existingTrackingHelper !== trackingHelperContent) {
      filesToCommit.push({ path: "lib/agentweb-track.ts", content: trackingHelperContent });
    }
    if (needsDomainMap) {
      filesToCommit.push({ path: "domainMap.ts", content: buildDomainMapFile({}) });
    }

    const { pushedCommitSha, pushTimestampMs } = await commitFilesToRepoMain(
      repoFullName,
      ghHeaders,
      filesToCommit.map((file) => ({ path: file.path, content: Buffer.from(file.content) })),
      "chore: backfill middleware/tracking-helper fix (ENG-501)",
      1,
    );

    console.log(`[V0 SERVICE] Synced middleware/tracking-helper to ${repoFullName} (${filesToCommit.map((f) => f.path).join(", ")})`);
    return { committed: true, pushedCommitSha, pushTimestampMs };
  } catch (err: any) {
    const reason = err?.response?.data?.message || err?.message || String(err);
    console.error(`[V0 SERVICE] FAILED to sync middleware/tracking-helper to ${repoFullName}: ${reason}`);
    return { committed: false, reason };
  }
}

/**
 * Push the lead-capture files into an EXISTING landing-page repo. ENG-310.
 *
 * Generation injects `middleware.ts` / `domainMap.ts` / `app/api/capture/route.ts` into
 * every new site, but attaching a lead list to an ALREADY-GENERATED page used to write
 * DynamoDB and nothing else: the repo was never touched, so a deployed site whose pages
 * all carried a `leadListId` still 404'd on `/api/capture`. The record claimed a lead
 * list that meant nothing. This is the missing half — same blob → tree → commit → ref
 * push as {@link updateSubdomainMiddleware}, and the push is what makes Vercel redeploy.
 *
 * Two things it is careful about, both of which cost a customer real money if got wrong:
 *
 *  - It does NOT touch `domainMap.ts` when the repo already has one. That file holds the
 *    live host → path map for any subdomain the customer has attached; overwriting it
 *    with `{}` would break their routing — ENG-308's bug with the roles reversed. It is
 *    only written (empty) when ABSENT, because the middleware imports it and the Vercel
 *    build fails outright without it.
 *
 *  - It is idempotent. If the repo already has byte-for-byte what we would write, it
 *    makes no commit at all: a pointless commit is a pointless redeploy of a live site.
 *
 * It never throws. The caller has already committed the DynamoDB write by the time this
 * runs, and a GitHub hiccup must not unwind that — the result says what happened and the
 * caller decides how to surface it.
 *
 * @param repoFullName e.g. "AgentWebPro/lp-product-abc12345"
 * @param listByPath page path -> lead list id, for EVERY page of the site (the capture
 *   route is repo-level while the lead list is per-page). May be empty.
 */
export async function syncLeadCaptureFilesToRepo(
  repoFullName: string,
  /**
   * ENG-485: a callback, not a static value — called FRESH on every retry attempt, not once
   * upfront. `commitFilesToRepoMain`'s own retry re-reads the git ref to rebase the COMMIT
   * onto, but reuses the same precomputed file content across every attempt; that's correct
   * for a page's own STATIC files (they never change based on what's on `main`), but wrong
   * here, where the correct content depends on who else just committed. A losing writer's
   * retry used to recommit a stale LIST_BY_PATH snapshot on top of a winning writer's newer
   * commit, silently erasing whichever page's entry the winner had just added.
   */
  buildListByPath: () => Record<string, string> | Promise<Record<string, string>>,
  /** Threaded through to buildCaptureRoute — see its own doc comment. */
  pixelId?: string,
  metaAccountId?: string,
): Promise<{ committed: boolean; reason?: string; pushedCommitSha?: string; pushTimestampMs?: number }> {
  const MAX_ATTEMPTS = 2;
  let lastErr: any;

  try {
    const { token: ghToken } = await getGitHubOrgToken();
    const ghHeaders = {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github.v3+json",
    };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Fresh every attempt — see the buildListByPath doc comment above for why.
      const listByPath = await buildListByPath();
      const middlewareContent = buildLandingPageMiddleware();
      const captureRouteContent = buildCaptureRoute(listByPath, undefined, pixelId, metaAccountId);
      const trackingHelperContent = buildTrackingHelper();

      const [existingMiddleware, existingCaptureRoute, existingDomainMap, existingTrackingHelper] = await Promise.all([
        readRepoFile(repoFullName, "middleware.ts", ghHeaders),
        readRepoFile(repoFullName, "app/api/capture/route.ts", ghHeaders),
        readRepoFile(repoFullName, "domainMap.ts", ghHeaders),
        readRepoFile(repoFullName, "lib/agentweb-track.ts", ghHeaders),
      ]);

      // Only write domainMap.ts if the repo has none. If it exists it may carry a real
      // subdomain map — clobbering it with {} would break the customer's routing.
      const needsDomainMap = existingDomainMap === null;

      if (
        !needsDomainMap &&
        existingMiddleware === middlewareContent &&
        existingCaptureRoute === captureRouteContent &&
        existingTrackingHelper === trackingHelperContent
      ) {
        console.log(
          `[V0 SERVICE] Lead-capture files already up to date in ${repoFullName} — skipping commit (no redeploy)`
        );
        return { committed: false, reason: "up-to-date" };
      }

      const filesToCommit: Array<{ path: string; content: string }> = [
        { path: "middleware.ts", content: middlewareContent },
        { path: "app/api/capture/route.ts", content: captureRouteContent },
        { path: "lib/agentweb-track.ts", content: trackingHelperContent },
      ];
      if (needsDomainMap) {
        // Pre-ENG-308 repo: the middleware imports ./domainMap, so it MUST exist or the
        // Vercel build fails. Empty is correct here — no subdomain has ever been attached.
        filesToCommit.push({ path: "domainMap.ts", content: buildDomainMapFile({}) });
      }

      try {
        // ONE internal attempt per OUR loop iteration — WE regenerate fresh content on
        // retry now, so commitFilesToRepoMain's own multi-attempt retry (correct for static
        // content) would just waste time recommitting the SAME content commitFilesToRepoMain
        // itself can't know is stale.
        const { pushedCommitSha, pushTimestampMs } = await commitFilesToRepoMain(
          repoFullName,
          ghHeaders,
          filesToCommit.map((file) => ({ path: file.path, content: Buffer.from(file.content) })),
          "chore: sync lead-capture route and middleware",
          1,
        );

        const wired = Object.entries(listByPath);
        console.log(
          `[V0 SERVICE] Synced lead-capture files to ${repoFullName} (${filesToCommit
            .map((f) => f.path)
            .join(", ")}); ${
            wired.length
              ? wired.map(([p, l]) => `${p} -> ${l}`).join(", ")
              : "NO page of this site has a lead list — its forms will fail loudly"
          }`
        );
        return { committed: true, pushedCommitSha, pushTimestampMs };
      } catch (err: any) {
        lastErr = err;
        const { retryable, reason } = isRetryableGithubPushError(err);
        if (!retryable || attempt === MAX_ATTEMPTS) throw err;
        const delay = 800 * Math.pow(2, attempt - 1) + Math.random() * 400;
        console.warn(
          `[V0 SERVICE] lead-capture sync to ${repoFullName} attempt ${attempt} failed (${reason}); ` +
            `rebuilding fresh content and retrying in ${Math.round(delay)}ms`
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  } catch (err: any) {
    const reason = err?.response?.data?.message || err?.message || String(err);
    console.error(
      `[V0 SERVICE] FAILED to sync lead-capture files to ${repoFullName}: ${reason}. ` +
        `The lead list is wired in DynamoDB but this repo's /api/capture route is STALE — ` +
        `leads submitted from this site will not be filed correctly until this is retried.`,
      err?.response?.status ? `(HTTP ${err.response.status})` : ""
    );
    return { committed: false, reason };
  }
}
