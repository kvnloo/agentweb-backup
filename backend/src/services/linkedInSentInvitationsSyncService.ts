import { linkedInOutreachService } from './linkedInOutreachService';
import {
  getAllSentInvitationsByAccount,
  profileUrlFromPublicId,
  pruneStaleSentInvitations,
  UnipileSentInvitation,
  upsertSentInvitations,
} from './unipileSentInvitationsDb';

const TAG = '[linkedInConnectionSync]';

/**
 * True when a freshly-read invitation differs from its cached row in any way a
 * consumer can observe. Volatile timestamps are deliberately excluded.
 */
export function sentInvitationChanged(
  cached: UnipileSentInvitation,
  candidate: UnipileSentInvitation,
): boolean {
  return (
    cached.publicProfileUrl !== candidate.publicProfileUrl ||
    cached.invitationId !== candidate.invitationId ||
    cached.invitedUserName !== candidate.invitedUserName ||
    cached.invitationText !== candidate.invitationText
  );
}

export interface SyncSentInvitationsOptions {
  /**
   * 'full' walks the entire pending feed and prunes; 'incremental' stops at the
   * first page that is entirely known-and-unchanged and does NOT prune.
   *
   * Defaults to 'full' so every existing caller — the backfill script especially —
   * keeps its exact previous semantics, and only the cron opts into the cheap walk.
   */
  mode?: 'full' | 'incremental';
}

/**
 * Sync PENDING sent invitations for one Unipile account into the cache.
 *
 * This service intentionally has no cron or agent-mode imports. Operator scripts
 * can refresh the cache without loading the server's LLM dependency graph.
 *
 * Cost note (ENG-1197): this walked the WHOLE pending feed every ten minutes, on
 * every instance, with no early exit even when the previous cycle had already
 * proved nothing changed. At ~100 invitations per page that is 7 pages for an
 * account with 685 pending and 16 for one with 1,540 — repeated 144 times a day
 * each, against LinkedIn, whether or not anyone was using the product. Since load
 * scaled with backlog size, the accounts we hit hardest were exactly the ones whose
 * sessions kept being revoked.
 *
 * The incremental mode fixes that. The feed is newest-first, so a page in which
 * every invitation is already cached and unchanged means everything behind it is
 * too, and the walk can stop. What it cannot do is prune: dropping stale rows
 * requires having seen the COMPLETE pending set, so an early exit would delete
 * invitations it simply never reached. Pruning therefore stays with the full walk,
 * which the cron still runs — just far less often.
 */
export async function syncSentInvitationsForAccount(
  accountId: string,
  options: SyncSentInvitationsOptions = {},
): Promise<number> {
  const mode = options.mode ?? 'full';
  const toUpsert: UnipileSentInvitation[] = [];
  const stillPendingPublicIds = new Set<string>();
  const now = new Date().toISOString();
  let unchanged = 0;
  let stoppedEarly = false;

  // Unipile occasionally omits parsed_datetime. Carry the first-observed value
  // forward instead of moving sentAt on every sync. Keep the whole cached row so
  // unchanged invitations can skip their DynamoDB write (ENG-875).
  const cachedByPublicId = new Map<string, UnipileSentInvitation>();
  let cachePreloaded = false;
  try {
    for (const inv of await getAllSentInvitationsByAccount(accountId)) {
      cachedByPublicId.set(inv.invitedUserPublicId, inv);
    }
    cachePreloaded = true;
  } catch (err) {
    // Non-fatal — the refresh remains correct, but may rewrite unchanged rows.
    console.warn(`${TAG} could not preload cached invitations for account ${accountId}:`, err);
  }

  let cursor: string | undefined;
  let page = 0;
  const MAX_PAGES = 50;

  do {
    const result = await linkedInOutreachService.listSentInvitations(accountId, cursor);
    const items: any[] = result?.items ?? [];
    if (items.length === 0) break;

    let pageWasEntirelyKnown = true;
    for (const item of items) {
      const publicId: string =
        item.invited_user_public_id ||
        item.invited_user_public_identifier ||
        '';
      if (!publicId) continue;

      // The prune relies on the complete feed, so every pending id is retained
      // even when its unchanged row does not need another write.
      stillPendingPublicIds.add(publicId);

      const cached = cachedByPublicId.get(publicId);
      const candidate: UnipileSentInvitation = {
        accountId,
        invitedUserPublicId: publicId,
        publicProfileUrl: profileUrlFromPublicId(publicId),
        invitationId: item.id ?? '',
        invitedUserName: item.invited_user ?? '',
        invitationText: item.invitation_text ?? '',
        sentAt: item.parsed_datetime ?? cached?.sentAt ?? now,
        syncedAt: now,
      };

      if (cached && !sentInvitationChanged(cached, candidate)) {
        unchanged += 1;
        continue;
      }

      pageWasEntirelyKnown = false;
      toUpsert.push(candidate);
    }

    cursor = (result as any)?.cursor ?? undefined;
    page++;

    // Newest-first ordering means a page we already knew in full implies every page
    // behind it is known too. Requires a trustworthy cache: if the preload failed we
    // have no basis for "unchanged" and must keep walking.
    if (mode === 'incremental' && cachePreloaded && pageWasEntirelyKnown) {
      stoppedEarly = true;
      break;
    }
  } while (cursor && page < MAX_PAGES);

  await upsertSentInvitations(toUpsert);

  if (stoppedEarly) {
    // No prune: `stillPendingPublicIds` holds only the pages actually read, so
    // pruning against it would delete every invitation beyond the early exit.
    console.log(
      `${TAG} account=${accountId} pending invitations: ${toUpsert.length} upserted, ` +
      `${unchanged} unchanged (skipped), prune deferred to the next full walk (pages=${page}, incremental)`,
    );
    return toUpsert.length;
  }

  const pruned = await pruneStaleSentInvitations(
    accountId,
    stillPendingPublicIds,
    cachePreloaded ? Array.from(cachedByPublicId.values()) : undefined,
  );

  console.log(
    `${TAG} account=${accountId} pending invitations: ${toUpsert.length} upserted, ` +
    `${unchanged} unchanged (skipped), ${pruned} pruned (pages=${page})`,
  );
  return toUpsert.length;
}
