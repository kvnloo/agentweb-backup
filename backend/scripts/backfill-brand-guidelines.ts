/**
 * DRY-RUN by default. Harsha approval is required before merge and before --apply.
 * From backend: NODE_ENV=production npx ts-node --transpile-only scripts/backfill-brand-guidelines.ts
 * Add --apply only after approval. NODE_ENV=development selects Dev-* tables.
 * Lists every user account with any empty core field, including accounts with
 * no derivable values. Does not read arbitrary KB prose or invent missing copy.
 * Re-read/conditional writes preserve concurrent edits, founders and attachments.
 */
import 'dotenv/config';
import { runBrandGuidelinesBackfill } from '../src/services/brandGuidelinesBackfill';

if (require.main === module) {
  runBrandGuidelinesBackfill(process.argv.slice(2)).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
