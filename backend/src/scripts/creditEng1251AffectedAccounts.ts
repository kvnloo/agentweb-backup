/**
 * ENG-1251: credit back the counter-vs-ledger divergence found on the
 * accounts flagged by the cross-account reconciliation (2026-08-16). Grants
 * an idempotent admin credit for the EXACT delta amount per account -- never
 * a blanket reset. Genuine usage is untouched; only the unexplained "extra"
 * on top of what the ledger can account for is credited back.
 *
 * Default is dry-run; --apply is a production data-plane operation.
 *
 *   NODE_ENV=production npx ts-node --transpile-only src/scripts/creditEng1251AffectedAccounts.ts
 *   NODE_ENV=production npx ts-node --transpile-only src/scripts/creditEng1251AffectedAccounts.ts --apply
 *
 * Reads billingUserId,amountUsd,email rows from --csv (default: the audit
 * output committed alongside this script). Each grant is idempotent
 * (grantId keyed on billingUserId + this issue's id), so re-running is safe.
 */
import fs from 'fs';
import path from 'path';
import AWS from 'aws-sdk';

AWS.config.update({ region: process.env.AWS_REGION || 'us-west-2' });

const apply = process.argv.includes('--apply');
const csvArg = process.argv.find((arg) => arg.startsWith('--csv='));
const csvPath = csvArg
  ? csvArg.slice('--csv='.length)
  : path.join(__dirname, 'eng1251-affected-accounts.csv');

interface Row {
  billingUserId: string;
  amountUsd: number;
  email: string;
}

function readRows(): Row[] {
  const raw = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
  const [header, ...lines] = raw;
  if (header.trim() !== 'billingUserId,amountUsd,email') {
    throw new Error(`Unexpected CSV header: ${header}`);
  }
  return lines.map((line) => {
    const [billingUserId, amountUsdStr, email] = line.split(',');
    return { billingUserId, amountUsd: Number(amountUsdStr), email };
  });
}

async function main() {
  const { userDb } = await import('../services/db');
  const { grantMonthlyLlmUsageCredit } = await import('../services/llmUsageCreditService');

  const rows = readRows();
  const summary = { rows: rows.length, granted: 0, idempotent: 0, skipped: 0, totalAppliedUsd: 0 };

  for (const row of rows) {
    if (!row.billingUserId || !Number.isFinite(row.amountUsd) || row.amountUsd <= 0) {
      console.error(`[skip] malformed row: ${JSON.stringify(row)}`);
      summary.skipped++;
      continue;
    }

    const target = await userDb.getUserById(row.billingUserId);
    if (!target || String(target.userId).startsWith('deleted_')) {
      console.log(`[skip] ${row.billingUserId} (${row.email}) -- no longer a live account`);
      summary.skipped++;
      continue;
    }

    // Whole-cent, per admin-grant source's requirement.
    const amountMicroUsd = Math.round(row.amountUsd * 100) * 10_000;
    const grantId = `eng1251-reconciliation:${row.billingUserId}`;

    console.log(
      `${apply ? '[apply]' : '[dry-run]'} ${row.billingUserId} (${row.email}) credit=$${row.amountUsd.toFixed(2)}`
    );
    if (!apply) continue;

    const result = await grantMonthlyLlmUsageCredit({
      billingUserId: row.billingUserId,
      grantId,
      source: 'admin',
      amountMicroUsd,
      reason:
        'ENG-1251: cross-account reconciliation -- counter exceeded the independent usage ledger by this amount ' +
        '(same shape as the confirmed founders@ incident); credited back rather than charging the customer for ' +
        'our own duplicate-charge bug.',
      grantedBy: 'ENG-1251-reconciliation-script',
    });
    if (result.granted) summary.granted++;
    else summary.idempotent++;
    summary.totalAppliedUsd += row.amountUsd;
  }

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', summary }, null, 2));
}

main().catch((error) => {
  console.error('[creditEng1251AffectedAccounts] failed', error);
  process.exit(1);
});
