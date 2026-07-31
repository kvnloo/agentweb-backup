import { normalizeLinkedInUrl } from './enrichmentGroups';

/**
 * Lead statuses that a LinkedIn invite is allowed to advance to 'contacted'.
 * An invite is the earliest possible touch, so it only sets 'contacted' on a lead
 * that has no meaningful status yet — it must never regress a lead already further
 * along the funnel (replied / meeting / won / ...).
 */
const UNCONTACTED_STATUSES = new Set(['', 'new', 'not_contacted', 'uncontacted', 'to_contact', 'none']);

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
  // passes leadId. The outreach path resolves by normalized LinkedIn URL — but
  // findLeadsByLinkedin is a GLOBAL GSI lookup, so it must be scoped to THIS list; a
  // same-URL match in another list is a different lead and must not be reused.
  let leadId = params.leadId;
  let existing: any = null;
  if (leadId) {
    existing = await crmDb.getLeadById(params.listId, leadId);
    if (!existing) leadId = undefined;
  }
  if (!leadId) {
    const matches = await crmDb.findLeadsByLinkedin(normalized);
    existing = (matches || []).find((l: any) => l.listId === params.listId) || null;
    if (existing) leadId = existing.leadId as string;
  }

  // Read-only preview: report whether this invitee would be created vs updated, no writes.
  if (params.dryRun) {
    return { leadId: leadId ?? '', created: !leadId };
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
  await crmDb.addLeadEngagement(params.listId, leadId, {
    eventType: 'linkedin.invite.sent',
    eventData: {
      note: params.note || '',
      accountId: params.accountId || '',
      linkedin: normalized,
    },
    createdAt: sentAt,
  });

  return { leadId, created };
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
  const result: ReconcileInvitationsResult = { total: 0, created: 0, updated: 0, skipped: 0 };
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
      }
    } catch (itemErr) {
      // One malformed/racey invite must never abort the whole reconciliation.
      console.warn(`[reconcileSentInvitations] failed to mirror ${inv.invitedUserPublicId} (skipped):`, itemErr);
      result.skipped++;
    }
  }

  console.log(
    `[reconcileSentInvitations]${params.dryRun ? ' (DRY-RUN, no writes)' : ''} account=${accountId} list=${listId} total=${result.total} created=${result.created} updated=${result.updated} skipped=${result.skipped}`,
  );
  return result;
}
