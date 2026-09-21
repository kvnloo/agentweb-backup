/**
 * Wires the real HTTP client (fetch → Enigma GraphQL) and DynamoDB cache store
 * to EnigmaService (ENG-1388). Kept separate from enigmaService.ts so the core
 * service stays free of AWS/network imports.
 *
 * Uses global fetch rather than axios so the ENG-1111 test egress guard (which
 * wraps fetch, not axios) blocks any test that forgets to mock this client.
 *
 * Call initEnigmaServiceFromEnv() once at server boot. Missing credentials
 * leave the service uninitialised, and getEnigmaService() returns null.
 */

import AWS from 'aws-sdk';
import { crmDb } from './db';
import { CrmEnrichmentService } from './crmEnrichmentService';
import {
  EnigmaApiError,
  EnigmaAuthError,
  EnigmaCreditsExhaustedError,
  EnigmaBudgetExhaustedError,
  EnigmaQuotaExceededError,
  EnigmaRateLimitedError,
  EnigmaService,
  ENIGMA_MAX_CREDITS_PER_CALL,
  countEnigmaBilledCredits,
  countEnigmaBilledFills,
  initEnigmaService,
  type EnigmaBilledFillKey,
  type EnigmaCacheStore,
  type EnigmaHttpClient,
  type EnigmaQuotaTracker,
} from './enigmaService';
import { getEnigmaApiKey } from '../utils/secretsManager';
import { TABLE_PREFIX } from '../config/constants';
import { recordVendorUsage } from './usageRecorderService';
import { getRecordingUnit } from '../utils/vendorRateCard';
import { buildSearchBrandBody } from './enigmaGraphql';

const ENIGMA_GRAPHQL_URL = 'https://api.enigma.com/graphql';
const REQUEST_TIMEOUT_MS = 30_000;

// ─── Vendor $ ledger mirroring ──────────────────────────────────────────────
//
// Enigma bills per value returned, and bills values even when our match
// validation later discards the brand, so the ledger records what came back —
// once per billed rate key with quantity = number of values. A search that
// returns no brand returns no values and records nothing (Enigma charges $0).
const FILL_KEYS: EnigmaBilledFillKey[] = ['card_revenue_12m', 'card_revenue_yoy_growth_12m', 'brand_attribute'];

