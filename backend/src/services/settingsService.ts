import AWS from "aws-sdk";
import dotenv from "dotenv";
import path from "path";
import { paginatedScan } from "../utils/dynamoPagination";
import { recordSettingChange } from "../loops/eval/evalChangeMarkers";

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// Get table prefix based on NODE_ENV (defaults to empty string for production)
const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

// Make sure we have a DynamoDB instance
const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  // Do not replace the SDK credential-provider chain with empty credentials.
  ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          ...(process.env.AWS_SESSION_TOKEN
            ? { sessionToken: process.env.AWS_SESSION_TOKEN }
            : {}),
        },
      }
    : {}),
});

export interface Setting {
  settingName: string;
  settingValue: string;
  description?: string;
  updatedAt: string;
  updatedBy: string;
  /**
   * Optional epoch-second DynamoDB TTL attribute. Only written when a caller opts in
   * (e.g. oauthTokenSessionStore) — omitted for every other setting, preserving today's
   * "settings live forever unless explicitly deleted" behavior exactly.
   */
  ttl?: number;
}

export interface PredefinedPlan {
  id: string;
  title: string;
  description?: string;
  welcomeMessage?: string;
  autocomplete?: boolean;
  requireLogin?: boolean;
  showLoginSignup?: string;
  showInAgentMode?: boolean;
  defaultModel?: string;
  steps: Array<{
    stepCount: number;
    title: string;
    description?: string;
    requiredFunctionCalls?: string[];
    skillIds?: string[];
  }>;
}

export interface PlanSyncInfo {
  inSync: boolean;
  existsInProd: boolean;
  existsInDev: boolean;
  changedFields: string[];
}

export class SettingsService {
  private tableName: string;

  constructor() {
    this.tableName = `${TABLE_PREFIX}AW-Settings`;
  }

  /** The AW-Settings table this service reads and writes (Dev- prefixed only when NODE_ENV is 'development'). */
  getTableName(): string {
    return this.tableName;
  }

  async getSetting(settingName: string): Promise<Setting | null> {
    try {
      const params = {
        TableName: this.tableName,
        Key: {
          settingName: settingName
        }
      };

      const result = await dynamodb.get(params).promise();
      return result.Item as Setting || null;
    } catch (error) {
      console.error('Error getting setting:', error);
      throw error;
    }
  }

  /** Like `getSetting` but strongly consistent: for decisions that must see a change made a moment ago (a kill switch). */
  async getSettingConsistent(settingName: string): Promise<Setting | null> {
    const result = await dynamodb.get({ TableName: this.tableName, Key: { settingName }, ConsistentRead: true }).promise();
    return (result.Item as Setting) || null;
  }

  async getSettings(settingNames: string[]): Promise<Setting[]> {
    const settings: Setting[] = [];
    const uniqueNames = [...new Set(settingNames.filter(name => typeof name === 'string' && name.length > 0))];

    const chunks: string[][] = [];
    for (let index = 0; index < uniqueNames.length; index += 100) {
      chunks.push(uniqueNames.slice(index, index + 100));
    }

    const results = await Promise.all(chunks.map(async names => {
      try {
        const items: Setting[] = [];
        let keys = names.map(settingName => ({ settingName }));

        for (let attempt = 0; keys.length > 0 && attempt < 4; attempt += 1) {
          if (attempt > 0) {
            await new Promise(resolve => setTimeout(resolve, 25 * (2 ** (attempt - 1))));
          }

          const result = await dynamodb.batchGet({
            RequestItems: {
              [this.tableName]: {
                Keys: keys,
                ProjectionExpression: 'settingName, settingValue',
              },
            },
          }).promise();
          const responseItems = result.Responses?.[this.tableName];
          if (Array.isArray(responseItems)) {
            items.push(...responseItems.filter(
              (item): item is Setting =>
                typeof item?.settingName === 'string' && typeof item?.settingValue === 'string',
            ));
          }

          const unprocessedKeys = result.UnprocessedKeys?.[this.tableName]?.Keys;
          keys = Array.isArray(unprocessedKeys)
            ? unprocessedKeys.filter(
                (key): key is { settingName: string } => typeof key?.settingName === 'string',
              )
            : [];
        }

        return items;
      } catch (error) {
        console.error('Error batch getting settings:', error);
        return [];
      }
    }));

    for (const items of results) settings.push(...items);
    return settings;
  }

