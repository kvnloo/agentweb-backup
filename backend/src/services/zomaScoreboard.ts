/**
 * ENG-2902 — Zoma launch scoreboard (per-user admin tracker).
 *
 * Definitions (Harsha, launch contract):
 *   - active (rolling 7d): a non-team/test account with >= 1 successful Zoma write — create,
 *     edit, pause or approve — in the last 7 days. "Successful" = an executed toolkit write whose
 *     provider read-back CONFIRMED it (mcp_write_executed, verification CONFIRMED). Only the Zoma
 *     toolkit gateways record mcp_write_executed, so every such event is a Zoma write.
 *   - first successful ad: the first Zoma-created campaign (CONFIRMED CAMPAIGN CREATE through
 *     Zoma) whose go-live was approved through Zoma (CONFIRMED UPDATE status=ACTIVE on the
 *     campaign or one of its ad sets/ads), AND whose provider read-back is effective_status
 *     ACTIVE, AND which has >= 1 impression. Recorded write-once on the user row
 *     (`zomaFirstAdLive`) only after that provider check passes; never inferred.
 *   - team/test accounts (our domains, admins, fixtures — journeyProductBackfill.accountFlag)
 *     are listed but flagged and excluded from every summary count.
 *
 * Reads only existing data (AW-Users attribution + MCP usage events). The one write is the
 * conditional first-ad marker plus the existing forward-only zomaStage → ad_live.
 */
import AWS from 'aws-sdk';
import { tableName } from '../config/constants';
import { accountFlag, type AccountFlag } from './journeyProductBackfill';
import { EMMA_MCP_LOOP_ID, EVT_MCP_WRITE_EXECUTED } from './mcpUsageEventsService';
import { LOOP_EVENTS_TABLE } from '../loops/core/sensors/eventTableEventSource';
import { classifyZomaWrite, type ZomaWriteKind } from './zomaWriteKind';

export { classifyZomaWrite, zomaWriteKindFor, type ZomaWriteKind } from './zomaWriteKind';

export const ACTIVE_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ZomaWriteEvent {
  userId: string;
  ts: string;
  platform?: string;
  entityType?: string;
  action?: string;
  writeKind?: string;
  verification?: string;
  objectId?: string;
}

export interface ZomaUserRecord {
  userId: string;
  email: string;
  isAdmin?: boolean;
  createdAt?: string;
  signupProduct?: string;
  signupRef?: string;
  zomaStage?: string;
  zomaStageAt?: string;
  zomaFirstWriteAt?: string;
  zomaFirstAdLive?: FirstAdLive;
}

export interface FirstAdLive {
  at: string;
  approvedAt: string;
  campaignId: string;
  platform: 'meta';
  effectiveStatus: 'ACTIVE';
  impressions: number;
}

export const isSuccessfulWrite = (e: ZomaWriteEvent) => e.verification === 'CONFIRMED';

export interface ScoreboardRow {
  userId: string;
  email: string;
  excluded?: AccountFlag;
  signupProduct?: string;
  signupRef?: string;
  zomaStage?: string;
  zomaStageAt?: string;
  createdAt?: string;
  firstWriteAt?: string;
  lastSuccessfulWriteAt?: string;
  writes7d: Record<ZomaWriteKind, number> & { total: number };
  active7d: boolean;
  firstAdLive?: FirstAdLive;
  /** CONFIRMED go-live approvals in the window not yet proven by the provider check. */
  goLiveApprovalsAwaitingProof: number;
}

export interface Scoreboard {
  generatedAt: string;
  activeWindowDays: number;
  definitions: Record<'active' | 'firstSuccessfulAd' | 'excluded', string>;
  summary: { zomaUsers: number; activeUsers7d: number; firstAdUsers: number; excludedAccounts: number };
  rows: ScoreboardRow[];
}

export interface ScoreboardDeps {
  listZomaUsers(): Promise<ZomaUserRecord[]>;
  getUser(userId: string): Promise<ZomaUserRecord | undefined>;
  listWriteEvents(startIso: string, endIso: string): Promise<ZomaWriteEvent[]>;
  now(): number;
}

