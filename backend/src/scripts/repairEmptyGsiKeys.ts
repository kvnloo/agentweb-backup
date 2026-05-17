/**
 * One-shot repair that removes empty-string values from the three sparse GSI
 * key attributes on AW-Leads:
 *
 *   email           → EmailLookupIndex HASH key
 *   linkedin        → LinkedinLookupIndex HASH key
 *   nameCompanyKey  → NameCompanyLookupIndex HASH key
 *
 * Background: before the sparse-index guards landed in createLead / updateLead,
 * some code paths (CSV imports, early enrichment writes) stored "" for these
 * attributes. DynamoDB rejects any UpdateItem on a row that carries an empty
 * string for a GSI hash key — even when the update itself doesn't touch that
 * attribute. This blocks all enrichment writes and CRM field updates on the
 * affected leads.
 *
 * The fix is to REMOVE the attribute (not SET to null — DynamoDB would still
 * reject null for a GSI key). Because the GSIs are sparse, removing the
 * attribute simply drops the lead from that index, which is the correct
 * behaviour for a lead with no email / no LinkedIn URL.
 *
 * The script also re-attempts the userId + nameCompanyKey backfill for the
 * repaired leads (the original backfillLeadsUserId run skipped them due to the
 * same DynamoDB rejection).
 *
 * Idempotent: safe to re-run. Leads that already have no empty-string GSI keys
 * are untouched.
 *
 * Usage:
 *   NODE_ENV=production npx ts-node src/scripts/repairEmptyGsiKeys.ts
 *   NODE_ENV=production npx ts-node src/scripts/repairEmptyGsiKeys.ts --dry-run
 */

import { computeNameCompanyKey } from '../utils/leadSchema';

const GSI_KEY_FIELDS = ['email', 'linkedin', 'nameCompanyKey'] as const;
type GsiKeyField = typeof GSI_KEY_FIELDS[number];

async function run(opts: { dryRun: boolean }) {
  const AWS = (await import('aws-sdk')).default;
  const dotenv = (await import('dotenv')).default;
  const path = (await import('path')).default;
  await import('../config/aws');

  dotenv.config({ path: path.resolve(__dirname, '../../.env') });

  const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
  const LEADS_TABLE = `${TABLE_PREFIX}AW-Leads`;
  const LISTS_TABLE = `${TABLE_PREFIX}AW-LeadLists`;

  AWS.config.update({
    region: process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  });

  const db = new AWS.DynamoDB.DocumentClient();

  console.log('[repairEmptyGsiKeys] starting', {
    dryRun: opts.dryRun,
    env: process.env.NODE_ENV,
    leadsTable: LEADS_TABLE,
  });

  // Load listId → userId map so we can backfill userId on repaired leads.
  const listsByListId = new Map<string, string>();
  let lastListKey: any;
  do {
    const r = await db.scan({
      TableName: LISTS_TABLE,
      ExclusiveStartKey: lastListKey,
      ProjectionExpression: 'listId, userId',
    }).promise();
    for (const item of r.Items ?? []) {
      if (item.listId && item.userId) listsByListId.set(String(item.listId), String(item.userId));
    }
    lastListKey = r.LastEvaluatedKey;
  } while (lastListKey);

  console.log(`[repairEmptyGsiKeys] loaded ${listsByListId.size} lists`);

  let scanned = 0;
  let repaired = 0;
  let skippedClean = 0;
  let errored = 0;

  let lastLeadKey: any;
  do {
    const r = await db.scan({
      TableName: LEADS_TABLE,
      ExclusiveStartKey: lastLeadKey,
      ProjectionExpression: 'leadId, listId, userId, email, linkedin, nameCompanyKey, firstName, lastName, company',
    }).promise();

    for (const item of r.Items ?? []) {
      scanned++;

      // Collect fields that need REMOVE.
      const toRemove: GsiKeyField[] = [];
      for (const field of GSI_KEY_FIELDS) {
        if ((item as any)[field] === '') toRemove.push(field);
      }

      if (toRemove.length === 0) {
        skippedClean++;
        continue;
      }

      // Also backfill userId + nameCompanyKey while we have the write open,
      // since the original backfill skipped these leads due to the same error.
      const setExpressions: string[] = [];
      const values: Record<string, any> = {};

      if (!item.userId) {
        const ownerUserId = listsByListId.get(String(item.listId));
        if (ownerUserId) {
          setExpressions.push('userId = if_not_exists(userId, :uid)');
          values[':uid'] = ownerUserId;
        }
      }

      // Recompute nameCompanyKey only if it's not already being removed.
      if (!toRemove.includes('nameCompanyKey') && !item.nameCompanyKey) {
        const nck = computeNameCompanyKey(item.firstName, item.lastName, item.company);
        if (nck) {
          setExpressions.push('nameCompanyKey = if_not_exists(nameCompanyKey, :nck)');
          values[':nck'] = nck;
        }
      }

      const removePart = `REMOVE ${toRemove.join(', ')}`;
      const setPart = setExpressions.length > 0 ? `SET ${setExpressions.join(', ')}` : '';
      const updateExpression = [setPart, removePart].filter(Boolean).join(' ');

      if (opts.dryRun) {
        repaired++;
        if (repaired <= 5) {
          console.log(`[repairEmptyGsiKeys] would fix ${item.listId}/${item.leadId}: REMOVE [${toRemove.join(', ')}]${setPart ? ' + ' + setPart : ''}`);
        }
        continue;
      }

      try {
        await db.update({
          TableName: LEADS_TABLE,
          Key: { listId: item.listId, leadId: item.leadId },
          UpdateExpression: updateExpression,
          ExpressionAttributeValues: Object.keys(values).length > 0 ? values : undefined,
          ConditionExpression: 'attribute_exists(leadId)',
        }).promise();
        repaired++;
      } catch (err) {
        errored++;
        console.warn(
          `[repairEmptyGsiKeys] failed for ${item.listId}/${item.leadId}:`,
          (err as Error).message,
        );
      }
    }

    lastLeadKey = r.LastEvaluatedKey;
  } while (lastLeadKey);

  console.log('[repairEmptyGsiKeys] DONE', {
    scanned,
    repaired,
    skippedClean,
    errored,
    dryRun: opts.dryRun,
  });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  void run({ dryRun });
}
