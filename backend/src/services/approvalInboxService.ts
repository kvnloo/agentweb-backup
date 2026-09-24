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
  /** ENG-1644 Phase E: required iff gateType === 'customer_credential' — the
   *  exact URL the customer's notification email links to (e.g. an existing
   *  `/settings?tab=connected-accounts&platform=...` deep link). Generalizes
   *  linkedInDisconnectNotifyService.ts's hardcoded-to-LinkedIn URL: the
   *  caller supplies the exact target rather than this service knowing how
   *  to build one per platform. */
  customerActionUrl?: string;
  /** Both required iff gateType === 'customer_credential' — the platform
   *  (e.g. 'meta', 'linkedin') and connected-account id this decision is
   *  actually about. Lets a real OAuth reconnect auto-resolve the matching
   *  decision (gap-closing round) without parsing customerActionUrl, which
   *  is free-text and not a guaranteed-stable contract. */
  credentialPlatform?: string;
  credentialAccountId?: string;
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
  customerActionUrl?: string;
  credentialPlatform?: string;
  credentialAccountId?: string;
  originSessionId?: string;
  originCorrelator?: string;
  /** ISO timestamp. Required — every decision must have a real expiry (ticket
   *  point 1: "...expiry, evidence packet, exact options..."). */
  expiresAt: string;
}

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

