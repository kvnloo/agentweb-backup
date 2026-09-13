import AWS from 'aws-sdk';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { EvaluationDenied, isEvaluationUser, SANDBOX_TOOL_CLASS_NAMES } from './evaluationPolicy';
import { mintSandboxToken, sandboxAdAccountId } from './sandbox/sentinel';

/** The sandbox policy: one row per principal, authoritative for every gate. */
export interface EvaluationRecord {
  userId: string;
  email: string;
  status: 'active' | 'revoked';
  expiresAt: number;
  mode: 'sandbox';
  label: string;
  datasetId?: string;
  datasetVersion?: number;
  connectors: { meta: 'simulated' };
  deniedToolClasses: string[];
  provisionedBy?: string;
  reviewerUserIds?: string[];
}
export interface ProvisionEvaluation {
  email: string;
  displayName: string;
  password: string;
  expiresAt: number;
  brandGuidelines: { brandName: string; website?: string; description?: string };
  /** The frozen dataset the simulated Meta connection serves (ENG-1908). Required: an account with no data is not a sandbox. */
  datasetId: string;
  datasetVersion: number;
  reviewerUserIds?: string[];
  label?: string;
  deniedToolClasses?: string[];
}

export const SANDBOX_TIER_NAME = 'Sandbox';

/** The tier row bounds usage and tool/page/connector visibility; without it the product fails open. */
export class SandboxTierMissing extends Error {
  constructor() {
    super(`The "${SANDBOX_TIER_NAME}" subscription tier is not defined in the subscription_types setting; run scripts/ensure-sandbox-tier.ts before provisioning.`);
  }
}

/** The pinned dataset must already be loaded; a connection pointing at nothing would read as a broken Meta account. */
export class SandboxDatasetMissing extends Error {
  constructor(datasetId: string, version: number) {
    super(`Sandbox dataset ${datasetId}@${version} is not loaded; compile and load it before provisioning.`);
  }
}

/** What provisioning needs to know about a dataset: just enough to write a believable connection row. */
export interface SandboxDatasetSummary {
  account: { account_id: string; currency: string; name: string; timezone_name: string };
}
export interface SandboxProvisionDeps {
  loadDatasetSummary(datasetId: string, version: number): Promise<SandboxDatasetSummary | null>;
}
let provisionDeps: SandboxProvisionDeps = {
  // Lazy: the dataset store pulls in the whole simulator module graph, which the policy
  // read path (every request) must never pay for.
  loadDatasetSummary: (datasetId, version) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { sandboxDatasetStore } = require('./sandbox/sandboxDatasetStore');
    return sandboxDatasetStore.loadDatasetSummary(datasetId, version);
  },
};
/** Test seam (and future alternate dataset sources). */
export function setSandboxProvisionDeps(deps: SandboxProvisionDeps): void { provisionDeps = deps; }

/** The simulated token must outlive the account by a wide margin so no refresh path ever fires. */
const SANDBOX_TOKEN_GRACE_MS = 90 * 86400000;
const SANDBOX_REQUESTED_SCOPES = ['ads_management', 'ads_read', 'business_management', 'pages_show_list'];
const SANDBOX_GRANTED_SCOPES = ['ads_management', 'ads_read'];

const ID_PATTERN = /^[a-zA-Z0-9-]{1,100}$/;

