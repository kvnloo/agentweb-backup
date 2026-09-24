import AWS from 'aws-sdk';
import { randomUUID } from 'crypto';
import type { AskUserQuestionOption } from './agentMode/core/askUserQuestion';

// Same per-file DynamoDB client convention as approvalDb.ts/chatbotService.ts —
// each service owns its own DocumentClient instance rather than sharing one.
const dynamodbConfig = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
};
const dynamodb = new AWS.DynamoDB.DocumentClient(dynamodbConfig);

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const APPROVAL_DECISIONS_TABLE = `${TABLE_PREFIX}AW-ApprovalDecisions`;

export class ApprovalInboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalInboxError';
  }
}

export type ApprovalDecisionGateType =
  | 'meta_write'
  | 'plan_choice'
  | 'customer_credential'
  | 'customer_confirmation';

export type ApprovalDecisionAudience = 'team' | 'customer';

/** Named approvers per the ticket — Matt, Harsha, Fangfang. Extend here (and
 *  in approverDirectory.ts, Phase C) if a fourth named approver is ever added. */
export type ApprovalDecisionApprover = 'matt' | 'harsha' | 'fangfang';

export type ApprovalDecisionStatus =
  // Pending states are audience-specific and mutually exclusive by
  // construction (createDecision enforces this) — a customer item can never
  // read as an internal team review item, or vice versa (ticket point 6).
  | 'pending_team_review'
  | 'pending_customer_response'
  // Shared terminal/in-flight states once a pending decision resolves.
  | 'approved'
  | 'rejected'
  | 'edited'
  | 'expired'
  | 'dispatching'
  | 'executed'
  | 'execution_failed'
  | 'superseded';

export type ApprovalDecisionVerdict = 'approve' | 'reject' | 'edit';

export interface ApprovalDecisionEvidencePacket {
  chatUrl?: string;
  researchSummary?: string;
  links?: string[];
  screenshots?: string[];
}

/** Present iff gateType === 'meta_write'. Mirrors ApprovalDeckItem.metaWriteDispatch
 *  (approvalDeck.ts) exactly, including the same resolvedAccountId freeze —
 *  this is the field a durable, days-later resume must dispatch against,
 *  never a live re-derivation. See agentModeService.ts's own comment at the
 *  construction site for why account_id (raw) and resolvedAccountId (frozen)
 *  are both kept, never merged into one. */
export interface ApprovalDecisionMetaWriteDispatch {
  entity_type: string;
  action: string;
  account_id: string;
  resolvedAccountId?: string;
  campaign_id?: string;
  ad_set_id?: string;
  ad_id?: string;
  params: unknown;
}

export interface ApprovalDecisionExecutionResult {
  success: boolean;
  message?: string;
  appliedObjectId?: string;
  readBack?: unknown;
  at: string;
}

export interface ApprovalDecision {
  /** HASH key. For gateType='meta_write', THIS IS the metaWriteManifestDigest
   *  itself (metaLaunchGate.ts's own comment: "Child ENG-1644 uses this same
   *  digest as its pending-approval store key") — a changed payload produces
   *  a different digest, which is structurally a new record, never an
   *  in-place edit of this one. For every other gateType, a random UUID. */
  decisionId: string;
  gateType: ApprovalDecisionGateType;
  audience: ApprovalDecisionAudience;
  /** Present iff audience === 'team'. */
  approver?: ApprovalDecisionApprover;
  /** Present iff audience === 'customer' (Phase E). */
  customerId?: string;
  customerEmail?: string;
  customerName?: string;
  status: ApprovalDecisionStatus;
  businessImpact: string;
  evidencePacket: ApprovalDecisionEvidencePacket;
  /** Present for plan_choice items — the fixed decision-deck option shape,
   *  reused as-is rather than inventing a second one. */
  options?: AskUserQuestionOption[];
  /** Present iff gateType === 'meta_write'; equal to decisionId. */
  metaWriteManifestDigest?: string;
  metaWriteDispatch?: ApprovalDecisionMetaWriteDispatch;
  originSessionId?: string;
  originCorrelator?: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  answeredAt?: string;
  answeredBy?: string;
  verdict?: ApprovalDecisionVerdict;
  freeText?: string;
  slack?: { channelId: string; messageTs: string };
  executionResult?: ApprovalDecisionExecutionResult;
}

export interface CreateApprovalDecisionRequest {
  gateType: ApprovalDecisionGateType;
  approver?: ApprovalDecisionApprover;
  customerId?: string;
  customerEmail?: string;
  customerName?: string;
  businessImpact: string;
  evidencePacket: ApprovalDecisionEvidencePacket;
  options?: AskUserQuestionOption[];
  metaWriteManifestDigest?: string;
  metaWriteDispatch?: ApprovalDecisionMetaWriteDispatch;
  originSessionId?: string;
  originCorrelator?: string;
  /** ISO timestamp. Required — every decision must have a real expiry (ticket
   *  point 1: "...expiry, evidence packet, exact options..."). */
  expiresAt: string;
}

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

