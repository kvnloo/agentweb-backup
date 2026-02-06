import AWS from "aws-sdk";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import path from "path";

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

export interface Skill {
  skillId: string;
  name: string;
  description: string;
  toolNames: string[];
  systemPrompt?: string;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string;
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
      // Note: for large datasets, scan is inefficient, but for <100 skills it's fine
      const result = await dynamodb.scan(params).promise();
      return (result.Items?.map(item => this.normalizeSkill(item)) as Skill[]) || [];
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
      const result = await dynamodb.scan(params).promise();
      return (result.Items?.map(item => this.normalizeSkill(item)) as Skill[]) || [];
    } catch (error) {
      if ((error as any).code === 'ResourceNotFoundException') {
        return [];
      }
      console.error("Error getting published skills:", error);
      throw error;
    }
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
}

export const skillService = new SkillService();
