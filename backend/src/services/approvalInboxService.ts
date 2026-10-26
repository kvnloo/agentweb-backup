import AWS from 'aws-sdk';
import { randomUUID } from 'crypto';
import type { AskUserQuestionOption } from './agentMode/core/askUserQuestion';
import type { PlatformType } from './connectedAccountsDb';

// Same per-file DynamoDB client convention as approvalDb.ts/chatbotService.ts —
// each service owns its own DocumentClient instance rather than sharing one.
const dynamodbConfig = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
};
const dynamodb = new AWS.DynamoDB.DocumentClient(dynamodbConfig);

import { TABLE_PREFIX } from '../config/constants';
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
  /** ENG-2159: required, regardless of audience. A short human label naming
   *  the account/customer this decision is actually about (e.g. "TriCityAI ·
   *  Meta Ad Account 2041725529929988") — deliberately separate from
   *  customerId/customerName above, which stay customer-audience-only by
   *  design (ticket point 6). Without this, a team-audience decision has no
   *  structured way to say what it's about at all; whatever account info
   *  showed up before was purely incidental to how the model phrased
   *  businessImpact. Rendered as its own prominent line, never folded into
   *  free text a reviewer might not read closely. */
  subjectLabel: string;
  /** ENG-2159 follow-up: optional, purely informational — the account
   *  owner's email, if known, shown alongside subjectLabel. Deliberately a
   *  DIFFERENT field from customerEmail above: customerEmail is tied to
   *  customerId (routing — who this decision is FOR, customer-audience
   *  only), this is display-only context about whose account a TEAM
   *  decision concerns. Carries no routing/execution semantics, so it's
   *  allowed on any audience, unlike customerId (ticket point 6's hard
   *  invariant stays about customerId specifically, not about showing
   *  contact info). */
  subjectContactEmail?: string;
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
  /** ENG-1853: required. Groups N independent decisions that must be reviewed
   *  and executed together as one campaign/account packet (e.g. Haven's 5
   *  calls, Every's 7) — the "one decision surface per campaign/account" the
   *  ticket asks for. Every decision has exactly one manifestId, even a
   *  single-item one (a packet of one is still a packet) — no optional/null
   *  case, so callers never have to branch on "is this grouped or not." */
  manifestId: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  answeredAt?: string;
  answeredBy?: string;
  verdict?: ApprovalDecisionVerdict;
  freeText?: string;
  slack?: { channelId: string; messageTs: string };
  executionResult?: ApprovalDecisionExecutionResult;
  /** ENG-1853 review fix: set by claimDispatch, at most once — the
   *  meta_write manifest executor's own at-most-once dispatch gate.
   *  advanceIndependentWorkflow provides no mutual exclusion between two
   *  concurrent drivers of the same workflow run picking the same
   *  un-checkpointed step (unlike the live-deck path, which is protected by
   *  claimMetaWriteManifestGrant), so without this, two concurrent
   *  approve-all requests (a client retry, two tabs, two EB instances) could
   *  both call dispatchAuthorizedMetaWrite for the same real Meta write
   *  before either checkpoint lands. */
  dispatchClaimedAt?: string;
  /** ENG-1853 second-review fix: set by claimManifestFinalization, at most
   *  once per manifest (stamped on one deterministic anchor decision) — the
   *  gate that stops two concurrent approve-all callers from both recording
   *  execution results and both resuming the origin session once a
   *  manifest's real dispatch work is done. See claimManifestFinalization's
   *  own header for the exact race this closes. */
  manifestFinalizedAt?: string;
}

export interface CreateApprovalDecisionRequest {
  gateType: ApprovalDecisionGateType;
  approver?: ApprovalDecisionApprover;
  customerId?: string;
  customerEmail?: string;
  customerName?: string;
  subjectLabel: string;
  subjectContactEmail?: string;
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
  /** Required — see ApprovalDecision.manifestId. */
  manifestId: string;
  /** ISO timestamp. Required — every decision must have a real expiry (ticket
   *  point 1: "...expiry, evidence packet, exact options..."). */
  expiresAt: string;
}

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