const zeroWrites = () => ({ create: 0, edit: 0, pause: 0, approve: 0, total: 0 });

export async function buildZomaScoreboard(deps: ScoreboardDeps = defaultScoreboardDeps()): Promise<Scoreboard> {
  const now = deps.now();
  const end = new Date(now).toISOString();
  const start = new Date(now - ACTIVE_WINDOW_DAYS * DAY_MS).toISOString();
  const [users, events] = await Promise.all([deps.listZomaUsers(), deps.listWriteEvents(start, end)]);

  const byId = new Map(users.map((u) => [u.userId, u]));
  // A pre-attribution Zoma user (wrote before ENG-2906) is still a Zoma user.
  for (const id of new Set(events.map((e) => e.userId))) {
    if (byId.has(id)) continue;
    const user = await deps.getUser(id);
    if (user) byId.set(id, user);
  }

  const rows: ScoreboardRow[] = [...byId.values()].map((user) => {
    const mine = events.filter((e) => e.userId === user.userId && e.ts >= start && e.ts <= end);
    const ok = mine.filter(isSuccessfulWrite);
    const writes7d = zeroWrites();
    for (const e of ok) { writes7d[classifyZomaWrite(e)] += 1; writes7d.total += 1; }
    const excluded = accountFlag(user.email, user.isAdmin);
    const approvals = ok.filter((e) => classifyZomaWrite(e) === 'approve').length;
    return {
      userId: user.userId,
      email: user.email,
      ...(excluded ? { excluded } : {}),
      signupProduct: user.signupProduct,
      signupRef: user.signupRef,
      zomaStage: user.zomaStage,
      zomaStageAt: user.zomaStageAt,
      createdAt: user.createdAt,
      firstWriteAt: user.zomaFirstWriteAt,
      lastSuccessfulWriteAt: ok.map((e) => e.ts).sort().pop(),
      writes7d,
      active7d: !excluded && writes7d.total > 0,
      ...(user.zomaFirstAdLive ? { firstAdLive: user.zomaFirstAdLive } : {}),
      goLiveApprovalsAwaitingProof: user.zomaFirstAdLive ? 0 : approvals,
    };
  });

  rows.sort((a, b) => Number(!!a.excluded) - Number(!!b.excluded)
    || Number(b.active7d) - Number(a.active7d)
    || String(b.lastSuccessfulWriteAt ?? '').localeCompare(String(a.lastSuccessfulWriteAt ?? ''))
    || a.email.localeCompare(b.email));

  const counted = rows.filter((r) => !r.excluded);
  return {
    generatedAt: end,
    activeWindowDays: ACTIVE_WINDOW_DAYS,
    definitions: {
      active: 'Non-team/test account with at least one provider-confirmed Zoma create, edit, pause or go-live approval in the last 7 days.',
      firstSuccessfulAd: 'First Zoma-created campaign whose go-live was approved through Zoma, read back from the provider as ACTIVE with at least 1 impression.',
      excluded: 'Team (our domains or admin) and test/fixture accounts are listed but never counted.',
    },
    summary: {
      zomaUsers: counted.length,
      activeUsers7d: counted.filter((r) => r.active7d).length,
      firstAdUsers: counted.filter((r) => r.firstAdLive).length,
      excludedAccounts: rows.length - counted.length,
    },
    rows,
  };
}

// ---------------------------------------------------------------------------------------------
// First successful ad — provider-verified, write-once.
// ---------------------------------------------------------------------------------------------

export type FirstAdOutcome =
  | 'verified' | 'already_recorded' | 'no_go_live_approval' | 'not_zoma_created'
  | 'not_active' | 'no_impressions' | 'provider_error';

export interface FirstAdResult {
  userId: string;
  outcome: FirstAdOutcome;
  campaignId?: string;
  effectiveStatus?: string;
  impressions?: number;
  error?: string;
}

