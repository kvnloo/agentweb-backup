import { userDb, orgDb } from './db';
import {
  isFeatureEffectivelyEnabled,
  canEditItem,
  type UserLike,
  type OrgLike,
} from './orgShareService';

// Shared CRM lead-list access guards (ENG-686). Used by crm.ts and its sibling
// routers (crmApollo.ts, crmEnrichSo.ts, crmSync.ts), plus Emma's chat-tool
// surface (agentModeService.ts, emma/tools.ts, emma/enrichmentToolRunner.ts —
// ENG-1049) so every CRM surface enforces the same org-share rules instead of
// each defining its own.

// Single source of truth for denial copy so a user gets the same explanation
// whether they hit a REST 403 or an Emma tool refusal (ENG-1049) — a bare
// "Access denied"/"Not authorized" gives no path forward and just produces
// confused bug reports.
export const CRM_EDITOR_REQUIRED_MESSAGE =
  'Only the list owner, the org owner, or a listed CRM editor can do this. Ask your org admin to add you as a CRM editor under Settings → Organization Sharing.';
export const CRM_SHARING_DISABLED_MESSAGE =
  'Your org has disabled cross-team CRM visibility for this list. Ask your org admin to enable CRM sharing or add you as an editor.';

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
