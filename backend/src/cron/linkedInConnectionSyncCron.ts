/**
 * LinkedIn Connection Sync Cron
 *
 * Runs every 10 minutes. For each connected Unipile account:
 *  1. Fetches the first 3 pages of getAllRelations (newest-first).
 *  2. Upserts new connections into AW-UnipileConnections cache.
 *  3. For each newly detected connection, auto-enrolls matching leads into any
 *     active sequence with enrollmentTrigger.type = 'linkedin_connection_accepted'.
 *
 * Manual resync (per-lead or per-list) calls syncConnectionsForAccount() directly.
 */

import { getAzureClient, meterUsageFromResponse } from '../utils/llmClients';
import { linkedInOutreachService } from '../services/linkedInOutreachService';
import { settingsService } from '../services/settingsService';
import { dripSequenceDb } from '../services/dripSequenceDb';
import { crmDb } from '../services/db';
import { leadListAlertService } from '../services/leadListAlertService';
import {
  upsertConnections,
  getLatestConnectedAt,
  getFullSyncCompletedAt,
  markFullSyncCompleted,
  normalizeLinkedInUrl,
  UnipileConnection,
} from '../services/unipileConnectionsDb';
import { syncSentInvitationsForAccount } from '../services/linkedInSentInvitationsSyncService';

export {
  sentInvitationChanged,
  syncSentInvitationsForAccount,
} from '../services/linkedInSentInvitationsSyncService';

const TAG = '[linkedInConnectionSync]';

/**
 * Kill-switches for the side effects of detecting a newly-accepted LinkedIn
 * connection. Both default to DISABLED (muted) and must be explicitly turned on
 * by setting the env var to "true". This is a deliberate fail-safe added after
 * the 2026-06-03 notification flood (see docs/postmortem-2026-06-03-linkedin-connection-notification-flood.md):
 * a one-time connection backfill caused thousands of "invitation accepted"
 * emails/Slack messages and auto-enrollments to fire for historical, already-old
 * connections — at a scale that risked spamming clients' prospects.
 *
 *  - LINKEDIN_CONNECTION_NOTIFY:  owner email/Slack alerts ("X accepted your invite")
 *  - LINKEDIN_CONNECTION_ENROLL:  auto-enroll accepted leads into drip sequences
 *                                 (this is what triggers OUTBOUND messages to leads)
 *
 * Connection caching itself is unaffected — the "already connected" detection
 * other CRM features rely on keeps working.
 *
 * Read at call time (not module load) so the flag can be flipped via the EB
 * environment without import-order concerns.
 */
const isNotifyEnabled = (): boolean => process.env.LINKEDIN_CONNECTION_NOTIFY === 'true';
const isEnrollEnabled = (): boolean => process.env.LINKEDIN_CONNECTION_ENROLL === 'true';

/**
 * Kill-switch for mirroring pending invitations into the CRM on every sync.
 * Muted by default: it performs bulk writes into customers' lead lists
 * unattended, so switching it on is a data-plane decision. Set
 * LINKEDIN_INVITE_CRM_RECONCILE=true to enable.
 */
const isInviteReconcileEnabled = (): boolean => process.env.LINKEDIN_INVITE_CRM_RECONCILE === 'true';

/**
 * All Unipile account IDs to sync: site-wide settings + every per-user connected
 * account, plus the owner of each per-user account.
 *
 * Site-wide accounts are deliberately absent from `ownerByAccountId` — they belong
 * to no single customer, so nothing that writes into a customer's CRM may act on
 * them.
 */
