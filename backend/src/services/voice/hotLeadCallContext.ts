import { crmDb, orgDb, userDb } from '../db';
import { suppressLeadSideEffects } from '../../utils/sessionList';
import { hotLeadCallConfigOf, HotLeadCallConfig } from '../hotLeadCallConfig';

export interface HotLeadCallContext {
  orgId: string;
  ownerUserId: string;
  /** The org's billing owner, whose plan decides whether calls are allowed. */
  orgOwnerUserId: string;
  config: HotLeadCallConfig;
}

/**
 * Routing for the hot-lead call comes from persisted list ownership, never from lead fields or
 * request input (same rule as the Slack lead alerts). Returns null for anything that must not
 * ring: unknown list, session list, owner/org mismatch, or a missing/invalid/disabled config.
 * It lives beside the voice code instead of generalising the Slack routing, so the Slack path
 * stays untouched.
 */
export async function resolveHotLeadCallContext(listId: string): Promise<HotLeadCallContext | null> {
  const list = await crmDb.getLeadListById(listId, { consistentRead: true });
  if (!list || list.listId !== listId || typeof list.userId !== 'string' || !list.userId) return null;
  if (suppressLeadSideEffects(list)) return null;
  const owner = await userDb.getUserById(list.userId);
  if (!owner || owner.userId !== list.userId || !owner.orgId) return null;
  const org = await orgDb.getOrgById(owner.orgId);
  if (!org || org.orgId !== owner.orgId) return null;
  const config = hotLeadCallConfigOf(org.hotLeadCall);
  if (!config?.enabled) return null;
  return { orgId: org.orgId, ownerUserId: owner.userId, orgOwnerUserId: org.ownerUserId, config };
}
