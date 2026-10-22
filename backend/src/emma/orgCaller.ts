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
 * Resolve the caller's own org from their persisted user record (never from tool arguments), together with who
 * is asking. Writes additionally require org:configure; `settingsNoun` only words the refusal message, and
 * writes read the org consistently so the revision they act on is current.
 */
export async function callerIdentity(context: ToolContext, settingsNoun: string, write = false) {
  const userId = context?.userId || context?.agentUserId;
  if (typeof userId !== 'string' || !userId.trim()) throw new Error('Authentication required');
  const user = await userDb.getUserById(userId);
  if (user?.userId !== userId || typeof user.orgId !== 'string' || !user.orgId.trim()) {
    throw new Error('Organization membership required');
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