async function getAllUnipileAccountIds(): Promise<{
  ids: string[];
  ownerByAccountId: Map<string, string>;
}> {
  const ids = new Set<string>();
  const ownerByAccountId = new Map<string, string>();

  // Site-wide accounts
  try {
    const setting = await settingsService.getSetting('site-wide-unipile-accounts');
    if (setting?.settingValue) {
      const siteAccounts = JSON.parse(setting.settingValue) as any[];
      for (const a of siteAccounts) {
        if (a.enabled !== false && a.account_id) ids.add(a.account_id);
      }
    }
  } catch { /* ignore */ }

  // Per-user connected Unipile accounts
  try {
    const { userDb } = await import('../services/db');
    const users = await userDb.getAllUsers();
    for (const user of users) {
      if (!user.connected_accounts) continue;
      for (const acct of user.connected_accounts as any[]) {
        if (acct.platform === 'unipile') {
          const accountId = acct.config?.unipile_account_id || acct.account_id;
          if (accountId) {
            ids.add(accountId);
            // First owner wins; an account shared across users has no single owner
            // to attribute to, and overwriting would make the choice arbitrary.
            if (user.userId && !ownerByAccountId.has(accountId)) {
              ownerByAccountId.set(accountId, String(user.userId));
            }
          }
        }
      }
    }
  } catch { /* ignore */ }

  return { ids: Array.from(ids), ownerByAccountId };
}

// ─── Core sync logic ──────────────────────────────────────────────────────────

/**
 * Fetch recent connections for one Unipile account and upsert into cache.
 * Returns the list of newly discovered connections (connectedAt > lastKnownAt).
 * Pass fullSync=true to paginate through ALL connections (used for manual per-list resync).
 */
export async function syncConnectionsForAccount(
  accountId: string,
  opts: { fullSync?: boolean } = {},
): Promise<UnipileConnection[]> {
  const lastKnownAt = await getLatestConnectedAt(accountId).catch(() => null);
  const newConnections: UnipileConnection[] = [];

  // Decide whether this run should backfill ALL connections instead of the incremental
  // 3-page poll. The incremental poll only captures the newest ~60, so an account with
  // more connections than that would never get its older connections cached — making
  // genuinely-connected leads look "not connected" (the CRM then offers "Send Invite",
  // which fails live as "already connected"). We force a one-time full backfill until a
  // __fullsync__ marker is set, covering BOTH:
  //   - empty caches (no watermark yet), and
  //   - partial caches populated by incremental polls before this fix landed.
  const fullSyncDoneAt = await getFullSyncCompletedAt(accountId).catch(() => null);
  const needsBackfill = fullSyncDoneAt === null;
  const fullSync = opts.fullSync || needsBackfill;

  let cursor: string | undefined;
  let page = 0;
  const MAX_PAGES = fullSync ? 200 : 3; // Unipile returns ~20 relations/page → ~60 newest per incremental 10-min poll

  do {
    const result = await linkedInOutreachService.listConnections(accountId, cursor);
    const items: any[] = result?.items ?? [];

    if (items.length === 0) break;

    const toUpsert: UnipileConnection[] = [];
    let hitOldRecord = false;

    for (const item of items) {
      const connectedAt: number = item.created_at ?? 0;

      // If sorting newest-first and we hit an already-known timestamp, stop paginating
      if (!fullSync && lastKnownAt !== null && connectedAt <= lastKnownAt) {
        hitOldRecord = true;
        break;
      }

      const profileUrl = normalizeLinkedInUrl(
        item.public_profile_url || `https://www.linkedin.com/in/${item.public_identifier}/`,
      );

      toUpsert.push({
        accountId,
        memberId: item.member_id || item.public_identifier,
        publicProfileUrl: profileUrl,
        memberUrn: item.member_urn ?? '',
        connectionUrn: item.connection_urn ?? '',
        firstName: item.first_name ?? '',
        lastName: item.last_name ?? '',
        headline: item.headline ?? '',
        connectedAt,
        syncedAt: new Date().toISOString(),
      });
    }

    if (toUpsert.length > 0) {
      await upsertConnections(toUpsert);
      newConnections.push(...toUpsert);
    }

    cursor = (result as any)?.cursor ?? undefined;
    page++;

    if (hitOldRecord) break;
  } while (cursor && page < MAX_PAGES);

  // After a successful full pagination, record the one-time backfill marker so
  // subsequent polls revert to the cheap 3-page incremental path.
  if (fullSync) {
    await markFullSyncCompleted(accountId).catch((err) =>
      console.error(`${TAG} Failed to mark full-sync complete for ${accountId}:`, err),
    );
  }

  console.log(`${TAG} account=${accountId} synced ${newConnections.length} new connections (pages=${page}, fullSync=${fullSync})`);
  return newConnections;
}

