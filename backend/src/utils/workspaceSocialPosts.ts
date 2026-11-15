// ENG-2968: org-wide social posts list. Same-org members see each other's
// posts (stamped with createdBy); users without an org see only their own.
// Reuses the ENG-2874 member resolution, which re-checks every member against
// the caller's orgId so cross-org posts can never be merged in.
import {
  WorkspaceCaller,
  WorkspaceMember,
  WorkspaceMemberDeps,
  resolveWorkspaceMembers,
  creatorFor,
  mapWithConcurrency,
  MEMBER_FETCH_CONCURRENCY,
} from './workspaceAssets';

export interface PostsResultLike {
  success: boolean;
  posts: any[];
  accounts: any[];
}

/**
 * Merge per-member posts results. The caller's result comes first and wins on
 * collisions (same post id or account id, e.g. a company page connected by two
 * teammates). Teammate posts are read-only for the caller (`canModify: false`).
 */
export function mergeWorkspaceSocialPosts(
  perMember: Array<{ member: WorkspaceMember; result: PostsResultLike }>,
  callerUserId: string,
): PostsResultLike {
  const posts: any[] = [];
  const accounts: any[] = [];
  const seenPosts = new Set<string>();
  const seenAccounts = new Set<string>();
  let success = true;
  for (const { member, result } of perMember) {
    const isOwn = member.userId === callerUserId;
    if (isOwn && result && result.success === false) success = false;
    const createdBy = creatorFor(member);
    for (const p of result?.posts || []) {
      if (!p || typeof p !== 'object') continue;
      const key = `${p.accountId}::${p.id}`;
      if (seenPosts.has(key)) continue;
      seenPosts.add(key);
      posts.push({ ...p, createdBy, canModify: isOwn });
    }
    for (const a of result?.accounts || []) {
      if (!a || typeof a !== 'object' || seenAccounts.has(a.accountId)) continue;
      seenAccounts.add(a.accountId);
      accounts.push({ ...a, createdBy, canModify: isOwn });
    }
  }
  posts.sort((x, y) => String(y.createdAt || '').localeCompare(String(x.createdAt || '')));
  return { success, posts, accounts };
}

/**
 * Fetch the caller's posts (errors propagate, preserving existing behaviour)
 * plus every same-org teammate's posts (errors swallowed per member).
 */
export async function getWorkspaceSocialPosts(
  caller: WorkspaceCaller,
  deps: WorkspaceMemberDeps & {
    fetchOwn: () => Promise<PostsResultLike>;
    fetchForMember: (userId: string) => Promise<PostsResultLike>;
  },
): Promise<PostsResultLike> {
  const members = await resolveWorkspaceMembers(caller, deps);
  const perMember = await mapWithConcurrency(members, MEMBER_FETCH_CONCURRENCY, async (member) => {
    if (member.userId === caller.userId) {
      return { member, result: await deps.fetchOwn() };
    }
    try {
      return { member, result: await deps.fetchForMember(member.userId) };
    } catch (err) {
      console.error(`[ENG-2968] social posts fetch failed for member ${member.userId}:`, err);
      return { member, result: { success: true, posts: [], accounts: [] } };
    }
  });
  return mergeWorkspaceSocialPosts(perMember, caller.userId);
}

/**
 * ENG-2968 AC2: find the same-org member who owns `accountId`. Returns the
 * caller first when they own it; null when no same-org member does (route
 * keeps 403/404). Cross-org owners are never returned.
 */
export async function findWorkspaceAccountOwner(
  caller: WorkspaceCaller,
  accountId: string,
  deps: WorkspaceMemberDeps & {
    getConnectedAccounts: (userId: string) => Promise<Array<{ account_id?: string }>>;
  },
): Promise<WorkspaceMember | null> {
  const members = await resolveWorkspaceMembers(caller, deps);
  for (const m of members) {
    let accts: Array<{ account_id?: string }> = [];
    try {
      accts = (await deps.getConnectedAccounts(m.userId)) || [];
    } catch (err) {
      if (m.userId === caller.userId) throw err;
      continue;
    }
    if (accts.some((a) => a && a.account_id === accountId)) return m;
  }
  return null;
}
