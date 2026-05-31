/**
 * backfill-unipile-sent-invitations.ts
 *
 * One-off / on-demand sync of an account's PENDING LinkedIn sent-invitations into
 * the AW-UnipileSentInvitations cache. Lets the CRM immediately show "Invitation
 * pending" (and suppress re-inviting) for accounts whose invitations were sent
 * before this feature shipped, or sent directly on LinkedIn (outside the CRM).
 *
 * Reconciles fully: upserts all still-pending invites and prunes any cached rows
 * that are no longer pending.
 *
 * Usage:
 *   NODE_ENV=production npx ts-node src/scripts/backfill-unipile-sent-invitations.ts <accountId> [<accountId> ...]
 */

import { syncSentInvitationsForAccount } from '../cron/linkedInConnectionSyncCron';

async function main() {
  const accountIds = process.argv.slice(2);
  if (accountIds.length === 0) {
    console.error('Usage: backfill-unipile-sent-invitations.ts <accountId> [<accountId> ...]');
    process.exit(1);
  }

  for (const accountId of accountIds) {
    console.log(`\n=== Sync sent invitations for account ${accountId} ===`);
    const before = Date.now();
    const count = await syncSentInvitationsForAccount(accountId);
    console.log(`Account ${accountId}: ${count} pending invitations cached in ${Math.round((Date.now() - before) / 1000)}s`);
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
