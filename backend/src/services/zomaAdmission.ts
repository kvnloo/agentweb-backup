import AWS from 'aws-sdk';
import { accountFlag } from './journeyProductBackfill';

const db = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
const table = () => `${process.env.NODE_ENV === 'development' ? 'Dev-' : ''}AW-Waitlist`;
const counterKey = { email: '__zoma_free_capacity__' };
export const zomaAdmissionEnabled = () => process.env.ZOMA_WAITLIST_ENABLED === 'true';
export function zomaCapacity(): number {
  const cap = Number(process.env.ZOMA_FREE_USER_CAP ?? '60');
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error('Invalid ZOMA_FREE_USER_CAP');
  return cap;
}
/** Harsha, Matt and Fangfang approve Zoma waitlist entries; override with ZOMA_WAITLIST_SLACK_CHANNEL. */
const WAITLIST_SLACK_CHANNEL = 'C0CGETQP27Q';
const WAITLIST_APPROVERS = ['U08TM4QFQ1L', 'U08TWRHKCG4', 'U08TWRKGESG'];
type PostSlack = (channel: string, text: string) => Promise<unknown>;
let postSlack: PostSlack = async (channel, text) => (await import('./slackService')).postSlackMessage(channel, text);
/** Test seam for the approval ping. */
export function setZomaWaitlistSlackPoster(fn: PostSlack) { postSlack = fn; }

/** Fail-open approval ping: a Slack outage never blocks or fails a registration. */
export async function notifyZomaWaitlisted(email: string, approvedCount: number, capacity: number): Promise<boolean> {
  const channel = process.env.ZOMA_WAITLIST_SLACK_CHANNEL || WAITLIST_SLACK_CHANNEL;
  const mentions = WAITLIST_APPROVERS.map((id) => `<@${id}>`).join(' ');
  try {
    await postSlack(channel, `${mentions} Zoma waitlist: ${email} is waiting for approval (${approvedCount}/${capacity} free seats used). Approve or reject in Admin → Waitlist.`);
    return true;
  } catch (error) {
    console.error('[zoma-waitlist] approval ping failed (ignored):', error instanceof Error ? error.message : error);
    return false;
  }
}
export const waitlistedResponse = {
  code: 'waitlisted', status: 'waitlisted',
  message: 'You are on the waitlist. We will notify you when access is approved.',
};
async function entry(email: string): Promise<any> {
  return (await db.get({ TableName: table(), Key: { email }, ConsistentRead: true }).promise()).Item;
}
export async function zomaApprovedCount() {
  const row = await entry(counterKey.email);
  // Explicit bootstrap is required: never silently start at zero with existing users.
  if (!Number.isSafeInteger(row?.approvedCount) || row.approvedCount < 0) {
    throw new Error('Zoma capacity counter is not initialized');
  }
  return { approvedCount: row.approvedCount, capacity: zomaCapacity() };
}

/** A durable per-email decision and counter increment commit together. Reservations
 * survive failed account creation, so retries cannot consume a second seat. */
