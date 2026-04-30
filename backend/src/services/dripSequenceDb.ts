/**
 * AW-DripSequences + AW-SequenceEnrollments
 *
 * A Sequence is a named, reusable drip campaign (e-mail sequence) that belongs
 * to one user.  It supports any purpose: free→paid conversion, onboarding,
 * re-engagement, nurture, upsell, or a fully custom flow.
 *
 * Table schemas:
 *
 *   AW-DripSequences
 *     PK: sequenceId
 *     GSI: userId-createdAt-index (PK: userId, SK: createdAt)
 *
 *   AW-SequenceEnrollments
 *     PK: enrollmentId
 *     GSI: sequenceId-status-index (PK: sequenceId, SK: status) — dashboard queries
 *     GSI: userId-nextSendAt-index (PK: userId, SK: nextSendAt) — worker queries
 *     GSI: leadEmail-index (PK: leadEmail) — de-dup checks
 */

import { v4 as uuidv4 } from 'uuid';
import AWS from 'aws-sdk';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

AWS.config.update({
  region: process.env.AWS_REGION || 'us-west-2',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const dynamodb = new AWS.DynamoDB.DocumentClient();

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const SEQUENCES_TABLE = `${TABLE_PREFIX}AW-DripSequences`;
const ENROLLMENTS_TABLE = `${TABLE_PREFIX}AW-SequenceEnrollments`;

// ─── Types ────────────────────────────────────────────────────────────────────

export type SequenceCampaignType =
  | 'conversion'
  | 'onboarding'
  | 'reengagement'
  | 'nurture'
  | 'upsell'
  | 'custom';

export type SequenceStatus = 'draft' | 'active' | 'paused' | 'archived';

export type EnrollmentTriggerType =
  | 'manual'
  | 'lifecycle_change'
  | 'list_membership';

export type LeadLifecycle =
  | 'unknown'
  | 'inbox'
  | 'signed_up'
  | 'in_deal'
  | 'trialing'
  | 'paying'
  | 'at_risk'
  | 'churned';

export type EmailEngagementEvent = 'opened' | 'clicked' | 'replied';

export type EnrollmentStatus =
  | 'active'
  | 'completed'
  | 'exited'
  | 'unsubscribed'
  | 'bounced';

export type ExitReason =
  | 'completed'
  | 'converted'
  | 'engagement'
  | 'unsubscribed'
  | 'bounced'
  | 'manual';

export type StepConditionOperator = 'eq' | 'neq' | 'exists' | 'not_exists' | 'contains';

export interface StepCondition {
  field: string;              // dot-notation path on lead record, e.g. "lifecycle" or "customFields.interested_in_outreach"
  operator: StepConditionOperator;
  value?: any;                // not required for exists / not_exists
}

export interface SequenceStep {
  stepId: string;
  stepNumber: number;         // 1-based display order
  name: string;
  delayDays: number;          // days after previous step (or enrollment for step 1)
  subject: string;
  bodyHtml: string;
  senderId?: string;          // sender config id; falls back to user default
  spamCheckedAt?: string;     // ISO timestamp of last spam check
  spamPassed?: boolean;       // result of last spam check
  spamContentHash?: string;   // hash of subject+bodyHtml at check time; if content changes, result is stale
}

export interface DripSequence {
  sequenceId: string;
  userId: string;
  name: string;
  description?: string;
  campaignType: SequenceCampaignType;

  enrollmentTrigger: {
    type: EnrollmentTriggerType;
    lifecycleStage?: LeadLifecycle;   // used when type = 'lifecycle_change'
    listId?: string;                  // used when type = 'list_membership'
  };

  exitConditions: {
    onLifecycleChange?: LeadLifecycle[];        // exit when lead reaches these stages
    onEmailEngagement?: EmailEngagementEvent[];  // exit on engagement events
    onUnsubscribe: boolean;                      // always enforced
  };

  enrollmentCondition?: StepCondition;  // if set, checked before every send; exits if not met

  // Lists configured to auto-enroll new leads into this sequence.
  // Set automatically when user enrolls via by-list; can be cleared to disable.
  autoEnrollListIds?: string[];

  steps: SequenceStep[];
  status: SequenceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSequenceInput {
  userId: string;
  name: string;
  description?: string;
  campaignType?: SequenceCampaignType;
  enrollmentTrigger?: DripSequence['enrollmentTrigger'];
  enrollmentCondition?: StepCondition;
  exitConditions?: Partial<DripSequence['exitConditions']>;
  steps?: Omit<SequenceStep, 'stepId'>[];
  status?: SequenceStatus;
}

export interface UpdateSequenceInput {
  name?: string;
  description?: string | null;
  campaignType?: SequenceCampaignType;
  enrollmentTrigger?: DripSequence['enrollmentTrigger'];
  enrollmentCondition?: StepCondition | null;
  exitConditions?: Partial<DripSequence['exitConditions']>;
  autoEnrollListIds?: string[] | null;
  steps?: Omit<SequenceStep, 'stepId'>[];
  status?: SequenceStatus;
}

export interface SequenceEnrollment {
  enrollmentId: string;
  sequenceId: string;
  userId: string;          // sequence owner (for worker GSI)
  listId: string;
  leadId: string;
  leadEmail: string;

  currentStep: number;     // 0-based index of the NEXT step to send
  nextSendAt: string;      // ISO — when to send the next step
  status: EnrollmentStatus;
  exitReason?: ExitReason;

  enrolledAt: string;
  lastEmailSentAt?: string;
  completedAt?: string;
}

export interface CreateEnrollmentInput {
  sequenceId: string;
  userId: string;
  listId: string;
  leadId: string;
  leadEmail: string;
  startAt?: string;   // override first send time; defaults to now
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function generateSequenceId(): string {
  return `seq_${Date.now()}_${uuidv4().slice(0, 8)}`;
}

export function generateEnrollmentId(): string {
  return `enr_${Date.now()}_${uuidv4().slice(0, 8)}`;
}

function generateStepId(): string {
  return `step_${uuidv4().slice(0, 8)}`;
}

function now(): string {
  return new Date().toISOString();
}

// ─── Sequences ────────────────────────────────────────────────────────────────

async function createSequence(input: CreateSequenceInput): Promise<DripSequence> {
  const sequenceId = generateSequenceId();
  const ts = now();

  const steps: SequenceStep[] = (input.steps ?? []).map((s, i) => ({
    ...s,
    stepId: generateStepId(),
    stepNumber: i + 1,
  }));

  const sequence: DripSequence = {
    sequenceId,
    userId: input.userId,
    name: input.name,
    description: input.description,
    campaignType: input.campaignType ?? 'custom',
    enrollmentTrigger: input.enrollmentTrigger ?? { type: 'manual' },
    ...(input.enrollmentCondition ? { enrollmentCondition: input.enrollmentCondition } : {}),
    exitConditions: {
      onUnsubscribe: true,
      ...input.exitConditions,
    },
    steps,
    status: input.status ?? 'draft',
    createdAt: ts,
    updatedAt: ts,
  };

  await dynamodb.put({
    TableName: SEQUENCES_TABLE,
    Item: sequence,
    ConditionExpression: 'attribute_not_exists(sequenceId)',
  }).promise();

  return sequence;
}

async function getSequence(sequenceId: string): Promise<DripSequence | null> {
  const result = await dynamodb.get({
    TableName: SEQUENCES_TABLE,
    Key: { sequenceId },
  }).promise();
  return (result.Item as DripSequence) ?? null;
}

async function listSequences(userId: string): Promise<DripSequence[]> {
  const result = await dynamodb.query({
    TableName: SEQUENCES_TABLE,
    IndexName: 'userId-createdAt-index',
    KeyConditionExpression: 'userId = :uid',
    ExpressionAttributeValues: { ':uid': userId },
    ScanIndexForward: false,
  }).promise();
  return (result.Items ?? []) as DripSequence[];
}

async function updateSequence(
  sequenceId: string,
  userId: string,
  input: UpdateSequenceInput,
): Promise<DripSequence> {
  const existing = await getSequence(sequenceId);
  if (!existing) throw new SequenceNotFoundError(sequenceId);
  if (existing.userId !== userId) throw new SequenceAuthError();

  const updates: Partial<DripSequence> = { updatedAt: now() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) (updates as any).description = input.description ?? null;
  if (input.campaignType !== undefined) updates.campaignType = input.campaignType;
  if (input.enrollmentTrigger !== undefined) updates.enrollmentTrigger = input.enrollmentTrigger;
  if (input.enrollmentCondition !== undefined) {
    // null means "remove condition" → REMOVE in DynamoDB
    (updates as any).enrollmentCondition = input.enrollmentCondition ?? null;
  }
  if (input.exitConditions !== undefined) {
    updates.exitConditions = {
      ...existing.exitConditions,
      ...input.exitConditions,
      onUnsubscribe: true,  // always enforced
    };
  }
  if (input.autoEnrollListIds !== undefined) {
    // null means "clear all auto-enroll lists" (disable auto-enroll) → REMOVE in DynamoDB
    (updates as any).autoEnrollListIds = input.autoEnrollListIds ?? null;
  }
  if (input.steps !== undefined) {
    updates.steps = input.steps.map((s, i) => ({
      ...s,
      stepId: generateStepId(),
      stepNumber: i + 1,
    }));
  }
  if (input.status !== undefined) updates.status = input.status;

  // Build DynamoDB update expression. Fields explicitly set to null get REMOVED.
  const setExpressions: string[] = [];
  const removeExpressions: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, any> = {};

  let idx = 0;
  for (const [k, v] of Object.entries(updates)) {
    const nameKey = `#f${idx}`;
    names[nameKey] = k;
    if (v === null || v === undefined) {
      removeExpressions.push(nameKey);
    } else {
      const valKey = `:v${idx}`;
      values[valKey] = v;
      setExpressions.push(`${nameKey} = ${valKey}`);
    }
    idx++;
  }

  let updateExpression = '';
  if (setExpressions.length > 0) updateExpression += `SET ${setExpressions.join(', ')}`;
  if (removeExpressions.length > 0) updateExpression += ` REMOVE ${removeExpressions.join(', ')}`;

  const result = await dynamodb.update({
    TableName: SEQUENCES_TABLE,
    Key: { sequenceId },
    UpdateExpression: updateExpression.trim(),
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
    ConditionExpression: 'attribute_exists(sequenceId)',
    ReturnValues: 'ALL_NEW',
  }).promise();

  return result.Attributes as DripSequence;
}

async function deleteSequence(sequenceId: string, userId: string): Promise<void> {
  const existing = await getSequence(sequenceId);
  if (!existing) throw new SequenceNotFoundError(sequenceId);
  if (existing.userId !== userId) throw new SequenceAuthError();

  await dynamodb.delete({
    TableName: SEQUENCES_TABLE,
    Key: { sequenceId },
  }).promise();
}

// ─── Enrollments ─────────────────────────────────────────────────────────────

async function enrollLead(input: CreateEnrollmentInput): Promise<SequenceEnrollment> {
  const enrollment: SequenceEnrollment = {
    enrollmentId: generateEnrollmentId(),
    sequenceId: input.sequenceId,
    userId: input.userId,
    listId: input.listId,
    leadId: input.leadId,
    leadEmail: input.leadEmail,
    currentStep: 0,
    nextSendAt: input.startAt ?? now(),
    status: 'active',
    enrolledAt: now(),
  };

  await dynamodb.put({
    TableName: ENROLLMENTS_TABLE,
    Item: enrollment,
  }).promise();

  return enrollment;
}

/** Bulk-enroll multiple leads; skips leads already enrolled (active or completed/converted). */
async function bulkEnroll(
  inputs: CreateEnrollmentInput[],
): Promise<{ enrolled: number; skipped: number }> {
  let enrolled = 0;
  let skipped = 0;

  for (const input of inputs) {
    const existing = await getExistingEnrollment(input.sequenceId, input.leadEmail);
    if (existing) {
      skipped++;
      continue;
    }
    await enrollLead(input);
    enrolled++;
  }

  return { enrolled, skipped };
}

/**
 * Returns any existing enrollment for this lead+sequence regardless of status.
 * Used by bulkEnroll to skip leads who are active, completed, or converted —
 * only truly fresh leads (never enrolled) get added.
 */
async function getExistingEnrollment(
  sequenceId: string,
  leadEmail: string,
): Promise<SequenceEnrollment | null> {
  const result = await dynamodb.query({
    TableName: ENROLLMENTS_TABLE,
    IndexName: 'leadEmail-index',
    KeyConditionExpression: 'leadEmail = :email',
    FilterExpression: 'sequenceId = :sid',
    ExpressionAttributeValues: {
      ':email': leadEmail,
      ':sid': sequenceId,
    },
  }).promise();

  const items = (result.Items ?? []) as SequenceEnrollment[];
  return items[0] ?? null;
}

async function getActiveEnrollment(
  sequenceId: string,
  leadEmail: string,
): Promise<SequenceEnrollment | null> {
  const result = await dynamodb.query({
    TableName: ENROLLMENTS_TABLE,
    IndexName: 'leadEmail-index',
    KeyConditionExpression: 'leadEmail = :email',
    FilterExpression: 'sequenceId = :sid AND #s = :active',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':email': leadEmail,
      ':sid': sequenceId,
      ':active': 'active',
    },
  }).promise();

  const items = (result.Items ?? []) as SequenceEnrollment[];
  return items[0] ?? null;
}

async function getEnrollment(enrollmentId: string): Promise<SequenceEnrollment | null> {
  const result = await dynamodb.get({
    TableName: ENROLLMENTS_TABLE,
    Key: { enrollmentId },
  }).promise();
  return (result.Item as SequenceEnrollment) ?? null;
}

async function listEnrollmentsForSequence(
  sequenceId: string,
  status?: EnrollmentStatus,
): Promise<SequenceEnrollment[]> {
  const params: Parameters<typeof dynamodb.query>[0] = {
    TableName: ENROLLMENTS_TABLE,
    IndexName: 'sequenceId-status-index',
    KeyConditionExpression: status
      ? 'sequenceId = :sid AND #s = :status'
      : 'sequenceId = :sid',
    ExpressionAttributeValues: status
      ? { ':sid': sequenceId, ':status': status }
      : { ':sid': sequenceId },
  };
  if (status) {
    params.ExpressionAttributeNames = { '#s': 'status' };
  }
  const result = await dynamodb.query(params).promise();
  return (result.Items ?? []) as SequenceEnrollment[];
}

/** Worker query: find all active enrollments whose nextSendAt is due. */
async function getDueEnrollments(userId: string): Promise<SequenceEnrollment[]> {
  const result = await dynamodb.query({
    TableName: ENROLLMENTS_TABLE,
    IndexName: 'userId-nextSendAt-index',
    KeyConditionExpression: 'userId = :uid AND nextSendAt <= :now',
    FilterExpression: '#s = :active',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':uid': userId,
      ':now': now(),
      ':active': 'active',
    },
  }).promise();
  return (result.Items ?? []) as SequenceEnrollment[];
}

/** All due enrollments across all users (for the global worker). */
async function getAllDueEnrollments(): Promise<SequenceEnrollment[]> {
  // We scan with a filter. Acceptable because the table stays small and the
  // worker runs every few minutes — no hot-path concern.
  const result = await dynamodb.scan({
    TableName: ENROLLMENTS_TABLE,
    FilterExpression: '#s = :active AND nextSendAt <= :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':active': 'active',
      ':now': now(),
    },
  }).promise();
  return (result.Items ?? []) as SequenceEnrollment[];
}

async function advanceEnrollment(
  enrollmentId: string,
  nextStep: number,
  nextSendAt: string,
): Promise<void> {
  await dynamodb.update({
    TableName: ENROLLMENTS_TABLE,
    Key: { enrollmentId },
    UpdateExpression: 'SET currentStep = :step, nextSendAt = :next, lastEmailSentAt = :sent',
    ExpressionAttributeValues: {
      ':step': nextStep,
      ':next': nextSendAt,
      ':sent': now(),
    },
  }).promise();
}

async function completeEnrollment(
  enrollmentId: string,
  exitReason: ExitReason,
  finalStatus: EnrollmentStatus = 'completed',
): Promise<void> {
  await dynamodb.update({
    TableName: ENROLLMENTS_TABLE,
    Key: { enrollmentId },
    UpdateExpression: 'SET #s = :status, exitReason = :reason, completedAt = :ts, lastEmailSentAt = :sent',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':status': finalStatus,
      ':reason': exitReason,
      ':ts': now(),
      ':sent': now(),
    },
  }).promise();
}