export interface FirstAdDeps {
  listWriteEvents(startIso: string, endIso: string): Promise<ZomaWriteEvent[]>;
  getUser(userId: string): Promise<ZomaUserRecord | undefined>;
  /** Provider read-back of a campaign the user owns; null when not found in any of their accounts. */
  readCampaign(userId: string, campaignId: string): Promise<{ accountId: string; effectiveStatus?: string } | null>;
  /** Campaign of an approved ad set / ad (provider read); null when unresolvable. */
  campaignOf(userId: string, entityType: string, objectId: string): Promise<string | null>;
  /** Lifetime impressions of a campaign. */
  campaignImpressions(userId: string, accountId: string, campaignId: string): Promise<number>;
  /** Conditional write-once; false when a first ad is already recorded. */
  recordFirstAd(userId: string, record: FirstAdLive): Promise<boolean>;
  onFirstAd?(userId: string, record: FirstAdLive): Promise<void>;
  now(): number;
}

export const FIRST_AD_LOOKBACK_DAYS = 60;
const MAX_APPROVALS_CHECKED = 10;

/**
 * Check every user with a Zoma go-live approval (CONFIRMED UPDATE status=ACTIVE) and no recorded
 * first ad. A campaign only counts if this user created it through Zoma (CONFIRMED CAMPAIGN
 * CREATE) within the lookback. Bounded: at most `maxUsers` users, 10 approvals per user.
 */
