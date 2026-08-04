/**
 * normalize-lead-linkedin-urls.ts
 *
 * One-time data repair (ENG-787): rewrite every lead's `linkedin` field in a list
 * to its canonical form.
 *
 * WHY: `batchCreateLeads` (CSV import) has always normalized the URL, but
 * `createLead` / `updateLead` stored it trim-only until ENG-787. Leads added one at
 * a time — through the CRM UI or the API — therefore sit in `LinkedinLookupIndex`
 * under whatever the user pasted: mixed case, `http://`, no `www.`, a trailing
 * slash, tracking query params. The index is an EXACT-match GSI, so a canonical
 * lookup misses those rows entirely.
 *
 * CONSEQUENCE if this is not run first: `reconcile-sent-invitations-to-crm.ts`
 * looks each invitee up by canonical URL, misses the un-canonical row that already
 * represents that person, and CREATES A DUPLICATE LEAD — the exact opposite of what
 * the reconciliation is for. RUN THIS FIRST, then the reconciliation.
 *
 * Two cases are reported but never written, because both need a human decision:
 *   • unsupported — the value is not a personal /in/ profile (a company page, a
 *     search URL, free text). Writing the normalized (empty) value would DELETE the
 *     field, so the row is left exactly as-is.
 *   • collisions — two leads in the same list canonicalize to the SAME URL, i.e.
 *     they are duplicates of one person. Normalizing surfaces the duplicate rather
 *     than hiding it; merging them is a CRM decision, not this script's.
 *
 * ⚠️ DATA-PLANE: this is a bulk mutation of a customer's leads and it rewrites a
 * GSI key. Get data-plane sign-off, and ALWAYS --dry-run first.
 *
 * Usage:
 *   NODE_ENV=production npx ts-node src/scripts/normalize-lead-linkedin-urls.ts \
 *     <listId> [--dry-run]
 *
 * Example (ENG-787 reporter) — validate, then commit, then reconcile:
 *   ... normalize-lead-linkedin-urls.ts list_1782945941846_b0ptvsguv --dry-run
 *   ... normalize-lead-linkedin-urls.ts list_1782945941846_b0ptvsguv
 *   ... reconcile-sent-invitations-to-crm.ts tMgX8uZJTZWTG_mFY1aI2A list_1782945941846_b0ptvsguv <userId> --dry-run
 */

import { crmDb } from '../services/db';
import { normalizeListLinkedinUrls } from '../services/leadLinkedinCanonicalizer';

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const [listId] = argv.filter((a) => a !== '--dry-run');
  if (!listId) {
    console.error('Usage: normalize-lead-linkedin-urls.ts <listId> [--dry-run]');
    process.exit(1);
  }

  const list = await crmDb.getLeadListById(listId);
  if (!list) {
    console.error(`Lead list ${listId} not found`);
    process.exit(1);
  }

  console.log(`=== Normalize lead LinkedIn URLs ${dryRun ? '(DRY-RUN, no writes) ' : ''}===`);
  console.log(`list=${listId} name=${JSON.stringify((list as any).name ?? '')}`);
  const before = Date.now();
  const result = await normalizeListLinkedinUrls(listId, { dryRun });
  console.log(
    `Done in ${Math.round((Date.now() - before) / 1000)}s — ` +
      `total=${result.total} withLinkedin=${result.withLinkedin} ` +
      `alreadyCanonical=${result.alreadyCanonical} normalized=${result.normalized} ` +
      `unsupported=${result.unsupported} collisions=${result.collisions}`,
  );
  if (result.collisions > 0) {
    console.warn(`\u26a0\ufe0f  ${result.collisions} canonical URL(s) map to more than one lead — merge them before reconciling.`);
  }
}

main().catch((err) => {
  console.error('Normalization failed:', err);
  process.exit(1);
});
