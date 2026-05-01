import AWS from "aws-sdk";
import dotenv from "dotenv";
import path from "path";
import { paginatedScan } from "../utils/dynamoPagination";

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// Get table prefix based on NODE_ENV (defaults to empty string for production)
const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

// Make sure we have a DynamoDB instance
const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

export interface Setting {
  settingName: string;
  settingValue: string;
  description?: string;
  updatedAt: string;
  updatedBy: string;
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

  async setSetting(settingName: string, settingValue: string, description?: string, updatedBy: string = 'system'): Promise<Setting> {
    try {
      const timestamp = new Date().toISOString();
      
      const setting: Setting = {
        settingName,
        settingValue,
        description,
        updatedAt: timestamp,
        updatedBy
      };

      const params = {
        TableName: this.tableName,
        Item: setting
      };

      await dynamodb.put(params).promise();
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

  async invalidateSlackChannelMappingsForUser(userId: string): Promise<void> {
    try {
      const allSettings = await this.getAllSettings();
      const staleKeys = allSettings
        .filter(s => s.settingName.startsWith('slack_channel_mapping_') && s.settingValue === userId)
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
    } catch (error) {
      console.error('Error deleting setting:', error);
      throw error;
    }
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
