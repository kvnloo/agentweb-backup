/**
 * backfill-unipile-connections.ts
 *
 * One-off / on-demand FULL sync of a Unipile account's 1st-degree LinkedIn
 * connections into the AW-UnipileConnections cache.
 *
 * Why: the 10-minute linkedInConnectionSyncCron only pulls the 3 newest pages
 * (~150 connections) and early-stops at the latest known timestamp. An account
 * that already had more than ~150 connections when caching began never got its
 * older connections backfilled — so genuinely-connected leads look "not
 * connected" (wrong CRM action shown, message sync skipped, etc.).
 *
 * This paginates through ALL connections (fullSync) and upserts them.
 *
 * Usage:
 *   NODE_ENV=production npx ts-node src/scripts/backfill-unipile-connections.ts <accountId> [<accountId> ...]
 */

import { syncConnectionsForAccount } from '../cron/linkedInConnectionSyncCron';

async function main() {
  const accountIds = process.argv.slice(2);
  if (accountIds.length === 0) {
    console.error('Usage: backfill-unipile-connections.ts <accountId> [<accountId> ...]');
    process.exit(1);
  }

  for (const accountId of accountIds) {
    console.log(`\n=== Full sync for account ${accountId} ===`);
    const before = Date.now();
    const synced = await syncConnectionsForAccount(accountId, { fullSync: true });
    console.log(`Account ${accountId}: upserted ${synced.length} connections in ${Math.round((Date.now() - before) / 1000)}s`);
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
