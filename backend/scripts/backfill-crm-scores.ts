/**
 * Backfill `lifecycle`, `heatScore`, `healthScore` on every row in AW-Leads.
 *
 * 5,218 Dev leads currently have all three fields null because the A1 schema
 * shipped without a migration. New events populate scores going forward, but
 * historic leads stay null — Inbox sort-by-heat is mostly tied and Paying tab
 * is sparse even when Stripe is connected.
 *
 * Pure compute logic lives in `backend/src/utils/crmBackfill.ts` so it can be
 * unit tested without DynamoDB. This script is thin orchestration.
 *
 * Usage:
 *   npx ts-node backend/scripts/backfill-crm-scores.ts                 # dry-run (default)
 *   npx ts-node backend/scripts/backfill-crm-scores.ts --apply         # actually write
 *   npx ts-node backend/scripts/backfill-crm-scores.ts --concurrency=5 # parallel workers per list
 *   npx ts-node backend/scripts/backfill-crm-scores.ts --list=<listId> # scope to one list (debugging)
 *
 * Env:
 *   NODE_ENV=development  -> targets Dev-AW-* tables (safe)
 *   NODE_ENV=production   -> targets AW-* tables (CAREFUL; out of scope per Notion spec)
 *
 * Task: https://www.notion.so/34709247c9518151811fdd15808af544
 */

/* eslint-disable no-console */

import AWS from 'aws-sdk';
import {
  BackfillLead,
  BackfillUser,
  computeBackfillScores,
  isLeadAlreadyBackfilled,
} from '../src/utils/crmBackfill';
import {
  BackfillDeal,
  BackfillEvent,
  buildBackfillSignalsExtension,
} from '../src/utils/crmBackfillSignals';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const LIST_FILTER = argv.find(a => a.startsWith('--list='))?.split('=')[1] ?? null;
const CONCURRENCY = Math.max(
  1,
  Math.min(50, parseInt(argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] ?? '10', 10) || 10)
);

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const LEAD_LISTS_TABLE = `${TABLE_PREFIX}AW-LeadLists`;
const LEADS_TABLE = `${TABLE_PREFIX}AW-Leads`;
const USERS_TABLE = `${TABLE_PREFIX}AW-Users`;
const CONTACT_EVENTS_TABLE = `${TABLE_PREFIX}AW-ContactEvents`;
const DEALS_TABLE = `${TABLE_PREFIX}AW-Deals`;

/**
 * How many most-recent ContactEvents rows we pull per lead. All the scoring
 * signals are "latest timestamp of type X" so more than this doesn't change
 * the compute result — it just burns RCUs. 200 easily covers a year of heavy
 * engagement for one contact.
 */
const CONTACT_EVENTS_PAGE_SIZE = 200;

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-west-2',
});

interface LeadListRow {
  listId: string;
  userId: string;
  name?: string;
}

interface LeadRow extends BackfillLead {
  tenantId?: string;
}

interface UserRow extends BackfillUser {
  // No extra fields needed — the type already captures what we read.
}

interface Stats {
  leadsScanned: number;
  leadsSkippedAlreadyBackfilled: number;
  leadsSkippedMalformed: number;
  leadsUpdated: number;
  eventsLogged: number;
  errors: number;
}

const EVENT_SOURCE_ID_PREFIX = 'backfill-crm-scores';

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

/**
 * Lookup a user row by email via the EmailIndex GSI. Returns null when no
 * match — lots of leads are prospect-only (no AW-Users row).
 */
async function getUserByEmail(email: string): Promise<UserRow | null> {
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
    const item = (res.Items || [])[0] as UserRow | undefined;
    if (!item) return null;
    // Skip tombstone rows — they aren't real users.
    if (typeof item.userId === 'string' && item.userId.startsWith('deleted_')) return null;
    return item;
  } catch (err: any) {
    // EmailIndex missing (fresh test envs sometimes) — no user match is the
    // honest answer rather than crashing the whole backfill.
    if (err?.code === 'ValidationException' || err?.name === 'ValidationException') {
      return null;
    }
    throw err;
  }
}

/**
 * Fetch the most-recent ContactEvents rows for a contactId (lowercased email),
 * used to populate lastEngagementAt / lastEmmaSessionAt / etc. signals for
 * scoring. Returns an empty list when the table is missing or the contact has
 * no events — prospect-only leads are expected to have zero events.
 */
async function getContactEventsForLead(lead: LeadRow): Promise<BackfillEvent[]> {
  if (!lead.email || typeof lead.email !== 'string') return [];
  const contactId = lead.email.trim().toLowerCase();
  if (!contactId) return [];
  try {
    const res = await dynamodb
      .query({
        TableName: CONTACT_EVENTS_TABLE,
        KeyConditionExpression: 'contactId = :cid',
        ExpressionAttributeValues: { ':cid': contactId },
        // Descending on eventTimestamp — most recent first, which is all the
        // scoring compute cares about. Cap pages so heavy contacts don't
        // starve the concurrency slot.
        ScanIndexForward: false,
        Limit: CONTACT_EVENTS_PAGE_SIZE,
      })
      .promise();
    return (res.Items || []).map(it => ({
      eventType: typeof it.eventType === 'string' ? it.eventType : '',
      eventTimestamp: typeof it.eventTimestamp === 'string' ? it.eventTimestamp : '',
      payload: (it.payload as Record<string, unknown>) ?? null,
    }));
  } catch (err: any) {
    // Event table may not exist in minimal test envs — zero events is the
    // honest answer rather than crashing the whole backfill.
    if (
      err?.code === 'ResourceNotFoundException' ||
      err?.name === 'ResourceNotFoundException' ||
      err?.code === 'ValidationException' ||
      err?.name === 'ValidationException'
    ) {
      return [];
    }
    throw err;
  }
}

