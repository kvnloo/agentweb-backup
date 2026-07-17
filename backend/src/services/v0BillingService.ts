/**
 * v0 (Vercel v0 platform) credit/billing monitor.
 *
 * Landing-page generation runs on the v0 API, which burns real credits.
 * This service gives the admin dashboard visibility into the remaining
 * balance so a runaway consumer can never silently drain the account again.
 *
 * Response shapes below were pinned against the live v0 API (2026-07-11):
 *   GET https://api.v0.dev/v1/user/plan
 *   GET https://api.v0.dev/v1/user/billing
 *   GET https://api.v0.dev/v1/rate-limits
 *
 * Failure policy: on ANY v0 API failure this module throws. It NEVER returns
 * fabricated/zero balances — a wrong "you have $0/$100 left" is worse than a
 * loud error (see feedback-avoid-fallbacks).
 */

import axios from "axios";
import { getV0ApiKey } from "../utils/secretsManager";

const V0_API_BASE = "https://api.v0.dev/v1";
const V0_REQUEST_TIMEOUT_MS = 10_000;

/** Serve cached balances for up to 5 minutes so dashboard refreshes don't hammer v0. */
export const V0_CREDITS_CACHE_TTL_MS = 5 * 60 * 1000;

// ── Warn thresholds ───────────────────────────────────────────────────────────
/** Total spendable (monthly remaining + on-demand remaining) below this → "low". */
export const LOW_TOTAL_SPENDABLE_USD = 25;
/** Total spendable below this → "critical". */
export const CRITICAL_TOTAL_SPENDABLE_USD = 10;
/** Monthly allowance remaining below this fraction of its total → "low". */
export const LOW_MONTHLY_REMAINING_FRACTION = 0.2;

export type V0WarnLevel = "ok" | "low" | "critical";

// ── Raw v0 API shapes (as observed) ──────────────────────────────────────────

interface V0Balance {
  remaining: number;
  total: number;
}

interface V0PlanResponse {
  object: string; // "plan"
  plan: string; // e.g. "v0-team"
  billingCycle?: { start: number; end: number }; // ms epochs
  balance?: V0Balance;
}

interface V0BillingResponse {
  billingType: string; // "token"
  data?: {
    plan?: string;
    role?: string;
    billingCycle?: { start: number; end: number };
    balance?: V0Balance;
    onDemand?: {
      balance: number; // current on-demand USD remaining
      blocks?: Array<{
        expirationDate: number;
        effectiveDate: number;
        originalBalance: number;
        currentBalance: number;
      }>;
    };
  };
}

interface V0RateLimitsResponse {
  limit?: number;
  remaining?: number;
  reset?: number; // ms epoch
  dailyLimit?: {
    limit: number;
    remaining: number;
    reset: number;
    isWithinGracePeriod?: boolean;
  };
}

// ── Stable DTO served to the admin dashboard ─────────────────────────────────

export interface V0CreditsDto {
  plan: string;
  billingCycle: { start: number; end: number } | null;
  /** Monthly plan credit allowance, in USD. */
  monthly: { remaining: number; total: number };
  /** On-demand (purchased) credit, in USD. total = sum of purchased blocks. */
  onDemand: { remaining: number; total: number };
  /** monthly.remaining + onDemand.remaining, rounded to cents. */
  totalSpendableUsd: number;
  rateLimits: {
    limit: number | null;
    remaining: number | null;
    reset: number | null;
    daily: { limit: number; remaining: number; reset: number } | null;
  } | null;
  warnLevel: V0WarnLevel;
  fetchedAt: string; // ISO timestamp of the underlying v0 fetch
}

export function computeWarnLevel(
  totalSpendableUsd: number,
  monthly: V0Balance
): V0WarnLevel {
  const monthlyExhausted = monthly.total > 0 && monthly.remaining <= 0;
  if (totalSpendableUsd < CRITICAL_TOTAL_SPENDABLE_USD || monthlyExhausted) {
    return "critical";
  }
  const monthlyLow =
    monthly.total > 0 &&
    monthly.remaining / monthly.total < LOW_MONTHLY_REMAINING_FRACTION;
  if (totalSpendableUsd < LOW_TOTAL_SPENDABLE_USD || monthlyLow) {
    return "low";
  }
  return "ok";
}