  async setSetting(settingName: string, settingValue: string, description?: string, updatedBy: string = 'system', ttl?: number): Promise<Setting> {
    try {
      if (ttl !== undefined && !Number.isFinite(ttl)) {
        throw new Error(`Invalid ttl for setting "${settingName}": must be a finite epoch-second number, got ${ttl}`);
      }

      const timestamp = new Date().toISOString();

      const setting: Setting = {
        settingName,
        settingValue,
        description,
        updatedAt: timestamp,
        updatedBy,
        ...(ttl !== undefined ? { ttl } : {}),
      };

      const params = {
        TableName: this.tableName,
        Item: setting
      };

      await dynamodb.put(params).promise();
      // ENG-2145: a prompt/model/judge row changed outside git — mark it as needing eval.
      // Report-only and best-effort: never awaited, never fails the write.
      void recordSettingChange(settingName, 'set', settingValue);
      return setting;
    } catch (error) {
      console.error('Error setting setting:', error);
      throw error;
    }
  }

  async getAllSettings(): Promise<Setting[]> {
    try {
      const params = {
        TableName: this.tableName
      };

      return await paginatedScan<Setting>(dynamodb, params);
    } catch (error) {
      console.error('Error getting all settings:', error);
      throw error;
    }
  }

  /**
   * Atomically claim membership in a setting-backed string set (DynamoDB ADD on the
   * `settingMembers` attribute — no read-modify-write). Returns true when `member`
   * was NOT already in the set, i.e. this caller won the claim: concurrent callers
   * for the same member get exactly one `true`. Used for exactly-once markers
   * (e.g. ship-notify's per-item notified-reporters set).
   */
  async claimSetMember(settingName: string, member: string): Promise<boolean> {
    const result = await dynamodb.update({
      TableName: this.tableName,
      Key: { settingName },
      UpdateExpression: 'ADD settingMembers :m SET updatedAt = :t',
      ExpressionAttributeValues: {
        ':m': dynamodb.createSet([member]),
        ':t': new Date().toISOString(),
      },
      ReturnValues: 'UPDATED_OLD',
    }).promise();
    const old: string[] = (result.Attributes?.settingMembers as any)?.values ?? [];
    return !old.includes(member);
  }

  /** Inverse of claimSetMember — releases a claim (e.g. after a failed send, so a delivery retry can re-claim). */
  async releaseSetMember(settingName: string, member: string): Promise<void> {
    await dynamodb.update({
      TableName: this.tableName,
      Key: { settingName },
      UpdateExpression: 'DELETE settingMembers :m',
      ExpressionAttributeValues: { ':m': dynamodb.createSet([member]) },
    }).promise();
  }

  async getJsonArraySetting<T>(settingName: string, fallback: T[]): Promise<T[]> {
    try {
      const setting = await this.getSetting(settingName);
      if (setting) {
        const parsed = JSON.parse(setting.settingValue);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed as T[];
      }
    } catch {
      // fall through to default
    }
    return fallback;
  }

  async invalidateSlackChannelMappings(userId: string, channelIds: string[]): Promise<void> {
    try {
      const allSettings = await this.getAllSettings();
      const byChannelKeys = channelIds.map(ch => `slack_channel_mapping_${ch}`);
      const staleKeys = allSettings
        .filter(s =>
          s.settingName.startsWith('slack_channel_mapping_') &&
          (s.settingValue === userId || byChannelKeys.includes(s.settingName))
        )
        .map(s => s.settingName);
      await Promise.all(staleKeys.map(k => this.deleteSetting(k)));
      if (staleKeys.length > 0) {
        console.log(`🗑️ Invalidated ${staleKeys.length} stale slack channel mapping cache entries for user ${userId}`);
      }
    } catch (error) {
      console.error('Error invalidating slack channel mappings:', error);
      throw error;
    }
  }

  async deleteSetting(settingName: string): Promise<void> {
    try {
      const params = {
        TableName: this.tableName,
        Key: {
          settingName: settingName
        }
      };

      await dynamodb.delete(params).promise();
      void recordSettingChange(settingName, 'delete', undefined);
    } catch (error) {
      console.error('Error deleting setting:', error);
      throw error;
    }
  }

