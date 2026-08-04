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
  /** Bumped by every thumbnail write and by nothing else. Thumbnail generations
   *  condition on it, so a concurrent title/step/owner edit cannot discard a
   *  generated thumbnail while a concurrent thumbnail action still does. */
  thumbnail_rev?: string;
}

/** Owned exclusively by updateThumbnail. updateWorkPlan must never write these,
 *  or an ordinary plan save would clobber a newer thumbnail — the same
 *  lost-update class this pipeline already had (ENG-889). */
const THUMBNAIL_FIELDS = ['thumbnail_url', 'thumbnail_source', 'thumbnail_alt_text', 'thumbnail_rev'] as const;

/** Optional plan fields: set when present, REMOVEd when the caller cleared them
 *  (a whole-item put used to give us that for free). */
const OPTIONAL_PLAN_FIELDS = [
  'description', 'welcomeMessage', 'autocomplete', 'requireLogin', 'showLoginSignup',
  'showInAgentMode', 'defaultModel', 'category', 'ownerId', 'orgId', 'reviewFeedback',
] as const;

/** Always written. */
const REQUIRED_PLAN_FIELDS = ['title', 'steps', 'visibility', 'isBuiltIn', 'createdAt'] as const;

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

  /**
   * Update a plan without touching its thumbnail.
   *
   * This was a whole-item put, which meant an ordinary save wrote back whatever
   * thumbnail the caller happened to be holding — clobbering a newer one, and
   * making any thumbnail-scoped version attribute impossible to keep. It is now
   * attribute-scoped: every non-thumbnail field is written, fields the caller
   * cleared are REMOVEd (which the put gave us for free), and the thumbnail
   * attributes are left entirely alone (ENG-889).
   */
  async updateWorkPlan(plan: WorkPlan): Promise<void> {
    this.validateSteps(plan.steps);

    const sets = ['#updatedAt = :updatedAt'];
    const removes: string[] = [];
    const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
    const values: Record<string, any> = { ':updatedAt': new Date().toISOString() };

    for (const key of REQUIRED_PLAN_FIELDS) {
      names[`#${key}`] = key;
      values[`:${key}`] = (plan as any)[key];
      sets.push(`#${key} = :${key}`);
    }
    for (const key of OPTIONAL_PLAN_FIELDS) {
      names[`#${key}`] = key;
      const value = (plan as any)[key];
      if (value === undefined) {
        removes.push(`#${key}`);
      } else {
        values[`:${key}`] = value;
        sets.push(`#${key} = :${key}`);
      }
    }

    await dynamodb.update({
      TableName: this.tableName,
      Key: { planId: plan.planId },
      UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(planId)',
    }).promise();
  }

  /**
   * Write only the thumbnail attributes of a plan, and only if no other
   * thumbnail action has happened since the caller observed it.
   *
   * Ordering is one conditional write on `thumbnail_rev`, an attribute only
   * this method writes. Not a claim-then-write token — a claim is a second
   * unconditioned write that races the actions it exists to order. Not the
   * plan-wide `updatedAt` either: that made an unrelated title or step edit
   * discard a perfectly good generated thumbnail. Scoping the version to the
   * thumbnail means only a competing thumbnail action invalidates a generation.
   *
   * Safe because updateWorkPlan is attribute-scoped and never writes these
   * fields, so an ordinary plan save cannot roll the revision back.
   *
   * @param opts.expectedRev the revision observed when the work began; `null`
   *   for "the plan had no thumbnail revision yet". Omit for user-initiated
   *   writes, which are unconditional and always win.
   * @returns the new revision when the write landed, or null when a newer
   *   thumbnail action won, or the plan is gone. Callers must not report null
   *   as success.
   */
  async updateThumbnail(
    planId: string,
    fields: Partial<Pick<WorkPlan, 'thumbnail_url' | 'thumbnail_source' | 'thumbnail_alt_text'>>,
    opts: { expectedRev?: string | null } = {},
  ): Promise<string | null> {
    const rev = uuidv4();
    const sets = ['#updatedAt = :updatedAt', '#thumbnail_rev = :thumbnail_rev'];
    const removes: string[] = [];
    const names: Record<string, string> = { '#updatedAt': 'updatedAt', '#thumbnail_rev': 'thumbnail_rev' };
    const values: Record<string, any> = { ':updatedAt': new Date().toISOString(), ':thumbnail_rev': rev };

    for (const key of ['thumbnail_url', 'thumbnail_source', 'thumbnail_alt_text'] as const) {
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

    // update is an upsert, so without attribute_exists a plan deleted while a
    // generation was running would come back as a stub holding only planId and
    // the thumbnail fields — no title, no steps — which breaks every consumer
    // that maps over plan.steps.
    let condition = 'attribute_exists(planId)';
    if ('expectedRev' in opts) {
      if (opts.expectedRev === null || opts.expectedRev === undefined) {
        condition += ' AND attribute_not_exists(#thumbnail_rev)';
      } else {
        values[':expectedRev'] = opts.expectedRev;
        condition += ' AND #thumbnail_rev = :expectedRev';
      }
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
      return rev;
    } catch (err: any) {
      // Either the plan is gone, or a newer thumbnail action won. Both mean
      // "this write does not apply", not "this write failed".
      if (err?.code === 'ConditionalCheckFailedException') return null;
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
