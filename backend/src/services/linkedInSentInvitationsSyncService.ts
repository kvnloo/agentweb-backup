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
 * consumer can observe. `syncedAt` is excluded, and `sentAt` counts only when it
 * moved EARLIER: `resolveLedgerSentAt` never moves it later, so the per-request
 * drift of `parsed_datetime` (ENG-875) still produces no write.
 */
export function sentInvitationChanged(
  cached: UnipileSentInvitation,
  candidate: UnipileSentInvitation,
): boolean {
  return (
    cached.publicProfileUrl !== candidate.publicProfileUrl ||
    cached.invitationId !== candidate.invitationId ||
    cached.invitedUserName !== candidate.invitedUserName ||
    cached.invitationText !== candidate.invitationText ||
    isEarlierTimestamp(candidate.sentAt, cached.sentAt)
  );
}

/** Tolerated clock skew before a provider timestamp counts as "in the future". */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

function validPastMs(value: unknown, nowMs: number): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) || ms > nowMs + FUTURE_SKEW_MS ? null : ms;
}

function isEarlierTimestamp(candidate: string | undefined, cached: string | undefined): boolean {
  const candidateMs = typeof candidate === 'string' ? Date.parse(candidate) : NaN;
  const cachedMs = typeof cached === 'string' ? Date.parse(cached) : NaN;
  if (Number.isNaN(candidateMs)) return false;
  return Number.isNaN(cachedMs) || candidateMs < cachedMs;
}

/**
 * ENG-1938: the `sentAt` to store for a pending invitation — the EARLIEST
 * estimate ever observed for this invitation, not the first one.
 *
 * LinkedIn exposes only a relative age ("Sent 3 months ago") and Unipile resolves
 * it to an absolute `parsed_datetime` at request time. That label is a floor on
 * the real age, so every resolution lands at or after the real send, and the
 * earliest one seen is the tightest estimate. Keeping the FIRST value instead
 * (the pre-ENG-1938 rule) froze two kinds of wrong row forever:
 *   - a row first seen while Unipile omitted `parsed_datetime`, stamped with the
 *     sync time — 450 of TFA Connect's 681 rows on 2026-09-14, which made invites
 *     from March–May look 4–19 days old to the stale-invitation drain;
 *   - a row first seen at a coarse bucket ("1 week ago") that later rolled over
 *     to an earlier one ("1 month ago").
 *
 * Properties the callers rely on:
 *   - Never moves later, so request-time drift causes no rewrite (ENG-875) and a
 *     send-path row keeps the exact instant it was stamped with.
 *   - A different `invitationId` is a NEW invitation to the same person (re-invite
 *     after a withdrawal/acceptance), so the old row's date is discarded.
 *   - An unparseable or future provider value is ignored rather than trusted.
 */
export function resolveLedgerSentAt(
  cached: Pick<UnipileSentInvitation, 'sentAt' | 'invitationId'> | undefined,
  item: { parsed_datetime?: unknown; id?: unknown },
  now: string,
): string {
  const nowMs = Date.parse(now);
  const sameInvitation = !cached
    || !cached.invitationId
    || typeof item.id !== 'string'
    || !item.id
    || cached.invitationId === item.id;
  const cachedSentAt = sameInvitation ? cached?.sentAt : undefined;
  const cachedMs = validPastMs(cachedSentAt, nowMs);
  const parsedMs = validPastMs(item.parsed_datetime, nowMs);

  if (parsedMs !== null && (cachedMs === null || parsedMs < cachedMs)) {
    return item.parsed_datetime as string;
  }
  if (cachedMs !== null) return cachedSentAt as string;
  return now;
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
  let consecutiveKnownPages = 0;

  // sentAt keeps the EARLIEST estimate observed (resolveLedgerSentAt, ENG-1938),
  // so request-time drift never moves it. Keep the whole cached row so unchanged
  // invitations can skip their DynamoDB write (ENG-875).
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
        sentAt: resolveLedgerSentAt(cached, item, now),
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
    //
    // Two CONSECUTIVE known pages, not one. The early exit rests on Unipile ordering
    // the feed newest-first, which is observed behaviour rather than a documented
    // contract — and the cost of that assumption being wrong is not a slow sync, it
    // is a pending invitation missing from the cache, which reads as "never invited"
    // and can re-invite someone. One extra page is cheap insurance against a single
    // out-of-order page ending the walk early.
    consecutiveKnownPages = pageWasEntirelyKnown ? consecutiveKnownPages + 1 : 0;
    if (mode === 'incremental' && cachePreloaded && consecutiveKnownPages >= 2) {
      stoppedEarly = true;
      break;
    }
  } while (cursor && page < MAX_PAGES);

  // Truncation is an incomplete walk too. Hitting MAX_PAGES with a cursor still in
  // hand means there are pages we never read, so `stillPendingPublicIds` is partial —
  // and pruning against a partial set deletes real pending invitations. The
  // two-known-pages exit already sets this; the page cap has exactly the same
  // consequence and was not covered.
  if (cursor && page >= MAX_PAGES) {
    stoppedEarly = true;
    console.warn(
      `${TAG} account=${accountId} stopped at the ${MAX_PAGES}-page cap with more feed remaining — ` +
      `prune skipped (an incomplete set cannot say what is stale)`,
    );
  }

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