async function fetchV0<T>(path: string, apiKey: string): Promise<T> {
  try {
    const response = await axios.get(`${V0_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: V0_REQUEST_TIMEOUT_MS,
    });
    return response.data as T;
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    throw new Error(
      `v0 API request failed: GET ${path}${status ? ` (HTTP ${status})` : ""} — ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

async function fetchAndNormalize(): Promise<V0CreditsDto> {
  const apiKey = await getV0ApiKey();

  const [billing, plan, rateLimits] = await Promise.all([
    fetchV0<V0BillingResponse>("/user/billing", apiKey),
    fetchV0<V0PlanResponse>("/user/plan", apiKey),
    fetchV0<V0RateLimitsResponse>("/rate-limits", apiKey),
  ]);

  // Billing is the primary source; the plan endpoint is the fallback.
  const monthly = billing.data?.balance ?? plan.balance;
  if (
    !monthly ||
    typeof monthly.remaining !== "number" ||
    typeof monthly.total !== "number"
  ) {
    // Refuse to fabricate balances — a zero here would read as "account empty".
    throw new Error(
      "v0 API returned no usable balance data (user/billing and user/plan both missing `balance`)"
    );
  }

  const onDemandRaw = billing.data?.onDemand;
  const onDemandRemaining =
    typeof onDemandRaw?.balance === "number" ? onDemandRaw.balance : 0;
  const onDemandTotal = onDemandRaw?.blocks?.length
    ? onDemandRaw.blocks.reduce((sum, block) => sum + (block.originalBalance || 0), 0)
    : onDemandRemaining;

  const totalSpendableUsd = roundToCents(monthly.remaining + onDemandRemaining);

  return {
    plan: billing.data?.plan || plan.plan || "unknown",
    billingCycle: billing.data?.billingCycle ?? plan.billingCycle ?? null,
    monthly: { remaining: monthly.remaining, total: monthly.total },
    onDemand: { remaining: onDemandRemaining, total: onDemandTotal },
    totalSpendableUsd,
    rateLimits:
      rateLimits && typeof rateLimits === "object"
        ? {
            limit: rateLimits.limit ?? null,
            remaining: rateLimits.remaining ?? null,
            reset: rateLimits.reset ?? null,
            daily: rateLimits.dailyLimit
              ? {
                  limit: rateLimits.dailyLimit.limit,
                  remaining: rateLimits.dailyLimit.remaining,
                  reset: rateLimits.dailyLimit.reset,
                }
              : null,
          }
        : null,
    warnLevel: computeWarnLevel(totalSpendableUsd, monthly),
    fetchedAt: new Date().toISOString(),
  };
}

// ── In-memory cache (successes only; failures always propagate) ──────────────

let cache: { dto: V0CreditsDto; expiresAt: number } | null = null;
// In-flight dedup: concurrent callers (including ?refresh=1 racing a natural
// cache expiry) share ONE v0 fetch instead of stampeding the API.
let inflight: Promise<V0CreditsDto> | null = null;

export async function getV0Credits(options?: {
  forceRefresh?: boolean;
}): Promise<V0CreditsDto> {
  if (!options?.forceRefresh && cache && Date.now() < cache.expiresAt) {
    return cache.dto;
  }
  if (inflight) {
    // A fetch is already running — its result is as fresh as a new one would be.
    return inflight;
  }
  inflight = (async () => {
    try {
      const dto = await fetchAndNormalize();
      cache = { dto, expiresAt: Date.now() + V0_CREDITS_CACHE_TTL_MS };
      return dto;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// ── Low-credit alerting ───────────────────────────────────────────────────────
//
// Hourly cron (see server.ts) so credits can never silently run out even if no
// admin looks at the dashboard card. Alerts route through the backend's
// canonical ops-alert path — emailService.sendOncallAlert (oncall email list +
// auto-filed tracked issue via intakeService; suppressed outside production) —
// the same transport the AgentMode context-limit alerts use.

/** Re-alert at most once per level within this window (a redeploy re-alerting once is acceptable). */
export const V0_ALERT_REALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Stable dedupe class for the intake gate (ENG-358): every v0 balance alert carries
 * `"Alert Class": V0_ALERT_CLASS` in its context, so occurrences cluster onto ONE open
 * canonical Linear issue regardless of the dollar amount / warn level in the subject —
 * the intake gate matches this class before any title comparison. Without it, every
 * balance change filed a fresh issue (14 near-identical issues in 5 days, ENG-292…350).
 */
export const V0_ALERT_CLASS = "v0-credits";

/** Warn level -> intake `"Alert Priority"` (Linear: critical -> Urgent, low -> High). */
const ALERT_PRIORITY_BY_LEVEL: Record<Exclude<V0WarnLevel, "ok">, string> = {
  critical: "urgent",
  low: "high",
};

export type V0AlertTransport = (
  subject: string,
  message: string,
  context?: Record<string, any>
) => Promise<void>;

/** Default transport: the existing oncall alert util. Lazy import keeps the
 *  heavy emailService dependency graph out of this module's unit tests. */
const defaultAlertTransport: V0AlertTransport = async (subject, message, context) => {
  const { emailService } = await import("./emailService");
  await emailService.sendOncallAlert(subject, message, context);
};

let lastAlerted: { level: Exclude<V0WarnLevel, "ok">; at: number } | null = null;

function formatAlertMessage(dto: V0CreditsDto): { subject: string; message: string } {
  const subject = `v0 credits ${dto.warnLevel.toUpperCase()} — $${dto.totalSpendableUsd.toFixed(2)} spendable`;
  const message = [
    `v0 (landing-page generation) account credits are ${dto.warnLevel.toUpperCase()}.`,
    `Plan: ${dto.plan}`,
    `Total spendable: $${dto.totalSpendableUsd.toFixed(2)}`,
    `Monthly allowance: $${dto.monthly.remaining.toFixed(2)} of $${dto.monthly.total.toFixed(2)} remaining`,
    `On-demand: $${dto.onDemand.remaining.toFixed(2)} of $${dto.onDemand.total.toFixed(2)} remaining`,
    `Action: top up v0 credits (v0.dev → Settings → Billing) before landing-page generation starts failing.`,
  ].join("\n");
  return { subject, message };
}

export interface V0AlertCheckResult {
  warnLevel: V0WarnLevel;
  alerted: boolean;
  recovered: boolean;
}

/**
 * Fetch credits (respecting the cache) and alert on a warn-level transition
 * INTO 'low' or 'critical'. Dedupe: the same level only re-alerts after
 * V0_ALERT_REALERT_WINDOW_MS; a *different* level alerts immediately.
 * Recovery to 'ok' resets the state and sends a one-line all-clear.
 *
 * Transport failures are logged (console.error) and do NOT throw out of the
 * cron; alert state is only advanced on a successful send so the next tick
 * retries. v0 API failures DO propagate — the cron wrapper logs them.
 */
export async function checkAndAlert(options?: {
  transport?: V0AlertTransport;
}): Promise<V0AlertCheckResult> {
  const transport = options?.transport ?? defaultAlertTransport;
  const dto = await getV0Credits();
  const level = dto.warnLevel;

  if (level === "ok") {
    const recovered = lastAlerted !== null;
    if (recovered) {
      lastAlerted = null;
      try {
        await transport(
          "v0 credits recovered",
          `v0 credit balance is back to OK — $${dto.totalSpendableUsd.toFixed(2)} spendable (plan: ${dto.plan}).`
        );
      } catch (error) {
        console.error("[v0CreditAlert] Failed to send recovery note:", error);
      }
    }
    return { warnLevel: level, alerted: false, recovered };
  }

  const now = Date.now();
  const sameLevelWithinWindow =
    lastAlerted !== null &&
    lastAlerted.level === level &&
    now - lastAlerted.at < V0_ALERT_REALERT_WINDOW_MS;
  if (sameLevelWithinWindow) {
    return { warnLevel: level, alerted: false, recovered: false };
  }

  const { subject, message } = formatAlertMessage(dto);
  try {
    await transport(subject, message, {
      Plan: dto.plan,
      "Total spendable": `$${dto.totalSpendableUsd.toFixed(2)}`,
      "Monthly remaining": `$${dto.monthly.remaining.toFixed(2)} / $${dto.monthly.total.toFixed(2)}`,
      "Warn level": level,
      "Fetched at": dto.fetchedAt,
      // Intake-gate clustering keys (ENG-358): dedupe every occurrence onto the one open
      // canonical; escalate (low -> critical) in place instead of filing a new issue.
      "Alert Class": V0_ALERT_CLASS,
      "Alert Priority": ALERT_PRIORITY_BY_LEVEL[level],
    });
  } catch (error) {
    // Logged loudly, never thrown out of the hourly cron. State is NOT
    // advanced, so the next tick retries the alert.
    console.error("[v0CreditAlert] Failed to send low-credit alert:", error);
    return { warnLevel: level, alerted: false, recovered: false };
  }
  lastAlerted = { level, at: now };
  return { warnLevel: level, alerted: true, recovered: false };
}

/** Test-only: clear the module-level cache, in-flight fetch, and alert state. */
export function __resetV0CreditsCacheForTests(): void {
  cache = null;
  inflight = null;
  lastAlerted = null;
}