function recordEnigmaLedger(brands: any[] | null | undefined, userId: string | undefined): void {
  const counts = countEnigmaBilledFills(brands);
  for (const rateKey of FILL_KEYS) {
    const quantity = counts[rateKey];
    if (quantity <= 0) continue;
    void recordVendorUsage({
      userId,
      provider: 'enigma',
      operation: rateKey,
      feature: 'crm_enrichment',
      unit: getRecordingUnit('enigma', rateKey) ?? 'fill',
      quantity,
      // ENG-1929: priced inside the recorder, so a rate-card gap can never throw
      // into the Enigma request.
      rateKey,
    });
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export function buildEnigmaHttpClient(apiKey: string): EnigmaHttpClient {
  return {
    async searchBrand(request, userId) {
      const res = await fetch(ENIGMA_GRAPHQL_URL, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: buildSearchBrandBody(request),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.status === 401 || res.status === 403) {
        console.error(`[enigma] AUTH FAILURE HTTP ${res.status} — check Secrets Manager AgentWeb/Enigma`);
        throw new EnigmaAuthError(res.status);
      }
      if (res.status === 402) {
        console.error('[enigma] OUT OF CREDITS (HTTP 402) — lookups will fail until the account is topped up');
        throw new EnigmaCreditsExhaustedError();
      }
      if (res.status === 429) {
        throw new EnigmaRateLimitedError(parseRetryAfter(res.headers.get('retry-after')));
      }
      if (!res.ok) {
        throw new EnigmaApiError(`Enigma HTTP ${res.status}`, res.status);
      }

      const body: any = await res.json();
      const search = body?.data?.search;
      // Values that came back were billed, even alongside GraphQL errors.
      if (Array.isArray(search)) recordEnigmaLedger(search, userId);

      if (Array.isArray(body?.errors) && body.errors.length > 0) {
        const message = body.errors.map((e: any) => e?.message).filter(Boolean).join('; ') || 'unknown GraphQL error';
        const err = new EnigmaApiError(`Enigma GraphQL error: ${message}`, res.status);
        // Values that came back were billed (and ledgered above), so the monthly
        // budget must count them too. With none, nothing was billed: leave it
        // unset so the whole reservation, including the user's daily call, is released.
        const billedCredits = Array.isArray(search) ? countEnigmaBilledCredits(search) : 0;
        if (billedCredits > 0) err.billedCredits = billedCredits;
        throw err;
      }
      // A missing or non-array `search` is schema drift, not "no brand": throw so
      // it is never cached as a 30-day not_found.
      if (!Array.isArray(search)) {
        throw new EnigmaApiError('Enigma response missing data.search array', res.status);
      }
      return search;
    },
  };
}

function buildCacheStore(): EnigmaCacheStore {
  return {
    async get(canonicalId, sk) {
      const item = await crmDb.getEnrichmentCacheItem(canonicalId, sk);
      if (!item || item.cacheType !== 'enigma') return null;
      return item;
    },
    async put(row, opts) {
      await crmDb.putEnrichmentCacheItem({ ...row, cacheType: 'enigma' }, opts);
    },
  };
}

// ─── Spend limits (AW-Configs rows, reserved atomically) ─────────────────────

// Same prefix as db.ts, which owns the rest of this feature's persistence (the
// enrichment cache): quota rows and cache rows must live in the same environment.
const CONFIGS_TABLE = `${TABLE_PREFIX}AW-Configs`;
const ENIGMA_USAGE_CONFIG_ID = 'system:enigmaUsage';
const ENIGMA_CREDIT_BUDGET_CONFIG_ID = 'system:enigmaCreditBudget';
// AW-Configs rows are keyed by userId; the credit budget is platform-wide, so
// it uses a reserved id no real user can hold.
const PLATFORM_BUDGET_USER_ID = 'system';
// ENG-1933: ~19 credits per live call, 52 worst case, against a 2,100/month Pro
// plan. Default leaves headroom for the manual Console checks.
const DEFAULT_MONTHLY_CREDIT_BUDGET = 1_800;
const DEFAULT_DAILY_LIMIT_PER_USER = 150;

function dailyLimitFromEnv(): number {
  const n = Number(process.env.ENIGMA_DAILY_LIMIT_PER_USER);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_LIMIT_PER_USER;
}

function monthlyCreditBudgetFromEnv(): number {
  const n = Number(process.env.ENIGMA_MONTHLY_CREDIT_BUDGET);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MONTHLY_CREDIT_BUDGET;
}

const isConditionFailure = (err: any) => err?.code === 'ConditionalCheckFailedException';

/**
 * Atomic counters on AW-Configs. Both limits reserve capacity with a single
 * conditional write, so concurrent lookups cannot all pass one stale read:
 *
 * - user/day:    ADD callCount 1        IF today's row and callCount < limit
 * - platform/mo: ADD creditCount reserve IF this month's row and creditCount <= budget - reserve
 *
 * A row from an earlier day/month is replaced by a conditional put, so the first
 * call of a new period starts a fresh counter; losing that race falls back to
 * one retry of the conditional add. `settle` then trues the credits up to what
 * Enigma actually billed and releases everything when the call failed.
 */
export function buildEnigmaQuotaTracker(
  dynamodb: Pick<AWS.DynamoDB.DocumentClient, 'update' | 'put'>,
  limit: number = dailyLimitFromEnv(),
  now: () => Date = () => new Date(),
  creditBudget: number = monthlyCreditBudgetFromEnv(),
): EnigmaQuotaTracker {
  const userKey = (userId: string) => ({ userId, configId: ENIGMA_USAGE_CONFIG_ID });
  const budgetKey = { userId: PLATFORM_BUDGET_USER_ID, configId: ENIGMA_CREDIT_BUDGET_CONFIG_ID };

  /**
   * Adds `amount` to `counter` on a row scoped to `period` (`periodField` holds
   * the day or month), only while the counter is <= `maxBefore`. Returns false
   * when the limit is spent. A stale or missing row is replaced.
   */
  async function reserveOn(
    key: { userId: string; configId: string },
    periodField: 'date' | 'month',
    period: string,
    counter: 'callCount' | 'creditCount',
    amount: number,
    maxBefore: number,
  ): Promise<boolean> {
    if (maxBefore < 0) return false;
    const tryAdd = async (): Promise<boolean> => {
      try {
        await dynamodb.update({
          TableName: CONFIGS_TABLE,
          Key: key,
          UpdateExpression: 'ADD #counter :amount',
          ConditionExpression: '#period = :period AND #counter <= :maxBefore',
          ExpressionAttributeNames: { '#counter': counter, '#period': periodField },
          ExpressionAttributeValues: { ':amount': amount, ':period': period, ':maxBefore': maxBefore },
        }).promise();
        return true;
      } catch (err) {
        if (!isConditionFailure(err)) throw err;
        return false;
      }
    };

    if (await tryAdd()) return true;
    // Either the limit is spent this period, or the row is missing or from an
    // earlier period. Start a fresh counter only in that last case.
    try {
      await dynamodb.put({
        TableName: CONFIGS_TABLE,
        Item: { ...key, [periodField]: period, [counter]: amount },
        // Replace only a missing or OLDER period (ISO day/month strings sort
        // lexicographically). A request that computed its period just before a
        // rollover must not overwrite the newer counter and lose reservations.
        ConditionExpression: 'attribute_not_exists(userId) OR #period < :period',
        ExpressionAttributeNames: { '#period': periodField },
        ExpressionAttributeValues: { ':period': period },
      }).promise();
      return true;
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
    // Another writer created this period's row between our two writes: one retry.
    return tryAdd();
  }

  /** Best-effort add of a (possibly negative) delta to the period's counter. */
  async function adjust(
    key: { userId: string; configId: string },
    periodField: 'date' | 'month',
    period: string,
    counter: 'callCount' | 'creditCount',
    delta: number,
  ): Promise<void> {
    if (delta === 0) return;
    try {
      await dynamodb.update({
        TableName: CONFIGS_TABLE,
        Key: key,
        UpdateExpression: 'ADD #counter :delta',
        // The period may have rolled over while the call was in flight; then the
        // reservation belonged to a row that no longer counts, so do nothing.
        ConditionExpression: '#period = :period',
        ExpressionAttributeNames: { '#counter': counter, '#period': periodField },
        ExpressionAttributeValues: { ':delta': delta, ':period': period },
      }).promise();
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
  }

  return {
    async reserve(userId) {
      const at = now();
      const month = at.toISOString().slice(0, 7);
      const day = at.toISOString().slice(0, 10);

      // Budget first; if the user's own limit then refuses, give the credits back.
      let credits = 0;
      if (creditBudget > 0) {
        credits = Math.min(ENIGMA_MAX_CREDITS_PER_CALL, creditBudget);
        const ok = await reserveOn(budgetKey, 'month', month, 'creditCount', credits, creditBudget - credits);
        if (!ok) throw new EnigmaBudgetExhaustedError(creditBudget);
      }

      if (userId) {
        let ok = false;
        try {
          ok = await reserveOn(userKey(userId), 'date', day, 'callCount', 1, limit - 1);
        } catch (err) {
          await adjust(budgetKey, 'month', month, 'creditCount', -credits).catch(() => undefined);
          throw err;
        }
        if (!ok) {
          await adjust(budgetKey, 'month', month, 'creditCount', -credits).catch(() => undefined);
          throw new EnigmaQuotaExceededError(limit);
        }
      }

      return { userId, credits, month, day: userId ? day : undefined };
    },

    async settle(reservation, actualCredits) {
      if (reservation.credits > 0 && reservation.month) {
        // Billed less than the worst case: release the difference. (Billed more
        // than reserved cannot happen: the reservation is the query's ceiling.)
        const billed = actualCredits === null ? 0 : Math.min(actualCredits, reservation.credits);
        await adjust(budgetKey, 'month', reservation.month, 'creditCount', billed - reservation.credits);
      }
      // A call that failed before billing does not use up the user's daily allowance.
      if (actualCredits === null && reservation.userId && reservation.day) {
        await adjust(userKey(reservation.userId), 'date', reservation.day, 'callCount', -1);
      }
    },
  };
}

export async function initEnigmaServiceFromEnv(): Promise<void> {
  const apiKey = await getEnigmaApiKey();
  initEnigmaService(new EnigmaService({
    http: buildEnigmaHttpClient(apiKey),
    store: buildCacheStore(),
    isPersonalDomain: (host) => CrmEnrichmentService.isPersonalDomain(host),
    quota: buildEnigmaQuotaTracker(new AWS.DynamoDB.DocumentClient()),
  }));
}
