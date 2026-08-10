import { userDb, orgDb } from './db';
import {
  isFeatureEffectivelyEnabled,
  canEditItem,
  type UserLike,
  type OrgLike,
} from './orgShareService';

// Shared CRM lead-list access guards (ENG-686). Used by crm.ts and its sibling
// routers (crmApollo.ts, crmEnrichSo.ts, crmSync.ts) so every CRM surface
// enforces the same org-share rules instead of each defining its own.

// Read access: honours shareSettings.crm.enabled. When disabled, only the list
// owner, the org owner, and listed crm.editors retain cross-member read access.
export async function canAccessCrmList(userId: string, list: { userId: string } | Record<string, any>): Promise<boolean> {
  if (list.userId === userId) return true;
  const [user, owner] = await Promise.all([
    userDb.getUserById(userId),
    userDb.getUserById(list.userId),
  ]);
  if (!user?.orgId || !owner?.orgId || user.orgId !== owner.orgId) return false;
  const org = await orgDb.getOrgById(user.orgId);
  return isFeatureEffectivelyEnabled(user as UserLike, org as OrgLike | null, "crm");
}

// Destructive write access: requires being the list owner, the org owner, or a
// listed crm.editor — regardless of the crm.enabled toggle. Mirrors landingPages.
export async function canDestructiveCrmList(userId: string, list: { userId: string } | Record<string, any>): Promise<boolean> {
  if (list.userId === userId) return true;
  const [user, owner] = await Promise.all([
    userDb.getUserById(userId),
    userDb.getUserById(list.userId),
  ]);
  if (!user?.orgId || !owner?.orgId || user.orgId !== owner.orgId) return false;
  const org = await orgDb.getOrgById(user.orgId);
  return canEditItem({ userId: list.userId }, user as UserLike, org as OrgLike | null, owner?.orgId, "crm");
}
