import { normalizeLinkedInUrl } from './enrichmentGroups';

/**
 * Lead statuses that a LinkedIn invite is allowed to advance to 'contacted'.
 * An invite is the earliest possible touch, so it only sets 'contacted' on a lead
 * that has no meaningful status yet — it must never regress a lead already further
 * along the funnel (replied / meeting / won / ...).
 */
const UNCONTACTED_STATUSES = new Set(['', 'new', 'not_contacted', 'uncontacted', 'to_contact', 'none']);

/** Engagement event type written for every mirrored invitation. */
const INVITE_SENT_EVENT = 'linkedin.invite.sent';

/**
 * True when the lead already carries an engagement for THIS exact invitation.
 *
 * `addLeadEngagement` appends unconditionally, so without this guard the same
 * real-world invitation is logged again every time it is re-mirrored — and it is
 * re-mirrored often: the send-time dedup guard re-runs the mirror on every
 * outreach run for an invite that is still pending, and the reconciliation job is
 * designed to be re-run as a backstop. That would turn the ENG-787 under-count
 * into an over-count and inflate follow-up cadence.
 *
 * Identity is (event type, sending account, invitee, send time). `sentAt` for a
 * cached pending invitation is stable across syncs, so re-mirroring matches; a
 * genuinely new invitation (previous one accepted/withdrawn, then re-sent) carries
 * a later timestamp and is still recorded.
 */
function hasInviteEngagement(
  lead: any,
  opts: { linkedin: string; accountId: string; sentAt: string },
): boolean {
  const engagements = Array.isArray(lead?.engagements) ? lead.engagements : [];
  return engagements.some(
    (e: any) =>
      String(e?.eventType ?? '') === INVITE_SENT_EVENT &&
      String(e?.createdAt ?? '') === opts.sentAt &&
      String(e?.eventData?.linkedin ?? '') === opts.linkedin &&
      String(e?.eventData?.accountId ?? '') === opts.accountId,
  );
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
  /** ISO timestamp of the send; defaults to now. */
  sentAt?: string;
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
  /** True when a new lead was (or would be) created; false when an existing lead matched. */
  created: boolean;
  /**
   * True when a `linkedin.invite.sent` engagement was appended; false when this exact
   * invitation was already recorded on the lead (re-mirror of a still-pending invite,
   * or a repeat reconciliation run) and the append was skipped.
   */
  engagementLogged: boolean;
}

/**
 * Mirror a sent LinkedIn connection invitation back into the CRM lead list (ENG-787).
 *
 * Attribution gap: invitations sent through the outreach tool (or the manual CRM
 * button) were never written back as a lead-level record, so the CRM under-reported
 * true contact volume and follow-up cadence could not fire for pending invitees. This
 * reconciles the invitee into the target list: creates the lead if absent, marks it
 * 'contacted', stamps `linkedInInviteSentAt`, and appends a `linkedin.invite.sent`
 * engagement carrying the note + sending account for provenance.
 *
 * Best-effort by contract: every call site wraps this so a CRM write can NEVER fail an
 * invite that Unipile already accepted. Returns null when there is no usable personal
 * LinkedIn identifier to key the lead on.
 */