  /**
   * Compare-and-swap primitives (ENG-965) for callers that must consume a stored value
   * exactly once: read a setting, decide what to do with it, then persist that decision
   * ONLY IF nothing else touched the row in between. Conditioned on the exact raw
   * `settingValue` the caller already read (optimistic concurrency — no separate lock).
   *
   * On a race (another writer changed the row since the read), or if the row no longer
   * exists when a caller expected it to, DynamoDB rejects with
   * `ConditionalCheckFailedException` — the caller must treat that as "my read was stale,
   * do not trust it," not as an ordinary error. Any other failure means the write was never
   * even attempted server-side, so the row is provably unchanged from what was read.
   *
   * Same table, same item shape as `setSetting`/`deleteSetting` — this only changes which
   * DynamoDB API parameters are used, not the persistence contract.
   */
  async setSettingIfValueMatches(
    settingName: string,
    settingValue: string,
    expectedValue: string,
    description?: string,
    updatedBy: string = 'system',
    ttl?: number,
  ): Promise<void> {
    if (ttl !== undefined && !Number.isFinite(ttl)) {
      throw new Error(`Invalid ttl for setting "${settingName}": must be a finite epoch-second number, got ${ttl}`);
    }

    const setting: Setting = {
      settingName,
      settingValue,
      description,
      updatedAt: new Date().toISOString(),
      updatedBy,
      ...(ttl !== undefined ? { ttl } : {}),
    };

    await dynamodb.put({
      TableName: this.tableName,
      Item: setting,
      ConditionExpression: 'settingValue = :expected',
      ExpressionAttributeValues: { ':expected': expectedValue },
    }).promise();
    // Only reached when the conditional write succeeded (ENG-2145).
    void recordSettingChange(settingName, 'set', settingValue);
  }

  /**
   * Create a setting only if no row exists. Returns false (and writes nothing) when one
   * does, so two concurrent callers can never both win.
   */
  async setSettingIfAbsent(
    settingName: string,
    settingValue: string,
    description?: string,
    updatedBy: string = 'system',
    ttl?: number,
  ): Promise<boolean> {
    if (ttl !== undefined && !Number.isFinite(ttl)) {
      throw new Error(`Invalid ttl for setting "${settingName}": must be a finite epoch-second number, got ${ttl}`);
    }
    const setting: Setting = {
      settingName,
      settingValue,
      description,
      updatedAt: new Date().toISOString(),
      updatedBy,
      ...(ttl !== undefined ? { ttl } : {}),
    };
    try {
      await dynamodb.put({
        TableName: this.tableName,
        Item: setting,
        ConditionExpression: 'attribute_not_exists(settingName)',
      }).promise();
    } catch (error: any) {
      if (error?.code === 'ConditionalCheckFailedException') return false;
      throw error;
    }
    void recordSettingChange(settingName, 'set', settingValue);
    return true;
  }

  /** Delete counterpart of `setSettingIfValueMatches` — see its doc comment. */
  async deleteSettingIfValueMatches(settingName: string, expectedValue: string): Promise<void> {
    await dynamodb.delete({
      TableName: this.tableName,
      Key: { settingName },
      ConditionExpression: 'settingValue = :expected',
      ExpressionAttributeValues: { ':expected': expectedValue },
    }).promise();
    void recordSettingChange(settingName, 'delete', undefined);
  }

