import AWS from "aws-sdk";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import path from "path";
import { paginatedScan } from "../utils/dynamoPagination";

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

// DynamoDB Instance
const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

export type SkillCategory = 'tool_bundle' | 'digest' | 'analysis' | 'report' | 'action';
export type SkillTriggerMode = 'install_only' | 'on_demand' | 'scheduled' | 'both';
export type SkillVisibility = 'system' | 'private' | 'public' | 'pending_review';

export interface SkillSchedule {
  frequency: 'daily' | 'weekly' | 'monthly' | 'custom';
  preferredTime?: string;
  deliveryChannels?: string[];
  cronExpression?: string;
}

export interface SkillSyncInfo {
  inSync: boolean;
  existsInProd: boolean;
  existsInDev: boolean;
  changedFields: string[];
}

export interface Skill {
  skillId: string;
  name: string;
  description: string;
  toolNames: string[];
  systemPrompt?: string;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string;
  // Extended fields (Phase 1) — all optional for backward compatibility
  category?: SkillCategory;
  triggerMode?: SkillTriggerMode;
  schedule?: SkillSchedule;
  welcomeMessage?: string;
  llmModel?: string;
  maxIterations?: number;
  isBuiltIn?: boolean;
  ownerId?: string;
  orgId?: string;
  visibility?: SkillVisibility;
  reviewFeedback?: string;
}

export class SkillService {
  private tableName: string;

  constructor() {
    this.tableName = `${TABLE_PREFIX}AW-Skills`;
  }

  private normalizeSkill(item: any): Skill {
    if (!item) return item;
    const skill = { ...item };

    // Convert DynamoDB Set to Array if necessary
    if (skill.toolNames && typeof skill.toolNames === 'object' && !Array.isArray(skill.toolNames) && 'values' in skill.toolNames) {
      skill.toolNames = skill.toolNames.values;
    } else if (!skill.toolNames) {
      skill.toolNames = [];
    }

    // Default triggerMode for legacy skills without the field
    if (!skill.triggerMode) {
      skill.triggerMode = 'install_only';
    }

    return skill as Skill;
  }