export async function admitZoma(emailInput: string, actor?: string): Promise<string> {
  const email = emailInput.toLowerCase();
  if (email === counterKey.email) throw new Error('Invalid admission email');
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await entry(email);
    if (current?.zomaStatus === 'approved') return 'approved';
    if (current?.zomaStatus && !actor) return current.zomaStatus;
    if (actor && current?.zomaStatus !== 'waitlisted') return current?.zomaStatus ?? 'not_found';
    const { approvedCount, capacity } = await zomaApprovedCount();
    const now = new Date().toISOString();
    if (approvedCount >= capacity) {
      if (actor) return 'capacity_exhausted';
      try {
        await db.update({ TableName: table(), Key: { email },
          UpdateExpression: 'SET zomaStatus = :pending, joinedAt = if_not_exists(joinedAt, :now)',
          ConditionExpression: 'attribute_not_exists(zomaStatus)',
          ExpressionAttributeValues: { ':pending': 'waitlisted', ':now': now },
        }).promise();
        // Only the request that created the waitlist decision pings; retries see zomaStatus and return above.
        void notifyZomaWaitlisted(email, approvedCount, capacity);
        return 'waitlisted';
      } catch (err: any) {
        if (err.code === 'ConditionalCheckFailedException') continue;
        throw err;
      }
    }
    try {
      await db.transactWrite({ TransactItems: [
        { Update: { TableName: table(), Key: counterKey,
          UpdateExpression: 'SET approvedCount = approvedCount + :one',
          ConditionExpression: 'attribute_exists(approvedCount) AND approvedCount < :cap',
          ExpressionAttributeValues: { ':one': 1, ':cap': capacity } } },
        { Update: { TableName: table(), Key: { email },
          UpdateExpression: 'SET zomaStatus = :approved, approvedAt = :now, approvedBy = :actor, joinedAt = if_not_exists(joinedAt, :now)',
          ConditionExpression: actor ? 'zomaStatus = :pending' : 'attribute_not_exists(zomaStatus)',
          ExpressionAttributeValues: { ':approved': 'approved', ':now': now, ':actor': actor ?? 'system:capacity', ...(actor ? { ':pending': 'waitlisted' } : {}) } } },
      ] }).promise();
      return 'approved';
    } catch (err: any) {
      if (err.code !== 'TransactionCanceledException') throw err;
      if (err.CancellationReasons?.some((r: any) => !['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(r.Code))) throw err;
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  throw new Error('Zoma admission contention; retry request');
}
/**
 * A waitlist-form applicant (no admission decision yet) becomes a pending Zoma decision, so an
 * admin Invite reserves a seat under the cap instead of sending an invitation the gate then refuses.
 */
export async function markZomaWaitlisted(emailInput: string): Promise<void> {
  const email = emailInput.toLowerCase();
  if (email === counterKey.email) throw new Error('Invalid admission email');
  try {
    await db.update({ TableName: table(), Key: { email },
      UpdateExpression: 'SET zomaStatus = :pending, joinedAt = if_not_exists(joinedAt, :now)',
      ConditionExpression: 'attribute_not_exists(zomaStatus)',
      ExpressionAttributeValues: { ':pending': 'waitlisted', ':now': new Date().toISOString() },
    }).promise();
  } catch (err: any) {
    if (err.code !== 'ConditionalCheckFailedException') throw err;
  }
}
export type ZomaSeatExemption = 'team' | 'org_invite' | 'legacy_invite' | 'databricks';
export interface ZomaSignupDeps {
  hasPendingOrgInvite(email: string): Promise<boolean>;
}
/**
 * Where a signup came from, when that changes the seat decision. Absent means an ordinary signup.
 * `databricks` must come from the registered OAuth client's redirect URIs (isDatabricksClient) or
 * from a server-signed Databricks signup intent, never from a client-supplied name.
 */
export interface ZomaSignupOrigin {
  databricks?: boolean;
  /** Attribution for the exemption log only, never part of the decision: the OAuth client and account at authorization. */
  clientId?: string;
  userId?: string;
}
const defaultSignupDeps: ZomaSignupDeps = {
  hasPendingOrgInvite: async (email) => !!(await (await import('./db')).orgDb.getOrgWithPendingInviteForEmail(email)),
};

/**
 * Signups that are not a new free Zoma seat: our own team domains, a Databricks-origin client
 * (ENG-2781: those arrive through the Databricks Marketplace listing, and tokens issued to such a
 * client get the read-only tool view), a teammate joining an org that invited them, and an
 * applicant a human already invited before the gate was enabled. They are admitted without
 * consuming a seat (and never waitlisted). A failed org lookup is not an exemption: the gate still
 * applies. A Databricks origin does not override an admin Reject: that is a decision about the
 * person, not about the cap, and it still stands (a waitlisted row is exempt: the cap is moot).
 */
export async function zomaSeatExemption(
  emailInput: string,
  deps: ZomaSignupDeps = defaultSignupDeps,
  origin: ZomaSignupOrigin = {},
): Promise<ZomaSeatExemption | null> {
  const email = emailInput.toLowerCase();
  if (accountFlag(email) === 'internal') return 'team';
  let rejectedRow: any;
  if (origin.databricks === true) {
    // The one extra read, only on the Databricks path. Unreadable is not an exemption: it throws.
    const decision = await entry(email);
    if (decision?.zomaStatus !== 'rejected') return 'databricks';
    rejectedRow = decision;
  }
  if (await deps.hasPendingOrgInvite(email).catch(() => false)) return 'org_invite';
  const row = rejectedRow ?? await entry(email);
  if (row && !row.zomaStatus && row.status === 'invited') return 'legacy_invite';
  return null;
}

/** Registration-time admission (password + Google): exemptions first, then the capped seat. */
export async function admitZomaSignup(email: string, deps: ZomaSignupDeps = defaultSignupDeps, origin: ZomaSignupOrigin = {}): Promise<string> {
  const exemption = await zomaSeatExemption(email, deps, origin);
  // Makes the bypass traceable without storing anything on the account and without an email address.
  // At authorization the client and account are known; at registration only the signed marker is.
  if (exemption === 'databricks') {
    if (origin.clientId) {
      console.log('[zoma-waitlist] Databricks-origin signup admitted without a free seat (authorization):', { clientId: origin.clientId, userId: origin.userId });
    } else {
      console.log('[zoma-waitlist] Databricks-origin signup admitted without a free seat (signed intent marker, no client at registration)');
    }
  }
  return exemption ? 'approved' : admitZoma(email);
}

export async function rejectZoma(emailInput: string, actor: string): Promise<string> {
  const email = emailInput.toLowerCase();
  try {
    await db.update({ TableName: table(), Key: { email },
      UpdateExpression: 'SET zomaStatus = :rejected, rejectedBy = :actor, rejectedAt = :now',
      ConditionExpression: 'zomaStatus = :pending',
      ExpressionAttributeValues: { ':pending': 'waitlisted', ':rejected': 'rejected', ':actor': actor, ':now': new Date().toISOString() },
    }).promise();
    return 'rejected';
  } catch (err: any) {
    if (err.code !== 'ConditionalCheckFailedException') throw err;
    return (await entry(email))?.zomaStatus ?? 'not_found';
  }
}

/**
 * ENG-2881: an admin Invite/Reject on the waitlist is the Zoma admission decision while the gate
 * is on. Returns null when the legacy status update may proceed, or the HTTP refusal to send.
 * Invite reserves the seat (capacity-checked, atomic) BEFORE any invitation is sent.
 */
export async function applyZomaWaitlistDecision(
  entry: { zomaStatus?: string } | undefined, email: string, status: string, actor: string | undefined,
): Promise<{ statusCode: number; body: Record<string, unknown> } | null> {
  if (!zomaAdmissionEnabled() || (status !== 'invited' && status !== 'rejected') || !entry) return null;
  const inviting = status === 'invited';
  if (!actor) return { statusCode: 403, body: { message: 'Admin identity required' } };
  // A waitlist-form row has no decision yet: record one, so Reject also blocks a later self-signup.
  if (!entry.zomaStatus) await markZomaWaitlisted(email);
  const decision = inviting ? await admitZoma(email, actor) : await rejectZoma(email, actor);
  if (decision === (inviting ? 'approved' : 'rejected')) return null;
  return {
    statusCode: 409,
    body: {
      message: decision === 'capacity_exhausted'
        ? 'All free Zoma seats are taken; this applicant stays on the waitlist.'
        : `Zoma admission is already ${decision}.`,
      zomaStatus: decision,
    },
  };
}
