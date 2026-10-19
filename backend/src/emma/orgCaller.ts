import { orgDb, userDb } from '../services/db';
import { can } from '../services/orgAuthz';

export type ToolContext = { userId?: unknown; agentUserId?: unknown; isUnattendedRun?: unknown } | undefined;

/**
 * Resolve the caller's own org from their persisted user record (never from tool arguments).
 * Writes additionally require org:configure; `settingsNoun` only words the refusal message.
 */
export async function callerOrg(context: ToolContext, settingsNoun: string, write = false) {
  const userId = context?.userId || context?.agentUserId;
  if (typeof userId !== 'string' || !userId.trim()) throw new Error('Authentication required');
  const user = await userDb.getUserById(userId);
  if (user?.userId !== userId || typeof user.orgId !== 'string' || !user.orgId.trim()) {
    throw new Error('Organization membership required');
  }
  const org = await orgDb.getOrgById(user.orgId);
  if (!org || org.orgId !== user.orgId) throw new Error('Organization not found');
  if (write && !can({ userId, orgId: user.orgId, orgRole: typeof user.orgRole === 'string' ? user.orgRole : undefined }, org, 'org:configure')) {
    throw new Error(`Only org owners and admins can update ${settingsNoun}`);
  }
  return org;
}
