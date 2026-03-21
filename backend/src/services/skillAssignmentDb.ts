import AWS from "aws-sdk";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import path from "path";
import { paginatedQuery } from "../utils/dynamoPagination";

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

export type AssignmentStatus = 'active' | 'paused' | 'completed' | 'error';

export interface SkillAssignmentSchedule {
  frequency: 'daily' | 'weekly' | 'monthly' | 'custom';
  preferredTime?: string;
  deliveryChannels?: string[];
  cronExpression?: string;
}

export interface SkillAssignment {
  assignmentId: string;
  skillId: string;
  userId: string;
  status: AssignmentStatus;
  schedule?: SkillAssignmentSchedule;
  nextRunTime?: string;
  lastRunTime?: string;
  lastRunResult?: string;
  config?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAssignmentInput {
  skillId: string;
  userId: string;
  status: AssignmentStatus;
  schedule?: SkillAssignmentSchedule;
  nextRunTime?: string;
  config?: Record<string, any>;
}

const VALID_STATUSES: AssignmentStatus[] = ['active', 'paused', 'completed', 'error'];

export class SkillAssignmentDb {
  private tableName: string;

  constructor() {
    this.tableName = `${TABLE_PREFIX}AW-SkillAssignments`;
  }

  async createAssignment(input: CreateAssignmentInput): Promise<SkillAssignment> {
    if (!input.skillId) {
      throw new Error('skillId is required');
    }
    if (!input.userId) {
      throw new Error('userId is required');
    }
    if (!VALID_STATUSES.includes(input.status)) {
      throw new Error(`Invalid status: ${input.status}. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    const timestamp = new Date().toISOString();
    const assignment: SkillAssignment = {
      assignmentId: uuidv4(),
      skillId: input.skillId,
      userId: input.userId,
      status: input.status,
      ...(input.schedule && { schedule: input.schedule }),
      ...(input.nextRunTime && { nextRunTime: input.nextRunTime }),
      ...(input.config && { config: input.config }),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const params = {
      TableName: this.tableName,
      Item: assignment,
    };

    try {
      await dynamodb.put(params).promise();
      return assignment;
    } catch (error) {
      console.error("Error creating skill assignment:", error);
      throw error;
    }
  }

  async getAssignment(assignmentId: string): Promise<SkillAssignment | null> {
    const params = {
      TableName: this.tableName,
      Key: { assignmentId },
    };

    try {
      const result = await dynamodb.get(params).promise();
      return (result.Item as SkillAssignment) || null;
    } catch (error) {
      console.error(`Error getting assignment ${assignmentId}:`, error);
      throw error;
    }
  }

  async getAssignmentsByUser(userId: string): Promise<SkillAssignment[]> {
    const params = {
      TableName: this.tableName,
      IndexName: 'UserIndex',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId,
      },
    };

    try {
      return await paginatedQuery<SkillAssignment>(dynamodb, params);
    } catch (error) {
      console.error(`Error getting assignments for user ${userId}:`, error);
      throw error;
    }
  }

  async getAssignmentsBySkill(skillId: string): Promise<SkillAssignment[]> {
    const params = {
      TableName: this.tableName,
      IndexName: 'SkillIndex',
      KeyConditionExpression: 'skillId = :skillId',
      ExpressionAttributeValues: {
        ':skillId': skillId,
      },
    };

    try {
      return await paginatedQuery<SkillAssignment>(dynamodb, params);
    } catch (error) {
      console.error(`Error getting assignments for skill ${skillId}:`, error);
      throw error;
    }
  }

  async getAssignmentsReadyToRun(): Promise<SkillAssignment[]> {
    const now = new Date().toISOString();
    const params = {
      TableName: this.tableName,
      IndexName: 'RunnerIndex',
      KeyConditionExpression: '#status = :status AND nextRunTime <= :now',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':status': 'active',
        ':now': now,
      },
    };

    try {
      return await paginatedQuery<SkillAssignment>(dynamodb, params);
    } catch (error) {
      console.error("Error getting assignments ready to run:", error);
      throw error;
    }
  }

  async updateAssignment(
    assignmentId: string,
    updates: Partial<Pick<SkillAssignment, 'status' | 'schedule' | 'nextRunTime' | 'lastRunTime' | 'lastRunResult' | 'config'>>
  ): Promise<SkillAssignment> {
    if (!assignmentId) {
      throw new Error('assignmentId is required');
    }
    if (updates.status !== undefined && !VALID_STATUSES.includes(updates.status)) {
      throw new Error(`Invalid status: ${updates.status}. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    const timestamp = new Date().toISOString();
    const expressionParts: string[] = [];
    const expressionNames: Record<string, string> = {};
    const expressionValues: Record<string, any> = {
      ':updatedAt': timestamp,
    };

    expressionParts.push('#updatedAt = :updatedAt');
    expressionNames['#updatedAt'] = 'updatedAt';

    if (updates.status !== undefined) {
      expressionParts.push('#status = :status');
      expressionNames['#status'] = 'status';
      expressionValues[':status'] = updates.status;
    }
    if (updates.schedule !== undefined) {
      expressionParts.push('#schedule = :schedule');
      expressionNames['#schedule'] = 'schedule';
      expressionValues[':schedule'] = updates.schedule;
    }
    if (updates.nextRunTime !== undefined) {
      expressionParts.push('nextRunTime = :nextRunTime');
      expressionValues[':nextRunTime'] = updates.nextRunTime;
    }
    if (updates.lastRunTime !== undefined) {
      expressionParts.push('lastRunTime = :lastRunTime');
      expressionValues[':lastRunTime'] = updates.lastRunTime;
    }
    if (updates.lastRunResult !== undefined) {
      expressionParts.push('lastRunResult = :lastRunResult');
      expressionValues[':lastRunResult'] = updates.lastRunResult;
    }
    if (updates.config !== undefined) {
      expressionParts.push('#config = :config');
      expressionNames['#config'] = 'config';
      expressionValues[':config'] = updates.config;
    }

    const params = {
      TableName: this.tableName,
      Key: { assignmentId },
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: expressionValues,
      ReturnValues: 'ALL_NEW',
    };

    try {
      const result = await dynamodb.update(params).promise();
      return result.Attributes as SkillAssignment;
    } catch (error) {
      console.error(`Error updating assignment ${assignmentId}:`, error);
      throw error;
    }
  }

  async deleteAssignment(assignmentId: string): Promise<void> {
    const params = {
      TableName: this.tableName,
      Key: { assignmentId },
    };

    try {
      await dynamodb.delete(params).promise();
    } catch (error) {
      console.error(`Error deleting assignment ${assignmentId}:`, error);
      throw error;
    }
  }
}

export const skillAssignmentDb = new SkillAssignmentDb();