// Deliberately duplicated from approvalDeck.ts's own (file-private, not
// exported) validateItemShape rather than refactoring that live-in-production
// file's exports as a side effect of this new one — same three checks
// (option count, exactly one recommended, reserved 'comment' id), scoped down
// to just the option-shape rules that generalize to a standalone decision
// (the itemId/existingIds/kind checks there are deck-batch-specific and don't
// apply to a single durable decision record). Worth extracting into a shared
// pure validator later; not blocking for this phase.
function validateOptions(options: AskUserQuestionOption[] | undefined): void {
  if (options === undefined) return;
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    throw new ApprovalInboxError(`options must have between ${MIN_OPTIONS} and ${MAX_OPTIONS} entries`);
  }
  const recommendedCount = options.filter((o) => o.recommended === true).length;
  if (recommendedCount !== 1) {
    throw new ApprovalInboxError(`options must have exactly one recommended:true entry, found ${recommendedCount}`);
  }
  if (options.some((o) => o.id === 'comment')) {
    throw new ApprovalInboxError(`option id 'comment' is reserved (collides with the universal comment verdict)`);
  }
}

function validateCreateRequest(request: CreateApprovalDecisionRequest): void {
  if (typeof request.businessImpact !== 'string' || request.businessImpact.trim() === '') {
    throw new ApprovalInboxError('businessImpact must be a non-empty string');
  }
  if (typeof request.expiresAt !== 'string' || request.expiresAt.trim() === '') {
    throw new ApprovalInboxError('expiresAt must be a non-empty ISO timestamp');
  }

  const isCustomer = request.gateType === 'customer_credential' || request.gateType === 'customer_confirmation';
  // ENG-1644 ticket point 6, enforced as a hard invariant here rather than a
  // naming convention: a customer-audience item must never be constructible
  // with a team approver, and a team-audience item must never carry a
  // customerId — one or the other, never both, never neither.
  if (isCustomer) {
    if (request.approver) {
      throw new ApprovalInboxError(`gateType '${request.gateType}' is customer-audience and must not carry an approver`);
    }
    if (!request.customerId) {
      throw new ApprovalInboxError(`gateType '${request.gateType}' requires customerId`);
    }
  } else {
    if (request.customerId) {
      throw new ApprovalInboxError(`gateType '${request.gateType}' is team-audience and must not carry a customerId`);
    }
    if (!request.approver) {
      throw new ApprovalInboxError(`gateType '${request.gateType}' requires an approver (matt|harsha|fangfang)`);
    }
  }

  if (request.gateType === 'meta_write') {
    if (!request.metaWriteManifestDigest || !request.metaWriteDispatch) {
      throw new ApprovalInboxError(`gateType 'meta_write' requires both metaWriteManifestDigest and metaWriteDispatch`);
    }
    if (request.options !== undefined) {
      throw new ApprovalInboxError(`gateType 'meta_write' uses the fixed approve/reject verdict vocabulary and must not also declare options`);
    }
  } else if (request.gateType === 'plan_choice') {
    validateOptions(request.options);
    if (request.metaWriteManifestDigest || request.metaWriteDispatch) {
      throw new ApprovalInboxError(`gateType 'plan_choice' must not carry a metaWriteManifestDigest/metaWriteDispatch`);
    }
  }
}

export class ApprovalInboxService {
  /**
   * Idempotent create — attribute_not_exists(decisionId) means a re-preview
   * of the literal same write (same digest) collides safely rather than
   * silently overwriting an in-flight decision with a fresh one.
   */
  async createDecision(request: CreateApprovalDecisionRequest): Promise<ApprovalDecision> {
    validateCreateRequest(request);

    const isCustomer = request.gateType === 'customer_credential' || request.gateType === 'customer_confirmation';
    const decisionId = request.gateType === 'meta_write'
      ? request.metaWriteManifestDigest!
      : randomUUID();
    const now = new Date().toISOString();

    const decision: ApprovalDecision = {
      decisionId,
      gateType: request.gateType,
      audience: isCustomer ? 'customer' : 'team',
      approver: request.approver,
      customerId: request.customerId,
      customerEmail: request.customerEmail,
      customerName: request.customerName,
      status: isCustomer ? 'pending_customer_response' : 'pending_team_review',
      businessImpact: request.businessImpact,
      evidencePacket: request.evidencePacket,
      options: request.options,
      metaWriteManifestDigest: request.metaWriteManifestDigest,
      metaWriteDispatch: request.metaWriteDispatch,
      originSessionId: request.originSessionId,
      originCorrelator: request.originCorrelator,
      createdAt: now,
      expiresAt: request.expiresAt,
      updatedAt: now,
    };

    try {
      await dynamodb
        .put({
          TableName: APPROVAL_DECISIONS_TABLE,
          Item: decision,
          ConditionExpression: 'attribute_not_exists(decisionId)',
        })
        .promise();
      return decision;
    } catch (error: any) {
      if (error?.code === 'ConditionalCheckFailedException') {
        // Same digest (or same UUID collision, astronomically unlikely)
        // already staged — return the EXISTING record rather than erroring,
        // so a re-preview of the same exact write is a safe no-op, mirroring
        // claimMetaWriteManifestDigest's own at-most-once philosophy.
        const existing = await this.getDecision(decisionId);
        if (existing) return existing;
      }
      throw error;
    }
  }

