/**
 * Backfill `customFields.utm_*` on founders@ "AgentWeb Signups" list leads.
 *
 * Before the signupAutoEnrollService attribution fix (PR #1255, 2026-04-21),
 * leads enrolled into the founders@ "AgentWeb Signups" list were created
 * with an empty customFields — attribution was silently dropped even though
 * the source user row had `firstTouch` populated correctly.
 *
 * This script fixes that retroactively. For every lead in the Signups list
 * whose customFields has no `utm_source`:
 *   1. Look up the user in AW-Users by email.
 *   2. Read `firstTouch` (the attribution blob captured at signup).
 *   3. Flatten to `customFields.utm_source / utm_medium / utm_campaign /
 *      utm_content / utm_term / gclid / fbclid / ttclid / li_fat_id /
 *      referrer / landing_url / ref` — same shape signupAutoEnrollService now
 *      writes for new signups.
 *   4. Update the lead row.
 *
 * Safe to re-run — rows that already have `customFields.utm_source` are
 * skipped. Users who signed up BEFORE attribution capture landed (no
 * `firstTouch` on the user) stay empty — we can't recover data that was
 * never captured.
 *
 * Usage:
 *   npx ts-node backend/scripts/backfill-signups-attribution.ts          # dry-run (default)
 *   npx ts-node backend/scripts/backfill-signups-attribution.ts --apply  # actually write
 *
 * Env:
 *   NODE_ENV=development  -> targets Dev-AW-* tables (safe, test env)
 *   NODE_ENV=production   -> targets AW-* tables (CAREFUL, prod)
 *
 * Task: https://www.notion.so/34909247c951817890a7d1fe2752c3be
 */

/* eslint-disable no-console */

import AWS from 'aws-sdk';

const APPLY = process.argv.includes('--apply');
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const LEAD_LISTS_TABLE = `${TABLE_PREFIX}AW-LeadLists`;
const LEADS_TABLE = `${TABLE_PREFIX}AW-Leads`;
const USERS_TABLE = `${TABLE_PREFIX}AW-Users`;

const FOUNDERS_USERID = 'be754b6c-767e-44ec-b181-4042cfe45ea9';
const SIGNUPS_LIST_NAME = 'AgentWeb Signups';

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-west-2',
});

interface AttributionTouch {
  utm?: { source?: string; medium?: string; campaign?: string; content?: string; term?: string };
  clickIds?: { gclid?: string; fbclid?: string; ttclid?: string; liFatId?: string };
  referrer?: string;
  landingUrl?: string;
  ref?: string;
}

interface LeadRow {
  listId: string;
  leadId: string;
  email?: string;
  customFields?: Record<string, unknown>;
}

interface UserRow {
  userId: string;
  email: string;
  firstTouch?: AttributionTouch;
}

function flattenAttribution(touch?: AttributionTouch): Record<string, string> {
  if (!touch) return {};
  const cf: Record<string, string> = {};
  if (touch.utm?.source) cf.utm_source = touch.utm.source;
  if (touch.utm?.medium) cf.utm_medium = touch.utm.medium;
  if (touch.utm?.campaign) cf.utm_campaign = touch.utm.campaign;
  if (touch.utm?.content) cf.utm_content = touch.utm.content;
  if (touch.utm?.term) cf.utm_term = touch.utm.term;
  if (touch.clickIds?.gclid) cf.gclid = touch.clickIds.gclid;
  if (touch.clickIds?.fbclid) cf.fbclid = touch.clickIds.fbclid;
  if (touch.clickIds?.ttclid) cf.ttclid = touch.clickIds.ttclid;
  if (touch.clickIds?.liFatId) cf.li_fat_id = touch.clickIds.liFatId;
  if (touch.referrer) cf.referrer = touch.referrer;
  if (touch.landingUrl) cf.landing_url = touch.landingUrl;
  if (touch.ref) cf.ref = touch.ref;
  return cf;
}

