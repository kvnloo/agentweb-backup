/**
 * Drip campaigns — DB service (multi-tenant, customer-scoped).
 *
 * Config-layer CRUD for drip campaigns. Every campaign belongs to a single
 * customer (`userId`). The table uses a GSI `UserIdIndex` (hash=userId,
 * range=createdAt) so `listByUserId` and `listActiveByUserId` are Query,
 * not Scan.
 *
 * Phase A (this refactor) migrates from Partner-Portal admin-only to
 * customer-scoped so each user can run their own drip campaigns against
 * their own AW-Leads in Customer Portal. Cross-tenant reads (passing a
 * `userId` that does not own the campaign) return null / throw
 * `Campaign not found` exactly like a missing row — callers map to 404.
 *
 * Segment query in Phase A is still the onboarding-flavoured
 * `{ stage, lastActivityBefore, goal }` shape for backward compatibility
 * with existing campaigns. Phase B layers on CRM-flavoured criteria
 * (`lifecycle`, `heatScore`, `utm_source`, `leadListId`) via the new
 * `get_leads_by_crm_criteria` Emma tool and a follow-on segmentQuery
 * extension.
 *
 * See Notion: https://www.notion.so/34709247c951814f90d8f109e5883882
 */

import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';

export type DripCadenceUnit = 'hours' | 'days' | 'weeks';