/** Sandbox policy, audit and (from phase 2) dataset/overlay rows live only in AW-Evaluations. */
export class EvaluationStore {
  private prefix = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
  private table = `${this.prefix}AW-Evaluations`;
  private users = `${this.prefix}AW-Users`;
  constructor(private db = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' })) {}

  private key(userId: string) {
    if (!isEvaluationUser(userId) || !/^eval_[a-zA-Z0-9-]+$/.test(userId)) throw new EvaluationDenied();
    return { evaluationKey: `evaluation/${userId}` };
  }

  /** Normalizes legacy ENG-1870 rows (budget, materials, artifacts, toy simulation) into the policy shape. */
  async get(userId: string): Promise<EvaluationRecord | null> {
    const result = await this.db.get({ TableName: this.table, Key: this.key(userId), ConsistentRead: true }).promise();
    if (!result.Item) return null;
    const item = result.Item as Record<string, unknown>;
    if (item.userId !== userId) throw new EvaluationDenied();
    const persistedDeniedToolClasses = Array.isArray(item.deniedToolClasses)
      ? item.deniedToolClasses.filter((c): c is string => typeof c === 'string' && SANDBOX_TOOL_CLASS_NAMES.includes(c))
      : null;
    const record: EvaluationRecord = {
      userId,
      email: item.email as string,
      status: item.status as EvaluationRecord['status'],
      expiresAt: item.expiresAt as number,
      mode: 'sandbox',
      label: typeof item.label === 'string' && item.label ? item.label : 'Sandbox',
      connectors: { meta: 'simulated' },
      deniedToolClasses: persistedDeniedToolClasses === null || (item.deniedToolClasses as unknown[]).length > 0 && persistedDeniedToolClasses.length === 0
        ? [...SANDBOX_TOOL_CLASS_NAMES]
        : persistedDeniedToolClasses,
    };
    if (typeof item.datasetId === 'string') record.datasetId = item.datasetId;
    if (typeof item.datasetVersion === 'number') record.datasetVersion = item.datasetVersion;
    if (typeof item.provisionedBy === 'string') record.provisionedBy = item.provisionedBy;
    if (Array.isArray(item.reviewerUserIds)) record.reviewerUserIds = item.reviewerUserIds.filter((id): id is string => typeof id === 'string');
    return record;
  }

  private audit(userId: string, actor: string, action: string, details: Record<string, unknown> = {}) {
    return { Put: { TableName: this.table, Item: {
      evaluationKey: `evaluation/${userId}/audit/${randomUUID()}`, userId, actor, action, at: new Date().toISOString(), ...details,
    }, ConditionExpression: 'attribute_not_exists(evaluationKey)' } };
  }

  async provision(actor: string, input: ProvisionEvaluation) {
    if (!input || typeof input !== 'object' ||
        typeof input.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || input.email.length > 254 ||
        typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.length > 100 ||
        typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 72 ||
        !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 30 * 86400000) throw new EvaluationDenied();
    const brand = input.brandGuidelines;
    if (!brand || typeof brand !== 'object' || typeof brand.brandName !== 'string' || !brand.brandName.trim() || brand.brandName.length > 100 ||
        (brand.website !== undefined && (typeof brand.website !== 'string' || brand.website.length > 500)) ||
        (brand.description !== undefined && (typeof brand.description !== 'string' || brand.description.length > 2000))) throw new EvaluationDenied();
    if (input.reviewerUserIds !== undefined && (!Array.isArray(input.reviewerUserIds) || input.reviewerUserIds.length > 5 ||
      input.reviewerUserIds.some(id => typeof id !== 'string' || !ID_PATTERN.test(id)))) throw new EvaluationDenied();
    if (input.label !== undefined && (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 40)) throw new EvaluationDenied();
    if (typeof input.datasetId !== 'string' || !ID_PATTERN.test(input.datasetId)) throw new EvaluationDenied();
    if (!Number.isSafeInteger(input.datasetVersion) || input.datasetVersion < 1) throw new EvaluationDenied();
    if (input.deniedToolClasses !== undefined && (!Array.isArray(input.deniedToolClasses) ||
      input.deniedToolClasses.some(c => typeof c !== 'string' || !SANDBOX_TOOL_CLASS_NAMES.includes(c)))) throw new EvaluationDenied();

    const { getSubscriptionTypeConfig } = await import('./subscriptionService');
    if (!(await getSubscriptionTypeConfig(SANDBOX_TIER_NAME))) throw new SandboxTierMissing();
    const dataset = await provisionDeps.loadDatasetSummary(input.datasetId, input.datasetVersion);
    if (!dataset) throw new SandboxDatasetMissing(input.datasetId, input.datasetVersion);

    const userId = `eval_${randomUUID()}`;
    const email = input.email.toLowerCase();
    const deniedToolClasses = input.deniedToolClasses === undefined
      ? [...SANDBOX_TOOL_CLASS_NAMES]
      : [...new Set([...input.deniedToolClasses, 'lifecycle'])];
    const record: EvaluationRecord = {
      userId, email, status: 'active', expiresAt: input.expiresAt, mode: 'sandbox',
      label: input.label?.trim() || 'Sandbox', connectors: { meta: 'simulated' }, deniedToolClasses,
      provisionedBy: actor, reviewerUserIds: input.reviewerUserIds || [],
      datasetId: input.datasetId, datasetVersion: input.datasetVersion,
    };
    const now = new Date().toISOString();
    // The simulated Meta connection (ENG-1908 AC 1). Same shape routes/metaAuth.ts writes for a
    // real ad account, so Settings → Connected accounts, list_connected_accounts and every
    // credential resolver treat it as Connected + ads-capable. The token is a sentinel the Graph
    // interceptor recognizes; it is never sent to Meta and never refreshed (metaTokenRefresh.ts).
    // The ad account id is derived from the principal, not copied from the dataset, so two
    // sandboxes on one dataset never share an id.
    const adAccountId = sandboxAdAccountId(userId);
    const connectedAccounts = [{
      platform: 'meta', account_id: adAccountId, account_name: dataset.account.name, created_at: now, updated_at: now,
      config: {
        account_type: 'ad_account', ad_account_id: adAccountId, currency: dataset.account.currency, account_status: 1,
        access_token: mintSandboxToken(userId), token_expires_at: input.expiresAt + SANDBOX_TOKEN_GRACE_MS,
        scopes: SANDBOX_REQUESTED_SCOPES, granted_scopes: SANDBOX_GRANTED_SCOPES,
      },
    }];
    // The full brandGuidelines shape (services/db.ts User.brandGuidelines): the portal keys onboarding
    // off brandData.brandName and the brand page reads every array field.
    const brandGuidelines = {
      brandData: {
        brandName: brand.brandName.trim(), tagline: brand.description?.trim() || '',
        ...(brand.website ? { domain: brand.website.trim() } : {}),
        primaryColor: '#ECAC5F', primaryColorEnd: '#ECAC5F', secondaryColor: '#7A6999', fontFamily: 'Inter',
        toneOfVoice: '', keyMessages: [], brandValues: [], targetAudience: '', brandPersonality: '', isGradient: false, founders: [],
      },
      attachments: [], createdAt: now, updatedAt: now,
    };
    const audit = this.audit(userId, actor, 'provision', { label: record.label, datasetId: record.datasetId, datasetVersion: record.datasetVersion, deniedToolClasses });
    await this.db.transactWrite({ TransactItems: [
      { Put: { TableName: this.users, Item: {
        email, userId, displayName: input.displayName.trim(), password: await bcrypt.hash(input.password, 12),
        isOAuthUser: false, isAdmin: false, isActive: true, roles: ['customer'],
        subscriptionType: SANDBOX_TIER_NAME, subscription_status: 'active', sessionVersion: 0,
        signupSource: 'evaluation', createdAt: now, brandGuidelines, connected_accounts: connectedAccounts,
        memoryEnabled: false, emailNotificationsEnabled: false, emmaTipsEnabled: false,
      }, ConditionExpression: 'attribute_not_exists(email)' } },
      { Put: { TableName: this.table, Item: { ...this.key(userId), ...record }, ConditionExpression: 'attribute_not_exists(evaluationKey)' } },
      audit,
    ] }).promise();
    return { userId, expiresAt: record.expiresAt, audit: audit.Put.Item };
  }

  /** Explicit assignment, never organization membership, authorizes reviewer access. */
  async requireReview(actor: string, userId: string) {
    const record = await this.get(userId);
    if (!record || record.userId !== userId || (record.provisionedBy !== actor &&
      (!Array.isArray(record.reviewerUserIds) || !record.reviewerUserIds.includes(actor)))) throw new EvaluationDenied();
    return record;
  }

  async review(actor: string, userId: string) {
    const record = await this.requireReview(actor, userId);
    const audit: Record<string, unknown>[] = [];
    let cursor: AWS.DynamoDB.DocumentClient.Key | undefined;
    let pages = 0;
    do {
      const page = await this.db.scan({ TableName: this.table, ConsistentRead: true, Limit: 100,
        FilterExpression: 'userId = :user AND begins_with(evaluationKey, :prefix)',
        ExpressionAttributeValues: { ':user': userId, ':prefix': `evaluation/${userId}/audit/` },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }).promise();
      if (!Array.isArray(page.Items)) throw new EvaluationDenied();
      for (const item of page.Items) {
        if (!item || item.userId !== userId || typeof item.evaluationKey !== 'string' || !item.evaluationKey.startsWith(`evaluation/${userId}/audit/`)) throw new EvaluationDenied();
        audit.push(item);
      }
      cursor = page.LastEvaluatedKey; pages++;
    } while (cursor && audit.length < 1000 && pages < 100);
    return { userId, status: record.status, audit, truncated: !!cursor };
  }

  async discardJob(userId: string, scheduleId: string) {
    this.key(userId);
    if (typeof scheduleId !== 'string' || !scheduleId) throw new EvaluationDenied();
    try {
      await this.db.delete({ TableName: `${this.prefix}AW-TaskSchedules`, Key: { scheduleId },
        ConditionExpression: 'userId = :user', ExpressionAttributeValues: { ':user': userId },
      }).promise();
    } catch (error: any) { if (error?.code !== 'ConditionalCheckFailedException') throw error; }
  }

  async revoke(actor: string, userId: string) {
    const record = await this.get(userId);
    if (!record || record.userId !== userId || typeof record.email !== 'string') throw new EvaluationDenied();
    const audit = this.audit(userId, actor, 'revoke', { cleanupStatus: 'pending' });
    // This marker is committed with the deny state, so incomplete cleanup remains
    // durable even when both cleanup and the best-effort failure audit write fail.
    const writes: AWS.DynamoDB.DocumentClient.TransactWriteItemList = [
      { Update: { TableName: this.table, Key: this.key(userId),
        UpdateExpression: 'SET #status = :revoked', ConditionExpression: 'userId = :user',
        ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':revoked': 'revoked', ':user': userId },
      } },
      { Update: { TableName: this.users, Key: { email: record.email },
        UpdateExpression: 'SET isActive = :inactive ADD sessionVersion :one, delegateTokenEpoch :one',
        ConditionExpression: 'userId = :user', ExpressionAttributeValues: { ':inactive': false, ':one': 1, ':user': userId },
      } }, audit,
    ];
    try {
      await this.db.transactWrite({ TransactItems: writes }).promise();
    } catch (error: any) {
      // A separately deleted/replaced account must not keep its policy or MCP grants alive.
      const reasons = error?.CancellationReasons;
      if (!Array.isArray(reasons) || reasons.length !== 3 || reasons[1]?.Code !== 'ConditionalCheckFailed' ||
          reasons.some((r, i) => i !== 1 && r?.Code !== 'None')) throw error;
      await this.db.transactWrite({ TransactItems: [writes[0], writes[2]] }).promise();
    }
    let cleanup: Record<string, number>;
    try { cleanup = await this.cleanupCredentials(userId); } catch (error) {
      try { await this.db.transactWrite({ TransactItems: [this.audit(userId, actor, 'revocation-cleanup-failed')] }).promise(); } catch {
        // The original revoke audit is already committed. Keep the cleanup failure.
      }
      throw error;
    }
    const cleanupAudit = this.audit(userId, actor, 'revocation-cleanup');
    await this.db.transactWrite({ TransactItems: [{ Put: { ...cleanupAudit.Put, Item: { ...cleanupAudit.Put.Item, cleanup } } }] }).promise();
    return { userId, status: 'revoked', audit: audit.Put.Item, cleanup, cleanupAudit: cleanupAudit.Put.Item };
  }