export async function mirrorLinkedInInviteToCrm(
  params: MirrorInviteParams,
): Promise<MirrorInviteResult | null> {
  const normalized = normalizeLinkedInUrl(params.linkedinUrl);
  // No personal /in/ profile URL → nothing to key a lead on; and a target list is required.
  if (!normalized || !params.listId) return null;

  const { crmDb } = await import('./db');
  const sentAt = params.sentAt || new Date().toISOString();

  // Resolve the target lead. A caller that already knows the lead (manual CRM button)
  // passes leadId. The outreach path resolves by normalized LinkedIn URL —
  // findLeadByLinkedinInList scopes that GLOBAL GSI lookup to THIS list server-side
  // (a same-URL match in another list is a different lead and must not be reused) and
  // pages past the 10-item ceiling that would otherwise hide the match.
  let leadId = params.leadId;
  let existing: any = null;
  if (leadId) {
    existing = await crmDb.getLeadById(params.listId, leadId);
    if (!existing) leadId = undefined;
  }
  if (!leadId) {
    existing = await crmDb.findLeadByLinkedinInList(params.listId, normalized);
    if (existing) leadId = existing.leadId as string;
  }

  // Read-only preview: report whether this invitee would be created vs updated, no writes.
  if (params.dryRun) {
    const alreadyLogged = !!existing && hasInviteEngagement(existing, {
      linkedin: normalized,
      accountId: params.accountId || '',
      sentAt,
    });
    return { leadId: leadId ?? '', created: !leadId, engagementLogged: !alreadyLogged };
  }

  let created = false;
  if (!leadId) {
    // createLead stores the LinkedIn URL verbatim, so pass the already-normalized value
    // to keep it consistent with the LinkedinLookupIndex GSI reads above.
    const newLead = await crmDb.createLead(params.listId, {
      linkedin: normalized,
      firstName: params.firstName,
      lastName: params.lastName,
      company: params.company,
      title: params.title,
      status: 'contacted',
      userId: params.userId,
    });
    leadId = (newLead as any)?.leadId as string;
    created = true;
  }

  if (!leadId) return null;

  // Advance status to 'contacted' only when the lead has no meaningful status yet.
  // Always stamp the invite timestamp so the UI reflects the send.
  const currentStatus = String(existing?.status ?? '').trim().toLowerCase();
  const leadUpdate: { status?: string; linkedInInviteSentAt: string } = {
    linkedInInviteSentAt: sentAt,
  };
  if (!created && UNCONTACTED_STATUSES.has(currentStatus)) {
    leadUpdate.status = 'contacted';
  }
  await crmDb.updateLead(params.listId, leadId, leadUpdate);

  // Lead-level engagement record — provenance + so follow-up cadence can fire.
  // Skipped when this exact invitation is already on the lead, so re-mirroring a
  // still-pending invite (or re-running the reconciliation) stays idempotent.
  const accountId = params.accountId || '';
  if (!created && hasInviteEngagement(existing, { linkedin: normalized, accountId, sentAt })) {
    return { leadId, created, engagementLogged: false };
  }
  await crmDb.addLeadEngagement(params.listId, leadId, {
    eventType: INVITE_SENT_EVENT,
    eventData: {
      note: params.note || '',
      accountId,
      linkedin: normalized,
    },
    createdAt: sentAt,
  });

  return { leadId, created, engagementLogged: true };
}

/** Split a LinkedIn display name ("Bala S.", "泓杰 虞") into best-effort first/last. */
function splitInvitedUserName(name?: string): { firstName?: string; lastName?: string } {
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
    total: 0, created: 0, updated: 0, skipped: 0, alreadyRecorded: 0,
  };
  if (!accountId || !listId) return result;

  // Refresh the cache from Unipile's live sent feed first (default on) so the
  // reconciliation reflects invites sent since the last ~10-min sync cron.
  if (params.refreshFromLive !== false) {
    try {
      const { syncSentInvitationsForAccount } = await import('../cron/linkedInConnectionSyncCron');
      await syncSentInvitationsForAccount(accountId);
    } catch (syncErr) {
      // Non-fatal: reconcile against whatever the cache already holds.
      console.warn(`[reconcileSentInvitations] live refresh failed for account ${accountId} (using cache):`, syncErr);
    }
  }

  const { getAllSentInvitationsByAccount } = await import('./unipileSentInvitationsDb');
  const pending = await getAllSentInvitationsByAccount(accountId);
  result.total = pending.length;

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
        sentAt: inv.sentAt,
        dryRun: params.dryRun,
      });
      if (!mirror) {
        result.skipped++;
      } else if (mirror.created) {
        result.created++;
      } else {
        result.updated++;
        if (!mirror.engagementLogged) result.alreadyRecorded++;
      }
    } catch (itemErr) {
      // One malformed/racey invite must never abort the whole reconciliation.
      console.warn(`[reconcileSentInvitations] failed to mirror ${inv.invitedUserPublicId} (skipped):`, itemErr);
      result.skipped++;
    }
  }

  console.log(
    `[reconcileSentInvitations]${params.dryRun ? ' (DRY-RUN, no writes)' : ''} account=${accountId} list=${listId} total=${result.total} created=${result.created} updated=${result.updated} (alreadyRecorded=${result.alreadyRecorded}) skipped=${result.skipped}`,
  );
  return result;
}
