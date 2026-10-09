import { createHash } from 'crypto';
import { normalizeLinkedInUrl } from './enrichmentGroups';

/**
 * Lead statuses that a LinkedIn invite is allowed to advance to 'contacted'.
 * An invite is the earliest possible touch, so it only sets 'contacted' on a lead
 * that has no meaningful status yet — it must never regress a lead already further
 * along the funnel (replied / meeting / won / ...).
 */
const UNCONTACTED_STATUSES = new Set(['', 'new', 'not_contacted', 'uncontacted', 'to_contact', 'none']);

/** Engagement event type written for a mirrored OUTBOUND invitation this account sent. */
export const INVITE_SENT_EVENT = 'linkedin.invite.sent';
/**
 * Engagement event type written when this account accepted an INBOUND invitation
 * (ENG-1595). Distinct from {@link INVITE_SENT_EVENT} because the two are opposite
 * real-world events — who initiated contact matters for provenance — but they share
 * every other mechanic below (dedup, idempotent append, status advance).
 */
export const INVITE_ACCEPTED_EVENT = 'linkedin.invite.accepted';

/**
 * ENG-1719: a stale invitation we withdrew ourselves.
 *
 * Logged so a lead's history reads truthfully — "we invited them, then withdrew
 * it" — rather than ending at `linkedin.invite.sent` forever. Deliberately does
 * NOT flip the lead back from 'contacted' and does NOT clear
 * `linkedInInviteSentAt`: we really did contact that person, and rewriting that
 * would be falsifying history rather than correcting it. What has to stop being
 * true is the "invitation pending" indicator, and that is driven off the
 * AW-UnipileSentInvitations row, which the withdrawal deletes.
 */
export const INVITE_WITHDRAWN_EVENT = 'linkedin.invite.withdrawn';

/**
 * True when the lead already carries an invite-sent engagement for this invitee
 * from this sending account.
 *
 * `addLeadEngagement` appends unconditionally, so without this guard the same
 * real-world invitation is logged again every time it is re-mirrored — and it is
 * re-mirrored often: the send-time dedup guard re-runs the mirror on every
 * outreach run for an invite that is still pending, and the reconciliation job is
 * designed to be re-run as a backstop. That would turn the ENG-787 under-count
 * into an over-count and inflate follow-up cadence.
 *
 * Identity is Unipile's own `invitationId` — stable for the life of one invitation
 * and the only value every path agrees on. It is deliberately NOT the send time:
 * one invitation carries several timestamps over its life (the fresh send stamps
 * locally, the sync cron then overwrites the cache row with Unipile's
 * parsed_datetime, and the reconciliation reads that), so a time-keyed identity
 * logged the same invitation once per source.
 *
 * A different `invitationId` means a genuinely new invitation — the invitee was
 * re-invited after the first was accepted or withdrawn — and is recorded, even
 * when an older id-less event already exists for the same account and invitee.
 * An id-less recorded event therefore only matches an incoming invite that ALSO
 * carries no id (handled below); it never masks an incoming id. Suppressing a
 * genuine re-invite would drop it from the follow-up cadence — the exact
 * under-reporting ENG-787 fixes — which is worse than the rare double-log of a
 * single invitation first written id-less and later reconciled with its id.
 *
 * With no `invitationId` on the incoming side, any prior invite-sent engagement
 * for this account and invitee counts as already recorded.
 */
function hasInviteEngagement(
  lead: any,
  opts: { linkedin: string; accountId: string; invitationId?: string; eventType: string },
): boolean {
  const engagements = Array.isArray(lead?.engagements) ? lead.engagements : [];
  const candidates = engagements.filter(
    (e: any) =>
      String(e?.eventType ?? '') === opts.eventType &&
      String(e?.eventData?.linkedin ?? '') === opts.linkedin &&
      String(e?.eventData?.accountId ?? '') === opts.accountId,
  );
  if (candidates.length === 0) return false;
  const incomingId = (opts.invitationId ?? '').trim();
  if (!incomingId) return true;
  return candidates.some((e: any) => {
    const recordedId = String(e?.eventData?.invitationId ?? '').trim();
    return recordedId === incomingId;
  });
}


