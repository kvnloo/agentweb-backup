/**
 * cleanup-misattributed-linkedin-messages.ts
 *
 * One-off cleanup for the CRM message-sync bug where LinkedIn message history was
 * synced onto leads who are NOT 1st-degree connections. For a non-connected attendee
 * Unipile resolved to an unrelated chat and dumped hundreds of messages from other
 * conversations onto the lead (e.g. a non-connected lead showing the user's entire
 * multi-year sent history).
 *
 * The code fix (connection gate in POST /sync-linkedin-messages) prevents NEW
 * mis-attribution. This script removes the bad events already persisted.
 *
 * It only deletes live-sync events (eventId prefix `linkedin_msg_`) attributed to a
 * leadEmail that is NOT a connection of the list's LinkedIn account. CSV-imported
 * message events (eventId prefix `linkedin-<listId>-`) are left untouched.
 *
 * Usage:
 *   # Dry run (default) — reports what WOULD be deleted, changes nothing:
 *   NODE_ENV=production npx ts-node src/scripts/cleanup-misattributed-linkedin-messages.ts <listId>
 *
 *   # Apply the deletion:
 *   NODE_ENV=production npx ts-node src/scripts/cleanup-misattributed-linkedin-messages.ts <listId> --apply
 */

import { dynamodb } from '../config/aws';
import { crmDb } from '../services/db';
import { emailEventsDb } from '../services/emailEventsDb';
import { getConnectionByProfileUrlAndAccount } from '../services/unipileConnectionsDb';

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const EVENTS_TABLE = `${TABLE_PREFIX}AW-EmailEvents`;

async function main() {
  const listId = process.argv[2];
  const apply = process.argv.includes('--apply');

  if (!listId) {
    console.error('Usage: cleanup-misattributed-linkedin-messages.ts <listId> [--apply]');
    process.exit(1);
  }

  const list = await crmDb.getLeadListById(listId);
  if (!list) {
    console.error(`Lead list not found: ${listId}`);
    process.exit(1);
  }

  const accountId: string | null = (list as any).linkedInAccountId ?? null;
  if (!accountId) {
    console.error(`List ${listId} has no assigned linkedInAccountId — cannot determine connection status. Aborting.`);
    process.exit(1);
  }

  console.log(`List: ${(list as any).name} (${listId})`);
  console.log(`LinkedIn account: ${accountId}`);
  console.log(`Mode: ${apply ? 'APPLY (will delete)' : 'DRY RUN (no changes)'}`);
  console.log('');

  const events = await emailEventsDb.getEventsByEmailDomain(`linkedin-${listId}`);
  console.log(`Total linkedin events for this list: ${events.length}`);

  // Only consider live-sync events; leave CSV-imported events alone.
  const liveSyncEvents = events.filter((e) => (e.eventId || '').startsWith('linkedin_msg_'));
  console.log(`Live-sync events (linkedin_msg_*): ${liveSyncEvents.length}`);

  // Group by leadEmail (the LinkedIn profile URL the event was attributed to).
  const byLead = new Map<string, typeof liveSyncEvents>();
  for (const e of liveSyncEvents) {
    const key = (e.leadEmail || '').trim().toLowerCase();
    if (!key) continue;
    if (!byLead.has(key)) byLead.set(key, []);
    byLead.get(key)!.push(e);
  }
  console.log(`Distinct lead profile URLs with live-sync events: ${byLead.size}`);
  console.log('');

  const toDelete: string[] = [];
  for (const [profileUrl, evts] of byLead) {
    const connection = await getConnectionByProfileUrlAndAccount(profileUrl, accountId);
    const connected = !!connection;
    console.log(`${connected ? 'KEEP   ' : 'DELETE '} ${evts.length.toString().padStart(4)} events  connected=${connected}  ${profileUrl}`);
    if (!connected) {
      for (const e of evts) toDelete.push(e.eventId);
    }
  }

  console.log('');
  console.log(`Events to delete (non-connected leads): ${toDelete.length}`);

  if (!apply) {
    console.log('\nDry run complete. Re-run with --apply to delete.');
    return;
  }

  // Batch delete in chunks of 25 (DynamoDB batchWrite limit).
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += 25) {
    const batch = toDelete.slice(i, i + 25);
    await dynamodb.batchWrite({
      RequestItems: {
        [EVENTS_TABLE]: batch.map((eventId) => ({ DeleteRequest: { Key: { eventId } } })),
      },
    }).promise();
    deleted += batch.length;
    console.log(`Deleted ${deleted}/${toDelete.length}`);
  }
  console.log(`\nDone. Deleted ${deleted} mis-attributed events.`);
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