async function exitEnrollment(
  enrollmentId: string,
  exitReason: ExitReason,
): Promise<void> {
  await completeEnrollment(enrollmentId, exitReason, 'exited');
}

async function getEnrollmentStats(sequenceId: string): Promise<{
  active: number;
  completed: number;
  exited: number;
  unsubscribed: number;
  bounced: number;
  total: number;
}> {
  const all = await listEnrollmentsForSequence(sequenceId);
  const counts = { active: 0, completed: 0, exited: 0, unsubscribed: 0, bounced: 0, total: all.length };
  for (const e of all) {
    if (e.status in counts) (counts as any)[e.status]++;
  }
  return counts;
}

/**
 * Returns all active sequences for a user that have autoEnrollListIds containing listId.
 * Called when a new lead is added to a list to auto-enroll them.
 */
async function getSequencesByAutoEnrollList(userId: string, listId: string): Promise<DripSequence[]> {
  const all = await listSequences(userId);
  return all.filter(
    (s) =>
      s.status === 'active' &&
      Array.isArray(s.autoEnrollListIds) &&
      s.autoEnrollListIds.includes(listId),
  );
}

// ─── Error classes ────────────────────────────────────────────────────────────

export class SequenceNotFoundError extends Error {
  constructor(sequenceId: string) {
    super(`Sequence ${sequenceId} not found`);
    this.name = 'SequenceNotFoundError';
  }
}

export class SequenceAuthError extends Error {
  constructor(message = 'Not authorized to modify this sequence') {
    super(message);
    this.name = 'SequenceAuthError';
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const dripSequenceDb = {
  // Sequences
  createSequence,
  getSequence,
  listSequences,
  updateSequence,
  deleteSequence,
  getSequencesByAutoEnrollList,

  // Enrollments
  enrollLead,
  bulkEnroll,
  getEnrollment,
  getActiveEnrollment,
  getExistingEnrollment,
  listEnrollmentsForSequence,
  getDueEnrollments,
  getAllDueEnrollments,
  advanceEnrollment,
  completeEnrollment,
  exitEnrollment,
  getEnrollmentStats,
};