/**
 * Mirror one account's PENDING sent-invitations into the CRM list bound to it (ENG-787).
 *
 * The per-send mirror covers invites that go through this product's send path, but
 * an invite still escapes it when the model omits `list_id` and no list is bound,
 * when the profile cannot be resolved, when the CRM write fails (the mirror is
 * best-effort and never retries), or when the invite was sent directly on LinkedIn
 * and never touched our code at all. Every one of those is only recoverable while
 * the invitation is still pending — acceptance drops it from Unipile's feed and the
 * prune removes it. Reconciling on each sync closes that window to ~10 minutes
 * instead of "whenever someone remembers to run the backfill".
 *
 * Idempotent by construction: the mirror skips an invitation already recorded, so
 * the steady state is a no-op that reports everything as alreadyRecorded.
 *
 * Requires a known owner AND a list bound to the account — a site-wide/shared
 * account belongs to no single customer and must never write into one's CRM.
 * Muted behind LINKEDIN_INVITE_CRM_RECONCILE because it is a bulk unattended write.
 */
async function reconcileInvitesToCrmForAccount(accountId: string, userId?: string): Promise<void> {
  if (!isInviteReconcileEnabled() || !userId) return;
  try {
    const { resolveListIdForAccount, reconcileSentInvitationsToCrm } =
      await import('../services/linkedInInviteCrmMirror');
    const listId = await resolveListIdForAccount(userId, accountId);
    if (!listId) return;
    const result = await reconcileSentInvitationsToCrm({
      accountId,
      listId,
      userId,
      // The cache was just refreshed above — re-pulling the live feed would double
      // every sync's Unipile calls for no new data.
      refreshFromLive: false,
    });
    if (result.created > 0 || result.updated > result.alreadyRecorded) {
      console.log(
        `${TAG} account=${accountId} mirrored invitations into list ${listId}: created=${result.created} updated=${result.updated} (alreadyRecorded=${result.alreadyRecorded})`,
      );
    }
  } catch (err) {
    // Attribution must never take down the sync.
    console.error(`${TAG} Invite→CRM reconciliation failed for account ${accountId}:`, err);
  }
}

/**
 * For each newly detected connection, find any active sequence with
 * enrollmentTrigger.type='linkedin_connection_accepted', then find leads in
 * that sequence owner's lists whose linkedin URL matches, and enroll them.
 */
export async function enrollNewConnections(newConnections: UnipileConnection[]): Promise<number> {
  if (newConnections.length === 0) return 0;

  // Kill-switch: auto-enrollment is what sends OUTBOUND messages to leads, so it
  // is muted by default. Set LINKEDIN_CONNECTION_ENROLL=true to re-enable.
  if (!isEnrollEnabled()) {
    console.log(`${TAG} Auto-enrollment muted (LINKEDIN_CONNECTION_ENROLL not 'true') — skipping ${newConnections.length} connection(s)`);
    return 0;
  }

  const sequences = await dripSequenceDb.getAllSequencesByTriggerType('linkedin_connection_accepted');
  if (sequences.length === 0) return 0;

  let enrolled = 0;

  for (const conn of newConnections) {
    for (const seq of sequences) {
      try {
        // Get all lead lists for this sequence owner
        const lists = await crmDb.getLeadListsByUserId(seq.userId);

        for (const list of lists as any[]) {
          // Only search lists that are configured for auto-enroll on this sequence
          if (seq.autoEnrollListIds?.length && !seq.autoEnrollListIds.includes(list.listId)) continue;
          // Scan leads in this list for a matching LinkedIn URL
          let lastKey: any = null;
          do {
            const page = await crmDb.getLeadsByListId(list.listId, 200, lastKey);
            const items: any[] = (page as any).items ?? [];
            lastKey = (page as any).lastEvaluatedKey ?? null;

            for (const lead of items) {
              if (!lead.linkedin || !lead.email) continue;
              const normalized = normalizeLinkedInUrl(lead.linkedin);
              if (normalized !== conn.publicProfileUrl) continue;

              // Found a matching lead — enroll if not already enrolled
              const existing = await dripSequenceDb.getExistingEnrollment(seq.sequenceId, lead.email);
              if (existing) continue;

              await dripSequenceDb.enrollLead({
                sequenceId: seq.sequenceId,
                userId: seq.userId,
                listId: list.listId,
                leadId: lead.leadId,
                leadEmail: lead.email,
              });
              enrolled++;
              console.log(`${TAG} Enrolled lead ${lead.email} into sequence ${seq.sequenceId} (LinkedIn connected)`);
            }
          } while (lastKey);
        }
      } catch (err) {
        console.error(`${TAG} Error enrolling for sequence ${seq.sequenceId}:`, err);
      }
    }
  }

  return enrolled;
}

