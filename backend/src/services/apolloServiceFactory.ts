/**
 * Wires axios → Apollo + DynamoDB cache store to ApolloService.
 *
 * Kept separate from apolloService.ts so the core service stays free of
 * AWS/axios imports for fast unit tests.
 *
 * Call initApolloServiceFromEnv() once at server boot. The boot site should
 * wrap this in try/catch so a missing API key (Secrets Manager not yet
 * provisioned) doesn't crash boot — Apollo features simply stay dormant
 * until the secret is in place.
 */

import axios from 'axios';
import AWS from 'aws-sdk';
import {
  ApolloService,
  initApolloService,
  type ApolloHttpClient,
  type ApolloCacheStore,
} from './apolloService';
import {
  DynamoApolloQuotaTracker,
  APOLLO_USAGE_CONFIG_ID,
  type ApolloUsageRow,
  type ApolloQuotaTracker,
  type ApolloEndpoint,
} from './apolloQuota';
import { crmDb } from './db';
import { getApolloApiKey, getApolloWebhookSecret } from '../utils/secretsManager';

const APOLLO_BASE_URL = 'https://api.apollo.io/api/v1';
const TABLE_PREFIX = process.env.NODE_ENV === 'production' ? '' : 'Dev-';
const CONFIGS_TABLE = `${TABLE_PREFIX}AW-Configs`;

/**
 * Build the public webhook URL Apollo will POST async waterfall results to.
 * Auth is sent in a custom header (X-Apollo-Webhook-Secret) supplied to
 * Apollo via webhook_headers, not as a URL query param — query strings land
 * in nginx access logs and LB traces.
 */
