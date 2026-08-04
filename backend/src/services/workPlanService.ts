import AWS from "aws-sdk";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import path from "path";
import { paginatedScan } from "../utils/dynamoPagination";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

export type WorkPlanVisibility = 'system' | 'private' | 'public' | 'pending_review';

/**
 * Maximum length of a step's userInstructions field. Capped so the
 * customer-facing panel renders without scrolling at text-sm + leading-
 * relaxed (~5 short lines). The legacy `description` field still holds
 * the LLM's raw system prompt and is not bound by this limit.
 */
export const USER_INSTRUCTIONS_MAX_LENGTH = 500;

export interface WorkPlanStep {
  stepCount: number;
  title: string;
  description?: string;
  /** User-facing guidance: what the customer should do at this step
   *  and what to expect. Capped at USER_INSTRUCTIONS_MAX_LENGTH chars
   *  via validateSteps(). The legacy `description` field is the LLM's
   *  raw system prompt and is NEVER rendered to end users. */
  userInstructions?: string;
  requiredFunctionCalls?: string[];
  skillIds?: string[];
  /** Number of media assets (images/videos) this step must produce before it can be
   *  marked completed. Carried through to the session work plan and enforced by
   *  setWorkPlanStatus. Set this on multi-image steps (e.g. "Generate 18 images") so
   *  the step cannot be closed with only a fraction generated. */
  expectedAssetCount?: number;
}

export interface WorkPlan {
  planId: string;
  title: string;
  description?: string;
  welcomeMessage?: string;
  autocomplete?: boolean;
  requireLogin?: boolean;
  showLoginSignup?: string;
  showInAgentMode?: boolean;
  defaultModel?: string;
  category?: string;
  steps: WorkPlanStep[];
  ownerId?: string;
  orgId?: string;
  visibility: WorkPlanVisibility;
  isBuiltIn: boolean;
  createdAt: string;
  updatedAt: string;
  reviewFeedback?: string;
  thumbnail_url?: string;
  thumbnail_source?: 'ai' | 'upload' | 'none';
  thumbnail_alt_text?: string;
}

export class WorkPlanService {
  private tableName: string;

  constructor() {
    this.tableName = `${TABLE_PREFIX}AW-WorkPlans`;
  }

  /**
   * Validate per-step fields that have a user-facing constraint.
   * Throws an error with a 1-indexed step pointer so the message
   * surfaces clearly in API responses + logs.
   */
  private validateSteps(steps: WorkPlanStep[] | undefined): void {
    if (!steps) return;
    steps.forEach((step, idx) => {
      if (step.userInstructions === undefined || step.userInstructions === null) return;
      if (typeof step.userInstructions !== 'string') {
        throw new Error(`step ${idx + 1}: userInstructions must be a string`);
      }
      if (step.userInstructions.length > USER_INSTRUCTIONS_MAX_LENGTH) {
        throw new Error(
          `step ${idx + 1}: userInstructions exceeds ${USER_INSTRUCTIONS_MAX_LENGTH} characters (got ${step.userInstructions.length})`,
        );
      }
    });
  }

