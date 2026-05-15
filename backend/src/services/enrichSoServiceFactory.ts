/**
 * Wires the real HTTP client (axios → enrich.so) and DynamoDB cache store
 * to EnrichSoService. Kept separate from enrichSoService.ts so the core
 * service stays free of AWS/axios imports for fast unit tests.
 *
 * Call initEnrichSoServiceFromEnv() once at server boot.
 */

import axios from 'axios';
import AWS from 'aws-sdk';
import {
  EnrichSoService,
  initEnrichSoService,
  type EnrichSoHttpClient,
  type EnrichSoCacheStore,
} from './enrichSoService';
import {
  DynamoQuotaTracker,
  ENRICHSO_USAGE_CONFIG_ID,
  type UsageRow,
  type QuotaTracker,
} from './enrichSoQuota';
import type { EnrichSoEndpoint } from './enrichSoCacheKeys';
import { crmDb } from './db';
import { getEnrichSoApiKey } from '../utils/secretsManager';

const ENRICHSO_BASE_URL = 'https://dev.enrich.so/api/v3';
const TABLE_PREFIX = process.env.NODE_ENV === 'production' ? '' : 'Dev-';
const CONFIGS_TABLE = `${TABLE_PREFIX}AW-Configs`;

function buildHttpClient(apiKey: string): EnrichSoHttpClient {
  const client = axios.create({
    baseURL: ENRICHSO_BASE_URL,
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    timeout: 30_000,
  });

  return {
    async validateEmail(email) {
      const r = await client.post('/email-validation', { email });
      return r.data;
    },
    async findEmail(input) {
      try {
        const r = await client.post('/email-finder', input);
        return r.data;
      } catch (err: any) {
        // Translate 404 to the same shape the service's negative classifier
        // recognizes (`apiData.found === false`) so a confirmed not-found
        // goes into the 7d negative cache instead of the 1h error bucket.
        // Without this we'd re-hit the API every hour for every
        // known-not-found name.
        const status = err?.response?.status;
        if (status === 404) return { found: false };
        throw err;
      }
    },
    async reverseLookup(email) {
      try {
        const r = await client.post('/reverse-lookup/lookup', { email });
        return r.data;
      } catch (err: any) {
        // Translate 404 to a success:false envelope so the cache-first wrapper
        // routes it into the 7d not_found bucket instead of the 1h error bucket.
        // Without this, every miss costs 168x more cache slots and re-hits the
        // API every hour for known-not-found emails.
        const status = err?.response?.status;
        if (status === 404) return { success: false, error: { code: 'NOT_FOUND' } };
        throw err;
      }
    },
  };
}