/**
 * For each newly detected connection, look up matching CRM leads via the
 * LinkedinLookupIndex GSI and send an email notification to the list owner.
 * Fires independently of sequence enrollment.
 */
/**
 * Generate and save a LinkedIn follow-up message draft on the lead so the
 * list owner sees a ready-to-send message when they open the deep-link.
 * Non-fatal — if generation fails the notification still fires.
 */
async function generateConnectionFollowUpDraft(lead: any, list: any): Promise<void> {
  // Skip if a draft already exists — don't overwrite user-authored content.
  if (lead.messageDraft?.content) return;

  const leadName = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.email || 'there';
  const company = lead.company ? ` at ${lead.company}` : '';
  const title = lead.title ? `, ${lead.title}` : '';

  const userId = (list as any).userId;

  // Fetch activity history and brand/strategy context in parallel.
  let brandContext = '';
  let activityContext = '';
  try {
    const { agentModeService } = await import('../services/agentModeService');
    const [brand, strategy, engagementsResult] = await Promise.all([
      agentModeService.readBrandGuidelines(userId).catch(() => null),
      agentModeService.readMarketStrategy(userId).catch(() => null),
      userId ? crmDb.getLeadEngagements(lead.listId, lead.leadId, userId).catch(() => ({ engagements: [] })) : Promise.resolve({ engagements: [] }),
    ]);
    // readBrandGuidelines / readMarketStrategy return { exists, formattedContent }
    // — there is no `.guidelines` / `.strategy` field, so the previous checks were
    // always false and brand/offer context never reached the prompt.
    if (brand?.exists && brand.formattedContent) brandContext += `\nBrand voice: ${String(brand.formattedContent).slice(0, 500)}`;
    if (strategy?.exists && strategy.formattedContent) brandContext += `\nOffer/market fit: ${String(strategy.formattedContent).slice(0, 500)}`;

    const engagements: any[] = (engagementsResult as any).engagements || [];
    if (engagements.length > 0) {
      activityContext = '\n\nPast activity with this lead (most recent first):';
      engagements.slice(0, 10).forEach((eng: any, i: number) => {
        // Label direction so the model knows what to acknowledge: outbound
        // (we contacted them) vs inbound (they replied / engaged).
        const type = String(eng.eventType || '');
        const inbound = /received|replied|reply|opened|clicked/i.test(type);
        const actor = inbound ? 'They' : 'You';
        activityContext += `\n${i + 1}. ${actor} sent [${type}] ${eng.createdAt}`;
        if (eng.eventData?.subject) activityContext += ` — Subject: ${eng.eventData.subject}`;
        if (eng.text) activityContext += `\n   "${String(eng.text).slice(0, 300)}"`;
      });
      activityContext += '\n\nUse this history to craft a relevant follow-up that references prior touchpoints where appropriate. If they already replied, acknowledge their reply rather than re-introducing yourself.';
    }
  } catch { /* non-fatal */ }

  const prompt = `A LinkedIn lead just accepted your connection request. Write a short, warm follow-up LinkedIn message to start a conversation.

Lead: ${leadName}${company}${title}${brandContext}${activityContext}

Write a message that:
- Is 1-3 short sentences, max 300 characters
- Leads with something specific about THEIR work, role, or company, or builds on a prior touchpoint — show you actually know who they are
- Sounds like one human writing to another — warm, direct, no corporate speak
- References that you just connected, naturally (not "thanks for accepting my request")
- Ends with one genuine, open-ended question or a soft next step
- Does NOT use: synergy, opportunity, exciting, leverage, passionate, innovative, value-add, circle back, touch base
- No emojis, no subject line, no signature

Bad: "Hi John, thanks for connecting! I'd love to learn more about what you're working on. Would you be open to a quick chat sometime?"
Good: "Glad we connected, John. Still think your take on isolating the browser instead of locking it down is the right call — are you finding that scales as the team grows?"

Respond with JSON: {"content": "the message text"}`;

  // Un-metered client + explicit meter below: with a real userId this LLM spend
  // must be charged to that user's cap (tokens + cost), not just recorded (ENG-200).
  const openai = getAzureClient({ userId, feature: 'linkedin_cron' }, process.env.AZURE_OPENAI_DEPLOYMENT, { metered: false });
  const completion = await openai.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4',
    messages: [
      { role: 'system', content: 'You write concise, genuine LinkedIn messages. Respond only with valid JSON.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.7,
    max_tokens: 200,
    response_format: { type: 'json_object' },
  });
  meterUsageFromResponse(
    { userId, model: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4', provider: 'azure-openai', feature: 'linkedin_cron' },
    completion
  );

  const raw = completion.choices[0]?.message?.content;
  if (!raw) return;

  let parsed: { content?: string };
  try { parsed = JSON.parse(raw); } catch { return; }
  if (!parsed.content?.trim()) return;

  const now = new Date().toISOString();
  await crmDb.updateLead(lead.listId, lead.leadId, {
    messageDraft: { content: parsed.content.trim(), createdAt: now, updatedAt: now },
  });
}

/**
 * Look up CRM leads matching a connection's LinkedIn profile URL.
 *
 * The connection URL is normalized with a trailing slash (e.g. ".../in/john/"),
 * but leads store their LinkedIn URL WITHOUT a trailing slash (CSV import and
 * enrichment both strip it). findLeadsByLinkedin does an exact GSI match, so a
 * single slash-terminated lookup silently misses every lead — which is why
 * acceptance notifications stopped firing. Query both variants and dedup.
 */
async function findLeadsForConnectionUrl(profileUrl: string): Promise<any[]> {
  const withSlash = normalizeLinkedInUrl(profileUrl); // lowercase + trailing slash
  const withoutSlash = withSlash.replace(/\/+$/, '');
  const variants = withSlash === withoutSlash ? [withSlash] : [withoutSlash, withSlash];

  const seen = new Set<string>();
  const out: any[] = [];
  for (const variant of variants) {
    const leads = (await crmDb.findLeadsByLinkedin(variant)) || [];
    for (const lead of leads as any[]) {
      const key = `${lead.listId}#${lead.leadId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(lead);
    }
  }
  return out;
}

export async function notifyNewConnections(newConnections: UnipileConnection[]): Promise<void> {
  // Kill-switch: owner email/Slack alerts are muted by default after the
  // 2026-06-03 flood. Set LINKEDIN_CONNECTION_NOTIFY=true to re-enable.
  if (!isNotifyEnabled()) {
    if (newConnections.length > 0) {
      console.log(`${TAG} Acceptance notifications muted (LINKEDIN_CONNECTION_NOTIFY not 'true') — skipping ${newConnections.length} connection(s)`);
    }
    return;
  }
  for (const conn of newConnections) {
    try {
      const leads = await findLeadsForConnectionUrl(conn.publicProfileUrl);
      for (const lead of leads as any[]) {
        if (!lead.listId) continue;
        // Dedup: skip if we already sent a notification for this lead's connection event.
        if (lead.system?.linkedInConnectionNotifiedAt) {
          console.log(`${TAG} Skipping duplicate notification for lead ${lead.leadId} (already notified at ${lead.system.linkedInConnectionNotifiedAt})`);
          continue;
        }
        try {
          const list = await crmDb.getLeadListById(lead.listId);
          if (!list) continue;
          // Only notify at the lead-list level when the list has an assigned
          // LinkedIn sender, AND this connection was synced from that exact
          // sender account. Otherwise a connection accepted on an unrelated
          // account (e.g. the shared site-wide pool) would wrongly notify the
          // owner of a list that never sent the invite.
          const listSenderAccountId: string | null = (list as any).linkedInAccountId ?? null;
          if (!listSenderAccountId || listSenderAccountId !== conn.accountId) {
            console.log(`${TAG} Skipping notification for lead ${lead.leadId} — list ${lead.listId} has no matching assigned LinkedIn sender (list sender=${listSenderAccountId ?? 'none'}, connection account=${conn.accountId})`);
            continue;
          }
          // Mark as notified before sending — prevents duplicate sends if this throws.
          await crmDb.updateLead(lead.listId, lead.leadId, {
            system: { ...((lead.system as Record<string, any>) ?? {}), linkedInConnectionNotifiedAt: new Date().toISOString() },
            skipFieldNamesUpdate: true,
          });
          // Generate a follow-up draft before notifying so the panel is pre-filled.
          await generateConnectionFollowUpDraft(lead, list).catch(err =>
            console.error(`${TAG} Draft generation failed for lead ${lead.leadId}:`, err)
          );
          await leadListAlertService.notifyLinkedInConnectionAccepted(list, lead);
          console.log(`${TAG} Notified list owner for lead ${lead.leadId} (LinkedIn connection accepted)`);
        } catch (err) {
          console.error(`${TAG} Failed to notify for lead ${lead.leadId}:`, err);
        }
      }
    } catch (err) {
      console.error(`${TAG} Failed to look up leads for connection ${conn.publicProfileUrl}:`, err);
    }
  }
}

// ─── Main cron entry point ────────────────────────────────────────────────────

let isRunning = false;

export async function runLinkedInConnectionSync(): Promise<void> {
  if (isRunning) {
    console.log(`${TAG} Already running, skipping`);
    return;
  }
  isRunning = true;

  try {
    const { ids: accountIds, ownerByAccountId } = await getAllUnipileAccountIds();

    if (accountIds.length === 0) {
      console.log(`${TAG} No accounts to sync`);
      return;
    }

    console.log(`${TAG} Syncing ${accountIds.length} account(s)`);

    const allNewConnections: UnipileConnection[] = [];
    for (const accountId of accountIds) {
      try {
        // Detect a one-time full backfill BEFORE syncing. syncConnectionsForAccount
        // forces a full backfill (then sets the __fullsync__ marker) whenever that
        // marker is absent — covering BOTH empty caches and partial caches populated
        // by incremental polls before the backfill fix landed. That backfill pulls
        // ALL historical connections into the cache; those are old accepted
        // invitations, NOT freshly accepted ones. Treating them as new would
        // email/enroll the list owner for every pre-existing connection at once
        // (observed: a one-time burst of acceptance emails). Cache them silently and
        // only process genuinely-new connections on subsequent incremental runs.
        const wasBackfill = (await getFullSyncCompletedAt(accountId).catch(() => null)) === null;

        const newConns = await syncConnectionsForAccount(accountId);
        if (wasBackfill) {
          console.log(`${TAG} account=${accountId} one-time backfill cached ${newConns.length} connection(s) — skipping accepted-notifications and enrollment`);
        } else {
          allNewConnections.push(...newConns);
        }
      } catch (err) {
        console.error(`${TAG} Sync failed for account ${accountId}:`, err);
      }
      // Refresh pending sent-invitations independently — a failure here must not
      // block connection sync (and vice versa).
      try {
        await syncSentInvitationsForAccount(accountId);
      } catch (err) {
        console.error(`${TAG} Sent-invitation sync failed for account ${accountId}:`, err);
      }
      // Then mirror those pending invitations into the CRM (ENG-787). Runs here, right
      // after the refresh, because a pending invitation is the ONLY window in which an
      // invite is recoverable: once it is accepted or withdrawn it drops off Unipile's
      // feed and is pruned from the cache. Attribution that depends on a manual backfill
      // therefore races acceptance, and loses for invites sent outside this product,
      // sent without a resolvable list, or whose send-time mirror write failed.
      await reconcileInvitesToCrmForAccount(accountId, ownerByAccountId.get(accountId));
    }

    // Auto-enroll leads and send email notifications for newly accepted connections
    if (allNewConnections.length > 0) {
      const [enrolled] = await Promise.all([
        enrollNewConnections(allNewConnections),
        notifyNewConnections(allNewConnections),
      ]);
      if (enrolled > 0) {
        console.log(`${TAG} Auto-enrolled ${enrolled} lead(s) from new connections`);
      }
    }
  } finally {
    isRunning = false;
  }
}