  private async cleanupCredentials(userId: string) {
    const counts: Record<string, number> = {};
    // Primary-table scans avoid stale identity indexes during revocation. Only key + owner
    // are read for conditional deletion; row keys and credential values are never logged.
    for (const [table, key, owner] of [
      ['AW-AgentApiKeys', 'keyId', 'userId'], ['AW-MCPOAuthTokens', 'tokenHash', 'userId'],
      ['AW-MCPOAuthCodes', 'code', 'userId'], ['AW-MCPSessions', 'sessionId', 'agentUserId'],
      ['AW-TaskSchedules', 'scheduleId', 'userId'],
    ]) {
      counts[table] = 0;
      let cursor: AWS.DynamoDB.DocumentClient.Key | undefined;
      do {
        let page: AWS.DynamoDB.DocumentClient.ScanOutput;
        try {
          page = await this.db.scan({ TableName: `${this.prefix}${table}`, ConsistentRead: true, Limit: 100,
            FilterExpression: '#owner = :user', ProjectionExpression: '#key, #owner',
            ExpressionAttributeNames: { '#key': key, '#owner': owner }, ExpressionAttributeValues: { ':user': userId },
            ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          }).promise();
        } catch (error: any) {
          // Some environments use only the in-memory MCP store; absent tables hold no grants.
          if (error?.code === 'ResourceNotFoundException') break;
          throw error;
        }
        if (!Array.isArray(page.Items)) throw new EvaluationDenied();
        for (const item of page.Items) {
          if (!item || item[owner] !== userId || typeof item[key] !== 'string') throw new EvaluationDenied();
          try {
            await this.db.delete({ TableName: `${this.prefix}${table}`, Key: { [key]: item[key] },
              ConditionExpression: '#owner = :user', ExpressionAttributeNames: { '#owner': owner }, ExpressionAttributeValues: { ':user': userId },
            }).promise();
            counts[table]++;
          } catch (error: any) { if (error?.code !== 'ConditionalCheckFailedException') throw error; }
        }
        cursor = page.LastEvaluatedKey;
      } while (cursor);
    }
    return counts;
  }
}

export const evaluationStore = new EvaluationStore();
