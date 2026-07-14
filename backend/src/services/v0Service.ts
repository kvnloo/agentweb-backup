import { v4 as uuidv4 } from "uuid";
import AWS from "aws-sdk";
import axios from "axios";
import fs from "fs";
import path from "path";
import { getV0ApiKey, getGitHubOrgToken, getVercelToken, getLandingPagesConfig } from "../utils/secretsManager";
import { resolveLandingPageGa4 } from "../utils/landingPageGa4";
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
  templateHtml?: string
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
  originatingSessionId?: string
): Promise<GeneratedLandingPage> {
  if (process.env.CODING_AGENT_SUBPAGES === "true") {
    const { addPageViaCodingAgent } = await import("./codingAgentSubpageService");
    return addPageViaCodingAgent(site, userId, prompt, name, brandContext, {
      leadListId,
      originatingSessionId,
    });
  }
  return addPageToExistingRepo(
    site, userId, prompt, name, brandContext, leadListId, templateHtml, originatingSessionId
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
          site, userId, prompt, name, brandContext, leadListId, templateHtml, originatingSessionId
        );
      }
      // siteId given but not a usable site (deleted / never deployed) → fall through.
    }

    // 2. "separate" → each campaign gets its OWN site (fresh v0 generation + repo +
    //    subdomain). The costlier, opt-in path (e.g. distinct campaign URLs).
    if (mode === "separate") {
      return generateFirstPage(
        userId, prompt, name, brandContext, leadListId, templateHtml, undefined, originatingSessionId
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
        existing, userId, prompt, name, brandContext, leadListId, templateHtml, originatingSessionId
      );
    }
    return generateFirstPage(
      userId, prompt, name, brandContext, leadListId, templateHtml, undefined, originatingSessionId
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
    return addPageToExistingRepo(siteRecord, userId, prompt, name, brandContext, leadListId, templateHtml);
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

  return generateFirstPage(userId, prompt, name, brandContext, leadListId, templateHtml, recyclable?.id);
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
  originatingSessionId?: string
): Promise<GeneratedLandingPage> {
  // Reuse a recyclable failed record's id when retrying, otherwise mint a new one.
  const id = existingId ?? uuidv4();
  const now = new Date().toISOString();

  // Auto-load the HTML template structure as design inspiration for v0.
  // We send a condensed outline (not the full 55KB HTML) to avoid exceeding v0 prompt limits.
  const effectiveTemplate = templateHtml ?? await loadDefaultTemplateOutline();

  const enrichedPrompt = buildBrandEnrichedPrompt(prompt, brandContext, leadListId, effectiveTemplate);

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
  originatingSessionId?: string
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

    const enrichedPrompt = buildBrandEnrichedPrompt(prompt, brandContext, leadListId, effectiveTemplate);
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

      try {
        validateV0Output(previewFiles);
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
    const { pushedCommitSha, pushTimestampMs } = await commitFilesToRepoMain(
      repoFullName,
      ghHeaders,
      filesToCommit,
      `Add new page: ${name} (/${slug})`
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

    // Update record to deployed, re-persisting repo fields in case they were missing
    const deployedSubPage: GeneratedLandingPage = {
      ...record,
      status: "deployed",
      updatedAt: new Date().toISOString(),
    };

    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression:
          "SET #status = :status, updatedAt = :updatedAt, githubRepoUrl = :repoUrl, vercelProjectId = :vercelId",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "deployed",
          ":updatedAt": new Date().toISOString(),
          ":repoUrl": existingPage.githubRepoUrl ?? record.githubRepoUrl,
          ":vercelId": existingPage.vercelProjectId ?? record.vercelProjectId,
        },
      })
      .promise();

    void enqueueLandingPageHumanEval(deployedSubPage);

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
 * - If the file already exports a `metadata` object, rewrite its `title`
 *   field (or insert one) to the provided title.
 * - Otherwise, prepend a new `export const metadata = { title: "…" }` block
 *   right after any leading `'use client'` directive (if present — though
 *   `metadata` exports only work in server components, so this case is rare).
 */
