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

export async function getV0Credits(options?: {
  forceRefresh?: boolean;
}): Promise<V0CreditsDto> {
  if (!options?.forceRefresh && cache && Date.now() < cache.expiresAt) {
    return cache.dto;
  }
  const dto = await fetchAndNormalize();
  cache = { dto, expiresAt: Date.now() + V0_CREDITS_CACHE_TTL_MS };
  return dto;
}

/** Test-only: clear the module-level cache between test cases. */
export function __resetV0CreditsCacheForTests(): void {
  cache = null;
}
