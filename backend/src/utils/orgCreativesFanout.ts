// ENG-2834: Creatives (Images/Videos/Reports) org fan-out.
//
// getExecutionsWithAssets(userId, ...) returns Record<groupId, group> scoped to
// one user's task executions and agent sessions. When the caller's org has the
// `creatives` share feature on, Creatives must also show other members' assets.
// This module merges per-member results; it never reads across orgs because
// the member list always comes from the caller's own orgId.
import { isFeatureEffectivelyEnabled, MEMBER_FANOUT_CAP } from '../services/orgShareService';

export type AssetGroups = Record<string, any>;

/**
 * Max groups taken from each teammate, most recent first. Bounds the response
 * size by member count instead of by a busy teammate's whole history.
 */
export const SHARED_GROUPS_PER_MEMBER_CAP = 50;

function recentGroupEntries(groups: AssetGroups): Array<[string, any]> {
  const entries = Object.entries(groups || {});
  if (entries.length <= SHARED_GROUPS_PER_MEMBER_CAP) return entries;
  const ts = (g: any) => String(g?.latestExecutionTime || g?.updatedAt || g?.createdAt || '');
  return entries
    .sort(([, a], [, b]) => ts(b).localeCompare(ts(a)))
    .slice(0, SHARED_GROUPS_PER_MEMBER_CAP);
}

export interface CreativesFanoutDeps {
  getUser: (userId: string) => Promise<{ orgId?: string; orgRole?: string } | null | undefined>;
  getOrg: (orgId: string) => Promise<any>;
  getOrgMemberIds: (orgId: string) => Promise<string[]>;
  getAssetsForUser: (userId: string) => Promise<AssetGroups>;
}

/**
 * Merge the caller's groups with other members' groups. The caller's own
 * entries win on key collision; other members' groups are stamped with
 * `ownerUserId` so the UI can label them and keep mutations owner-scoped.
 */
export function mergeAssetGroups(
  own: AssetGroups,
  others: Array<{ ownerUserId: string; groups: AssetGroups }>,
): AssetGroups {
  const merged: AssetGroups = { ...own };
  for (const { ownerUserId, groups } of others) {
    for (const [key, group] of recentGroupEntries(groups)) {
      if (key in merged) continue;
      // Favorites are per-owner (the toggle is owner-scoped), so a teammate's
      // stars must not appear as the caller's favorites.
      const result_files = Array.isArray(group?.result_files)
        ? group.result_files.map((f: any) => ({ ...f, is_favorited: false }))
        : group?.result_files;
      merged[key] = { ...group, ...(result_files !== undefined ? { result_files } : {}), ownerUserId, sharedFromOrg: true };
    }
  }
  return merged;
}

/**
 * Caller's assets, plus org members' assets when `creatives` sharing is on.
 * Any failure resolving the org degrades to the caller-only result rather than
 * failing the whole Creatives page.
 */
export async function getOrgVisibleAssets(callerUserId: string, deps: CreativesFanoutDeps): Promise<AssetGroups> {
  const own = await deps.getAssetsForUser(callerUserId);
  let memberIds: string[] = [];
  try {
    const user = await deps.getUser(callerUserId);
    const orgId = user?.orgId;
    if (!orgId) return own;
    const org = await deps.getOrg(orgId);
    if (!org || org.orgId !== orgId) return own;
    const enabled = isFeatureEffectivelyEnabled(
      { userId: callerUserId, orgId, orgRole: user?.orgRole as any },
      org,
      'creatives',
    );
    if (!enabled) return own;
    memberIds = (await deps.getOrgMemberIds(orgId)).filter((id) => id && id !== callerUserId);
  } catch (err) {
    console.warn('[creatives-fanout] org resolution failed; caller-only result:', err);
    return own;
  }
  const targets = memberIds.slice(0, MEMBER_FANOUT_CAP);
  const others = await Promise.all(
    targets.map(async (uid) => {
      try {
        return { ownerUserId: uid, groups: await deps.getAssetsForUser(uid) };
      } catch (err) {
        console.warn(`[creatives-fanout] skipping member ${uid}:`, err);
        return { ownerUserId: uid, groups: {} };
      }
    }),
  );
  return mergeAssetGroups(own, others);
}
