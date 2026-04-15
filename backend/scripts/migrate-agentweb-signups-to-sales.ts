/**
 * One-shot migration: flip the existing "AgentWeb Signups" list (owned by
 * founders@) from listType='customers' to listType='sales'.
 *
 * Why: the customer-type list is hidden in a secondary section of the CRM UI.
 * Making it a sales-type list surfaces it on the main CRM page where Harsha
 * expects to see new signups, and the Inbox tab dedup (which excludes
 * customer-type lists) picks it up.
 *
 * Usage:
 *   npx ts-node backend/scripts/migrate-agentweb-signups-to-sales.ts          # dry-run (default)
 *   npx ts-node backend/scripts/migrate-agentweb-signups-to-sales.ts --apply  # actually write
 *
 * Env:
 *   NODE_ENV=development  -> targets Dev-AW-LeadLists (safe)
 *   NODE_ENV=production   -> targets AW-LeadLists (CAREFUL)
 *
 * Safety:
 *   - Idempotent: if the list is already listType='sales', logs and exits.
 *   - Only touches the one list matching (userId=founders@, name="AgentWeb Signups").
 *   - Falls back to the known listId `list_1776228153073_bxl7xxkxr` if the
 *     name lookup somehow fails.
 */

/* eslint-disable no-console */

import AWS from 'aws-sdk';

const APPLY = process.argv.includes('--apply');
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const LEAD_LISTS_TABLE = `${TABLE_PREFIX}AW-LeadLists`;

const FOUNDERS_USERID = 'be754b6c-767e-44ec-b181-4042cfe45ea9';
const LIST_NAME = 'AgentWeb Signups';
const FALLBACK_LIST_ID = 'list_1776228153073_bxl7xxkxr';

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-west-2',
});

async function findSignupsList(): Promise<any | null> {
  // Try GSI query first (userId-index), fall back to scan.
  try {
    const result = await dynamodb
      .query({
        TableName: LEAD_LISTS_TABLE,
        IndexName: 'userId-index',
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': FOUNDERS_USERID },
      })
      .promise();
    const match = (result.Items || []).find((l: any) => l && l.name === LIST_NAME);
    if (match) return match;
  } catch (err: any) {
    console.warn(`[migrate] userId-index query failed (${err?.code || err?.message}); falling back to scan`);
  }

  const scan = await dynamodb
    .scan({
      TableName: LEAD_LISTS_TABLE,
      FilterExpression: 'userId = :u AND #n = :n',
      ExpressionAttributeNames: { '#n': 'name' },
      ExpressionAttributeValues: { ':u': FOUNDERS_USERID, ':n': LIST_NAME },
    })
    .promise();
  if (scan.Items && scan.Items[0]) return scan.Items[0];

  // Last-resort: direct get by known listId
  const direct = await dynamodb
    .get({ TableName: LEAD_LISTS_TABLE, Key: { listId: FALLBACK_LIST_ID } })
    .promise();
  return direct.Item || null;
}

async function main() {
  console.log(`[migrate] table=${LEAD_LISTS_TABLE} apply=${APPLY}`);

  const list = await findSignupsList();
  if (!list) {
    console.error(`[migrate] could not find "${LIST_NAME}" list for founders@. Nothing to do.`);
    process.exit(1);
  }

  console.log(`[migrate] found list:`);
  console.log(`  listId       = ${list.listId}`);
  console.log(`  name         = ${list.name}`);
  console.log(`  userId       = ${list.userId}`);
  console.log(`  listType     = ${list.listType ?? '(unset)'}`);
  console.log(`  leadCount    = ${list.leadCount}`);

  if (list.listType === 'sales') {
    console.log(`[migrate] list is already listType='sales' — nothing to do.`);
    return;
  }

  if (!APPLY) {
    console.log(`\n[migrate] DRY-RUN: would set listType='sales' on listId=${list.listId}`);
    console.log(`[migrate] re-run with --apply to execute.`);
    return;
  }

  const before = list.listType ?? '(unset)';
  await dynamodb
    .update({
      TableName: LEAD_LISTS_TABLE,
      Key: { listId: list.listId },
      UpdateExpression: 'SET listType = :t, updatedAt = :now',
      ExpressionAttributeValues: {
        ':t': 'sales',
        ':now': new Date().toISOString(),
      },
    })
    .promise();

  console.log(`[migrate] APPLIED: listType ${before} -> 'sales' on listId=${list.listId}`);

  // Read back to confirm
  const after = await dynamodb
    .get({ TableName: LEAD_LISTS_TABLE, Key: { listId: list.listId } })
    .promise();
  console.log(`[migrate] confirmed: listType=${(after.Item as any)?.listType}`);
}

main().catch((err) => {
  console.error(`[migrate] FAILED:`, err);
  process.exit(1);
});