/**
 * Resolve `lead.dealIds` to the stages on those deal rows. N round-trips per
 * lead, but N is tiny in practice (most leads have 0-1 deals) and the
 * concurrency cap bounds the total RCU draw. Malformed / missing deals are
 * silently skipped — the backfill must not block on a stale pointer.
 */
async function getOpenDealsForLead(lead: LeadRow): Promise<BackfillDeal[]> {
  const ids = Array.isArray(lead.dealIds) ? lead.dealIds.filter(Boolean) : [];
  if (ids.length === 0) return [];
  const out: BackfillDeal[] = [];
  for (const dealId of ids) {
    try {
      const res = await dynamodb
        .get({ TableName: DEALS_TABLE, Key: { dealId } })
        .promise();
      const item = res.Item as { dealId?: string; stage?: string | null } | undefined;
      if (item && typeof item.dealId === 'string') {
        out.push({ dealId: item.dealId, stage: item.stage ?? null });
      }
    } catch (err: any) {
      if (
        err?.code === 'ResourceNotFoundException' ||
        err?.name === 'ResourceNotFoundException' ||
        err?.code === 'ValidationException' ||
        err?.name === 'ValidationException'
      ) {
        // Deals table missing — no deal signal, keep going.
        continue;
      }
      throw err;
    }
  }
  return out;
}

/**
 * Apply the computed scores to a single lead row. Dry-run unless APPLY=true.
 * Returns whether it wrote (or would write) and whether it logged (or would
 * log) an event.
 */
async function backfillOneLead(lead: LeadRow): Promise<{ wroteLead: boolean; loggedEvent: boolean }> {
  if (isLeadAlreadyBackfilled(lead)) {
    return { wroteLead: false, loggedEvent: false };
  }

  let user: UserRow | null = null;
  if (lead.email && typeof lead.email === 'string') {
    user = await getUserByEmail(lead.email);
  }

  // Fetch per-lead timeline signals + open-deal stages in parallel. Both are
  // bounded (event page cap + small dealIds[]) so this is cheap.
  const [events, deals] = await Promise.all([
    getContactEventsForLead(lead),
    getOpenDealsForLead(lead),
  ]);

  const signalsExtension = buildBackfillSignalsExtension(events, deals);
  const scores = computeBackfillScores({ lead, user, ...signalsExtension });

  if (!APPLY) {
    return { wroteLead: true, loggedEvent: true };
  }

  // Partial SET — never clobber unrelated fields. Preserve any score the lead
  // already has; only fill nulls. isLeadAlreadyBackfilled catches the
  // all-three-set case; this handles the mixed partial-state case.
  const setClauses: string[] = [];
  const values: Record<string, unknown> = {};
  if (lead.lifecycle == null) {
    setClauses.push('#lc = :lc');
    values[':lc'] = scores.lifecycle;
  }
  if (typeof lead.heatScore !== 'number') {
    setClauses.push('heatScore = :heat');
    values[':heat'] = scores.heatScore;
  }
  if (typeof lead.healthScore !== 'number') {
    setClauses.push('healthScore = :health');
    values[':health'] = scores.healthScore;
  }

  if (setClauses.length === 0) {
    // Nothing to write (all three already set, but isLeadAlreadyBackfilled
    // should have caught it). Defensive no-op.
    return { wroteLead: false, loggedEvent: false };
  }

  // DynamoDB reserved-word guard: `lifecycle` is not reserved today but use a
  // placeholder anyway in case it ever is.
  await dynamodb
    .update({
      TableName: LEADS_TABLE,
      Key: { listId: lead.listId, leadId: lead.leadId },
      UpdateExpression: 'SET ' + setClauses.join(', '),
      ExpressionAttributeNames: { '#lc': 'lifecycle' },
      ExpressionAttributeValues: values,
    })
    .promise();

  // Audit-trail event row — idempotent on sourceRecordId so re-runs don't
  // double-log. Use `system` source per contactEventsDb enum and a
  // `lifecycle.changed` event type; payload records it came from the backfill.
  const contactId = lead.email ? lead.email.trim().toLowerCase() : `nocontact:${lead.leadId}`;
  const sourceRecordId = `${EVENT_SOURCE_ID_PREFIX}:${lead.listId}:${lead.leadId}`;
  const now = new Date().toISOString();
  try {
    await dynamodb
      .put({
        TableName: CONTACT_EVENTS_TABLE,
        Item: {
          contactId,
          eventTimestamp: now,
          eventId: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
          source: 'system',
          eventType: 'lifecycle.changed',
          payload: {
            backfill: true,
            listId: lead.listId,
            leadId: lead.leadId,
            from: { lifecycle: lead.lifecycle ?? null, heatScore: lead.heatScore ?? null, healthScore: lead.healthScore ?? null },
            to: scores,
          },
          sourceRecordId,
          createdAt: now,
          ...(lead.tenantId ? { tenantId: lead.tenantId } : {}),
        },
        ConditionExpression:
          'attribute_not_exists(contactId) AND attribute_not_exists(eventTimestamp)',
      })
      .promise();
    return { wroteLead: true, loggedEvent: true };
  } catch (err: any) {
    // Event table may not exist in minimal test envs — non-fatal, the lead
    // update already landed which is what Paying/Inbox care about.
    if (
      err?.code === 'ResourceNotFoundException' ||
      err?.name === 'ResourceNotFoundException' ||
      err?.code === 'ConditionalCheckFailedException' ||
      err?.name === 'ConditionalCheckFailedException'
    ) {
      return { wroteLead: true, loggedEvent: false };
    }
    throw err;
  }
}

