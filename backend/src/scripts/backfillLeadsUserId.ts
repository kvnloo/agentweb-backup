/**
 * One-shot backfill that populates `userId` and `nameCompanyKey` on existing
 * AW-Leads items so the CRM-history Tier 0 GSIs (EmailLookupIndex,
 * LinkedinLookupIndex, NameCompanyLookupIndex) start serving cross-tenant
 * sibling matches.
 *
 * Idempotent: safe to re-run. Uses attribute_not_exists(userId) so a partial
 * run can be resumed without re-writing items that were already touched.
 *
 * Run order:
 *   1. Deploy the schema change (create-tables.ts) so the new GSIs exist.
 *   2. Deploy the write-path changes so new leads carry userId + nameCompanyKey.
 *   3. Run this script to repair legacy leads.
 *
 * Usage:
 *   NODE_ENV=development npx ts-node src/scripts/backfillLeadsUserId.ts
 *   NODE_ENV=production npx ts-node src/scripts/backfillLeadsUserId.ts --dry-run
 */

import { computeNameCompanyKey } from '../utils/leadSchema';

export interface BackfillLead {
  leadId: string;
  listId: string;
  userId?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  nameCompanyKey?: string;
}

export interface BackfillList {
  listId: string;
  userId: string;
}

export interface BackfillDecision {
  /** Attributes to SET on the lead. Empty when isNoop is true. */
  attributesToWrite: {
    userId?: string;
    nameCompanyKey?: string;
  };
  /** No parent list found — userId can't be derived. Logged + skipped. */
  orphaned: boolean;
  /** True when the lead already has every attribute we'd backfill. */
  isNoop: boolean;
}

/**
 * Pure check used by the runtime to decide whether to even compute a payload.
 * Returns true when there is *potentially* something to write. False when the
 * lead is already complete OR has no derivable key (no first/last/company).
 */
export function shouldBackfillLead(lead: BackfillLead): boolean {
  if (!lead.userId) return true;
  const couldComputeKey = !!computeNameCompanyKey(lead.firstName, lead.lastName, lead.company);
  if (couldComputeKey && !lead.nameCompanyKey) return true;
  return false;
}

/**
 * Compute the per-lead write payload. Pure — no DDB I/O so it's unit-testable
 * with a Map of lists. The script wires this to a real DDB scan + per-item
 * UpdateItem in `runBackfill`.
 */
export function computeBackfillPayload(
  lead: BackfillLead,
  listsByListId: Map<string, BackfillList>,
): BackfillDecision {
  const out: BackfillDecision = {
    attributesToWrite: {},
    orphaned: false,
    isNoop: false,
  };

  if (!lead.userId) {
    const list = listsByListId.get(lead.listId);
    if (list?.userId) {
      out.attributesToWrite.userId = list.userId;
    } else {
      out.orphaned = true;
    }
  }

  if (!lead.nameCompanyKey) {
    const nck = computeNameCompanyKey(lead.firstName, lead.lastName, lead.company);
    if (nck) out.attributesToWrite.nameCompanyKey = nck;
  }

  if (Object.keys(out.attributesToWrite).length === 0 && !out.orphaned) {
    out.isNoop = true;
  }

  return out;
}

// ─── Runtime wrapper (only loaded when running as a script) ────────────────────

async function runBackfill(opts: { dryRun: boolean }) {
  // Lazy-load AWS only when running as a script so unit tests stay fast.
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

  const dynamodb = new AWS.DynamoDB.DocumentClient();

  console.log('[backfillLeadsUserId] starting', { dryRun: opts.dryRun, env: process.env.NODE_ENV, leadsTable: LEADS_TABLE, listsTable: LISTS_TABLE });

  // Load all lists into memory — listId → userId map.
  const listsByListId = new Map<string, BackfillList>();
  let lastListsKey: any = undefined;
  do {
    const r = await dynamodb.scan({
      TableName: LISTS_TABLE,
      ExclusiveStartKey: lastListsKey,
      ProjectionExpression: 'listId, userId',
    }).promise();
    for (const it of r.Items || []) {
      if (it.listId && it.userId) listsByListId.set(String(it.listId), { listId: String(it.listId), userId: String(it.userId) });
    }
    lastListsKey = r.LastEvaluatedKey;
  } while (lastListsKey);

  console.log(`[backfillLeadsUserId] loaded ${listsByListId.size} lists`);

  let touched = 0;
  let skippedNoop = 0;
  let skippedOrphaned = 0;
  let errored = 0;

  let lastLeadsKey: any = undefined;
  do {
    const r = await dynamodb.scan({
      TableName: LEADS_TABLE,
      ExclusiveStartKey: lastLeadsKey,
      ProjectionExpression: 'leadId, listId, userId, firstName, lastName, company, nameCompanyKey',
    }).promise();

    for (const item of r.Items || []) {
      const lead = item as BackfillLead;
      if (!shouldBackfillLead(lead)) {
        skippedNoop++;
        continue;
      }
      const decision = computeBackfillPayload(lead, listsByListId);
      if (decision.orphaned) {
        skippedOrphaned++;
        continue;
      }
      if (decision.isNoop) {
        skippedNoop++;
        continue;
      }

      if (opts.dryRun) {
        touched++;
        continue;
      }

      try {
        const setParts: string[] = [];
        const values: Record<string, any> = {};
        if (decision.attributesToWrite.userId !== undefined) {
          setParts.push('userId = if_not_exists(userId, :uid)');
          values[':uid'] = decision.attributesToWrite.userId;
        }
        if (decision.attributesToWrite.nameCompanyKey !== undefined) {
          setParts.push('nameCompanyKey = if_not_exists(nameCompanyKey, :nck)');
          values[':nck'] = decision.attributesToWrite.nameCompanyKey;
        }
        if (setParts.length === 0) continue;

        await dynamodb.update({
          TableName: LEADS_TABLE,
          Key: { listId: lead.listId, leadId: lead.leadId },
          UpdateExpression: 'SET ' + setParts.join(', '),
          ExpressionAttributeValues: values,
          ConditionExpression: 'attribute_exists(leadId)',
        }).promise();
        touched++;
      } catch (err) {
        errored++;
        console.warn(`[backfillLeadsUserId] update failed for ${lead.listId}/${lead.leadId}:`, (err as Error).message);
      }
    }

    lastLeadsKey = r.LastEvaluatedKey;
  } while (lastLeadsKey);

  console.log('[backfillLeadsUserId] DONE', { touched, skippedNoop, skippedOrphaned, errored, dryRun: opts.dryRun });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  void runBackfill({ dryRun });
}
