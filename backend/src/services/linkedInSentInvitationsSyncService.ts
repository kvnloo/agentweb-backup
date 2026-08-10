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

/**
 * Sync PENDING sent invitations for one Unipile account into the cache.
 *
 * This service intentionally has no cron or agent-mode imports. Operator scripts
 * can refresh the cache without loading the server's LLM dependency graph.
 */
export async function syncSentInvitationsForAccount(accountId: string): Promise<number> {
  const toUpsert: UnipileSentInvitation[] = [];
  const stillPendingPublicIds = new Set<string>();
  const now = new Date().toISOString();
  let unchanged = 0;

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

      toUpsert.push(candidate);
    }

    cursor = (result as any)?.cursor ?? undefined;
    page++;
  } while (cursor && page < MAX_PAGES);

  await upsertSentInvitations(toUpsert);
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
