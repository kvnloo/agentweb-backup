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

import { linkedInOutreachService } from '../services/linkedInOutreachService';
import { settingsService } from '../services/settingsService';
import { dripSequenceDb } from '../services/dripSequenceDb';
import { crmDb } from '../services/db';
import {
  upsertConnections,
  getLatestConnectedAt,
  normalizeLinkedInUrl,
  UnipileConnection,
} from '../services/unipileConnectionsDb';

const TAG = '[linkedInConnectionSync]';

/** Returns all Unipile account IDs to sync from site-wide settings. */
async function getAllUnipileAccountIds(): Promise<string[]> {
  const ids = new Set<string>();
  try {
    const setting = await settingsService.getSetting('site-wide-unipile-accounts');
    if (setting?.settingValue) {
      const siteAccounts = JSON.parse(setting.settingValue) as any[];
      for (const a of siteAccounts) {
        if (a.enabled !== false && a.account_id) ids.add(a.account_id);
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
async function enrollNewConnections(newConnections: UnipileConnection[]): Promise<number> {
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
          // Scan leads in this list for a matching LinkedIn URL
          let lastKey: any = null;
          do {
            const page = await crmDb.getLeadsByListId(list.listId, 200, lastKey);
            const items: any[] = (page as any).items ?? [];
            lastKey = (page as any).lastEvaluatedKey ?? null;

            for (const lead of items) {
              if (!lead.linkedin) continue;
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

    // Auto-enroll leads whose LinkedIn connection was just detected
    if (allNewConnections.length > 0) {
      const enrolled = await enrollNewConnections(allNewConnections);
      if (enrolled > 0) {
        console.log(`${TAG} Auto-enrolled ${enrolled} lead(s) from new connections`);
      }
    }
  } finally {
    isRunning = false;
  }
}
