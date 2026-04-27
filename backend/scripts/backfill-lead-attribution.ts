/**
 * Backfill `firstTouch`, `lastTouch`, `utmSource`, `utmMedium` on AW-Leads
 * rows by copying from the matching AW-Users row when a lead's email equals
 * a user's email.
 *
 * Why: UTM attribution was shipped in PR #541 on Users only. Leads created
 * before this task had zero attribution. For every lead whose email matches
 * a User row (signed-up trial / paying customer who is also in a list),
 * copy the attribution over so the CRM dashboard "Source" column is
 * populated for historic leads without waiting for a repeat touch.
 *
 * Idempotent: re-running skips leads that already have any attribution.
 * Pass `--force` to overwrite lastTouch / utmSource / utmMedium (firstTouch
 * still never gets overwritten — earliest wins by contract).
 *
 * Usage:
 *   npx ts-node backend/scripts/backfill-lead-attribution.ts                 # dry-run
 *   npx ts-node backend/scripts/backfill-lead-attribution.ts --apply         # actually write
 *   npx ts-node backend/scripts/backfill-lead-attribution.ts --list=<listId> # scope to one list
 *   npx ts-node backend/scripts/backfill-lead-attribution.ts --concurrency=10
 *   npx ts-node backend/scripts/backfill-lead-attribution.ts --force         # overwrite
 *
 * Env:
 *   NODE_ENV=development  -> targets Dev-AW-* tables (safe)
 *   NODE_ENV=production   -> targets AW-* tables (USE WITH CARE)
 *
 * Task: https://www.notion.so/34709247c951813f8874eeee9e4d2cbe
 */

/* eslint-disable no-console */

import AWS from 'aws-sdk';
import {
  BackfillAttributionLead,
  BackfillAttributionUser,
  deriveAttributionFromUser,
  buildAttributionUpdateExpression,
} from '../src/utils/crmBackfillAttribution';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const FORCE = argv.includes('--force');
const LIST_FILTER = argv.find(a => a.startsWith('--list='))?.split('=')[1] ?? null;
const CONCURRENCY = Math.max(
  1,
  Math.min(50, parseInt(argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] ?? '10', 10) || 10)
);

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const LEAD_LISTS_TABLE = `${TABLE_PREFIX}AW-LeadLists`;
const LEADS_TABLE = `${TABLE_PREFIX}AW-Leads`;
const USERS_TABLE = `${TABLE_PREFIX}AW-Users`;

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-west-2',
});

interface LeadListRow {
  listId: string;
  userId: string;
  name?: string;
}

interface Stats {
  leadsScanned: number;
  leadsSkippedAlreadyPopulated: number;
  leadsSkippedNoEmail: number;
  leadsSkippedNoUserMatch: number;
  leadsSkippedNoUserAttribution: number;
  leadsUpdated: number;
  errors: number;
}