function buildWebhookUrl(): string | null {
  const base = process.env.BACKEND_URL || process.env.PUBLIC_BASE_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/api/crm/webhooks/apollo`;
}

/**
 * Header bag delivered to Apollo alongside webhook_url so they include it on
 * the callback POST. Keyed under APOLLO_WEBHOOK_SECRET (set during init).
 * Returns null when the secret isn't loaded — caller must skip Tier 3 in
 * that case rather than send an unauthenticated webhook URL.
 */
function buildWebhookHeaders(): Record<string, string> | null {
  const secret = process.env.APOLLO_WEBHOOK_SECRET;
  if (!secret) return null;
  return { 'X-Apollo-Webhook-Secret': secret };
}

function buildHttpClient(apiKey: string): ApolloHttpClient {
  const client = axios.create({
    baseURL: APOLLO_BASE_URL,
    headers: {
      // Apollo accepts both Authorization and X-Api-Key. Use X-Api-Key so we
      // don't need to remember the "Bearer " prefix and to match the API
      // dashboard's quickstart examples.
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
    },
    timeout: 30_000,
  });

  return {
    async match(input) {
      try {
        const body: any = {};
        if (input.linkedinUrl) body.linkedin_url = input.linkedinUrl;
        if (input.email) body.email = input.email;
        if (input.firstName) body.first_name = input.firstName;
        if (input.lastName) body.last_name = input.lastName;
        if (input.organizationName) body.organization_name = input.organizationName;
        if (input.domain) body.domain = input.domain;
        const r = await client.post('/people/match', body);
        return r.data;
      } catch (err: any) {
        const status = err?.response?.status;
        // 404 / 422 → translate to a "person not found" envelope so the
        // service's negative-classifier routes it into the 7d not-found bucket
        // instead of the 1h error bucket. Without this we'd re-hit Apollo
        // every hour for known-not-found leads.
        if (status === 404 || status === 422) return { person: null };
        throw err;
      }
    },
    async findEmail(input) {
      try {
        // Two modes:
        //   default: basic /people/match (1 credit, sync, first-party data only)
        //   runWaterfall=true: enables Apollo's run_waterfall_email broker chain.
        //     Sync hits return immediately; broker hits POST to webhook_url
        //     later. Variable credit cost.
        //
        // linkedinUrl is an optional bonus signal — when the caller has it,
        // Apollo's /people/match prioritizes it over name+domain matching.
        //
        // Identifier handling: prefer `domain` (strict canonical match). Fall
        // back to `organization_name` (looser name match) only when no domain
        // is available. The service layer enforces mutual exclusion so we
        // never send both — sending a company-name string as `domain` would
        // corrupt match heuristics and pollute the cache for 60-90 days.
        const body: any = {
          first_name: input.firstName,
          last_name: input.lastName,
        };
        if (input.domain) body.domain = input.domain;
        else if (input.organizationName) body.organization_name = input.organizationName;
        if (input.linkedinUrl) body.linkedin_url = input.linkedinUrl;
        if (input.runWaterfall) {
          const webhook = input.webhookUrl ?? buildWebhookUrl();
          const headers = buildWebhookHeaders();
          if (!webhook || !headers) {
            // No webhook URL or no secret loaded → can't safely enable
            // run_waterfall_email (callback would be unauthenticated).
            // Fall back to basic match so the waterfall still works.
            console.warn('[apollo] runWaterfall requested but webhook auth not configured — sending basic match instead');
          } else {
            body.run_waterfall_email = true;
            body.webhook_url = webhook;
            // Apollo posts these on the callback request alongside the body.
            body.webhook_headers = headers;
          }
        }
        const r = await client.post('/people/match', body);
        return r.data;
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 404 || status === 422) return { person: null };
        throw err;
      }
    },
    async enrichOrg(domain) {
      try {
        const r = await client.get('/organizations/enrich', { params: { domain } });
        return r.data;
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 404) return { organization: null };
        throw err;
      }
    },
  };
}

function buildQuotaTracker(): ApolloQuotaTracker {
  const dynamodb = new AWS.DynamoDB.DocumentClient();

  /**
   * Race-safe day-rollover counter. Mirrors the pattern in
   * enrichSoServiceFactory.ts so the two providers behave identically when
   * concurrent first-of-day increments hit. See that file for full rationale.
   */
  async function safeIncrement(userId: string, counterAttr: string, today: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await dynamodb.update({
          TableName: CONFIGS_TABLE,
          Key: { userId, configId: APOLLO_USAGE_CONFIG_ID },
          UpdateExpression: 'ADD #c :one',
          ConditionExpression: '#date = :today',
          ExpressionAttributeNames: { '#c': counterAttr, '#date': 'date' },
          ExpressionAttributeValues: { ':one': 1, ':today': today },
        }).promise();
        return;
      } catch (err: any) {
        if (err.code !== 'ConditionalCheckFailedException') throw err;
        try {
          const fresh: ApolloUsageRow = {
            date: today,
            matchCount: counterAttr === 'matchCount' ? 1 : 0,
            findCount: counterAttr === 'findCount' ? 1 : 0,
            orgCount: counterAttr === 'orgCount' ? 1 : 0,
          };
          await dynamodb.put({
            TableName: CONFIGS_TABLE,
            Item: { userId, configId: APOLLO_USAGE_CONFIG_ID, ...fresh },
            ConditionExpression: 'attribute_not_exists(userId) OR #date <> :today',
            ExpressionAttributeNames: { '#date': 'date' },
            ExpressionAttributeValues: { ':today': today },
          }).promise();
          return;
        } catch (putErr: any) {
          if (putErr.code !== 'ConditionalCheckFailedException') throw putErr;
        }
      }
    }
    const fresh: ApolloUsageRow = {
      date: today,
      matchCount: counterAttr === 'matchCount' ? 1 : 0,
      findCount: counterAttr === 'findCount' ? 1 : 0,
      orgCount: counterAttr === 'orgCount' ? 1 : 0,
    };
    await dynamodb.put({
      TableName: CONFIGS_TABLE,
      Item: { userId, configId: APOLLO_USAGE_CONFIG_ID, ...fresh },
    }).promise();
  }

  return new DynamoApolloQuotaTracker({
    async readUsage(userId: string): Promise<ApolloUsageRow | null> {
      const r = await dynamodb.get({
        TableName: CONFIGS_TABLE,
        Key: { userId, configId: APOLLO_USAGE_CONFIG_ID },
      }).promise();
      if (!r.Item) return null;
      return {
        date: r.Item.date,
        matchCount: r.Item.matchCount ?? 0,
        findCount: r.Item.findCount ?? 0,
        orgCount: r.Item.orgCount ?? 0,
      };
    },
    async writeUsage(userId: string, row: ApolloUsageRow): Promise<void> {
      await dynamodb.put({
        TableName: CONFIGS_TABLE,
        Item: { userId, configId: APOLLO_USAGE_CONFIG_ID, ...row },
      }).promise();
    },
    async incrementUsage(userId: string, endpoint: ApolloEndpoint, today: string): Promise<void> {
      await safeIncrement(userId, `${endpoint}Count`, today);
    },
  });
}

function buildCacheStore(): ApolloCacheStore {
  return {
    async get(canonicalId, sk) {
      const item = await crmDb.getEnrichmentCacheItem(canonicalId, sk);
      if (!item) return null;
      // Discriminator check defends against legacy rows accidentally landing on
      // the same PK/SK from a different producer.
      if (item.cacheType !== 'apollo') return null;
      return item as any;
    },
    async put(row, opts) {
      await crmDb.putEnrichmentCacheItem({
        ...row,
        cacheType: 'apollo',
      }, opts);
    },
  };
}

export async function initApolloServiceFromEnv(): Promise<void> {
  const apiKey = await getApolloApiKey();
  // Stamp the webhook secret onto process.env so buildWebhookUrl() (called
  // from inside the HTTP client per-request) can reach it without re-fetching
  // from Secrets Manager. Failure here is non-fatal — Tier 3 (run_waterfall_email)
  // will fall back to basic match if the secret can't load.
  try {
    process.env.APOLLO_WEBHOOK_SECRET = await getApolloWebhookSecret();
  } catch (err) {
    console.warn('[apollo] webhook secret not loaded — Tier 3 waterfall calls will fall back to basic match:', (err as Error).message);
  }
  const quota = buildQuotaTracker();
  const svc = new ApolloService({
    http: buildHttpClient(apiKey),
    store: buildCacheStore(),
    quota,
  });
  initApolloService(svc);
}
