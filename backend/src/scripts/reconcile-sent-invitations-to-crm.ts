/**
 * reconcile-sent-invitations-to-crm.ts
 *
 * One-way sync / backfill (ENG-787): import an account's PENDING LinkedIn
 * sent-invitations into a CRM lead list. For every outstanding invite on the
 * account, the invitee is reconciled into the target list — created as a lead if
 * absent, marked 'contacted', and logged with a linkedin.invite.sent engagement —
 * so the CRM stops under-reporting true contact volume and follow-up cadence can
 * fire for the backlog.
 *
 * This is the reconciliation the issue asked for (suggested fix (c)). It also
 * backstops invites the outreach agent sent WITHOUT a list_id: re-running it for
 * the account + its list reconciles anything the per-send mirror missed.
 *
 * The account→list mapping has no stored binding, so YOU supply it explicitly.
 *
 * ⚠️ RUN `normalize-lead-linkedin-urls.ts <listId>` FIRST. Invitees are matched to
 * existing leads by canonical LinkedIn URL through an exact-match GSI. Leads added
 * before ENG-787 were stored with the URL the user pasted (mixed case, no `www.`,
 * trailing slash), so they will NOT match and this job would create a duplicate lead
 * for someone the list already has.
 *
 * ⚠️ DATA-PLANE: this performs BULK CRM writes (create/update leads + engagement)
 * into a customer's list. Confirm the account↔list mapping and get data-plane
 * sign-off before running against production.
 *
 * Usage:
 *   NODE_ENV=production npx ts-node src/scripts/reconcile-sent-invitations-to-crm.ts \
 *     <accountId> <listId> [<userId>] [--dry-run]
 *
 *   --dry-run   Read the live feed + resolve each lead but WRITE NOTHING; prints the
 *               created/updated/skipped counts. ALWAYS dry-run first to validate.
 *
 * Example (ENG-787 reporter) — validate, then commit:
 *   NODE_ENV=production npx ts-node src/scripts/reconcile-sent-invitations-to-crm.ts \
 *     tMgX8uZJTZWTG_mFY1aI2A list_1782945941846_b0ptvsguv 3da53332-0d6b-421d-97a0-3101459aa606 --dry-run
 */

import { reconcileSentInvitationsToCrm } from '../services/linkedInInviteCrmMirror';

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const [accountId, listId, userId] = argv.filter((a) => a !== '--dry-run');
  if (!accountId || !listId) {
    console.error(
      'Usage: reconcile-sent-invitations-to-crm.ts <accountId> <listId> [<userId>] [--dry-run]',
    );
    process.exit(1);
  }

  console.log(`=== Reconcile pending invitations → CRM ${dryRun ? '(DRY-RUN, no writes)' : ''}===`);
  console.log(`account=${accountId} list=${listId} user=${userId ?? '(none)'}`);
  const before = Date.now();
  const result = await reconcileSentInvitationsToCrm({ accountId, listId, userId, dryRun });
  console.log(
    `Done in ${Math.round((Date.now() - before) / 1000)}s — ` +
      `total=${result.total} created=${result.created} updated=${result.updated} ` +
      `(alreadyRecorded=${result.alreadyRecorded}) skipped=${result.skipped}`,
  );
}

main().catch((err) => {
  console.error('Reconciliation failed:', err);
  process.exit(1);
});