  async createSkill(
    name: string,
    description: string,
    toolNames: string[],
    systemPrompt?: string,
    isPublished?: boolean
  ): Promise<Skill> {
    const timestamp = new Date().toISOString();
    const skill: Skill = {
      skillId: uuidv4(),
      name,
      description,
      toolNames,
      systemPrompt,
      isPublished: isPublished || false, // Default to Draft (not published)
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const skillItem: any = {
      ...skill
    };

    if (toolNames && toolNames.length > 0) {
      skillItem.toolNames = dynamodb.createSet(toolNames);
    } else {
      delete skillItem.toolNames; // Or keep as empty list [] - but Sets can't be empty
    }

    const params = {
      TableName: this.tableName,
      Item: skillItem,
    };

    try {
      await dynamodb.put(params).promise();
      return skill;
    } catch (error) {
      console.error("Error creating skill:", error);
      throw error;
    }
  }

  async getSkill(skillId: string): Promise<Skill | null> {
    const params = {
      TableName: this.tableName,
      Key: { skillId },
    };

    try {
      const result = await dynamodb.get(params).promise();
      return this.normalizeSkill(result.Item);
    } catch (error) {
      console.error(`Error getting skill ${skillId}:`, error);
      throw error;
    }
  }

  async getAllSkills(): Promise<Skill[]> {
    const params = {
      TableName: this.tableName,
    };

    try {
      const items = await paginatedScan(dynamodb, params);
      return (items.map(item => this.normalizeSkill(item)) as Skill[]) || [];
    } catch (error) {
       // If table doesn't exist yet, return empty array
       if ((error as any).code === 'ResourceNotFoundException') {
        console.log(`AW-Skills table not found, returning empty skills list`);
        return [];
      }
      console.error("Error scanning skills:", error);
      throw error;
    }
  }

  async getPublishedSkills(): Promise<Skill[]> {
    const params = {
      TableName: this.tableName,
      FilterExpression: "isPublished = :isPublished",
      ExpressionAttributeValues: {
        ":isPublished": true,
      },
    };

    try {
      const items = await paginatedScan(dynamodb, params);
      return (items.map(item => this.normalizeSkill(item)) as Skill[]) || [];
    } catch (error) {
      if ((error as any).code === 'ResourceNotFoundException') {
        return [];
      }
      console.error("Error getting published skills:", error);
      throw error;
    }
  }

  /**
   * Get all skills available to a specific user: published skills + their own private skills
   * + any private skills shared across their org (when orgId is provided).
   */
  async getSkillsAvailableToUser(userId: string, orgId?: string): Promise<Skill[]> {
    const [publishedSkills, userSkills, orgSkills] = await Promise.all([
      this.getPublishedSkills(),
      this.getSkillsByOwner(userId),
      orgId ? this.getSkillsByOrg(orgId, userId) : Promise.resolve([]),
    ]);

    const seen = new Set(publishedSkills.map(s => s.skillId));
    const privateSkills: Skill[] = [];
    for (const s of [...userSkills, ...orgSkills]) {
      if (!seen.has(s.skillId)) {
        seen.add(s.skillId);
        privateSkills.push(s);
      }
    }
    return [...publishedSkills, ...privateSkills];
  }


  async getSkillsByIds(skillIds: string[]): Promise<Skill[]> {
    if (!skillIds || skillIds.length === 0) return [];

    // DynamoDB BatchGetItem
    const keys = skillIds.map((id) => ({ skillId: id }));
    const uniqueKeys = keys.filter((v, i, a) => a.findIndex(t => t.skillId === v.skillId) === i); // Dedupe

    const params = {
      RequestItems: {
        [this.tableName]: {
          Keys: uniqueKeys,
        },
      },
    };

    try {
      const result = await dynamodb.batchGet(params).promise();
      const items = result.Responses?.[this.tableName] || [];
      return items.map(item => this.normalizeSkill(item));
    } catch (error) {
      console.error("Error batch getting skills:", error);
      throw error;
    }
  }

  async updateSkill(skill: Skill): Promise<void> {
    const skillItem: any = {
      ...skill,
      updatedAt: new Date().toISOString()
    };

    if (skill.toolNames && skill.toolNames.length > 0) {
      skillItem.toolNames = dynamodb.createSet(skill.toolNames);
    }

    const params = {
      TableName: this.tableName,
      Item: skillItem,
    };

    try {
      await dynamodb.put(params).promise();
    } catch (error) {
      console.error(`Error updating skill ${skill.skillId}:`, error);
      throw error;
    }
  }

  async syncSkill(skillId: string, direction: 'prod-to-dev' | 'dev-to-prod'): Promise<Skill | null> {
    const sourceTable = direction === 'prod-to-dev' ? 'AW-Skills' : 'Dev-AW-Skills';
    const targetTable = direction === 'prod-to-dev' ? 'Dev-AW-Skills' : 'AW-Skills';

    try {
      // Read from source table
      const result = await dynamodb.get({
        TableName: sourceTable,
        Key: { skillId },
      }).promise();

      if (!result.Item) {
        return null;
      }

      const skill = this.normalizeSkill(result.Item);

      // Write to target table, converting toolNames back to DynamoDB Set
      const skillItem: any = { ...skill };
      if (skill.toolNames && skill.toolNames.length > 0) {
        skillItem.toolNames = dynamodb.createSet(skill.toolNames);
      } else {
        delete skillItem.toolNames;
      }

      await dynamodb.put({
        TableName: targetTable,
        Item: skillItem,
      }).promise();

      return skill;
    } catch (error) {
      console.error(`Error syncing skill ${skillId} (${direction}):`, error);
      throw error;
    }
  }

  private getChangedFields(a: Skill, b: Skill): string[] {
    const changed: string[] = [];
    if (a.name !== b.name) changed.push('name');
    if (a.description !== b.description) changed.push('description');
    if (a.isPublished !== b.isPublished) changed.push('isPublished');
    if ((a.systemPrompt || '') !== (b.systemPrompt || '')) changed.push('systemPrompt');
    const sortedA = [...(a.toolNames || [])].sort();
    const sortedB = [...(b.toolNames || [])].sort();
    if (JSON.stringify(sortedA) !== JSON.stringify(sortedB)) changed.push('toolNames');
    return changed;
  }

  async getSyncStatus(): Promise<Record<string, SkillSyncInfo>> {
    try {
      const [prodItems, devItems] = await Promise.all([
        paginatedScan(dynamodb, { TableName: 'AW-Skills' }),
        paginatedScan(dynamodb, { TableName: 'Dev-AW-Skills' }),
      ]);

      const prodSkills = prodItems.map(item => this.normalizeSkill(item));
      const devSkills = devItems.map(item => this.normalizeSkill(item));

      const prodMap = new Map(prodSkills.map(s => [s.skillId, s]));
      const devMap = new Map(devSkills.map(s => [s.skillId, s]));

      const allIds = new Set([...prodMap.keys(), ...devMap.keys()]);
      const result: Record<string, SkillSyncInfo> = {};

      for (const id of allIds) {
        const prod = prodMap.get(id);
        const dev = devMap.get(id);
        const changedFields = (prod && dev) ? this.getChangedFields(prod, dev) : [];
        result[id] = {
          inSync: !!(prod && dev && changedFields.length === 0),
          existsInProd: !!prod,
          existsInDev: !!dev,
          changedFields,
        };
      }

      return result;
    } catch (error) {
      console.error("Error getting sync status:", error);
      throw error;
    }
  }

  async getSkillsByOwner(ownerId: string): Promise<Skill[]> {
    const params = {
      TableName: this.tableName,
      IndexName: 'OwnerIndex',
      KeyConditionExpression: 'ownerId = :ownerId',
      ExpressionAttributeValues: { ':ownerId': ownerId },
    };

    try {
      const result = await dynamodb.query(params).promise();
      return (result.Items || []).map(item => this.normalizeSkill(item));
    } catch (error: any) {
      // Fallback to scan if GSI doesn't exist yet
      if (error.code === 'ValidationException' && error.message?.includes('specified index')) {
        console.warn(`OwnerIndex not found on ${this.tableName}, falling back to scan`);
        const scanResult = await dynamodb.scan({
          TableName: this.tableName,
          FilterExpression: 'ownerId = :ownerId',
          ExpressionAttributeValues: { ':ownerId': ownerId },
        }).promise();
        return (scanResult.Items || []).map(item => this.normalizeSkill(item));
      }
      console.error(`Error getting skills for owner ${ownerId}:`, error);
      throw error;
    }
  }

  async getSkillsByOrg(orgId: string, callerUserId: string): Promise<Skill[]> {
    try {
      const { orgDb } = await import("./db");
      const members = await orgDb.getOrgMembers(orgId);
      const others = members.map((m: { userId: string }) => m.userId).filter((uid: string) => uid !== callerUserId);
      const perMember = await Promise.all(others.map((uid: string) => this.getSkillsByOwner(uid)));
      return perMember.flat();
    } catch (error) {
      console.error(`Error getting skills for org ${orgId}:`, error);
      return [];
    }
  }

  async getSkillsByVisibility(visibility: SkillVisibility): Promise<Skill[]> {
    const params = {
      TableName: this.tableName,
      IndexName: 'VisibilityIndex',
      KeyConditionExpression: 'visibility = :visibility',
      ExpressionAttributeValues: { ':visibility': visibility },
    };

    try {
      const result = await dynamodb.query(params).promise();
      return (result.Items || []).map(item => this.normalizeSkill(item));
    } catch (error: any) {
      // Fallback to scan if GSI doesn't exist yet
      if (error.code === 'ValidationException' && error.message?.includes('specified index')) {
        console.warn(`VisibilityIndex not found on ${this.tableName}, falling back to scan`);
        const scanResult = await dynamodb.scan({
          TableName: this.tableName,
          FilterExpression: 'visibility = :visibility',
          ExpressionAttributeValues: { ':visibility': visibility },
        }).promise();
        return (scanResult.Items || []).map(item => this.normalizeSkill(item));
      }
      console.error(`Error getting skills by visibility ${visibility}:`, error);
      throw error;
    }
  }

  async submitForReview(skillId: string, ownerId: string): Promise<Skill> {
    const skill = await this.getSkill(skillId);
    if (!skill) throw new Error('Skill not found');
    if (skill.ownerId !== ownerId) throw new Error('Not authorized');
    if (skill.visibility !== 'private') throw new Error('Only private skills can be submitted for review');

    skill.visibility = 'pending_review';
    skill.reviewFeedback = undefined;
    await this.updateSkill(skill);
    return skill;
  }

  async approveSkill(skillId: string): Promise<Skill> {
    const skill = await this.getSkill(skillId);
    if (!skill) throw new Error('Skill not found');
    if (skill.visibility !== 'pending_review') throw new Error('Skill is not pending review');

    skill.visibility = 'public';
    skill.isPublished = true;
    await this.updateSkill(skill);
    return skill;
  }

  async rejectSkill(skillId: string, feedback: string): Promise<Skill> {
    const skill = await this.getSkill(skillId);
    if (!skill) throw new Error('Skill not found');
    if (skill.visibility !== 'pending_review') throw new Error('Skill is not pending review');

    skill.visibility = 'private';
    skill.reviewFeedback = feedback;
    await this.updateSkill(skill);
    return skill;
  }

  async deleteSkill(skillId: string): Promise<void> {
    const params = {
      TableName: this.tableName,
      Key: { skillId },
    };

    try {
      await dynamodb.delete(params).promise();
    } catch (error) {
      console.error(`Error deleting skill ${skillId}:`, error);
      throw error;
    }
  }

  /**
   * Transfer ownership of a skill to a new user (used when removing a member from an org).
   */
  async transferOwner(skillId: string, newOwnerId: string): Promise<void> {
    try {
      await dynamodb.update({
        TableName: this.tableName,
        Key: { skillId },
        UpdateExpression: "SET userId = :newOwner, updatedAt = :now",
        ExpressionAttributeValues: {
          ":newOwner": newOwnerId,
          ":now": new Date().toISOString(),
        },
      }).promise();
    } catch (error) {
      console.error(`Error transferring skill ${skillId} to ${newOwnerId}:`, error);
      throw error;
    }
  }
}

export const skillService = new SkillService();