/**
 * Process leads for a single list with bounded parallelism. Concurrency is
 * capped to avoid DynamoDB throttling on Dev tables.
 */
async function backfillListLeads(
  leads: LeadRow[],
  stats: Stats,
  onProgress: () => void
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < leads.length) {
      const i = cursor++;
      const lead = leads[i];
      stats.leadsScanned += 1;
      try {
        if (!lead.listId || !lead.leadId) {
          stats.leadsSkippedMalformed += 1;
          onProgress();
          continue;
        }
        if (isLeadAlreadyBackfilled(lead)) {
          stats.leadsSkippedAlreadyBackfilled += 1;
          onProgress();
          continue;
        }
        const r = await backfillOneLead(lead);
        if (r.wroteLead) stats.leadsUpdated += 1;
        if (r.loggedEvent) stats.eventsLogged += 1;
      } catch (err) {
        stats.errors += 1;
        console.error(
          `[backfill-crm-scores] error on list=${lead.listId} lead=${lead.leadId}:`,
          err instanceof Error ? err.message : err
        );
      }
      onProgress();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

async function main(): Promise<void> {
  console.log(
    `[backfill-crm-scores] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} concurrency=${CONCURRENCY} tables=${LEADS_TABLE}/${USERS_TABLE}/${CONTACT_EVENTS_TABLE}`
  );
  if (LIST_FILTER) console.log(`[backfill-crm-scores] scoped to list=${LIST_FILTER}`);

  const stats: Stats = {
    leadsScanned: 0,
    leadsSkippedAlreadyBackfilled: 0,
    leadsSkippedMalformed: 0,
    leadsUpdated: 0,
    eventsLogged: 0,
    errors: 0,
  };

  const allLists = await scanAll<LeadListRow>(LEAD_LISTS_TABLE);
  const lists = LIST_FILTER ? allLists.filter(l => l.listId === LIST_FILTER) : allLists;
  console.log(`[backfill-crm-scores] found ${lists.length} lead list(s) to scan`);

  let lastLoggedAt = 0;
  const progress = () => {
    if (stats.leadsScanned % 100 === 0 || Date.now() - lastLoggedAt > 5000) {
      console.log(
        `[backfill-crm-scores] progress scanned=${stats.leadsScanned} updated=${stats.leadsUpdated} skipped=${stats.leadsSkippedAlreadyBackfilled} errors=${stats.errors}`
      );
      lastLoggedAt = Date.now();
    }
  };

  for (const list of lists) {
    if (!list.listId) {
      console.warn(`[backfill-crm-scores] skipping malformed list row: ${JSON.stringify(list)}`);
      continue;
    }
    const leads = await queryListLeads(list.listId);
    console.log(
      `[backfill-crm-scores] list="${list.name || list.listId}" leads=${leads.length}`
    );
    await backfillListLeads(leads, stats, progress);
  }

  console.log('\n[backfill-crm-scores] ==========================================');
  console.log(`[backfill-crm-scores] scanned:                 ${stats.leadsScanned}`);
  console.log(`[backfill-crm-scores] already-backfilled (skip): ${stats.leadsSkippedAlreadyBackfilled}`);
  console.log(`[backfill-crm-scores] malformed (skip):        ${stats.leadsSkippedMalformed}`);
  console.log(
    `[backfill-crm-scores] ${APPLY ? 'updated' : 'would update'}:   ${stats.leadsUpdated}`
  );
  console.log(
    `[backfill-crm-scores] ${APPLY ? 'events logged' : 'events would log'}: ${stats.eventsLogged}`
  );
  console.log(`[backfill-crm-scores] errors:                  ${stats.errors}`);
  console.log('[backfill-crm-scores] ==========================================');

  if (!APPLY) {
    console.log('[backfill-crm-scores] dry-run — re-run with --apply to write.');
  }

  if (stats.errors > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[backfill-crm-scores] fatal:', err);
    process.exit(1);
  });
}