  async syncPlan(planId: string, direction: 'prod-to-dev' | 'dev-to-prod'): Promise<PredefinedPlan | null> {
    const sourceTable = direction === 'prod-to-dev' ? 'AW-Settings' : 'Dev-AW-Settings';
    const targetTable = direction === 'prod-to-dev' ? 'Dev-AW-Settings' : 'AW-Settings';

    try {
      // Read from source table
      const sourceResult = await dynamodb.get({
        TableName: sourceTable,
        Key: { settingName: 'agent-mode-predefined-workplans' },
      }).promise();

      if (!sourceResult.Item || !sourceResult.Item.settingValue) {
        return null;
      }

      const sourcePlans: PredefinedPlan[] = JSON.parse(sourceResult.Item.settingValue);
      const planToSync = sourcePlans.find((p) => p.id === planId);

      if (!planToSync) {
        return null;
      }

      // Read from target table
      const targetResult = await dynamodb.get({
        TableName: targetTable,
        Key: { settingName: 'agent-mode-predefined-workplans' },
      }).promise();

      let targetPlans: PredefinedPlan[] = [];
      if (targetResult.Item && targetResult.Item.settingValue) {
        try {
          targetPlans = JSON.parse(targetResult.Item.settingValue);
        } catch (error) {
          console.error('Error parsing target plans:', error);
          targetPlans = [];
        }
      }

      // Find existing plan in target or add new
      const existingIndex = targetPlans.findIndex((p) => p.id === planId);
      if (existingIndex >= 0) {
        targetPlans[existingIndex] = planToSync;
      } else {
        targetPlans.push(planToSync);
      }

      // Write back to target table
      await dynamodb.put({
        TableName: targetTable,
        Item: {
          settingName: 'agent-mode-predefined-workplans',
          settingValue: JSON.stringify(targetPlans),
          description: targetResult.Item?.description || 'Agent Mode predefined work plans',
          updatedAt: new Date().toISOString(),
          updatedBy: 'sync-operation'
        }
      }).promise();
      // ENG-2145: a synced plan is a work-plan change in the target environment.
      void recordSettingChange('agent-mode-predefined-workplans', 'sync', JSON.stringify(targetPlans));

      return planToSync;
    } catch (error) {
      console.error(`Error syncing plan ${planId} (${direction}):`, error);
      throw error;
    }
  }

  private getChangedPlanFields(a: PredefinedPlan, b: PredefinedPlan): string[] {
    const changed: string[] = [];
    if (a.title !== b.title) changed.push('title');
    if ((a.description || '') !== (b.description || '')) changed.push('description');
    if ((a.welcomeMessage || '') !== (b.welcomeMessage || '')) changed.push('welcomeMessage');
    if (a.autocomplete !== b.autocomplete) changed.push('autocomplete');
    if (a.requireLogin !== b.requireLogin) changed.push('requireLogin');
    if ((a.showLoginSignup || '') !== (b.showLoginSignup || '')) changed.push('showLoginSignup');
    if (a.showInAgentMode !== b.showInAgentMode) changed.push('showInAgentMode');
    if ((a.defaultModel || '') !== (b.defaultModel || '')) changed.push('defaultModel');

    // Deep comparison of steps
    if (JSON.stringify(a.steps) !== JSON.stringify(b.steps)) {
      changed.push('steps');
    }

    return changed;
  }

  async getPlanSyncStatus(): Promise<Record<string, PlanSyncInfo>> {
    try {
      const [prodResult, devResult] = await Promise.all([
        dynamodb.get({
          TableName: 'AW-Settings',
          Key: { settingName: 'agent-mode-predefined-workplans' }
        }).promise(),
        dynamodb.get({
          TableName: 'Dev-AW-Settings',
          Key: { settingName: 'agent-mode-predefined-workplans' }
        }).promise(),
      ]);

      let prodPlans: PredefinedPlan[] = [];
      let devPlans: PredefinedPlan[] = [];

      if (prodResult.Item && prodResult.Item.settingValue) {
        try {
          prodPlans = JSON.parse(prodResult.Item.settingValue);
        } catch (error) {
          console.error('Error parsing prod plans:', error);
        }
      }

      if (devResult.Item && devResult.Item.settingValue) {
        try {
          devPlans = JSON.parse(devResult.Item.settingValue);
        } catch (error) {
          console.error('Error parsing dev plans:', error);
        }
      }

      const prodMap = new Map(prodPlans.map((p) => [p.id, p]));
      const devMap = new Map(devPlans.map((p) => [p.id, p]));

      const allIds = new Set([...prodMap.keys(), ...devMap.keys()]);
      const result: Record<string, PlanSyncInfo> = {};

      for (const id of allIds) {
        const prod = prodMap.get(id);
        const dev = devMap.get(id);
        const changedFields = (prod && dev) ? this.getChangedPlanFields(prod, dev) : [];
        result[id] = {
          inSync: !!(prod && dev && changedFields.length === 0),
          existsInProd: !!prod,
          existsInDev: !!dev,
          changedFields,
        };
      }

      return result;
    } catch (error) {
      console.error('Error getting plan sync status:', error);
      throw error;
    }
  }
}

export const settingsService = new SettingsService();
