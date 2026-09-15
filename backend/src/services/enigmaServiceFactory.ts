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

import { crmDb } from './db';
import { CrmEnrichmentService } from './crmEnrichmentService';
import {
  EnigmaApiError,
  EnigmaAuthError,
  EnigmaCreditsExhaustedError,
  EnigmaRateLimitedError,
  EnigmaService,
  countEnigmaBilledFills,
  initEnigmaService,
  type EnigmaBilledFillKey,
  type EnigmaCacheStore,
  type EnigmaHttpClient,
} from './enigmaService';
import { getEnigmaApiKey } from '../utils/secretsManager';
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
        throw new EnigmaApiError(`Enigma GraphQL error: ${message}`, res.status);
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

export async function initEnigmaServiceFromEnv(): Promise<void> {
  const apiKey = await getEnigmaApiKey();
  initEnigmaService(new EnigmaService({
    http: buildEnigmaHttpClient(apiKey),
    store: buildCacheStore(),
    isPersonalDomain: (host) => CrmEnrichmentService.isPersonalDomain(host),
  }));
}