function buildQuotaTracker(): QuotaTracker {
  const dynamodb = new AWS.DynamoDB.DocumentClient();

  /**
   * Atomic counter increment with race-safe day-rollover.
   * Strategy: try the same-day ADD. On date-mismatch failure, retry with a
   * conditional put that wins only if the row is still missing or stale, then
   * loop back to ADD if another writer beat us to the reset. This bounds
   * day-boundary writes to at most one fresh row per user instead of
   * clobbering parallel first-of-day increments.
   */
  async function safeIncrement(
    userId: string,
    counterAttr: string,
    today: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await dynamodb.update({
          TableName: CONFIGS_TABLE,
          Key: { userId, configId: ENRICHSO_USAGE_CONFIG_ID },
          UpdateExpression: 'ADD #c :one',
          ConditionExpression: '#date = :today',
          ExpressionAttributeNames: { '#c': counterAttr, '#date': 'date' },
          ExpressionAttributeValues: { ':one': 1, ':today': today },
        }).promise();
        return;
      } catch (err: any) {
        if (err.code !== 'ConditionalCheckFailedException') throw err;
        // Date mismatch (or row didn't exist). Try to claim the reset slot.
        try {
          const fresh: UsageRow = {
            date: today,
            validateCount: counterAttr === 'validateCount' ? 1 : 0,
            findCount: counterAttr === 'findCount' ? 1 : 0,
            reverseCount: counterAttr === 'reverseCount' ? 1 : 0,
            lookupByEmailCount: counterAttr === 'lookupByEmailCount' ? 1 : 0,
          };
          await dynamodb.put({
            TableName: CONFIGS_TABLE,
            Item: { userId, configId: ENRICHSO_USAGE_CONFIG_ID, ...fresh },
            // Win only if no row exists OR the existing row is stale (different date).
            // Prevents clobbering a fresh row that another worker just wrote.
            ConditionExpression: 'attribute_not_exists(userId) OR #date <> :today',
            ExpressionAttributeNames: { '#date': 'date' },
            ExpressionAttributeValues: { ':today': today },
          }).promise();
          return;
        } catch (putErr: any) {
          if (putErr.code !== 'ConditionalCheckFailedException') throw putErr;
          // Another worker already wrote a fresh row → loop back to ADD.
        }
      }
    }
    // Final fallback: overwrite with a fresh same-day row. Using `put` (not
    // `update with if_not_exists(#date)`) guarantees that a stale-date row
    // from yesterday is replaced rather than carried forward — otherwise the
    // bumped counter would be associated with the wrong day and wouldn't
    // reset until the date naturally rolls.
    const fresh: UsageRow = {
      date: today,
      validateCount: counterAttr === 'validateCount' ? 1 : 0,
      findCount: counterAttr === 'findCount' ? 1 : 0,
      reverseCount: counterAttr === 'reverseCount' ? 1 : 0,
      lookupByEmailCount: counterAttr === 'lookupByEmailCount' ? 1 : 0,
    };
    await dynamodb.put({
      TableName: CONFIGS_TABLE,
      Item: { userId, configId: ENRICHSO_USAGE_CONFIG_ID, ...fresh },
    }).promise();
  }

  return new DynamoQuotaTracker({
    async readUsage(userId: string): Promise<UsageRow | null> {
      const r = await dynamodb.get({
        TableName: CONFIGS_TABLE,
        Key: { userId, configId: ENRICHSO_USAGE_CONFIG_ID },
      }).promise();
      if (!r.Item) return null;
      return {
        date: r.Item.date,
        validateCount: r.Item.validateCount ?? 0,
        findCount: r.Item.findCount ?? 0,
        reverseCount: r.Item.reverseCount ?? 0,
        lookupByEmailCount: r.Item.lookupByEmailCount ?? 0,
      };
    },
    async writeUsage(userId: string, row: UsageRow): Promise<void> {
      await dynamodb.put({
        TableName: CONFIGS_TABLE,
        Item: { userId, configId: ENRICHSO_USAGE_CONFIG_ID, ...row },
      }).promise();
    },
    async incrementUsage(userId: string, endpoint: EnrichSoEndpoint, today: string): Promise<void> {
      await safeIncrement(userId, `${endpoint}Count`, today);
    },
    async incrementLookupByEmail(userId: string, today: string): Promise<void> {
      await safeIncrement(userId, 'lookupByEmailCount', today);
    },
  });
}

function buildCacheStore(): EnrichSoCacheStore {
  return {
    async get(canonicalId, sk) {
      const item = await crmDb.getEnrichmentCacheItem(canonicalId, sk);
      if (!item) return null;
      // Discriminator check — defend against legacy field-group rows colliding
      // (shouldn't happen given namespacing, but cheap belt-and-suspenders).
      if (item.cacheType !== 'enrichso') return null;
      return item;
    },
    async put(row, opts) {
      await crmDb.putEnrichmentCacheItem({
        ...row,
        cacheType: 'enrichso',
      }, opts);
    },
  };
}

export async function initEnrichSoServiceFromEnv(): Promise<void> {
  const apiKey = await getEnrichSoApiKey();
  const quota = buildQuotaTracker();
  const svc = new EnrichSoService({
    http: buildHttpClient(apiKey),
    store: buildCacheStore(),
    quota,
  });
  initEnrichSoService(svc);
  // Hand the same tracker to the route module so route-level quota
  // (lookup-by-email cap) shares state with the service-level quota.
  const { setQuotaTrackerForLookupRoute } = await import('../routes/crmEnrichSo');
  setQuotaTrackerForLookupRoute(quota);
}
