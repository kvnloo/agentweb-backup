// ENG-2874: workspace-wide creative library. Members of one org see each
// other's images/videos/HTML reports; a user without an org sees only their
// own. Pure helpers with injected deps so the cross-org guarantees are unit
// testable without DynamoDB.

export interface WorkspaceCaller {
  userId: string;
  orgId?: string;
}

export interface WorkspaceMember {
  userId: string;
  orgId?: string;
  name?: string;
  displayName?: string;
  email?: string;
}

export interface WorkspaceMemberDeps {
  getOrgMembers: (orgId: string) => Promise<WorkspaceMember[]>;
}

export interface CreatorAttribution {
  userId: string;
  name: string | null;
}

// Upper bound on members aggregated per request; each member costs a full
// asset fetch. The caller is always included.
export const MAX_WORKSPACE_MEMBERS = 50;

/**
 * Resolve whose assets the caller may see. Never returns a user from another
 * org: every member is re-checked against the caller's orgId, so a stale or
 * misindexed member row cannot widen visibility. Any failure falls back to
 * the caller's own assets.
 */
export async function resolveWorkspaceMembers(
  caller: WorkspaceCaller,
  deps: WorkspaceMemberDeps,
): Promise<WorkspaceMember[]> {
  const self: WorkspaceMember = { userId: caller.userId, orgId: caller.orgId };
  if (!caller.orgId) return [self];
  let members: WorkspaceMember[];
  try {
    members = await deps.getOrgMembers(caller.orgId);
  } catch (err) {
    console.error('[ENG-2874] getOrgMembers failed; falling back to own assets:', err);
    return [self];
  }
  const sameOrg = (members || []).filter(
    (m) => m && typeof m.userId === 'string' && m.orgId === caller.orgId,
  );
  // A caller not listed in its own org is treated as org-less.
  const callerRow = sameOrg.find((m) => m.userId === caller.userId);
  if (!callerRow) return [self];
  const others = sameOrg.filter((m) => m.userId !== caller.userId);
  const seen = new Set<string>([caller.userId]);
  const out: WorkspaceMember[] = [callerRow];
  for (const m of others) {
    if (out.length >= MAX_WORKSPACE_MEMBERS) break;
    if (seen.has(m.userId)) continue;
    seen.add(m.userId);
    out.push(m);
  }
  return out;
}

export function creatorFor(member: WorkspaceMember): CreatorAttribution {
  const name = (member.displayName && member.displayName.trim()) || (member.name && member.name.trim()) || (member.email && member.email.trim()) || null;
  return { userId: member.userId, name };
}

/**
 * Merge per-member asset records (Record<taskId|sessionId, entry>) into one,
 * stamping `createdBy` on each entry and each of its files. On a key
 * collision the earlier member (the caller comes first) wins.
 *
 * Favorite/archive/report-type state is stored on the owner's record and the
 * mutation routes are owner-only. So a teammate's entry is surfaced with
 * `canModify: false` and `is_favorited: false` on every file: the caller's
 * Favorites view only ever reflects the caller's own favorites, and a
 * teammate toggling their favorite cannot change the caller's list.
 */
export function mergeWorkspaceAssets(
  perMember: Array<{ member: WorkspaceMember; result: Record<string, any> }>,
  callerUserId?: string,
): Record<string, any> {
  const merged: Record<string, any> = {};
  const ownerId = callerUserId ?? perMember[0]?.member.userId;
  for (const { member, result } of perMember) {
    const createdBy = creatorFor(member);
    const isOwn = member.userId === ownerId;
    const stampFile = (f: any) =>
      f && typeof f === 'object'
        ? isOwn
          ? { ...f, createdBy, canModify: true }
          : { ...f, createdBy, canModify: false, is_favorited: false }
        : f;
    for (const [key, entry] of Object.entries(result || {})) {
      if (key in merged || !entry || typeof entry !== 'object') continue;
      const stamped: any = { ...entry, createdBy, canModify: isOwn };
      if (Array.isArray(entry.executions)) {
        stamped.executions = entry.executions.map((ex: any) => ({
          ...ex,
          result_files: Array.isArray(ex?.result_files)
            ? ex.result_files.map(stampFile)
            : ex?.result_files,
        }));
      }
      merged[key] = stamped;
    }
  }
  return merged;
}

/** Max teammate asset fetches in flight per request (bounds DynamoDB burst). */
export const MEMBER_FETCH_CONCURRENCY = 5;

/** Order-preserving map with at most `limit` promises in flight. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Fetch and merge assets for every workspace member of the caller. */
export async function getWorkspaceAssets(
  caller: WorkspaceCaller,
  deps: WorkspaceMemberDeps & {
    fetchForUser: (userId: string) => Promise<Record<string, any>>;
  },
): Promise<Record<string, any>> {
  const members = await resolveWorkspaceMembers(caller, deps);
  const perMember = await mapWithConcurrency(
    members,
    MEMBER_FETCH_CONCURRENCY,
    async (member) => {
      if (member.userId === caller.userId) {
        // The caller's own fetch must not be swallowed: preserve existing error behaviour.
        return { member, result: await deps.fetchForUser(member.userId) };
      }
      try {
        return { member, result: await deps.fetchForUser(member.userId) };
      } catch (err) {
        console.error(`[ENG-2874] asset fetch failed for member ${member.userId}:`, err);
        return { member, result: {} };
      }
    },
  );
  return mergeWorkspaceAssets(perMember, caller.userId);
}

/** Merge approval status maps across members (caller first wins). */
export async function getWorkspaceApprovalStatusByUrl(
  members: WorkspaceMember[],
  getApprovalsByUserId: (userId: string) => Promise<Array<{ assetUrl: string; status?: string }>>,
): Promise<Record<string, string | undefined>> {
  const lists = await Promise.all(
    members.map((m) =>
      getApprovalsByUserId(m.userId).catch((err) => {
        console.error(`[ENG-2874] approval lookup failed for member ${m.userId}:`, err);
        return [];
      }),
    ),
  );
  const out: Record<string, string | undefined> = {};
  for (const list of lists) {
    for (const a of list || []) {
      if (a && a.assetUrl && !(a.assetUrl in out)) out[a.assetUrl] = a.status;
    }
  }
  return out;
}