export interface DripCampaign {
  campaignId: string;
  /**
   * Owner of this campaign. Every CRUD call scopes by userId so one
   * customer cannot see, update, or delete another customer's campaigns.
   * Indexed by `UserIdIndex` GSI (hash=userId, range=createdAt) for cheap
   * list queries.
   */
  userId: string;
  name: string;
  /**
   * Segment query — a structured filter fed to the Phase 2 segmentation API
   * (`GET /api/onboarding/users`). Kept as a small object, not a free-form
   * string, so the scheduler in Phase 4 can re-run it without parsing.
   */
  segmentQuery: {
    stage?: string;
    lastActivityBefore?: string; // ISO datetime
    goal?: string; // Phase 2 `onboardingGoal` filter
    /**
     * CRM lifecycle stage — Phase A extension. Matches `AW-Leads.lifecycle`
     * (unknown | inbox | signed_up | in_deal | trialing | paying | at_risk
     * | churned). Optional; campaigns that still target onboarding stages
     * use the original `stage` field above.
     */
    lifecycle?: string;
    /** Minimum heat score (0-100) a lead needs to qualify. Optional. */
    minHeatScore?: number;
    /** Filter leads whose `utmSource` matches this value. Optional. */
    utmSource?: string;
    /** Scope the campaign to a single lead list (belongs to the same user). Optional. */
    leadListId?: string;
  };
  templateHtml: string;
  subjectLine: string;
  cadenceUnit: DripCadenceUnit;
  cadenceValue: number; // e.g. 1 (unit=days) → "every day"
  maxSends: number; // per-user lifetime cap for this campaign
  isActive: boolean;
  /**
   * Kill switch — independent of `isActive`. Setting `killSwitch=true` halts
   * sends immediately even if the campaign is otherwise active. Phase 4
   * honours this first. Operators use this to pause a campaign in flight
   * without losing its config.
   */
  killSwitch: boolean;
  /**
   * User/session id of whoever created the campaign. For customer-created
   * campaigns this is the same as `userId`; we keep a separate field so
   * audit trails survive future ownership transfer.
   */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// Whitelisted merge fields that can appear in `templateHtml`. Phase 4's
// executor is responsible for substituting them, but we validate here so a
// malformed template is caught at save time.
export const ALLOWED_MERGE_FIELDS = [
  'firstName',
  'companyName',
  'lastStep',
  'goal',
] as const;

const VALID_CADENCE_UNITS: DripCadenceUnit[] = ['hours', 'days', 'weeks'];

// Matches `{{fieldName}}` tokens inside a template.
const MERGE_FIELD_REGEX = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Pull every `{{...}}` token out of a template and return the field names.
 * Used by both the Db validator and the Partner Portal preview endpoint so
 * the UI can highlight unknown fields before save.
 */
export function extractMergeFields(templateHtml: string): string[] {
  const fields = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(MERGE_FIELD_REGEX.source, MERGE_FIELD_REGEX.flags);
  while ((match = re.exec(templateHtml)) !== null) {
    fields.add(match[1]);
  }
  return Array.from(fields);
}

/**
 * Validate every token in `templateHtml` is in the merge-field allowlist.
 * Throws on the first unknown field. Used by create + update.
 */
export function validateMergeFields(templateHtml: string): void {
  const used = extractMergeFields(templateHtml);
  const invalid = used.filter(
    (f) => !(ALLOWED_MERGE_FIELDS as readonly string[]).includes(f),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Invalid merge fields: ${invalid.join(', ')}. Allowed: ${ALLOWED_MERGE_FIELDS.join(', ')}`,
    );
  }
}

/**
 * Substitute merge fields in a template with values from `user`. Missing
 * fields resolve to an empty string. Exposed so both the preview endpoint
 * and the Phase 4 executor share one code path.
 */
export function renderTemplate(
  templateHtml: string,
  user: {
    firstName?: string;
    companyName?: string;
    lastStep?: string;
    goal?: string;
  },
): string {
  return templateHtml.replace(MERGE_FIELD_REGEX, (_, field: string) => {
    const value = (user as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : '';
  });
}

export class DripCampaignDb {
  private tableName: string;
  private docClient: AWS.DynamoDB.DocumentClient;

  constructor(tableName?: string) {
    const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
    this.tableName = tableName || `${TABLE_PREFIX}AW-DripCampaigns`;
    this.docClient = new AWS.DynamoDB.DocumentClient();
  }

  /** Field-by-field validation shared by create + update. */
  private validate(campaign: Partial<DripCampaign>): void {
    if (!campaign.userId || typeof campaign.userId !== 'string') {
      throw new Error('userId is required');
    }
    if (!campaign.name || typeof campaign.name !== 'string') {
      throw new Error('name is required');
    }
    if (campaign.name.length > 200) {
      throw new Error('name must be 200 characters or fewer');
    }
    if (!campaign.templateHtml || typeof campaign.templateHtml !== 'string') {
      throw new Error('templateHtml is required');
    }
    if (!campaign.subjectLine || typeof campaign.subjectLine !== 'string') {
      throw new Error('subjectLine is required');
    }
    if (campaign.subjectLine.length > 200) {
      throw new Error('subjectLine must be 200 characters or fewer');
    }
    if (
      !campaign.cadenceUnit ||
      !VALID_CADENCE_UNITS.includes(campaign.cadenceUnit)
    ) {
      throw new Error(
        `cadenceUnit must be one of: ${VALID_CADENCE_UNITS.join(', ')}`,
      );
    }
    if (
      typeof campaign.cadenceValue !== 'number' ||
      !Number.isFinite(campaign.cadenceValue) ||
      campaign.cadenceValue <= 0 ||
      !Number.isInteger(campaign.cadenceValue)
    ) {
      throw new Error('cadenceValue must be a positive integer');
    }
    if (
      typeof campaign.maxSends !== 'number' ||
      !Number.isFinite(campaign.maxSends) ||
      campaign.maxSends < 1 ||
      !Number.isInteger(campaign.maxSends)
    ) {
      throw new Error('maxSends must be a positive integer');
    }
    if (campaign.maxSends > 100) {
      // Sanity cap — nobody should be sending more than 100 drip emails
      // per user per campaign. Prevents fat-finger typos that would spam
      // a whole segment.
      throw new Error('maxSends must be 100 or fewer');
    }
    if (!campaign.segmentQuery || typeof campaign.segmentQuery !== 'object') {
      throw new Error('segmentQuery is required');
    }
    validateMergeFields(campaign.templateHtml);
  }

  async create(
    input: Omit<DripCampaign, 'campaignId' | 'createdAt' | 'updatedAt'>,
  ): Promise<DripCampaign> {
    this.validate(input);

    const now = new Date().toISOString();
    const campaign: DripCampaign = {
      ...input,
      campaignId: uuidv4(),
      createdAt: now,
      updatedAt: now,
    };

    await this.docClient
      .put({
        TableName: this.tableName,
        Item: campaign,
      })
      .promise();

    return campaign;
  }

  /**
   * Fetch one campaign, scoped to the caller's userId.
   *
   * Returns null for BOTH "no such campaignId" AND "campaign exists but
   * belongs to a different user" — callers map both to 404 so the API
   * never reveals the existence of another tenant's resources. This is
   * the single chokepoint for cross-tenant isolation on reads.
   */
  async getById(
    campaignId: string,
    userId: string,
  ): Promise<DripCampaign | null> {
    const result = await this.docClient
      .get({
        TableName: this.tableName,
        Key: { campaignId },
      })
      .promise();

    const item = result.Item as DripCampaign | undefined;
    if (!item) return null;
    // Cross-tenant guard — treat as not found so the API returns 404.
    if (item.userId !== userId) return null;
    return item;
  }

  private async scanAll(
    params: AWS.DynamoDB.DocumentClient.ScanInput,
  ): Promise<DripCampaign[]> {
    const items: DripCampaign[] = [];
    let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;

    do {
      const result = await this.docClient
        .scan({ ...params, ExclusiveStartKey: lastKey })
        .promise();

      if (result.Items) {
        items.push(...(result.Items as DripCampaign[]));
      }
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    return items;
  }

  /**
   * Paginate every item returned by a GSI Query (here: `UserIdIndex`).
   * Used by `listByUserId` and `listActiveByUserId`. Falls back to a
   * filtered Scan if the index is missing (dev / non-migrated envs).
   */
  private async queryAllByUser(
    userId: string,
    extra?: {
      filterExpression?: string;
      expressionAttributeValues?: Record<string, any>;
    },
  ): Promise<DripCampaign[]> {
    const items: DripCampaign[] = [];
    let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;

    try {
      do {
        const result = await this.docClient
          .query({
            TableName: this.tableName,
            IndexName: 'UserIdIndex',
            KeyConditionExpression: 'userId = :userId',
            ExpressionAttributeValues: {
              ':userId': userId,
              ...(extra?.expressionAttributeValues ?? {}),
            },
            ...(extra?.filterExpression
              ? { FilterExpression: extra.filterExpression }
              : {}),
            ExclusiveStartKey: lastKey,
          })
          .promise();

        if (result.Items) {
          items.push(...(result.Items as DripCampaign[]));
        }
        lastKey = result.LastEvaluatedKey;
      } while (lastKey);

      return items;
    } catch (error: any) {
      // GSI missing in dev / LocalStack — fall back to Scan + filter.
      // Same pattern as `getLeadListsByUserId`. Safe because this file is
      // not on a hot path (drip executor runs every 15 min).
      if (
        error?.code === 'ResourceNotFoundException' ||
        /index/i.test(error?.message ?? '')
      ) {
        return this.scanAll({
          TableName: this.tableName,
          FilterExpression: extra?.filterExpression
            ? `userId = :userId AND (${extra.filterExpression})`
            : 'userId = :userId',
          ExpressionAttributeValues: {
            ':userId': userId,
            ...(extra?.expressionAttributeValues ?? {}),
          },
        });
      }
      throw error;
    }
  }

  /** List all campaigns owned by `userId`. Used by the Customer-Portal UI. */
  async listByUserId(userId: string): Promise<DripCampaign[]> {
    return this.queryAllByUser(userId);
  }

  /**
   * List every active, non-paused campaign across all users. Used by the
   * drip executor cron — one query, then in-process iteration per campaign.
   * Stays a scan because it's system-wide and runs every 15 minutes.
   */
  async listActiveAllTenants(): Promise<DripCampaign[]> {
    return this.scanAll({
      TableName: this.tableName,
      FilterExpression: 'isActive = :active AND killSwitch = :off',
      ExpressionAttributeValues: { ':active': true, ':off': false },
    });
  }

  /** List active, non-paused campaigns for a single user. */
  async listActiveByUserId(userId: string): Promise<DripCampaign[]> {
    return this.queryAllByUser(userId, {
      filterExpression: 'isActive = :active AND killSwitch = :off',
      expressionAttributeValues: { ':active': true, ':off': false },
    });
  }

  /**
   * Update a campaign, scoped to the caller's userId. Throws
   * `Campaign not found` for both missing and cross-tenant attempts —
   * caller maps to 404. The `userId` on the row is immutable: re-applying
   * the existing value every write.
   */
  async update(
    campaignId: string,
    userId: string,
    updates: Partial<
      Omit<DripCampaign, 'campaignId' | 'createdAt' | 'createdBy' | 'userId'>
    >,
  ): Promise<DripCampaign> {
    const existing = await this.getById(campaignId, userId);
    if (!existing) {
      throw new Error(`Campaign not found: ${campaignId}`);
    }

    const merged: DripCampaign = {
      ...existing,
      ...updates,
      campaignId: existing.campaignId,
      userId: existing.userId, // immutable — never honour an override
      createdAt: existing.createdAt,
      createdBy: existing.createdBy,
      updatedAt: new Date().toISOString(),
    };

    this.validate(merged);

    await this.docClient
      .put({
        TableName: this.tableName,
        Item: merged,
        // Belt-and-braces — even if somehow a row with a different owner
        // slipped past the getById guard, the conditional write prevents
        // the tenant swap.
        ConditionExpression:
          'updatedAt = :expectedUpdatedAt AND userId = :expectedUserId',
        ExpressionAttributeValues: {
          ':expectedUpdatedAt': existing.updatedAt,
          ':expectedUserId': existing.userId,
        },
      })
      .promise();

    return merged;
  }

  /**
   * Delete a campaign, scoped to the caller's userId. No-op when the row
   * exists under a different owner — mirrors read-side cross-tenant 404
   * behaviour so the caller can safely treat "deleted" as "gone".
   */
  async deleteById(campaignId: string, userId: string): Promise<void> {
    // Load first to confirm ownership. `getById` already handles the
    // cross-tenant case. Delete is a no-op if the row is not ours.
    const existing = await this.getById(campaignId, userId);
    if (!existing) {
      throw new Error(`Campaign not found: ${campaignId}`);
    }
    await this.docClient
      .delete({
        TableName: this.tableName,
        Key: { campaignId },
        ConditionExpression: 'userId = :expectedUserId',
        ExpressionAttributeValues: {
          ':expectedUserId': userId,
        },
      })
      .promise();
  }
}

// Lazy singleton — avoids DynamoDB client creation at import time (breaks test mocks)
let _instance: DripCampaignDb | null = null;
export function getDripCampaignDb(): DripCampaignDb {
  if (!_instance) _instance = new DripCampaignDb();
  return _instance;
}

// Test-only: reset the singleton so per-test Dynamo mocks work reliably.
export function __resetDripCampaignDbForTests(): void {
  _instance = null;
}
