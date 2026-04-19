/**
 * Lifecycle Drip Phase 3 — DripCampaign DB service.
 *
 * Config-layer CRUD for drip campaigns. Both entry points (Partner Portal
 * admin UI and Emma's `manage_drip_campaign` tool) write through here so
 * there is exactly one schema and one validation surface.
 *
 * Phase 3 is configuration only — the scheduler/executor is Phase 4.
 * See Notion: https://www.notion.so/34709247c951815d97b0c6b8be74e365
 */

import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';

export type DripCadenceUnit = 'hours' | 'days' | 'weeks';

export interface DripCampaign {
  campaignId: string;
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
  createdBy: string; // userId of creator (admin or Emma's session user)
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

  async getById(campaignId: string): Promise<DripCampaign | null> {
    const result = await this.docClient
      .get({
        TableName: this.tableName,
        Key: { campaignId },
      })
      .promise();

    return (result.Item as DripCampaign) || null;
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

  async listAll(): Promise<DripCampaign[]> {
    return this.scanAll({ TableName: this.tableName });
  }

  async listActive(): Promise<DripCampaign[]> {
    return this.scanAll({
      TableName: this.tableName,
      FilterExpression: 'isActive = :active AND killSwitch = :off',
      ExpressionAttributeValues: { ':active': true, ':off': false },
    });
  }

  async update(
    campaignId: string,
    updates: Partial<
      Omit<DripCampaign, 'campaignId' | 'createdAt' | 'createdBy'>
    >,
  ): Promise<DripCampaign> {
    const existing = await this.getById(campaignId);
    if (!existing) {
      throw new Error(`Campaign not found: ${campaignId}`);
    }

    const merged: DripCampaign = {
      ...existing,
      ...updates,
      campaignId: existing.campaignId,
      createdAt: existing.createdAt,
      createdBy: existing.createdBy,
      updatedAt: new Date().toISOString(),
    };

    this.validate(merged);

    await this.docClient
      .put({
        TableName: this.tableName,
        Item: merged,
        ConditionExpression: 'updatedAt = :expectedUpdatedAt',
        ExpressionAttributeValues: {
          ':expectedUpdatedAt': existing.updatedAt,
        },
      })
      .promise();

    return merged;
  }

  async deleteById(campaignId: string): Promise<void> {
    await this.docClient
      .delete({
        TableName: this.tableName,
        Key: { campaignId },
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
