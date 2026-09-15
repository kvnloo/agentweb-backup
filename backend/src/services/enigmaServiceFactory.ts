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
  EnigmaQuotaExceededError,
  EnigmaRateLimitedError,
  EnigmaService,
  countEnigmaBilledFills,
  initEnigmaService,
  type EnigmaBilledFillKey,
  type EnigmaCacheStore,
  type EnigmaHttpClient,
  type EnigmaQuotaTracker,
} from './enigmaService';
import { getEnigmaApiKey } from '../utils/secretsManager';
import { recordVendorUsage } from './usageRecorderService';
import { computeAllocatedCost, getRecordingUnit } from '../utils/vendorRateCard';
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
      costSource: 'allocated',
      costUsd: computeAllocatedCost('enigma', rateKey, quantity),
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
      const brands: any[] = Array.isArray(body?.data?.search) ? body.data.search : [];
      // Values that came back were billed, even alongside GraphQL errors.
      recordEnigmaLedger(brands, userId);

      if (Array.isArray(body?.errors) && body.errors.length > 0) {
        const message = body.errors.map((e: any) => e?.message).filter(Boolean).join('; ') || 'unknown GraphQL error';
        throw new EnigmaApiError(`Enigma GraphQL error: ${message}`, res.status);
      }
      return brands;
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

// ─── Per-user daily cap (AW-Configs, same row pattern as Apollo/enrich.so) ────

const CONFIGS_TABLE = `${process.env.NODE_ENV === 'production' ? '' : 'Dev-'}AW-Configs`;
const ENIGMA_USAGE_CONFIG_ID = 'system:enigmaUsage';
const DEFAULT_DAILY_LIMIT_PER_USER = 300;

function dailyLimitFromEnv(): number {
  const n = Number(process.env.ENIGMA_DAILY_LIMIT_PER_USER);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_LIMIT_PER_USER;
}

export function buildEnigmaQuotaTracker(
  dynamodb: Pick<AWS.DynamoDB.DocumentClient, 'get' | 'update' | 'put'>,
  limit: number = dailyLimitFromEnv(),
  now: () => Date = () => new Date(),
): EnigmaQuotaTracker {
  const key = (userId: string) => ({ userId, configId: ENIGMA_USAGE_CONFIG_ID });
  const today = () => now().toISOString().slice(0, 10);

  return {
    async checkQuota(userId) {
      const r = await dynamodb.get({ TableName: CONFIGS_TABLE, Key: key(userId) }).promise();
      const count = r.Item?.date === today() ? Number(r.Item.callCount ?? 0) : 0;
      if (count >= limit) throw new EnigmaQuotaExceededError(limit);
    },
    // Check-then-record is not atomic: concurrent leads can overshoot by up to
    // the run's concurrency, the same trade-off apolloService.ts documents.
    async recordUsage(userId) {
      const day = today();
      try {
        await dynamodb.update({
          TableName: CONFIGS_TABLE,
          Key: key(userId),
          UpdateExpression: 'ADD callCount :one',
          ConditionExpression: '#date = :today',
          ExpressionAttributeNames: { '#date': 'date' },
          ExpressionAttributeValues: { ':one': 1, ':today': day },
        }).promise();
      } catch (err: any) {
        if (err.code !== 'ConditionalCheckFailedException') throw err;
        // First call of the day (or no row yet): start a fresh counter. If a
        // concurrent writer already did, fall back to a plain ADD.
        try {
          await dynamodb.put({
            TableName: CONFIGS_TABLE,
            Item: { ...key(userId), date: day, callCount: 1 },
            ConditionExpression: 'attribute_not_exists(userId) OR #date <> :today',
            ExpressionAttributeNames: { '#date': 'date' },
            ExpressionAttributeValues: { ':today': day },
          }).promise();
        } catch (putErr: any) {
          if (putErr.code !== 'ConditionalCheckFailedException') throw putErr;
          await dynamodb.update({
            TableName: CONFIGS_TABLE,
            Key: key(userId),
            UpdateExpression: 'ADD callCount :one',
            ExpressionAttributeValues: { ':one': 1 },
          }).promise();
        }
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