export async function verifyZomaFirstAds(
  deps: FirstAdDeps,
  opts: { userId?: string; maxUsers?: number; lookbackDays?: number } = {},
): Promise<FirstAdResult[]> {
  const now = deps.now();
  const events = (await deps.listWriteEvents(
    new Date(now - (opts.lookbackDays ?? FIRST_AD_LOOKBACK_DAYS) * DAY_MS).toISOString(),
    new Date(now).toISOString(),
  )).filter(isSuccessfulWrite);
  const approvalsByUser = new Map<string, ZomaWriteEvent[]>();
  for (const e of events) {
    if (classifyZomaWrite(e) !== 'approve' || (e.platform && e.platform !== 'meta') || !e.objectId) continue;
    if (opts.userId && e.userId !== opts.userId) continue;
    approvalsByUser.set(e.userId, [...(approvalsByUser.get(e.userId) ?? []), e]);
  }
  if (opts.userId && !approvalsByUser.has(opts.userId)) return [{ userId: opts.userId, outcome: 'no_go_live_approval' }];

  const results: FirstAdResult[] = [];
  for (const [userId, approvals] of [...approvalsByUser].slice(0, opts.maxUsers ?? 25)) {
    const user = await deps.getUser(userId);
    if (user?.zomaFirstAdLive) { results.push({ userId, outcome: 'already_recorded', campaignId: user.zomaFirstAdLive.campaignId }); continue; }
    const created = new Set(events
      .filter((e) => e.userId === userId && e.entityType === 'CAMPAIGN' && String(e.action).toUpperCase() === 'CREATE' && e.objectId)
      .map((e) => e.objectId as string));
    let best: FirstAdResult = { userId, outcome: 'not_zoma_created' };
    const rank: FirstAdOutcome[] = ['not_zoma_created', 'provider_error', 'not_active', 'no_impressions'];
    // Oldest approval first: the FIRST successful ad.
    for (const approval of approvals.sort((a, b) => a.ts.localeCompare(b.ts)).slice(0, MAX_APPROVALS_CHECKED)) {
      let attempt: FirstAdResult;
      try {
        attempt = await checkApproval(deps, userId, approval, created);
      } catch (error) {
        attempt = { userId, outcome: 'provider_error', error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' };
      }
      if (attempt.outcome === 'verified') {
        const record: FirstAdLive = {
          at: new Date(now).toISOString(), approvedAt: approval.ts, campaignId: attempt.campaignId!,
          platform: 'meta', effectiveStatus: 'ACTIVE', impressions: attempt.impressions!,
        };
        const wrote = await deps.recordFirstAd(userId, record);
        if (wrote) await deps.onFirstAd?.(userId, record);
        best = wrote ? attempt : { ...attempt, outcome: 'already_recorded' };
        break;
      }
      if (rank.indexOf(attempt.outcome) > rank.indexOf(best.outcome)) best = attempt;
    }
    results.push(best);
  }
  return results;
}

async function checkApproval(deps: FirstAdDeps, userId: string, approval: ZomaWriteEvent, created: Set<string>): Promise<FirstAdResult> {
  const entity = String(approval.entityType ?? '').toUpperCase();
  const campaignId = entity === 'CAMPAIGN' ? approval.objectId! : await deps.campaignOf(userId, entity, approval.objectId!);
  if (!campaignId || !created.has(campaignId)) return { userId, outcome: 'not_zoma_created', ...(campaignId ? { campaignId } : {}) };
  const campaign = await deps.readCampaign(userId, campaignId);
  if (!campaign) return { userId, outcome: 'provider_error', campaignId, error: 'campaign not readable in any connected Meta account' };
  if (campaign.effectiveStatus !== 'ACTIVE') return { userId, outcome: 'not_active', campaignId, effectiveStatus: campaign.effectiveStatus };
  const impressions = await deps.campaignImpressions(userId, campaign.accountId, campaignId);
  if (!(impressions >= 1)) return { userId, outcome: 'no_impressions', campaignId, effectiveStatus: 'ACTIVE', impressions };
  return { userId, outcome: 'verified', campaignId, effectiveStatus: 'ACTIVE', impressions };
}

// ---------------------------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------------------------

let doc: AWS.DynamoDB.DocumentClient | undefined;
const client = () => (doc ??= new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' }));
const USER_FIELDS = ['userId', 'email', 'isAdmin', 'createdAt', 'signupProduct', 'signupRef', 'zomaStage', 'zomaStageAt', 'zomaFirstWriteAt', 'zomaFirstAdLive'];

function toUserRecord(item: any): ZomaUserRecord | undefined {
  if (!item?.userId || !item?.email) return undefined;
  const out: any = {};
  for (const f of USER_FIELDS) if (item[f] !== undefined) out[f] = item[f];
  return out as ZomaUserRecord;
}

function toWriteEvent(item: any): ZomaWriteEvent | undefined {
  const d = item?.dimensions ?? {};
  if (item?.eventType !== EVT_MCP_WRITE_EXECUTED || !item?.subjectId || !item?.ts) return undefined;
  return {
    userId: item.subjectId, ts: item.ts, platform: d.platform, entityType: d.entityType, action: d.action,
    writeKind: d.writeKind, verification: d.verification, objectId: d.objectId,
  };
}

export async function listZomaWriteEvents(startIso: string, endIso: string): Promise<ZomaWriteEvent[]> {
  const out: ZomaWriteEvent[] = [];
  let ExclusiveStartKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  do {
    const page = await client().query({
      TableName: LOOP_EVENTS_TABLE,
      KeyConditionExpression: 'loopId = :loopId AND tsSession BETWEEN :start AND :end',
      FilterExpression: 'eventType = :write',
      ExpressionAttributeValues: { ':loopId': EMMA_MCP_LOOP_ID, ':start': startIso, ':end': endIso, ':write': EVT_MCP_WRITE_EXECUTED },
      ExclusiveStartKey,
    }).promise();
    for (const item of page.Items ?? []) { const e = toWriteEvent(item); if (e) out.push(e); }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

async function listZomaUsers(): Promise<ZomaUserRecord[]> {
  const out: ZomaUserRecord[] = [];
  let ExclusiveStartKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  do {
    const page = await client().scan({
      TableName: tableName('AW-Users'),
      FilterExpression: 'attribute_exists(#products.#zoma) OR #signupProduct = :zoma',
      ProjectionExpression: USER_FIELDS.map((f) => `#${f}`).join(', '),
      ExpressionAttributeNames: {
        '#products': 'products', '#zoma': 'zoma',
        ...Object.fromEntries(USER_FIELDS.map((f) => [`#${f}`, f])),
      },
      ExpressionAttributeValues: { ':zoma': 'zoma' },
      ExclusiveStartKey,
    }).promise();
    for (const item of page.Items ?? []) { const u = toUserRecord(item); if (u) out.push(u); }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

async function getUser(userId: string): Promise<ZomaUserRecord | undefined> {
  const { userDb } = await import('./db');
  return toUserRecord(await userDb.getUserById(userId));
}

export function defaultScoreboardDeps(): ScoreboardDeps {
  return { listZomaUsers, getUser, listWriteEvents: listZomaWriteEvents, now: () => Date.now() };
}

async function metaAdAccountIds(userId: string): Promise<string[]> {
  const { getAccountsByUserIdIncludingOrgShared } = await import('./connectedAccountsDb');
  const { isMetaAdAccount } = await import('./metaTokenRefresh');
  const { META_PROVIDER } = await import('../mcp/zomaProviders');
  const accounts = await getAccountsByUserIdIncludingOrgShared(userId);
  const ids = accounts.filter((a) => isMetaAdAccount(a)).flatMap((a) => META_PROVIDER.accountIds(a));
  return [...new Set(ids)].slice(0, 10);
}

export function defaultFirstAdDeps(): FirstAdDeps {
  const ams = async () => (await import('./agentModeService')).agentModeService;
  return {
    listWriteEvents: listZomaWriteEvents,
    getUser,
    async readCampaign(userId, campaignId) {
      const service = await ams();
      for (const accountId of await metaAdAccountIds(userId)) {
        const node = await service.readBackMetaWriteTarget(userId, accountId, 'CAMPAIGN', campaignId).catch(() => null);
        if (node?.id) return { accountId, effectiveStatus: node.effective_status };
      }
      return null;
    },
    async campaignOf(userId, entityType, objectId) {
      const service = await ams();
      for (const accountId of await metaAdAccountIds(userId)) {
        if (entityType === 'AD_SET') {
          const node: any = await service.readBackMetaWriteTarget(userId, accountId, 'AD_SET', objectId).catch(() => null);
          if (node?.campaign_id) return String(node.campaign_id);
        } else if (entityType === 'AD') {
          // Ad-level insights carry campaign_id; an ad with no delivery has no row (and no impressions).
          const res: any = await service.callMetaAdsInsightsApiWrapper(userId, {
            account_id: accountId, object_type: 'ad' as any, object_id: objectId, fields: ['campaign_id', 'impressions'], date_preset: 'maximum',
          }).catch(() => null);
          const row = Array.isArray(res?.data) ? res.data.find((r: any) => r?.campaign_id) : undefined;
          if (row) return String(row.campaign_id);
        }
      }
      return null;
    },
    async campaignImpressions(userId, accountId, campaignId) {
      const res: any = await (await ams()).callMetaAdsInsightsApiWrapper(userId, {
        account_id: accountId, object_type: 'campaign' as any, object_id: campaignId, fields: ['impressions'], date_preset: 'maximum',
      });
      if (res?.success === false) throw new Error(String(res.error ?? 'insights read failed').slice(0, 200));
      const rows = Array.isArray(res?.data) ? res.data : [];
      return rows.reduce((sum: number, r: any) => sum + (Number(r?.impressions) || 0), 0);
    },
    async recordFirstAd(userId, record) {
      const user = await getUser(userId);
      if (!user) return false;
      try {
        await client().update({
          TableName: tableName('AW-Users'),
          Key: { email: user.email },
          UpdateExpression: 'SET #f = :record',
          ConditionExpression: 'attribute_exists(#email) AND #uid = :uid AND attribute_not_exists(#f)',
          ExpressionAttributeNames: { '#f': 'zomaFirstAdLive', '#email': 'email', '#uid': 'userId' },
          ExpressionAttributeValues: { ':record': record, ':uid': userId },
        }).promise();
        return true;
      } catch (error: any) {
        if (error?.code === 'ConditionalCheckFailedException') return false;
        throw error;
      }
    },
    async onFirstAd(userId) {
      const { zomaMilestone } = await import('./journeyMilestones');
      await zomaMilestone(userId, 'ad_live', { emit: 'always', props: { product: 'zoma', platform: 'meta' } });
    },
    now: () => Date.now(),
  };
}