export interface MirrorInviteParams {
  /** List-owner userId — stamped on newly-created leads for audit (CRM-history Tier 0). */
  userId?: string;
  /** Target CRM lead list to reconcile the invitee into. Required. */
  listId: string;
  /** The invitee's LinkedIn profile URL (raw is fine — it is normalized here). */
  linkedinUrl: string;
  /** When the caller already knows the lead (manual CRM button), skip the URL lookup. */
  leadId?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  /** The invitation note text, recorded on the engagement for provenance. */
  note?: string;
  /** The Unipile account that sent the invite, recorded on the engagement. */
  accountId?: string;
  /**
   * Unipile's invitation id — the stable identity of this invitation. Supply it
   * wherever it is available so a re-mirror is recognised as the same invitation
   * and a genuine re-invite is recognised as a different one.
   */
  invitationId?: string;
  /** ISO timestamp of the send; defaults to now. */
  sentAt?: string;
  /**
   * Which real-world event this mirror records — {@link INVITE_SENT_EVENT} (this
   * account sent the invite) or {@link INVITE_ACCEPTED_EVENT} (this account accepted
   * an inbound one). Defaults to `INVITE_SENT_EVENT` so every existing caller is
   * unchanged. Dedup, status-advance, and the idempotent append below all key off
   * this value, so a sent-invite mirror and an accepted-invite mirror for the SAME
   * person never collide or mask each other — they are different events and both
   * get their own engagement record.
   */
  eventType?: string;
  /**
   * Other lists belonging to the same owner to check before creating in `listId`.
   * One LinkedIn account can drive outreach for several lists, so an invitee may
   * already be a lead somewhere other than the caller's default target; mirroring
   * onto that existing lead is more faithful than duplicating them into this one.
   */
  searchListIds?: string[];
  /**
   * Read-only preview: resolve whether the invitee WOULD be created vs updated, but
   * write nothing (no createLead/updateLead/addLeadEngagement). Used by the
   * reconciliation script's --dry-run to validate counts before a real backfill.
   */
  dryRun?: boolean;
}

export interface MirrorInviteResult {
  /** Resolved lead id ('' for a would-be create under dryRun). */
  leadId: string;
  /** The list the lead actually lives in — may differ from the requested `listId`
   *  when the invitee was already a lead in another of the owner's lists. */
  listId: string;
  /** True when a new lead was (or would be) created; false when an existing lead matched. */
  created: boolean;
  /**
   * True when a `linkedin.invite.sent` engagement was appended; false when this exact
   * invitation was already recorded on the lead (re-mirror of a still-pending invite,
   * or a repeat reconciliation run) and the append was skipped.
   */
  engagementLogged: boolean;
}

/** Bound the cross-list search so a large account cannot turn one mirror into many reads. */
/**
 * CAS attempts before a contended engagement append is skipped rather than
 * written blind. Shared by `mirrorLinkedInInviteToCrm` and
 * `recordInviteWithdrawnInCrm` so the two cannot drift — an unguarded append is
 * exactly the duplicate the guard exists to prevent.
 */
const MAX_ATTEMPTS = 3;

const MAX_SEARCH_LISTS = 25;

/**
 * Resolve the CRM lead list a Unipile account sends for, from the stored binding.
 *
 * A lead list can be assigned a `linkedInAccountId` (see the CRM list settings), so
 * the account→list mapping does exist in data — it just was not being used. This
 * makes attribution work when the outreach agent omits `list_id`, which is
 * otherwise the one place the mirror depends on the model remembering to pass an
 * argument.
 *
 * Returns null unless EXACTLY one of the owner's lists is bound to the account —
 * with several bound lists there is no non-arbitrary choice, and guessing would
 * attribute invites to the wrong list.
 */
export async function resolveListIdForAccount(
  userId: string,
  accountId: string,
): Promise<string | null> {
  if (!userId || !accountId) return null;
  try {
    const { crmDb } = await import('./db');
    const lists = (await crmDb.getLeadListsByUserId(userId)) as any[];
    const bound = (lists || []).filter((l) => String(l?.linkedInAccountId ?? '') === accountId);
    if (bound.length === 1) return String(bound[0].listId);
    if (bound.length > 1) {
      console.warn(
        `[mirrorLinkedInInvite] ${bound.length} lists are bound to account ${accountId} for user ${userId} — cannot pick one, skipping ambient attribution`,
      );
    }
    return null;
  } catch (err) {
    console.warn(`[mirrorLinkedInInvite] failed to resolve list for account ${accountId}:`, err);
    return null;
  }
}

