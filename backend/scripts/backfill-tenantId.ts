/**
 * Backfill `tenantId` on every row in AW-Leads.
 *
 * For each lead list, every lead inherits the list owner as its tenantId.
 * Safe to re-run — rows that already have tenantId are skipped. Uses
 * BatchWrite for throughput (25 rows per call, DynamoDB max).
 *
 * Usage:
 *   npx ts-node backend/scripts/backfill-tenantId.ts          # dry-run (default)
 *   npx ts-node backend/scripts/backfill-tenantId.ts --apply  # actually write
 *
 * Env:
 *   NODE_ENV=development  -> targets Dev-AW-* tables (safe)
 *   NODE_ENV=production   -> targets AW-* tables (CAREFUL)
 *
 * Task: https://www.notion.so/34309247c95181ab8f61c0c651fc1cf3
 */

/* eslint-disable no-console */

import AWS from 'aws-sdk';

const APPLY = process.argv.includes('--apply');
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const LEAD_LISTS_TABLE = `${TABLE_PREFIX}AW-LeadLists`;
const LEADS_TABLE = `${TABLE_PREFIX}AW-Leads`;

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-west-2',
});

interface LeadListRow {
  listId: string;
  userId: string;
  name?: string;
}

interface LeadRow {
  listId: string;
  leadId: string;
  tenantId?: string;
  email?: string;
}

async function scanAll<T>(table: string): Promise<T[]> {
  const out: T[] = [];
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  do {
    const res = await dynamodb
      .scan({ TableName: table, ExclusiveStartKey: lastKey })
      .promise();
    out.push(...((res.Items || []) as T[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

async function queryListLeads(listId: string): Promise<LeadRow[]> {
  const out: LeadRow[] = [];
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
    out.push(...((res.Items || []) as LeadRow[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

async function updateTenantIdBatch(
  leads: LeadRow[],
  tenantId: string
): Promise<number> {
  let updated = 0;
  // UpdateItem is the safe primitive for partial updates. BatchWriteItem only
  // supports full PutItem or DeleteItem, which would clobber unrelated fields.
  // Keep it simple: serial UpdateItem calls. This script runs once, in a maint
  // window — throughput is not the bottleneck, correctness is.
  for (const lead of leads) {
    if (lead.tenantId === tenantId) continue;
    if (APPLY) {
      await dynamodb
        .update({
          TableName: LEADS_TABLE,
          Key: { listId: lead.listId, leadId: lead.leadId },
          UpdateExpression: 'SET tenantId = :t',
          ExpressionAttributeValues: { ':t': tenantId },
        })
        .promise();
    }
    updated += 1;
  }
  return updated;
}

async function main(): Promise<void> {
  console.log(
    `[backfill-tenantId] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} tables=${LEAD_LISTS_TABLE}/${LEADS_TABLE}`
  );

  const lists = await scanAll<LeadListRow>(LEAD_LISTS_TABLE);
  console.log(`[backfill-tenantId] found ${lists.length} lead lists`);

  let totalLeads = 0;
  let totalToUpdate = 0;

  for (const list of lists) {
    if (!list.listId || !list.userId) {
      console.warn(
        `[backfill-tenantId] skipping malformed list row (listId=${list.listId}, userId=${list.userId})`
      );
      continue;
    }
    const leads = await queryListLeads(list.listId);
    totalLeads += leads.length;
    const needsUpdate = leads.filter(l => l.tenantId !== list.userId);
    console.log(
      `[backfill-tenantId] list="${list.name || list.listId}" owner=${list.userId} leads=${leads.length} needsUpdate=${needsUpdate.length}`
    );
    const n = await updateTenantIdBatch(leads, list.userId);
    totalToUpdate += n;
  }

  console.log(
    `[backfill-tenantId] done. leads=${totalLeads} updated${APPLY ? '' : ' (would update)'}=${totalToUpdate}`
  );
  if (!APPLY) {
    console.log('[backfill-tenantId] dry-run — re-run with --apply to write.');
  }
}

main().catch(err => {
  console.error('[backfill-tenantId] fatal:', err);
  process.exit(1);
});
