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

import OpenAI from 'openai';
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
import {
  upsertSentInvitations,
  pruneStaleSentInvitations,
  profileUrlFromPublicId,
  UnipileSentInvitation,
} from '../services/unipileSentInvitationsDb';

const openai = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
  defaultQuery: { 'api-version': process.env.AZURE_OPENAI_API_VERSION },
  defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_API_KEY },
});

const TAG = '[linkedInConnectionSync]';

/** Returns all Unipile account IDs to sync: site-wide settings + all per-user connected accounts. */
async function getAllUnipileAccountIds(): Promise<string[]> {
  const ids = new Set<string>();

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
          if (accountId) ids.add(accountId);
        }
      }
    }
  } catch { /* ignore */ }

  return Array.from(ids);
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
 * Sync PENDING sent invitations for one Unipile account into the
 * AW-UnipileSentInvitations cache, then prune rows that are no longer pending.
 *
 * Unipile's getAllInvitationsSent feed contains only invitations that are still
 * outstanding — once accepted or withdrawn they drop off. So we pull the full
 * feed, upsert each, and delete any cached row not present in the feed. A cached
 * row therefore means "we invited this person and they haven't accepted yet",
 * which the CRM uses to suppress re-inviting.
 *
 * Always paginates fully (the feed is bounded by LinkedIn's pending-invite cap).
 */
export async function syncSentInvitationsForAccount(accountId: string): Promise<number> {
  const toUpsert: UnipileSentInvitation[] = [];
  const stillPendingPublicIds = new Set<string>();
  const now = new Date().toISOString();

  let cursor: string | undefined;
  let page = 0;
  const MAX_PAGES = 50; // 50 × 100 = 5000 pending invites — well above LinkedIn's limits

  do {
    const result = await linkedInOutreachService.listSentInvitations(accountId, cursor);
    const items: any[] = result?.items ?? [];
    if (items.length === 0) break;

    for (const item of items) {
      // Unipile may return the public id directly, or only a profile/public URL.
      const publicId: string =
        item.invited_user_public_id ||
        item.invited_user_public_identifier ||
        '';
      if (!publicId) continue;

      stillPendingPublicIds.add(publicId);
      toUpsert.push({
        accountId,
        invitedUserPublicId: publicId,
        publicProfileUrl: profileUrlFromPublicId(publicId),
        invitationId: item.id ?? '',
        invitedUserName: item.invited_user ?? '',
        invitationText: item.invitation_text ?? '',
        sentAt: item.parsed_datetime ?? now,
        syncedAt: now,
      });
    }

    cursor = (result as any)?.cursor ?? undefined;
    page++;
  } while (cursor && page < MAX_PAGES);

  await upsertSentInvitations(toUpsert);
  const pruned = await pruneStaleSentInvitations(accountId, stillPendingPublicIds);

  console.log(`${TAG} account=${accountId} pending invitations: ${toUpsert.length} upserted, ${pruned} pruned (pages=${page})`);
  return toUpsert.length;
}

/**
 * For each newly detected connection, find any active sequence with
 * enrollmentTrigger.type='linkedin_connection_accepted', then find leads in
 * that sequence owner's lists whose linkedin URL matches, and enroll them.
 */
export async function enrollNewConnections(newConnections: UnipileConnection[]): Promise<number> {
  if (newConnections.length === 0) return 0;

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

export async function notifyNewConnections(newConnections: UnipileConnection[]): Promise<void> {
  for (const conn of newConnections) {
    try {
      const leads = await crmDb.findLeadsByLinkedin(conn.publicProfileUrl);
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
    const accountIds = await getAllUnipileAccountIds();

    if (accountIds.length === 0) {
      console.log(`${TAG} No accounts to sync`);
      return;
    }

    console.log(`${TAG} Syncing ${accountIds.length} account(s)`);

    const allNewConnections: UnipileConnection[] = [];
    for (const accountId of accountIds) {
      try {
        const newConns = await syncConnectionsForAccount(accountId);
        allNewConnections.push(...newConns);
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
