import { orgDb, userDb } from '../services/db';
import { can } from '../services/orgAuthz';

export type ToolContext = {
  userId?: unknown;
  agentUserId?: unknown;
  isUnattendedRun?: unknown;
  sessionId?: unknown;
  /** Support or an admin acting as the customer. */
  isDelegatedAccess?: unknown;
  isDelegatedAdmin?: unknown;
} | undefined;

/**
 * The caller has no org, confirmed by a consistent read. A typed refusal (same message as before), so telemetry can tell it from a
 * handler bug by its class name instead of by matching text.
 */
export class OrgMembershipRequiredError extends Error {
  constructor() {
    super('Organization membership required');
    this.name = 'OrgMembershipRequired';
  }
}

function hasOrg<T extends { userId?: unknown; orgId?: unknown }>(user: T | null | undefined, userId: string): user is T & { userId: string; orgId: string } {
  return user?.userId === userId && typeof user.orgId === 'string' && user.orgId.trim() !== '';
}

/**
 * Resolve the caller's own org from their persisted user record (never from tool arguments), together with who
 * is asking. Writes additionally require org:configure; `settingsNoun` only words the refusal message, and
 * writes read the org consistently so the revision they act on is current.
 */
export async function callerIdentity(context: ToolContext, settingsNoun: string, write = false) {
  const userId = context?.userId || context?.agentUserId;
  if (typeof userId !== 'string' || !userId.trim()) throw new Error('Authentication required');
  let user = await userDb.getUserById(userId);
  if (!hasOrg(user, userId)) {
    // `getUserById` reads the UserIdIndex GSI, which is eventually consistent: a user who has just joined an org can still show
    // no orgId there. Only after a consistent re-read (primary key, resolved through the email) is "no org" believed. A failed
    // re-read is rethrown as itself, never reported as "no org".
    user = await userDb.getUserByIdConsistent(userId);
    if (!hasOrg(user, userId)) throw new OrgMembershipRequiredError();
  }
  const orgRole = typeof user.orgRole === 'string' ? user.orgRole : undefined;
  const org = write ? await orgDb.getOrgById(user.orgId, undefined, true) : await orgDb.getOrgById(user.orgId);
  if (!org || org.orgId !== user.orgId) throw new Error('Organization not found');
  if (write && !can({ userId, orgId: user.orgId, orgRole }, org, 'org:configure')) {
    throw new Error(`Only org owners and admins can update ${settingsNoun}`);
  }
  // Only an explicit unattended turn counts (`=== true`), mirroring the other unattended gates.
  return { org, caller: { userId, orgRole, unattended: context?.isUnattendedRun === true } };
}

export async function callerOrg(context: ToolContext, settingsNoun: string, write = false) {
  return (await callerIdentity(context, settingsNoun, write)).org;
}
