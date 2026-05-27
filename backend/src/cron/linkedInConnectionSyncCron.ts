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
  normalizeLinkedInUrl,
  UnipileConnection,
} from '../services/unipileConnectionsDb';

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

  let cursor: string | undefined;
  let page = 0;
  const MAX_PAGES = opts.fullSync ? 200 : 3; // 3 pages × 50 = 150 connections per 10-min poll

  do {
    const result = await linkedInOutreachService.listConnections(accountId, cursor);
    const items: any[] = result?.items ?? [];

    if (items.length === 0) break;

    const toUpsert: UnipileConnection[] = [];
    let hitOldRecord = false;

    for (const item of items) {
      const connectedAt: number = item.created_at ?? 0;

      // If sorting newest-first and we hit an already-known timestamp, stop paginating
      if (!opts.fullSync && lastKnownAt !== null && connectedAt <= lastKnownAt) {
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

  console.log(`${TAG} account=${accountId} synced ${newConnections.length} new connections (pages=${page})`);
  return newConnections;
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

  // Try to get brand/strategy context for the list owner.
  let brandContext = '';
  const userId = (list as any).userId;
  if (userId) {
    try {
      const { agentModeService } = await import('../services/agentModeService');
      const [brand, strategy] = await Promise.all([
        agentModeService.readBrandGuidelines(userId).catch(() => null),
        agentModeService.readMarketStrategy(userId).catch(() => null),
      ]);
      if (brand?.guidelines) brandContext += `\nBrand voice: ${String(brand.guidelines).slice(0, 300)}`;
      if (strategy?.strategy) brandContext += `\nOffer/market fit: ${String(strategy.strategy).slice(0, 300)}`;
    } catch { /* non-fatal */ }
  }

  const prompt = `A LinkedIn lead just accepted your connection request. Write a short, warm follow-up LinkedIn message to start a conversation.

Lead: ${leadName}${company}${title}${brandContext}

Requirements:
- 1-3 short sentences, max 300 characters
- Friendly and natural, not salesy
- Reference that you just connected
- Open-ended question or soft next step
- No subject line, no signature

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