// Review fix: emma/tools.ts's JSON schema declares an enum for
// credentialPlatform, but that's only advisory at the LLM tool-calling
// layer (validateAndRepairToolArgs only checks `type`, never `enum`) — not
// a real guarantee. These are the only platforms whose reconnect routes
// actually call autoResolveCredentialDecisionOnReconnect; any other value
// can structurally never auto-resolve. Enforced here for real.
// Typed against PlatformType (review fix) — a typo or a future rename of one
// of these platform values in connectedAccountsDb.ts now fails tsc instead
// of silently drifting, only ever surfacing at runtime for whatever exact
// value happened to be exercised.
const VALID_CREDENTIAL_PLATFORMS: PlatformType[] = ['meta', 'instagram', 'linkedin', 'linkedin_ads'];

// Worst-case page bound for listPendingForApprover/listPendingForCustomer's
// pagination (review fix) — keeps an approver/customer with an enormous,
// mostly-resolved history from turning a routine lookup into an unbounded
// scan when few or no items are actually pending.
const MAX_PENDING_LOOKUP_PAGES = 20;

// Shared between validateCreateRequest (reject at creation time) and
// findPendingCredentialDecisions (match at reconnect time) — a single source
// of truth for what "the same account id" means, so the two can never drift
// (review fix). Strips a leading "act_" — Meta's own API surfaces account
// ids both with and without it (established precedent: metaService.ts's own
// norm() helper, and 3 tool schemas explicitly warning "no act_ prefix").
function normalizeCredentialAccountId(v: string): string {
  return v.trim().toLowerCase().replace(/^act_/, '');
}

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
  if (typeof request.subjectLabel !== 'string' || request.subjectLabel.trim() === '') {
    throw new ApprovalInboxError('subjectLabel must be a non-empty string naming the account/customer this decision is about');
  }
  if (typeof request.businessImpact !== 'string' || request.businessImpact.trim() === '') {
    throw new ApprovalInboxError('businessImpact must be a non-empty string');
  }
  if (typeof request.expiresAt !== 'string' || request.expiresAt.trim() === '') {
    throw new ApprovalInboxError('expiresAt must be a non-empty ISO timestamp');
  }
  if (typeof request.manifestId !== 'string' || request.manifestId.trim() === '') {
    throw new ApprovalInboxError('manifestId must be a non-empty string — every decision belongs to a packet, even a packet of one');
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
    if (!(VALID_CREDENTIAL_PLATFORMS as string[]).includes(request.credentialPlatform.trim().toLowerCase())) {
      throw new ApprovalInboxError(
        `gateType 'customer_credential' requires credentialPlatform to be one of: ${VALID_CREDENTIAL_PLATFORMS.join(', ')} — got "${request.credentialPlatform}", which no reconnect route can ever auto-resolve`,
      );
    }
    if (!request.credentialAccountId || request.credentialAccountId.trim() === '') {
      throw new ApprovalInboxError(`gateType 'customer_credential' requires credentialAccountId — lets a real reconnect auto-resolve this decision`);
    }
    // Review fix: a raw value like "act_" is non-empty but normalizes to ''
    // (normalizeCredentialAccountId strips the act_ prefix) — reject it here
    // rather than letting it silently create a decision that can never
    // correctly match, and that risks matching a different one of this same
    // customer's own decisions that also happens to normalize to ''.
    if (normalizeCredentialAccountId(request.credentialAccountId) === '') {
      throw new ApprovalInboxError(`gateType 'customer_credential' requires a credentialAccountId with real content after normalization (not just an "act_" prefix)`);
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
      subjectLabel: request.subjectLabel,
      subjectContactEmail: request.subjectContactEmail,
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
      manifestId: request.manifestId,
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
   *
   * skipExpiryCheck (review fix): a real, observed system event — a
   * customer's OAuth reconnect genuinely just succeeded, called from
   * autoResolveCredentialDecisionOnReconnect — is not a "stale UI click"
   * the expiry guard exists to reject; it's unambiguous ground truth that
   * arrived a little late. Without this, a reconnect landing in the ~1hr
   * window between expiresAt and the next sweep tick silently lost the
   * claim, and the sweep later sent the customer a false "your window
   * closed" email despite them having already fixed it. Scoped narrowly:
   * only the auto-reconnect path sets this; the Slack human-click path
   * (resolveApprovalDecision) never does, since a stale button really
   * should be rejected there. Still atomic, still requires a real pending
   * status — only the expiresAt clause is dropped, shrinking the race to a
   * genuine millisecond-scale DynamoDB race against the sweep's own
   * expireDecision call, not an hour-wide window.
   */
  async claimDecision(
    decisionId: string,
    verdict: ApprovalDecisionVerdict,
    answeredBy: string,
    freeText?: string,
    options?: { skipExpiryCheck?: boolean },
  ): Promise<{ claimed: true; decision: ApprovalDecision } | { claimed: false; reason: 'not_found' | 'already_resolved' | 'expired' }> {
    const now = new Date().toISOString();
    const newStatus: ApprovalDecisionStatus =
      verdict === 'approve' ? 'approved' : verdict === 'reject' ? 'rejected' : 'edited';
    const skipExpiryCheck = options?.skipExpiryCheck === true;

    try {
      const result = await dynamodb
        .update({
          TableName: APPROVAL_DECISIONS_TABLE,
          Key: { decisionId },
          UpdateExpression:
            'SET #status = :newStatus, answeredAt = :now, answeredBy = :answeredBy, verdict = :verdict, updatedAt = :now' +
            (freeText !== undefined ? ', freeText = :freeText' : ''),
          ConditionExpression:
            skipExpiryCheck
              ? '(#status = :pendingTeam OR #status = :pendingCustomer)'
              : '(#status = :pendingTeam OR #status = :pendingCustomer) AND expiresAt > :now',
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
        if (!skipExpiryCheck && existing.expiresAt <= now) return { claimed: false, reason: 'expired' };
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

  /**
   * ENG-1853: a meta_write decision that's been individually claimed but is
   * waiting on the REST of its manifest before the whole packet dispatches
   * together — status only, deliberately does NOT touch executionResult
   * (that field is reserved for the real, final dispatch outcome once the
   * manifest-level orchestrator actually runs; writing a placeholder result
   * here would misrepresent "nothing has executed yet" as if something had).
   * Unconditional for the same reason recordExecutionResult below is —
   * claimDecision already made the claim itself at-most-once.
   */
  async markDispatching(decisionId: string): Promise<void> {
    await dynamodb
      .update({
        TableName: APPROVAL_DECISIONS_TABLE,
        Key: { decisionId },
        UpdateExpression: 'SET #status = :status, updatedAt = :now',
        ConditionExpression: 'attribute_exists(decisionId)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': 'dispatching', ':now': new Date().toISOString() },
      })
      .promise();
  }

  /**
   * ENG-1853 review fix: at-most-once dispatch gate for the meta_write
   * manifest executor (agentModeService.ts's
   * buildApprovalInboxMetaWriteWorkflowSteps). A single atomic conditional
   * update, guarded entirely by its own ConditionExpression — same shape as
   * claimDecision above — so two concurrent drivers of the same manifest
   * workflow run racing to execute() the same step can never both proceed to
   * dispatchAuthorizedMetaWrite: exactly one wins this update, the other's
   * ConditionalCheckFailedException tells its caller to back off instead of
   * dispatching a real Meta write a second time.
   */
  async claimDispatch(decisionId: string): Promise<boolean> {
    try {
      await dynamodb
        .update({
          TableName: APPROVAL_DECISIONS_TABLE,
          Key: { decisionId },
          UpdateExpression: 'SET dispatchClaimedAt = :now, updatedAt = :now',
          ConditionExpression: 'attribute_not_exists(dispatchClaimedAt)',
          ExpressionAttributeValues: { ':now': new Date().toISOString() },
        })
        .promise();
      return true;
    } catch (error: any) {
      if (error?.code === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }

  /**
   * ENG-1853 second-review fix: at-most-once FINALIZATION gate for a
   * meta_write manifest's post-dispatch side effects (recording every
   * decision's execution result + actively resuming the origin session) —
   * a sibling of claimDispatch above, but scoped to the whole manifest
   * rather than one write.
   *
   * Real gap found by an independent review: claimDispatch alone prevents
   * two concurrent `approve-all` requests for the same manifest from both
   * dispatching the same real Meta write, but it does NOT stop both
   * requests from each independently reaching 'completed' once the one
   * real dispatch is checkpointed (a second driver's own poll loop simply
   * observes the already-verified checkpoint and returns 'completed' too —
   * traced through advanceIndependentWorkflow directly, not assumed). Both
   * would then call recordExecutionResult a second, redundant time AND both
   * call resumeOriginSession — the in-memory tryClaimSessionGeneration lock
   * only serializes the actual generateSessionResponse call within a
   * single process, so a second/duplicate passive note (or, on a
   * multi-instance deployment, a second REAL active resume) could still
   * happen. This claim, anchored on one deterministic decision in the
   * manifest (the caller passes whichever one it likes, as long as every
   * caller for the same manifestId passes the SAME anchor), ensures only
   * one caller ever proceeds past dispatch to record results and resume —
   * every other concurrent caller sees `false` and returns the outcome
   * without repeating those side effects.
   */
  async claimManifestFinalization(anchorDecisionId: string): Promise<boolean> {
    try {
      await dynamodb
        .update({
          TableName: APPROVAL_DECISIONS_TABLE,
          Key: { decisionId: anchorDecisionId },
          UpdateExpression: 'SET manifestFinalizedAt = :now, updatedAt = :now',
          ConditionExpression: 'attribute_not_exists(manifestFinalizedAt)',
          ExpressionAttributeValues: { ':now': new Date().toISOString() },
        })
        .promise();
      return true;
    } catch (error: any) {
      if (error?.code === 'ConditionalCheckFailedException') return false;
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
    pendingStatus: ApprovalDecisionStatus | ApprovalDecisionStatus[],
    limit: number,
    // Applied server-side BEFORE the page limit counts a match, so rows the caller would only drop
    // afterwards (e.g. other gate types) can't fill the page and hide the rows it wants.
    extra?: { expression: string; names: Record<string, string>; values: Record<string, unknown> },
  ): Promise<ApprovalDecision[]> {
    const statuses = Array.isArray(pendingStatus) ? pendingStatus : [pendingStatus];
    const statusValues = Object.fromEntries(statuses.map((st, i) => [`:s${i}`, st]));
    const matches: ApprovalDecision[] = [];
    let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    let pages = 0;
    do {
      const result = await dynamodb
        .query({
          TableName: APPROVAL_DECISIONS_TABLE,
          IndexName: indexName,
          KeyConditionExpression: `${keyName} = :keyValue`,
          FilterExpression: `#status IN (${Object.keys(statusValues).join(', ')})${extra ? ` AND ${extra.expression}` : ''}`,
          ExpressionAttributeNames: { '#status': 'status', ...(extra?.names ?? {}) },
          ExpressionAttributeValues: { ':keyValue': keyValue, ...statusValues, ...(extra?.values ?? {}) },
          ScanIndexForward: true,
          Limit: limit,
          ExclusiveStartKey: lastEvaluatedKey,
        })
        .promise();
      matches.push(...((result.Items as ApprovalDecision[] | undefined) ?? []));
      lastEvaluatedKey = result.LastEvaluatedKey;
      pages++;
    } while (lastEvaluatedKey && matches.length < limit && pages < MAX_PENDING_LOOKUP_PAGES);
    // Review fix: listDuePending already warns on its own truncation cap —
    // this sibling cap was silent. A real (if rare) cause of "a genuinely
    // pending item was invisible" deserves the same visibility.
    if (lastEvaluatedKey && pages >= MAX_PENDING_LOOKUP_PAGES) {
      console.warn(
        `[approval-inbox-service] listPendingByIndex hit the ${MAX_PENDING_LOOKUP_PAGES}-page cap for ${indexName}=${keyValue} with more history unscanned — result may be missing a genuinely pending item.`,
      );
    }
    return matches.slice(0, limit);
  }

  async listPendingForApprover(approver: ApprovalDecisionApprover, limit = 50): Promise<ApprovalDecision[]> {
    return this.listPendingByIndex('ApproverIndex', 'approver', approver, 'pending_team_review', limit);
  }

  /**
   * ENG-1853: approved meta_write items that are waiting for Approve All. They are no longer
   * 'pending_team_review', so without this a reviewer who answered every card and left could not
   * find the packet again from the queue even though nothing had been dispatched yet.
   */
  async listAwaitingDispatchForApprover(approver: ApprovalDecisionApprover, limit = 50): Promise<ApprovalDecision[]> {
    return this.listPendingByIndex('ApproverIndex', 'approver', approver, ['approved', 'dispatching'], limit, {
      expression: '#gateType = :metaWrite AND #verdict = :approve',
      names: { '#gateType': 'gateType', '#verdict': 'verdict' },
      values: { ':metaWrite': 'meta_write', ':approve': 'approve' },
    });
  }

  async listPendingForCustomer(customerId: string, limit = 50): Promise<ApprovalDecision[]> {
    return this.listPendingByIndex('CustomerIndex', 'customerId', customerId, 'pending_customer_response', limit);
  }

  /**
   * ENG-1853: every decision in one packet, any status — unlike
   * listPendingByIndex's siblings above, this deliberately does NOT filter to
   * a single pending status, because the caller's whole point is usually to
   * check whether EVERY item in the manifest has already resolved (e.g. "is
   * this packet fully approved yet?"), which requires seeing the resolved
   * ones too. A manifest is small by construction (Haven's 5, Every's 7 —
   * nothing like ApproverIndex/CustomerIndex's potentially-large history), so
   * this is a single unpaginated query, not the bounded multi-page shape
   * above.
   */
  async listByManifest(manifestId: string): Promise<ApprovalDecision[]> {
    const result = await dynamodb
      .query({
        TableName: APPROVAL_DECISIONS_TABLE,
        IndexName: 'ManifestIndex',
        KeyConditionExpression: 'manifestId = :manifestId',
        ExpressionAttributeValues: { ':manifestId': manifestId },
        ScanIndexForward: true,
      })
      .promise();
    return (result.Items as ApprovalDecision[] | undefined) ?? [];
  }

  /**
   * Finds every pending customer_credential decision matching a real OAuth
   * reconnect — gap-closing round. Filters listPendingForCustomer's small,
   * already-bounded result set in-code rather than a new GSI: a customer has
   * at most a handful of pending decisions at once, and this only needs to
   * run once per reconnect, not on a hot path.
   *
   * Plural on purpose (was findPendingCredentialDecision, singular via
   * .find()) — found live on prod: a customer can end up with more than one
   * pending decision for the same platform+account (e.g. a duplicate staged
   * before the first was answered). A reconnect genuinely resolves ALL of
   * them at once, not just the oldest — a real customer reconnecting once
   * shouldn't leave a second, newer decision stuck until it silently expires
   * and the sweep emails a false "your window closed" notice.
   */
  async findPendingCredentialDecisions(customerId: string, platform: string, accountId: string): Promise<ApprovalDecision[]> {
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
    // must still match (review fix). Uses the shared normalizeCredentialAccountId
    // (module-level) rather than a local copy, so this can never drift from
    // what validateCreateRequest rejects at creation time (review fix).
    const normPlatform = platform.trim().toLowerCase();
    const normTargetAccountId = normalizeCredentialAccountId(accountId);
    return pending.filter(
      (d) =>
        d.gateType === 'customer_credential' &&
        d.credentialPlatform?.trim().toLowerCase() === normPlatform &&
        (d.credentialAccountId ? normalizeCredentialAccountId(d.credentialAccountId) : undefined) === normTargetAccountId,
    );
  }
}

export const approvalInboxService = new ApprovalInboxService();