async function findSignupsList(): Promise<string> {
  // AW-LeadLists PK is listId — we scan + filter. List count is low (<200)
  // so a one-shot scan is fine for this script.
  const lists: Array<{ listId: string; userId?: string; name?: string }> = [];
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  do {
    const res = await dynamodb
      .scan({
        TableName: LEAD_LISTS_TABLE,
        FilterExpression: 'userId = :u AND #n = :name',
        ExpressionAttributeNames: { '#n': 'name' },
        ExpressionAttributeValues: { ':u': FOUNDERS_USERID, ':name': SIGNUPS_LIST_NAME },
        ExclusiveStartKey: lastKey,
      })
      .promise();
    lists.push(...((res.Items || []) as typeof lists));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  if (lists.length === 0) {
    throw new Error(
      `Could not find "${SIGNUPS_LIST_NAME}" list for founders@ (userId=${FOUNDERS_USERID}).`
    );
  }
  return lists[0].listId;
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

async function getUserByEmail(email: string): Promise<UserRow | null> {
  const res = await dynamodb
    .query({
      TableName: USERS_TABLE,
      IndexName: 'EmailIndex',
      KeyConditionExpression: 'email = :e',
      ExpressionAttributeValues: { ':e': email.toLowerCase() },
      Limit: 1,
    })
    .promise();
  const items = (res.Items || []) as UserRow[];
  return items.length > 0 ? items[0] : null;
}

async function updateLeadCustomFields(
  listId: string,
  leadId: string,
  customFields: Record<string, string>
): Promise<void> {
  await dynamodb
    .update({
      TableName: LEADS_TABLE,
      Key: { listId, leadId },
      UpdateExpression: 'SET customFields = :cf, updatedAt = :now',
      ExpressionAttributeValues: {
        ':cf': customFields,
        ':now': new Date().toISOString(),
      },
    })
    .promise();
}

async function main() {
  console.log(`[backfill-signups-attribution] start (mode=${APPLY ? 'APPLY' : 'DRY-RUN'})`);
  console.log(`[backfill-signups-attribution] tables: leads=${LEADS_TABLE} users=${USERS_TABLE}`);

  const listId = await findSignupsList();
  console.log(`[backfill-signups-attribution] found Signups list: ${listId}`);

  const leads = await queryListLeads(listId);
  console.log(`[backfill-signups-attribution] ${leads.length} leads in list`);

  let alreadyPopulated = 0;
  let noEmail = 0;
  let noUserRow = 0;
  let noFirstTouch = 0;
  let firstTouchButEmpty = 0;
  let wouldUpdate = 0;
  let updated = 0;

  for (const lead of leads) {
    const cf = (lead.customFields || {}) as Record<string, unknown>;
    if (typeof cf.utm_source === 'string' && cf.utm_source.trim()) {
      alreadyPopulated++;
      continue;
    }
    if (!lead.email) {
      noEmail++;
      continue;
    }

    const user = await getUserByEmail(lead.email);
    if (!user) {
      noUserRow++;
      continue;
    }

    const touch = user.firstTouch;
    if (!touch) {
      noFirstTouch++;
      continue;
    }

    const newCf = flattenAttribution(touch);
    if (Object.keys(newCf).length === 0) {
      firstTouchButEmpty++;
      continue;
    }

    // Merge onto any existing non-utm customFields (e.g. from edits).
    const merged = { ...cf, ...newCf };

    if (!APPLY) {
      console.log(
        `[backfill-signups-attribution] DRY-RUN would update leadId=${lead.leadId} email=${lead.email} → customFields=${JSON.stringify(newCf)}`
      );
      wouldUpdate++;
      continue;
    }

    try {
      await updateLeadCustomFields(listId, lead.leadId, merged as Record<string, string>);
      updated++;
      console.log(
        `[backfill-signups-attribution] updated leadId=${lead.leadId} email=${lead.email} → ${Object.keys(newCf).length} fields`
      );
    } catch (err: any) {
      console.error(
        `[backfill-signups-attribution] update FAILED for leadId=${lead.leadId}: ${err.message}`
      );
    }
  }

  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`  already populated (skipped):      ${alreadyPopulated}`);
  console.log(`  no email on lead (skipped):       ${noEmail}`);
  console.log(`  no matching AW-Users row:         ${noUserRow}`);
  console.log(`  user row has no firstTouch:       ${noFirstTouch}`);
  console.log(`  firstTouch present but all empty: ${firstTouchButEmpty}`);
  if (APPLY) {
    console.log(`  UPDATED:                          ${updated}`);
  } else {
    console.log(`  would update (dry-run):           ${wouldUpdate}`);
  }
  console.log(`  total leads scanned:              ${leads.length}`);
  console.log('');
  console.log(`[backfill-signups-attribution] done. mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  if (!APPLY && wouldUpdate > 0) {
    console.log('Re-run with --apply to persist.');
  }
}

main().catch(err => {
  console.error('[backfill-signups-attribution] FATAL:', err);
  process.exit(1);
});