export function ensurePageMetadataTitle(content: string, title: string): string {
  if (!title || !title.trim()) return content;
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
  const metadataBlock = `export const metadata = { title: "${escaped}" };\n\n`;
  const useClientMatch = content.match(/^(\s*(?:'use client'|"use client");?\s*\n)/);
  if (useClientMatch) {
    return useClientMatch[1] + metadataBlock + content.slice(useClientMatch[1].length);
  }
  return metadataBlock + content;
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

      try {
        validateV0Output(previewFiles);
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
    const { githubRepoUrl, repoFullName, commitSha } = await createGitHubRepoAndPush(repoName, zipBuffer, record.name, record.leadListId);

    // Save GitHub repo URL immediately so it's not lost if Vercel step fails
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: "SET #status = :status, githubRepoUrl = :repoUrl, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "deploying",
          ":repoUrl": githubRepoUrl,
          ":updatedAt": new Date().toISOString(),
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

  console.log(`[V0 SERVICE] Output validation passed: ${tsxFiles.length} .tsx files, ${reactFiles.length} with React code`);
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
  if (captureRouteCount > 1 || middlewareCount > 1 || domainMapCount > 1) {
    throw new Error(
      `[V0 SERVICE] duplicate route after lead-capture injection (capture routes: ${captureRouteCount}, middleware: ${middlewareCount}, domainMap: ${domainMapCount})`
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

  // 2. First-touch attribution capture, on WHICHEVER response we are returning.
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

export function injectLeadCaptureAttribution(
  files: Array<{ path: string; content: Buffer }>,
  leadListId: string
): Array<{ path: string; content: Buffer }> {
  const filtered = files.filter(
    (f) => !isV0CaptureRoute(f.path) && !isV0Middleware(f.path) && !isV0DomainMap(f.path)
  );

  const apiBase = process.env.BACKEND_URL || "https://api.agentweb.pro";

  const middlewareContent = buildLandingPageMiddleware();

  const routeContent = `import { NextResponse } from "next/server";
import { cookies } from "next/headers";

const LIST_ID = "${leadListId}";
const FORWARD_URL = "${apiBase}/api/webhooks/forward-lead";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    let attribution: unknown;
    const raw = (await cookies()).get("aw_first_touch")?.value;
    if (raw) { try { attribution = JSON.parse(raw); } catch {} }

    const res = await fetch(FORWARD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, listId: LIST_ID, source: "landing-page", ...(attribution ? { attribution } : {}) }),
    });
    if (!res.ok) return NextResponse.json({ success: false }, { status: 502 });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
`;

  filtered.push({ path: "middleware.ts", content: Buffer.from(middlewareContent) });
  filtered.push({ path: "app/api/capture/route.ts", content: Buffer.from(routeContent) });
  // The middleware imports ./domainMap, so a fresh page MUST ship one or its very
  // first Vercel build fails. Empty until a subdomain is actually attached, at which
  // point updateSubdomainMiddleware rewrites it with the real map.
  filtered.push({ path: "domainMap.ts", content: Buffer.from(buildDomainMapFile({})) });

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
  leadListId?: string
): Promise<{ githubRepoUrl: string; repoFullName: string; commitSha: string }> {
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
    const lpConfig = await getLandingPagesConfig();
    const measurementId = lpConfig?.ga4MeasurementId;
    const gtagBlock = measurementId
      ? `\n        <script async src="https://www.googletagmanager.com/gtag/js?id=${measurementId}"></script>\n        <script dangerouslySetInnerHTML={{ __html: \`window.dataLayer = window.dataLayer || []; function gtag(){dataLayer.push(arguments);} gtag('js', new Date()); gtag('config', '${measurementId}');\` }} />`
      : '';
    scaffoldFiles.push({
      path: "app/layout.tsx",
      content: Buffer.from(`import type { Metadata } from "next";\nimport "./globals.css";\n\nexport const metadata: Metadata = {\n  title: "Landing Page",\n  description: "Generated landing page",\n};\n\nexport default function RootLayout({\n  children,\n}: {\n  children: React.ReactNode;\n}) {\n  return (\n    <html lang="en">\n      <head>${gtagBlock}\n      </head>\n      <body>{children}</body>\n    </html>\n  );\n}\n`),
    });
  }

  if (scaffoldFiles.length > 0) {
    console.log(`[V0 SERVICE] Adding ${scaffoldFiles.length} scaffold files: ${scaffoldFiles.map(f => f.path).join(", ")}`);
    files.push(...scaffoldFiles);
  }

  // Deterministically inject platform-owned lead-capture attribution (middleware.ts +
  // app/api/capture/route.ts), force-replacing any v0-generated equivalents.
  let finalFiles = files;
  if (leadListId) {
    finalFiles = injectLeadCaptureAttribution(files, leadListId);
    console.log(`[V0 SERVICE] Injected lead-capture attribution files (middleware.ts, app/api/capture/route.ts) for list ${leadListId}`);
  }

  // Auto-fix common v0 build issues before pushing to GitHub
  const fixCount = autoFixV0Files(finalFiles);
  if (fixCount > 0) {
    console.log(`[V0 SERVICE] Auto-fixed ${fixCount} files for build compatibility`);
  }

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

  return { githubRepoUrl, repoFullName, commitSha };
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
 * Fetch build error messages from Vercel deployment events.
 */
async function getVercelBuildErrors(deploymentId: string, vercelToken: string): Promise<string> {
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

    // Return the last 30 error lines (most relevant)
    return errorLines.slice(-30).join("\n") || "Build failed — no error details available in logs.";
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
    ExpressionAttributeValues: { ":userId": userId },
  });

  // Prefer: 1) explicit root page, 2) page with v0ChatId (original v0 page), 3) any with githubRepoUrl
  const siteRecord =
    pages.find((p) => p.isRootPage && p.githubRepoUrl) ||
    pages.find((p) => p.v0ChatId && p.githubRepoUrl) ||
    pages.find((p) => !!p.githubRepoUrl);

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
async function removePageFromGitHub(githubRepoUrl: string, slug: string): Promise<void> {
  const match = githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) return;
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
    return; // never push an empty commit — it would trigger a pointless rebuild
  }

  await commitFilesToRepoMain(
    repoFullName,
    ghHeaders,
    toDelete.map((path) => ({ path, deleted: true })),
    `Remove page /${slug}`
  );

  console.log(`[GITHUB] Removed ${toDelete.length} file(s) under ${prefix} from ${repoFullName}`);
}

/**
 * Delete a landing page. All pages are deletable (including the root).
 * Pages are soft-deleted (archived) and their route file is removed from GitHub.
 */
export async function deleteLandingPage(
  id: string,
  userId: string
): Promise<void> {
  const record = await getLandingPage(id, userId);
  if (!record) {
    throw new Error("Landing page not found");
  }

  // Remove route file from GitHub
  if (record.githubRepoUrl && record.slug) {
    try {
      await removePageFromGitHub(record.githubRepoUrl, record.slug);
    } catch (err: any) {
      console.error("[V0 SERVICE] Failed to remove route from GitHub:", err.message);
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
 */
export async function deleteLandingPageByRecord(record: GeneratedLandingPage): Promise<void> {
  if (record.githubRepoUrl && record.slug) {
    try {
      await removePageFromGitHub(record.githubRepoUrl, record.slug);
    } catch (err: any) {
      console.error("[V0 SERVICE] Failed to remove route from GitHub:", err.message);
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