/**
 * Mirror a LinkedIn connection (sent or accepted) back into the CRM lead list
 * (ENG-787, and ENG-1595 for the accepted/inbound direction).
 *
 * Attribution gap: connections formed through the outreach tool — invitations this
 * account SENT, or inbound ones this account ACCEPTED — were never written back as
 * a lead-level record, so the CRM under-reported true contact volume, follow-up
 * cadence could not fire, and (ENG-1595) a real accepted connection was invisible to
 * name-based CRM search entirely. This reconciles the invitee into the target list:
 * creates the lead if absent, marks it 'contacted', stamps `linkedInInviteSentAt`,
 * and appends a `params.eventType` engagement (default `linkedin.invite.sent`; pass
 * `INVITE_ACCEPTED_EVENT` for an inbound accept) carrying the note + account for
 * provenance.
 *
 * Best-effort by contract: every call site wraps this so a CRM write can NEVER fail an
 * invite/accept that Unipile already confirmed. Returns null when there is no usable
 * personal LinkedIn identifier to key the lead on.
 */
export async function mirrorLinkedInInviteToCrm(
  params: MirrorInviteParams,
): Promise<MirrorInviteResult | null> {
  const normalized = normalizeLinkedInUrl(params.linkedinUrl);
  // No personal /in/ profile URL → nothing to key a lead on; and a target list is required.
  if (!normalized || !params.listId) return null;

  const { crmDb } = await import('./db');
  const sentAt = params.sentAt || new Date().toISOString();
  const eventType = params.eventType || INVITE_SENT_EVENT;

  // Resolve the target lead. A caller that already knows the lead (manual CRM button)
  // passes leadId. The outreach path resolves by normalized LinkedIn URL —
  // findLeadByLinkedinInList scopes that GLOBAL GSI lookup to THIS list server-side
  // (a same-URL match in another list is a different lead and must not be reused) and
  // pages past the 10-item ceiling that would otherwise hide the match.
  let leadId = params.leadId;
  let listId = params.listId;
  let existing: any = null;
  if (leadId) {
    const candidate = await crmDb.getLeadById(listId, leadId);
    // A caller-supplied leadId is trusted ONLY when the lead's own LinkedIn URL
    // canonically matches the invitee. On the outreach path lead_id and profile_url
    // are two independent LLM-supplied values, so a stale or mismatched lead_id
    // would otherwise mark the WRONG person contacted and attach this invitee's
    // engagement to them.
    //
    // A lead with no URL is deliberately NOT accepted on a name match. Names are not
    // identity — namesakes exist — and accepting one would also stamp the invitee's
    // URL onto that lead, turning a wrong guess into permanently corrupted identity.
    // Falling through to the URL lookup may instead create an extra lead, which is
    // visible in the list and mergeable; a silent mis-attribution is neither.
    const candidateUrl = candidate ? normalizeLinkedInUrl(candidate.linkedin) : '';
    if (candidate && candidateUrl === normalized) {
      existing = candidate;
    } else {
      if (candidate) {
        console.warn(
          `[mirrorLinkedInInvite] ignoring leadId ${leadId} in list ${listId} — its LinkedIn URL does not confirm the invitee; resolving by profile URL instead`,
        );
      }
      leadId = undefined;
    }
  }
  if (!leadId) {
    existing = await crmDb.findLeadByLinkedinInList(listId, normalized);
    if (existing) leadId = existing.leadId as string;
  }
  // Still absent from the caller's target list: before creating a duplicate, look
  // in the owner's other lists. One LinkedIn account commonly drives outreach for
  // several lists, so the invitee may already be a lead elsewhere — mirroring onto
  // that lead attributes the invite where the CRM already tracks the person.
  if (!leadId && params.searchListIds?.length) {
    for (const candidateListId of params.searchListIds.slice(0, MAX_SEARCH_LISTS)) {
      if (candidateListId === listId) continue;
      const hit = await crmDb.findLeadByLinkedinInList(candidateListId, normalized);
      if (hit) {
        existing = hit;
        leadId = hit.leadId as string;
        listId = candidateListId;
        break;
      }
    }
  }

  const invitationId = (params.invitationId ?? '').trim();

  // Read-only preview: report whether this invitee would be created vs updated, no writes.
  if (params.dryRun) {
    const alreadyLogged = !!existing && hasInviteEngagement(existing, {
      linkedin: normalized,
      accountId: params.accountId || '',
      invitationId,
      eventType,
    });
    return { leadId: leadId ?? '', listId, created: !leadId, engagementLogged: !alreadyLogged };
  }

  let created = false;
  if (!leadId) {
    // No lead in the target list yet. Create it under a leadId DETERMINISTICALLY
    // derived from the (list, normalized URL) identity, with a fail-if-exists
    // guard, so two mirrors racing on the same brand-new invitee — the send-time
    // mirror and the pending-invitation reconciliation, say — collide on the same
    // item instead of each inserting a duplicate contacted lead. The loser adopts
    // the winner's lead and falls through to the idempotent engagement append.
    // (pass the already-normalized URL so it stays consistent with the GSI reads.)
    const deterministicLeadId = `lead_li_${createHash('sha1')
      .update(`${listId}\n${normalized}`)
      .digest('hex')
      .slice(0, 20)}`;
    try {
      const newLead = await crmDb.createLead(listId, {
        linkedin: normalized,
        firstName: params.firstName,
        lastName: params.lastName,
        company: params.company,
        title: params.title,
        status: 'contacted',
        userId: params.userId,
        leadId: deterministicLeadId,
        failIfExists: true,
      }, 'linkedin');
      leadId = (newLead as any)?.leadId as string;
      existing = newLead;
      created = true;
    } catch (err: any) {
      if (!err?.leadAlreadyExists) throw err;
      // A concurrent mirror created this invitee first — adopt that lead.
      existing = await crmDb.getLeadById(listId, deterministicLeadId);
      leadId = existing ? (existing.leadId as string) : deterministicLeadId;
    }
  }

  if (!leadId) return null;

  // Advance status to 'contacted' only when the lead has no meaningful status yet.
  // Stamp the direction-appropriate timestamp so the UI reflects what actually
  // happened — an ACCEPTED inbound connection must never be recorded under
  // linkedInInviteSentAt (an outbound-send field), which would misrepresent who
  // initiated contact and could overwrite a real prior outbound timestamp.
  const currentStatus = String(existing?.status ?? '').trim().toLowerCase();
  const leadUpdate: { status?: string; linkedInInviteSentAt?: string; linkedInInviteAcceptedAt?: string } =
    eventType === INVITE_ACCEPTED_EVENT
      ? { linkedInInviteAcceptedAt: sentAt }
      : { linkedInInviteSentAt: sentAt };
  if (!created && UNCONTACTED_STATUSES.has(currentStatus)) {
    leadUpdate.status = 'contacted';
  }
  // Keep the post-update item (updateLead returns ALL_NEW): it carries the fresh
  // updatedAt this call just stamped, plus the current engagements. Seeding the
  // CAS append below from it gives even a legacy lead — one whose loaded snapshot
  // had no updatedAt — a real precondition, so two concurrent mirrors can't both
  // fall to the unguarded path and double-log the same invitation (ENG-787).
  const afterUpdate = await crmDb.updateLead(listId, leadId, leadUpdate);

  // Lead-level engagement record — provenance + so follow-up cadence can fire.
  // Skipped when this invitation is already on the lead, so re-mirroring a
  // still-pending invite (or re-running the reconciliation) stays idempotent.
  const accountId = params.accountId || '';
  const engagement = {
    eventType,
    eventData: {
      note: params.note || '',
      accountId,
      linkedin: normalized,
      invitationId,
    },
    createdAt: sentAt,
  };

  // Every path — freshly created, adopted from a racing create, or a pre-existing
  // lead — appends through the SAME idempotent CAS loop below. A brand-new lead
  // starts from an empty snapshot so the first attempt simply appends; but a lead
  // adopted from a concurrent create may already carry the winner's engagement, so
  // it must be dedup-checked too. Not special-casing `created` closes the window
  // where a race-loser would have appended a second copy of the same invitation.

  // "Is it already recorded?" is a read and the append is a write, so on their own
  // two overlapping mirrors — the sync cron reconciling while an outreach run sends,
  // say — can both read "not present" and both append. Guard the append on the lead
  // being unchanged since the read that decided it, and on a lost race re-read and
  // re-decide: the loser then sees the winner's engagement and skips.
  // Seed from the post-update item so the very first attempt CASes against the
  // updatedAt this mirror just stamped, not the pre-update snapshot (which a
  // legacy lead may carry without an updatedAt at all). Merge over `existing` so
  // a partial return still falls back to the loaded snapshot's fields.
  let snapshot: any = afterUpdate ? { ...existing, ...afterUpdate } : existing;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (hasInviteEngagement(snapshot, { linkedin: normalized, accountId, invitationId, eventType })) {
      return { leadId, listId, created, engagementLogged: false };
    }
    // With updatedAt seeded from updateLead's ALL_NEW return this is effectively
    // always set; the unguarded fallback survives only for the pathological case
    // of an item that reports no updatedAt, where dropping attribution would be
    // worse than a theoretical duplicate.
    const expectedUpdatedAt = snapshot?.updatedAt ? String(snapshot.updatedAt) : undefined;
    try {
      await crmDb.addLeadEngagement(
        listId, leadId, engagement,
        expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt },
      );
      return { leadId, listId, created, engagementLogged: true };
    } catch (err: any) {
      if (!err?.preconditionFailed) throw err;
      // Someone wrote to the lead in between — including, possibly, this same
      // invitation. Re-read and let the loop re-decide.
      snapshot = await crmDb.getLeadById(listId, leadId);
      if (!snapshot) return { leadId, listId, created, engagementLogged: false };
    }
  }

  // Contention that outlives the retries: skip rather than append blind, because an
  // unguarded append is exactly the duplicate this guard exists to prevent.
  console.warn(
    `[mirrorLinkedInInvite] gave up appending the invite engagement for lead ${listId}/${leadId} after ${MAX_ATTEMPTS} contended attempts`,
  );
  return { leadId, listId, created, engagementLogged: false };
}