  /**
   * Atomic conditional claim — a SINGLE DynamoDB update, guarded entirely by
   * its own ConditionExpression (current pending status + live expiry), so
   * two concurrent Slack clicks cannot both win. Mirrors
   * claimMetaWriteManifestDigest's conditional-update shape (chatbotService.ts),
   * not AW-AssetApprovals' unconditional updateApprovalStatus — this table's
   * claim must be at-most-once by construction, not by caller discipline.
   *
   * Deliberately does NOT pre-read the item and branch on its status/expiry
   * before writing — a read-then-write here would be a real TOCTOU race
   * (the item could change between the read and the write), strictly worse
   * than just trusting the atomic condition. On failure, a cheap follow-up
   * read exists only to produce a more specific error reason, never to gate
   * the write itself.
   */
  async claimDecision(
    decisionId: string,
    verdict: ApprovalDecisionVerdict,
    answeredBy: string,
    freeText?: string,
  ): Promise<{ claimed: true; decision: ApprovalDecision } | { claimed: false; reason: 'not_found' | 'already_resolved' | 'expired' }> {
    const now = new Date().toISOString();
    const newStatus: ApprovalDecisionStatus =
      verdict === 'approve' ? 'approved' : verdict === 'reject' ? 'rejected' : 'edited';

    try {
      const result = await dynamodb
        .update({
          TableName: APPROVAL_DECISIONS_TABLE,
          Key: { decisionId },
          UpdateExpression:
            'SET #status = :newStatus, answeredAt = :now, answeredBy = :answeredBy, verdict = :verdict, updatedAt = :now' +
            (freeText !== undefined ? ', freeText = :freeText' : ''),
          ConditionExpression:
            '(#status = :pendingTeam OR #status = :pendingCustomer) AND expiresAt > :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':newStatus': newStatus,
            ':now': now,
            ':answeredBy': answeredBy,
            ':verdict': verdict,
            ':pendingTeam': 'pending_team_review',
            ':pendingCustomer': 'pending_customer_response',
            ...(freeText !== undefined ? { ':freeText': freeText } : {}),
          },
          ReturnValues: 'ALL_NEW',
        })
        .promise();
      return { claimed: true, decision: result.Attributes as ApprovalDecision };
    } catch (error: any) {
      if (error?.code === 'ConditionalCheckFailedException') {
        // The write already told us definitively that the claim failed — this
        // read is purely for a better error message, never re-checked or
        // raced against a second write.
        const existing = await this.getDecision(decisionId);
        if (!existing) return { claimed: false, reason: 'not_found' };
        if (existing.expiresAt <= now) return { claimed: false, reason: 'expired' };
        return { claimed: false, reason: 'already_resolved' };
      }
      throw error;
    }
  }

  /** Records the outcome of actually executing an approved decision (Phase D) —
   *  unconditional, since by this point claimDecision has already made this
   *  at-most-once; this just records what happened. */
  async recordExecutionResult(decisionId: string, status: ApprovalDecisionStatus, result: ApprovalDecisionExecutionResult): Promise<void> {
    await dynamodb
      .update({
        TableName: APPROVAL_DECISIONS_TABLE,
        Key: { decisionId },
        UpdateExpression: 'SET #status = :status, executionResult = :result, updatedAt = :now',
        ConditionExpression: 'attribute_exists(decisionId)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status, ':result': result, ':now': new Date().toISOString() },
      })
      .promise();
  }

  async getDecision(decisionId: string): Promise<ApprovalDecision | null> {
    const result = await dynamodb
      .get({ TableName: APPROVAL_DECISIONS_TABLE, Key: { decisionId } })
      .promise();
    return (result.Item as ApprovalDecision | undefined) ?? null;
  }

  async listPendingForApprover(approver: ApprovalDecisionApprover, limit = 50): Promise<ApprovalDecision[]> {
    const result = await dynamodb
      .query({
        TableName: APPROVAL_DECISIONS_TABLE,
        IndexName: 'ApproverIndex',
        KeyConditionExpression: 'approver = :approver',
        FilterExpression: '#status = :pending',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':approver': approver, ':pending': 'pending_team_review' },
        ScanIndexForward: true,
        Limit: limit,
      })
      .promise();
    return (result.Items as ApprovalDecision[] | undefined) ?? [];
  }

  async listPendingForCustomer(customerId: string, limit = 50): Promise<ApprovalDecision[]> {
    const result = await dynamodb
      .query({
        TableName: APPROVAL_DECISIONS_TABLE,
        IndexName: 'CustomerIndex',
        KeyConditionExpression: 'customerId = :customerId',
        FilterExpression: '#status = :pending',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':customerId': customerId, ':pending': 'pending_customer_response' },
        ScanIndexForward: true,
        Limit: limit,
      })
      .promise();
    return (result.Items as ApprovalDecision[] | undefined) ?? [];
  }
}

export const approvalInboxService = new ApprovalInboxService();