// Worst-case page bound for listPendingForApprover/listPendingForCustomer's
// pagination (review fix) — keeps an approver/customer with an enormous,
// mostly-resolved history from turning a routine lookup into an unbounded
// scan when few or no items are actually pending.
const MAX_PENDING_LOOKUP_PAGES = 20;

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
  } else if (request.gateType === 'customer_credential') {
    if (!request.customerActionUrl || request.customerActionUrl.trim() === '') {
      throw new ApprovalInboxError(`gateType 'customer_credential' requires customerActionUrl — the link the customer's notification email points to`);
    }
    if (!request.credentialPlatform || request.credentialPlatform.trim() === '') {
      throw new ApprovalInboxError(`gateType 'customer_credential' requires credentialPlatform — lets a real reconnect auto-resolve this decision`);
    }
    if (!request.credentialAccountId || request.credentialAccountId.trim() === '') {
      throw new ApprovalInboxError(`gateType 'customer_credential' requires credentialAccountId — lets a real reconnect auto-resolve this decision`);
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
      customerActionUrl: request.customerActionUrl,
      credentialPlatform: request.credentialPlatform,
      credentialAccountId: request.credentialAccountId,
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

  /**
   * Flips a pending decision to 'expired' once its expiresAt has passed with
   * nobody having answered it — same race-free shape as claimDecision (no
   * pre-read, single atomic conditional update): only succeeds if the item
   * is still genuinely pending AND already past expiry, so a real claim that
   * lands first (or a previous sweep tick that already expired it) always
   * wins cleanly, never double-processed. Called by approvalExpirySweepCron.
   */
  async expireDecision(decisionId: string): Promise<{ expired: true; decision: ApprovalDecision } | { expired: false }> {
    const now = new Date().toISOString();
    try {
      const result = await dynamodb
        .update({
          TableName: APPROVAL_DECISIONS_TABLE,
          Key: { decisionId },
          UpdateExpression: 'SET #status = :expired, updatedAt = :now',
          ConditionExpression: '(#status = :pendingTeam OR #status = :pendingCustomer) AND expiresAt <= :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':expired': 'expired',
            ':now': now,
            ':pendingTeam': 'pending_team_review',
            ':pendingCustomer': 'pending_customer_response',
          },
          ReturnValues: 'ALL_NEW',
        })
        .promise();
      return { expired: true, decision: result.Attributes as ApprovalDecision };
    } catch (error: any) {
      if (error?.code === 'ConditionalCheckFailedException') {
        // Already resolved by a real claim, or already expired by a
        // previous sweep tick — nothing to do, not an error.
        return { expired: false };
      }
      throw error;
    }
  }

  /**
   * Due-for-expiry lookup for the sweep cron. StatusExpiryIndex's HASH key is
   * `status`, so a single query can only cover one pending status at a time —
   * the cron calls this once per pending status value, not a design flaw
   * (DynamoDB has no cross-partition-key OR in one query).
   */
  async listDuePending(status: 'pending_team_review' | 'pending_customer_response', limit = 100): Promise<ApprovalDecision[]> {
    const now = new Date().toISOString();
    const result = await dynamodb
      .query({
        TableName: APPROVAL_DECISIONS_TABLE,
        IndexName: 'StatusExpiryIndex',
        KeyConditionExpression: '#status = :status AND expiresAt <= :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status, ':now': now },
        Limit: limit,
      })
      .promise();
    return (result.Items as ApprovalDecision[] | undefined) ?? [];
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

  /**
   * Shared by listPendingForApprover/listPendingForCustomer — both are a
   * "query one GSI's partition, filter to one pending status" lookup that
   * differ only in index/key. DynamoDB applies Limit to items READ before
   * FilterExpression is evaluated, not to items returned after filtering —
   * a single page could scan straight past a genuinely pending item sorted
   * behind older, already-resolved history for the same partition key
   * (review fix). Pages with a real per-page Limit (so each round trip
   * stays bounded, unlike a plain unbounded query) via ExclusiveStartKey,
   * accumulating only real matches, until either the index is exhausted,
   * `limit` matches are found, or MAX_PENDING_LOOKUP_PAGES round trips are
   * spent — a worst-case bound against an enormous, mostly-resolved history
   * with near-zero currently pending, so this can never turn into an
   * unbounded scan (review fix — the codebase's existing generic
   * paginatedQuery helper, utils/dynamoPagination.ts, doesn't support this
   * bounded early-exit shape, so this stays a dedicated helper here rather
   * than misusing that one).
   */
  private async listPendingByIndex(
    indexName: string,
    keyName: string,
    keyValue: string,
    pendingStatus: ApprovalDecisionStatus,
    limit: number,
  ): Promise<ApprovalDecision[]> {
    const matches: ApprovalDecision[] = [];
    let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    let pages = 0;
    do {
      const result = await dynamodb
        .query({
          TableName: APPROVAL_DECISIONS_TABLE,
          IndexName: indexName,
          KeyConditionExpression: `${keyName} = :keyValue`,
          FilterExpression: '#status = :pending',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':keyValue': keyValue, ':pending': pendingStatus },
          ScanIndexForward: true,
          Limit: limit,
          ExclusiveStartKey: lastEvaluatedKey,
        })
        .promise();
      matches.push(...((result.Items as ApprovalDecision[] | undefined) ?? []));
      lastEvaluatedKey = result.LastEvaluatedKey;
      pages++;
    } while (lastEvaluatedKey && matches.length < limit && pages < MAX_PENDING_LOOKUP_PAGES);
    return matches.slice(0, limit);
  }

  async listPendingForApprover(approver: ApprovalDecisionApprover, limit = 50): Promise<ApprovalDecision[]> {
    return this.listPendingByIndex('ApproverIndex', 'approver', approver, 'pending_team_review', limit);
  }

  async listPendingForCustomer(customerId: string, limit = 50): Promise<ApprovalDecision[]> {
    return this.listPendingByIndex('CustomerIndex', 'customerId', customerId, 'pending_customer_response', limit);
  }

  /**
   * Finds the pending customer_credential decision (if any) matching a real
   * OAuth reconnect — gap-closing round. Filters listPendingForCustomer's
   * small, already-bounded result set in-code rather than a new GSI: a
   * customer has at most a handful of pending decisions at once, and this
   * only needs to run once per reconnect, not on a hot path.
   */
  async findPendingCredentialDecision(customerId: string, platform: string, accountId: string): Promise<ApprovalDecision | null> {
    const pending = await this.listPendingForCustomer(customerId);
    // Normalize both sides before comparing — credentialPlatform is
    // free-text Emma writes at stage time (e.g. "Meta" vs "meta"), and stray
    // whitespace on either side would otherwise silently miss a real match
    // (review fix). Also strip a leading "act_" from the account id — this
    // exact ambiguity already has a real, established precedent in this
    // codebase (metaService.ts's own norm() helper, and 3 other tool schemas
    // explicitly warning Emma "no act_ prefix") because Meta's own API
    // surfaces the id both with and without it; a real reconnect always
    // passes the bare form, so a credentialAccountId written WITH the prefix
    // must still match (review fix).
    const normPlatform = platform.trim().toLowerCase();
    const normAccountId = (v: string) => v.trim().toLowerCase().replace(/^act_/, '');
    const normTargetAccountId = normAccountId(accountId);
    return (
      pending.find(
        (d) =>
          d.gateType === 'customer_credential' &&
          d.credentialPlatform?.trim().toLowerCase() === normPlatform &&
          (d.credentialAccountId ? normAccountId(d.credentialAccountId) : undefined) === normTargetAccountId,
      ) ?? null
    );
  }
}

export const approvalInboxService = new ApprovalInboxService();