/** Split a LinkedIn display name ("Bala S.", "泓杰 虞") into best-effort first/last. */
export function splitInvitedUserName(name?: string): { firstName?: string; lastName?: string } {
  const trimmed = (name || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return {};
  const parts = trimmed.split(' ');
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

export interface ReconcileInvitationsParams {
  /** Unipile account whose pending sent-invitations should be reconciled into the CRM. */
  accountId: string;
  /** Target CRM lead list to reconcile the pending invitees into. */
  listId: string;
  /** List-owner userId — stamped on newly-created leads for audit. */
  userId?: string;
  /**
   * When true, refresh the AW-UnipileSentInvitations cache from Unipile's live feed
   * before reconciling, so invites sent since the last ~10-min sync are included.
   * Defaults to true — a reconciliation should reflect the live LinkedIn state.
   */
  refreshFromLive?: boolean;
  /**
   * Also look for each invitee in the owner's OTHER lists before creating them in
   * `listId`. One LinkedIn account frequently drives outreach for several lists, so
   * a blind backfill into one list duplicates people the CRM already tracks
   * elsewhere. Defaults to true when `userId` is supplied.
   */
  searchOwnerLists?: boolean;
  /**
   * Read-only preview: compute the created/updated/skipped counts without writing any
   * lead or engagement. Validates a backfill before the real (data-plane) run.
   */
  dryRun?: boolean;
}

export interface ReconcileInvitationsResult {
  /** Total pending invitations considered. */
  total: number;
  /** Leads newly created by the reconciliation. */
  created: number;
  /** Existing leads updated (contacted/timestamp/engagement). */
  updated: number;
  /** Invitations skipped (no usable /in/ URL, or a per-item error). */
  skipped: number;
  /**
   * Of `updated`, how many already carried this invitation's engagement — i.e. were
   * mirrored by an earlier run and needed no new engagement. A repeat run should
   * report nearly all updates here; a non-zero `created` on a repeat run means new
   * invitations arrived since.
   */
  alreadyRecorded: number;
  /**
   * Of `updated`, how many were matched in one of the owner's OTHER lists rather
   * than the target list. A high number means the account→list mapping supplied is
   * not the whole picture — worth checking before trusting a blind backfill.
   */
  matchedInOtherList: number;
  /** True when the requested live refresh failed and reconciliation used cache. */
  liveRefreshFailed?: boolean;
  /** Newest cached row timestamp, included when live refresh falls back to cache. */
  newestCachedSyncedAt?: string | null;
}

/**
 * Reconcile an account's PENDING LinkedIn sent-invitations into a CRM lead list (ENG-787).
 *
 * This is the one-way sync / backfill the issue asked for: it closes the CRM↔LinkedIn
 * attribution gap for invitations that the per-send mirror missed —
 *   • historical invites sent before the mirror shipped,
 *   • invites the outreach agent sent without a list_id,
 *   • invites the send-time dedup guard skipped (already pending).
 *
 * It reuses ENG-182's live pending-invitation cache (AW-UnipileSentInvitations) as the
 * authoritative source of "who has an outstanding invite" and mirrors each one via
 * {@link mirrorLinkedInInviteToCrm}. Per-item best-effort: one bad invite never aborts
 * the batch. The caller supplies the account→list mapping (there is no stored binding).
 *
 * NOTE: this performs BULK CRM writes (create/update leads + engagement). Running it
 * against a production list is a data-plane operation — gate it accordingly.
 */
export async function reconcileSentInvitationsToCrm(
  params: ReconcileInvitationsParams,
): Promise<ReconcileInvitationsResult> {
  const { accountId, listId, userId } = params;
  const result: ReconcileInvitationsResult = {
    total: 0, created: 0, updated: 0, skipped: 0, alreadyRecorded: 0, matchedInOtherList: 0,
  };
  if (!accountId || !listId) return result;

  // Refresh the cache from Unipile's live sent feed first (default on) so the
  // reconciliation reflects invites sent since the last ~10-min sync cron.
  let liveRefreshFailed = false;
  if (params.refreshFromLive !== false) {
    try {
      const { syncSentInvitationsForAccount } = await import('./linkedInSentInvitationsSyncService');
      await syncSentInvitationsForAccount(accountId);
    } catch (syncErr) {
      // Non-fatal: reconcile against whatever the cache already holds.
      liveRefreshFailed = true;
      console.warn(`[reconcileSentInvitations] live refresh failed for account ${accountId} (using cache):`, syncErr);
    }
  }

  // The owner's other lists, so an invitee already tracked elsewhere is attributed
  // to that lead instead of being duplicated into the target list.
  let searchListIds: string[] | undefined;
  if (userId && params.searchOwnerLists !== false) {
    try {
      const { crmDb } = await import('./db');
      const lists = (await crmDb.getLeadListsByUserId(userId)) as any[];
      searchListIds = lists.map((l) => String(l.listId)).filter((id) => id && id !== listId);
    } catch (listErr) {
      // Non-fatal: fall back to target-list-only resolution.
      console.warn(`[reconcileSentInvitations] could not load other lists for user ${userId}:`, listErr);
    }
  }

  const { getAllSentInvitationsByAccount } = await import('./unipileSentInvitationsDb');
  const pending = await getAllSentInvitationsByAccount(accountId);
  result.total = pending.length;
  if (liveRefreshFailed) {
    result.liveRefreshFailed = true;
    result.newestCachedSyncedAt = pending.reduce<string | null>((newest, invitation) => {
      const syncedAt = invitation.syncedAt;
      if (!syncedAt || Number.isNaN(Date.parse(syncedAt))) return newest;
      return !newest || syncedAt > newest ? syncedAt : newest;
    }, null);
  }

  for (const inv of pending) {
    try {
      const { firstName, lastName } = splitInvitedUserName(inv.invitedUserName);
      const mirror = await mirrorLinkedInInviteToCrm({
        userId,
        listId,
        linkedinUrl: inv.publicProfileUrl,
        firstName,
        lastName,
        note: inv.invitationText,
        accountId,
        invitationId: inv.invitationId,
        sentAt: inv.sentAt,
        searchListIds,
        dryRun: params.dryRun,
      });
      if (!mirror) {
        result.skipped++;
      } else if (mirror.created) {
        result.created++;
      } else {
        result.updated++;
        if (!mirror.engagementLogged) result.alreadyRecorded++;
        if (mirror.listId !== listId) result.matchedInOtherList++;
      }
    } catch (itemErr) {
      // One malformed/racey invite must never abort the whole reconciliation.
      console.warn(`[reconcileSentInvitations] failed to mirror ${inv.invitedUserPublicId} (skipped):`, itemErr);
      result.skipped++;
    }
  }

  console.log(
    `[reconcileSentInvitations]${params.dryRun ? ' (DRY-RUN, no writes)' : ''} account=${accountId} list=${listId} total=${result.total} created=${result.created} updated=${result.updated} (alreadyRecorded=${result.alreadyRecorded}, matchedInOtherList=${result.matchedInOtherList}) skipped=${result.skipped}`,
    result.liveRefreshFailed
      ? `source=cache newestCachedSyncedAt=${result.newestCachedSyncedAt ?? 'none'}`
      : '',
  );
  return result;
}


/**
 * ENG-1719: append a withdrawal engagement to an EXISTING lead, if there is one.
 *
 * Deliberately much narrower than `mirrorLinkedInInviteToCrm`: it never creates a
 * lead and never changes a lead's status. A withdrawal is not an act of outreach,
 * so inventing a CRM record for someone who has none would manufacture a contact
 * from the act of undoing one. When the lead already exists, its history should
 * say what happened.
 *
 * Best-effort by contract, like every other call into this module: the invitation
 * is already withdrawn on LinkedIn's side by the time this runs, so a CRM write
 * failing here must never be reported as a failed withdrawal.
 */
export async function recordInviteWithdrawnInCrm(params: {
  userId: string;
  accountId: string;
  linkedinUrl: string;
  invitationId: string;
  sentAt?: string;
  listId?: string;
}): Promise<{ leadId: string; listId: string; engagementLogged: boolean } | null> {
  const normalized = normalizeLinkedInUrl(params.linkedinUrl);
  if (!normalized) return null;

  const listId = params.listId || (await resolveListIdForAccount(params.userId, params.accountId));
  if (!listId) return null;

  const { crmDb } = await import('./db');
  const existing = await crmDb.findLeadByLinkedinInList(listId, normalized);
  if (!existing?.leadId) return null;

  const leadId = String(existing.leadId);
  const engagement = {
    eventType: INVITE_WITHDRAWN_EVENT,
    eventData: {
      linkedin: normalized,
      accountId: params.accountId,
      invitationId: params.invitationId,
      ...(params.sentAt ? { originallySentAt: params.sentAt } : {}),
    },
    createdAt: new Date().toISOString(),
  };

  // Same duplicate guard the sent/accepted paths use, keyed on this event type and
  // this invitation id — a re-run of the drain must not append a second identical
  // withdrawal to the same lead.
  //
  // CodeRabbit on PR #2801: the guard alone is not enough, and the first version
  // of this function had only the guard. `addLeadEngagement` appends
  // unconditionally unless `expectedUpdatedAt` is supplied, so the read and the
  // append are two separate operations — two concurrent drains can BOTH observe
  // "not present" and both append. That is the precise race the CAS-and-retry loop
  // in `mirrorLinkedInInviteToCrm` above already solves; this reuses it rather
  // than inventing a weaker variant, which is what it should have done from the
  // start.
  let snapshot: any = existing;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (hasInviteEngagement(snapshot, {
      linkedin: normalized,
      accountId: params.accountId,
      invitationId: params.invitationId,
      eventType: INVITE_WITHDRAWN_EVENT,
    })) {
      // Already recorded by an earlier run or a concurrent winner — the history
      // entry exists, so this IS recorded from the caller's point of view.
      return { leadId, listId, engagementLogged: true };
    }
    const expectedUpdatedAt = snapshot?.updatedAt ? String(snapshot.updatedAt) : undefined;
    try {
      await crmDb.addLeadEngagement(
        listId, leadId, engagement,
        expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt },
      );
      return { leadId, listId, engagementLogged: true };
    } catch (err: any) {
      if (!err?.preconditionFailed) throw err;
      // Someone wrote to the lead in between — possibly this same withdrawal.
      // Re-read and let the loop re-decide.
      snapshot = await crmDb.getLeadById(listId, leadId);
      // The lead vanished mid-retry — nothing was appended, and saying otherwise
      // would let the drain report a missing history entry as written (CodeRabbit).
      if (!snapshot) return { leadId, listId, engagementLogged: false };
    }
  }

  // Contention outliving the retries: skip rather than append blind, because an
  // unguarded append is exactly the duplicate this guard exists to prevent.
  console.warn(
    `[recordInviteWithdrawn] gave up appending the withdrawal engagement for lead ${listId}/${leadId} after ${MAX_ATTEMPTS} contended attempts`,
  );
  // Contention outlived the retries: nothing was appended. The caller must be able
  // to tell this apart from a successful write, or the drain's own
  // `crmRecordFailed` report — the whole point of which is that nothing re-runs
  // this — silently under-reports.
  return { leadId, listId, engagementLogged: false };
}