async function scanAllLeadLists(): Promise<LeadListRow[]> {
  const out: LeadListRow[] = [];
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  do {
    const res = await dynamodb
      .scan({ TableName: LEAD_LISTS_TABLE, ExclusiveStartKey: lastKey })
      .promise();
    out.push(...((res.Items || []) as LeadListRow[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

async function queryListLeads(listId: string): Promise<BackfillAttributionLead[]> {
  const out: BackfillAttributionLead[] = [];
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  do {
    const res = await dynamodb
      .query({
        TableName: LEADS_TABLE,
        KeyConditionExpression: 'listId = :lid',
        ExpressionAttributeValues: { ':lid': listId },
        ExclusiveStartKey: lastKey,
      })
      .promise();
    out.push(...((res.Items || []) as BackfillAttributionLead[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

/**
 * Look up a user row by email via the EmailIndex GSI. Returns null when no
 * match — most leads are prospect-only with no AW-Users row.
 */
async function getUserByEmail(email: string): Promise<BackfillAttributionUser | null> {
  const normalised = email.trim().toLowerCase();
  if (!normalised) return null;
  try {
    const res = await dynamodb
      .query({
        TableName: USERS_TABLE,
        IndexName: 'EmailIndex',
        KeyConditionExpression: 'email = :e',
        ExpressionAttributeValues: { ':e': normalised },
        Limit: 1,
      })
      .promise();
    const item = (res.Items || [])[0] as BackfillAttributionUser | undefined;
    if (!item) return null;
    if (typeof item.userId === 'string' && item.userId.startsWith('deleted_')) return null;
    return item;
  } catch (err: any) {
    if (err?.code === 'ValidationException' || err?.name === 'ValidationException') {
      return null;
    }
    throw err;
  }
}

async function processLead(
  lead: BackfillAttributionLead,
  stats: Stats,
  dryRun: boolean
): Promise<void> {
  stats.leadsScanned += 1;

  if (!lead.email || typeof lead.email !== 'string' || !lead.email.trim()) {
    stats.leadsSkippedNoEmail += 1;
    return;
  }

  if (!FORCE && (lead.firstTouch || lead.lastTouch || lead.utmSource || lead.utmMedium)) {
    stats.leadsSkippedAlreadyPopulated += 1;
    return;
  }

  let user: BackfillAttributionUser | null;
  try {
    user = await getUserByEmail(lead.email);
  } catch (err) {
    stats.errors += 1;
    console.error(`  [err] getUserByEmail failed for ${lead.email}:`, err);
    return;
  }

  if (!user) {
    stats.leadsSkippedNoUserMatch += 1;
    return;
  }

  const update = deriveAttributionFromUser(lead, user, { force: FORCE });
  if (!update) {
    stats.leadsSkippedNoUserAttribution += 1;
    return;
  }

  const expr = buildAttributionUpdateExpression(update);
  if (!expr) {
    stats.leadsSkippedNoUserAttribution += 1;
    return;
  }

  if (dryRun) {
    stats.leadsUpdated += 1;
    console.log(
      `  [dry-run] lead=${lead.leadId} email=${lead.email} -> ${JSON.stringify(update)}`
    );
    return;
  }

  try {
    await dynamodb
      .update({
        TableName: LEADS_TABLE,
        Key: { listId: lead.listId, leadId: lead.leadId },
        UpdateExpression: expr.UpdateExpression,
        ExpressionAttributeNames: expr.ExpressionAttributeNames,
        ExpressionAttributeValues: expr.ExpressionAttributeValues,
      })
      .promise();
    stats.leadsUpdated += 1;
  } catch (err) {
    stats.errors += 1;
    console.error(`  [err] update failed for lead ${lead.leadId}:`, err);
  }
}

async function processList(
  list: LeadListRow,
  stats: Stats,
  dryRun: boolean
): Promise<void> {
  const leads = await queryListLeads(list.listId);
  if (leads.length === 0) return;
  console.log(`\nList ${list.listId} (${list.name ?? 'unnamed'}) — ${leads.length} leads`);

  // Simple fixed-size worker pool for the lead fan-out — same pattern as
  // backfill-crm-scores.ts. Keeps DynamoDB RCU usage bounded.
  const queue = [...leads];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const lead = queue.shift();
          if (!lead) break;
          await processLead(lead, stats, dryRun);
        }
      })()
    );
  }
  await Promise.all(workers);
}

async function main() {
  const dryRun = !APPLY;
  console.log('Backfill Lead attribution');
  console.log(`  env              = ${process.env.NODE_ENV || 'unset'}`);
  console.log(`  table prefix     = "${TABLE_PREFIX}"`);
  console.log(`  mode             = ${dryRun ? 'DRY-RUN (no writes)' : 'APPLY (writes live)'}`);
  console.log(`  force            = ${FORCE}`);
  console.log(`  list filter      = ${LIST_FILTER ?? '(all lists)'}`);
  console.log(`  concurrency      = ${CONCURRENCY}`);
  console.log('');

  const stats: Stats = {
    leadsScanned: 0,
    leadsSkippedAlreadyPopulated: 0,
    leadsSkippedNoEmail: 0,
    leadsSkippedNoUserMatch: 0,
    leadsSkippedNoUserAttribution: 0,
    leadsUpdated: 0,
    errors: 0,
  };

  const lists = LIST_FILTER
    ? [{ listId: LIST_FILTER, userId: '(unknown)', name: '(filtered)' }]
    : await scanAllLeadLists();

  console.log(`Found ${lists.length} lead list(s).`);
  for (const list of lists) {
    await processList(list, stats, dryRun);
  }

  console.log('\n--- Summary ---');
  console.log(`  Leads scanned                  : ${stats.leadsScanned}`);
  console.log(`  Skipped (already populated)    : ${stats.leadsSkippedAlreadyPopulated}`);
  console.log(`  Skipped (no email)             : ${stats.leadsSkippedNoEmail}`);
  console.log(`  Skipped (no user match)        : ${stats.leadsSkippedNoUserMatch}`);
  console.log(`  Skipped (user has no attrib)   : ${stats.leadsSkippedNoUserAttribution}`);
  console.log(`  Leads ${dryRun ? 'would be updated' : 'updated             '} : ${stats.leadsUpdated}`);
  console.log(`  Errors                         : ${stats.errors}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