  async createWorkPlan(plan: Omit<WorkPlan, 'planId' | 'createdAt' | 'updatedAt'>): Promise<WorkPlan> {
    this.validateSteps(plan.steps);
    const timestamp = new Date().toISOString();
    const workPlan: WorkPlan = {
      ...plan,
      planId: uuidv4(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await dynamodb.put({
      TableName: this.tableName,
      Item: workPlan,
    }).promise();

    return workPlan;
  }

  async getWorkPlan(planId: string): Promise<WorkPlan | null> {
    const result = await dynamodb.get({
      TableName: this.tableName,
      Key: { planId },
    }).promise();
    return (result.Item as WorkPlan) || null;
  }

  async updateWorkPlan(plan: WorkPlan): Promise<void> {
    this.validateSteps(plan.steps);
    await dynamodb.put({
      TableName: this.tableName,
      Item: { ...plan, updatedAt: new Date().toISOString() },
    }).promise();
  }

  /**
   * Write only the thumbnail attributes of a plan.
   *
   * updateWorkPlan is a whole-item put, so it is unsafe for the thumbnail
   * pipeline: AI generation is fired and forgotten at create time holding the
   * plan as it looked then, and finishes seconds-to-minutes later. Putting that
   * snapshot back silently reverted any edit made in the meantime — an admin
   * fixing a step right after creating a plan would watch the fix disappear
   * with no error (found while live-testing ENG-889).
   *
   * A field is left untouched when its key is absent, and REMOVEd when the key
   * is present with an undefined value.
   */
  async updateThumbnail(
    planId: string,
    fields: Partial<Pick<WorkPlan, 'thumbnail_url' | 'thumbnail_source' | 'thumbnail_alt_text'>>,
    opts: {
      /** Set on automatic (AI) writes. Generation starts at create time and lands
       *  ~40s later, so an admin can upload their own thumbnail in the window;
       *  without this the older automatic result silently replaces their choice.
       *  User-initiated writes leave it off and always win. */
      skipIfUserUploaded?: boolean;
    } = {},
  ): Promise<void> {
    const sets = ['#updatedAt = :updatedAt'];
    const removes: string[] = [];
    const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
    const values: Record<string, any> = { ':updatedAt': new Date().toISOString() };

    const KEYS = ['thumbnail_url', 'thumbnail_source', 'thumbnail_alt_text'] as const;
    for (const key of KEYS) {
      if (!(key in fields)) continue;
      names[`#${key}`] = key;
      const value = fields[key];
      if (value === undefined) {
        removes.push(`#${key}`);
      } else {
        sets.push(`#${key} = :${key}`);
        values[`:${key}`] = value;
      }
    }

    // update is an upsert. The thumbnail job runs long after create, so the plan
    // may be deleted mid-flight; without attribute_exists we would write back an
    // item holding only planId and the thumbnail fields — no title, no steps —
    // which breaks every consumer that maps over plan.steps.
    let condition = 'attribute_exists(planId)';
    if (opts.skipIfUserUploaded) {
      names['#thumbnail_source'] = 'thumbnail_source';
      values[':uploadedSource'] = 'upload';
      condition += ' AND (attribute_not_exists(#thumbnail_source) OR #thumbnail_source <> :uploadedSource)';
    }

    try {
      await dynamodb.update({
        TableName: this.tableName,
        Key: { planId },
        UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: condition,
      }).promise();
    } catch (err: any) {
      // Either the plan is gone, or an admin uploaded their own thumbnail while
      // this automatic job was running. Both mean "do nothing", not "fail".
      if (err?.code === 'ConditionalCheckFailedException') return;
      throw err;
    }
  }

  async deleteWorkPlan(planId: string): Promise<void> {
    await dynamodb.delete({
      TableName: this.tableName,
      Key: { planId },
    }).promise();
  }

  /**
   * Transfer ownership of a work plan to a new user (used when removing a member from an org).
   */
  async transferOwner(planId: string, newOwnerId: string): Promise<void> {
    await dynamodb.update({
      TableName: this.tableName,
      Key: { planId },
      UpdateExpression: "SET ownerId = :newOwner, updatedAt = :now",
      ExpressionAttributeValues: {
        ":newOwner": newOwnerId,
        ":now": new Date().toISOString(),
      },
    }).promise();
  }

  async getAllWorkPlans(): Promise<WorkPlan[]> {
    try {
      const items = await paginatedScan(dynamodb, { TableName: this.tableName });
      return (items as WorkPlan[]) || [];
    } catch (error) {
      if ((error as any).code === 'ResourceNotFoundException') {
        return [];
      }
      throw error;
    }
  }

  async getWorkPlansByOwner(ownerId: string): Promise<WorkPlan[]> {
    const result = await dynamodb.query({
      TableName: this.tableName,
      IndexName: 'OwnerIndex',
      KeyConditionExpression: 'ownerId = :ownerId',
      ExpressionAttributeValues: { ':ownerId': ownerId },
    }).promise();
    return (result.Items as WorkPlan[]) || [];
  }

  async getWorkPlansByOrg(orgId: string, callerUserId: string = ""): Promise<WorkPlan[]> {
    const { orgDb } = await import("./db");
    const members = await orgDb.getOrgMembers(orgId);
    const others = members.map((m: { userId: string }) => m.userId).filter((uid: string) => uid !== callerUserId);
    const perMember = await Promise.all(others.map((uid: string) => this.getWorkPlansByOwner(uid)));
    return perMember.flat();
  }

  async getWorkPlansByVisibility(visibility: WorkPlanVisibility): Promise<WorkPlan[]> {
    const result = await dynamodb.query({
      TableName: this.tableName,
      IndexName: 'VisibilityIndex',
      KeyConditionExpression: 'visibility = :visibility',
      ExpressionAttributeValues: { ':visibility': visibility },
    }).promise();
    return (result.Items as WorkPlan[]) || [];
  }

  async getPublicPlansForAgentMode(): Promise<WorkPlan[]> {
    const [systemPlans, publicPlans] = await Promise.all([
      this.getWorkPlansByVisibility('system'),
      this.getWorkPlansByVisibility('public'),
    ]);
    return [...systemPlans, ...publicPlans].filter(p => p.showInAgentMode !== false);
  }

  async submitForReview(planId: string, ownerId: string): Promise<WorkPlan> {
    const plan = await this.getWorkPlan(planId);
    if (!plan) throw new Error('Work plan not found');
    if (plan.ownerId !== ownerId) throw new Error('Not authorized');
    if (plan.visibility !== 'private') throw new Error('Only private plans can be submitted for review');

    plan.visibility = 'pending_review';
    plan.reviewFeedback = undefined;
    await this.updateWorkPlan(plan);
    return plan;
  }

  async approveWorkPlan(planId: string): Promise<WorkPlan> {
    const plan = await this.getWorkPlan(planId);
    if (!plan) throw new Error('Work plan not found');
    if (plan.visibility !== 'pending_review') throw new Error('Plan is not pending review');

    plan.visibility = 'public';
    plan.showInAgentMode = true;
    await this.updateWorkPlan(plan);
    return plan;
  }

  async rejectWorkPlan(planId: string, feedback: string): Promise<WorkPlan> {
    const plan = await this.getWorkPlan(planId);
    if (!plan) throw new Error('Work plan not found');
    if (plan.visibility !== 'pending_review') throw new Error('Plan is not pending review');

    plan.visibility = 'private';
    plan.reviewFeedback = feedback;
    await this.updateWorkPlan(plan);
    return plan;
  }

  async syncWorkPlan(planId: string, direction: 'prod-to-dev' | 'dev-to-prod'): Promise<WorkPlan | null> {
    const sourceTable = direction === 'prod-to-dev' ? 'AW-WorkPlans' : 'Dev-AW-WorkPlans';
    const targetTable = direction === 'prod-to-dev' ? 'Dev-AW-WorkPlans' : 'AW-WorkPlans';

    const result = await dynamodb.get({
      TableName: sourceTable,
      Key: { planId },
    }).promise();

    if (!result.Item) return null;

    await dynamodb.put({
      TableName: targetTable,
      Item: result.Item,
    }).promise();

    return result.Item as WorkPlan;
  }

  async getSyncStatus(): Promise<Record<string, { inSync: boolean; existsInProd: boolean; existsInDev: boolean; changedFields: string[] }>> {
    const [prodItems, devItems] = await Promise.all([
      paginatedScan(dynamodb, { TableName: 'AW-WorkPlans' }).catch(() => []),
      paginatedScan(dynamodb, { TableName: 'Dev-AW-WorkPlans' }).catch(() => []),
    ]);

    const prodMap = new Map((prodItems as WorkPlan[]).map(p => [p.planId, p]));
    const devMap = new Map((devItems as WorkPlan[]).map(p => [p.planId, p]));
    const allIds = new Set([...prodMap.keys(), ...devMap.keys()]);

    const result: Record<string, { inSync: boolean; existsInProd: boolean; existsInDev: boolean; changedFields: string[] }> = {};
    for (const id of allIds) {
      const prod = prodMap.get(id);
      const dev = devMap.get(id);
      const changedFields: string[] = [];
      if (prod && dev) {
        if (prod.title !== dev.title) changedFields.push('title');
        if (prod.description !== dev.description) changedFields.push('description');
        if (JSON.stringify(prod.steps) !== JSON.stringify(dev.steps)) changedFields.push('steps');
        if (prod.welcomeMessage !== dev.welcomeMessage) changedFields.push('welcomeMessage');
      }
      result[id] = {
        inSync: !!(prod && dev && changedFields.length === 0),
        existsInProd: !!prod,
        existsInDev: !!dev,
        changedFields,
      };
    }
    return result;
  }
}

export const workPlanService = new WorkPlanService();
