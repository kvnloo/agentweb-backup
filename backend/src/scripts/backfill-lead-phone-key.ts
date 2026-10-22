/**
 * ENG-2123 one-shot backfill: sets the sparse `phoneKey` attribute on EXISTING email-less lead rows so
 * the PhoneKeyIndex (HASH listId, RANGE phoneKey, KEYS_ONLY) can find a repeat phone-only visitor's
 * earlier row. New form captures already write it (db.createLead); this covers what existed before.
 *
 * DRY-RUN BY DEFAULT. It reads the whole table (a Scan; ~290k items is a few hundred MB, cheap on an
 * on-demand table) and prints what it WOULD write. Nothing is written without --apply.
 *
 * What it will and will not touch (decidePhoneKeyBackfill, unit-tested):
 *   - a row that already has a phoneKey, has an email, a linkedin url or sync metadata: skipped
 *   - a number phoneDedupeKey rejects (too short, junk, a non-specific pattern): skipped
 *   - it SETs phoneKey ONLY. It never sets updatedAt (that is the range key of three GSIs and would
 *     re-order "recently updated"), and the write is conditional on the phone being unchanged since the
 *     scan, so it cannot race a user editing the lead.
 *   - a legacy row carrying "" for email/linkedin/nameCompanyKey (the empty-string GSI-key hazard that
 *     scripts/repairEmptyGsiKeys.ts exists for) gets that attribute REMOVEd in the same write, because
 *     DynamoDB rejects an update that touches a row holding an empty index key.
 *
 * It cannot tell a landing-page capture from a manual or imported phone-only row, so imported phone-only
 * people also become matchable. Rows with a linkedin url or sync metadata (outreach prospects, CRM-mapped
 * contacts) are excluded as the closest available proxy.
 *
 * Run order:
 *   1. Deploy the PR that adds phoneKey to the write path, to EVERY environment, before anything else.
 *   2. Run this with no flags. Read the counts.
 *   3. Run with --apply --confirm-table=<exact table name>.
 *   4. Create PhoneKeyIndex (scripts/repair-leads-add-phone-key-index.sh) - DynamoDB indexes every item that
 *      already carries phoneKey in one pass. Wait for ACTIVE.
 *   5. Only then set the AW-Settings row LEAD_PHONE_DEDUPE_MODE (shadow first).
 *
 * Usage (from backend/):
 *   NODE_ENV=development npx ts-node src/scripts/backfill-lead-phone-key.ts
 *   NODE_ENV=production  npx ts-node src/scripts/backfill-lead-phone-key.ts --list=<listId>
 *   NODE_ENV=production  npx ts-node src/scripts/backfill-lead-phone-key.ts --apply --confirm-table=AW-Leads --rate=25
 */
import { phoneDedupeKey } from '../utils/phoneLeadDedupe';
import { isSmokeTestPhone } from '../utils/smokeTestLead';

export interface PhoneKeyRow {
  listId: string;
  leadId: string;
  phone?: unknown;
  email?: unknown;
  linkedin?: unknown;
  nameCompanyKey?: unknown;
  syncMetadata?: unknown;
  phoneKey?: unknown;
}

export type SkipReason = 'has-key' | 'has-email' | 'has-linkedin' | 'has-sync' | 'no-phone' | 'not-dedupable';
export type PhoneKeyDecision =
  | { action: 'skip'; reason: SkipReason }
  | { action: 'write'; key: string; phone: string; removeEmpty: string[] };

const EMPTY_HAZARD_ATTRS = ['email', 'linkedin', 'nameCompanyKey'] as const;
const hasText = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

export function decidePhoneKeyBackfill(row: PhoneKeyRow): PhoneKeyDecision {
  if (hasText(row.phoneKey)) return { action: 'skip', reason: 'has-key' };
  if (hasText(row.email)) return { action: 'skip', reason: 'has-email' };
  if (hasText(row.linkedin)) return { action: 'skip', reason: 'has-linkedin' };
  if (row.syncMetadata && typeof row.syncMetadata === 'object' && Object.keys(row.syncMetadata as object).length > 0) {
    return { action: 'skip', reason: 'has-sync' };
  }
  if (!hasText(row.phone)) return { action: 'skip', reason: 'no-phone' };
  const key = phoneDedupeKey(row.phone);
  if (!key || isSmokeTestPhone(String(row.phone))) return { action: 'skip', reason: 'not-dedupable' };
  return {
    action: 'write',
    key,
    phone: String(row.phone),
    removeEmpty: EMPTY_HAZARD_ATTRS.filter((a) => (row as any)[a] === ''),
  };
}

export interface BackfillOptions {
  tableName: string;
  apply: boolean;
  listId?: string;
  /** writes per second when applying */
  rate: number;
  /** pause after each scanned page, so the scan does not run flat out against the live table (0 = none) */
  pageDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface BackfillSummary {
  scanned: number;
  skipped: Record<SkipReason, number>;
  eligible: number;
  written: number;
  raced: number;
  errors: number;
  topLists: Array<{ listId: string; eligible: number }>;
}

/** `ddb` is an AWS DocumentClient (or a fake with scan/update returning { promise() }). */
export async function runPhoneKeyBackfill(ddb: any, opts: BackfillOptions): Promise<BackfillSummary> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? (() => undefined);
  const summary: BackfillSummary = {
    scanned: 0,
    skipped: { 'has-key': 0, 'has-email': 0, 'has-linkedin': 0, 'has-sync': 0, 'no-phone': 0, 'not-dedupable': 0 },
    eligible: 0, written: 0, raced: 0, errors: 0, topLists: [],
  };
  const perList = new Map<string, number>();
  let startKey: any;
  do {
    const page = await ddb.scan({
      TableName: opts.tableName,
      ProjectionExpression: 'listId, leadId, phone, email, linkedin, nameCompanyKey, syncMetadata, phoneKey',
      ...(opts.listId ? { FilterExpression: 'listId = :l', ExpressionAttributeValues: { ':l': opts.listId } } : {}),
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }).promise();
    for (const row of (page.Items || []) as PhoneKeyRow[]) {
      summary.scanned++;
      const d = decidePhoneKeyBackfill(row);
      if (d.action === 'skip') { summary.skipped[d.reason]++; continue; }
      summary.eligible++;
      perList.set(row.listId, (perList.get(row.listId) || 0) + 1);
      if (!opts.apply) continue;

      // The row is only rewritten if it is still what the scan saw: no key yet, the same phone, and no
      // email or linkedin url gained since (an attribute being REMOVEd must still be ""). nameCompanyKey
      // is deliberately NOT required to be absent - createLead writes a real one for any lead with first
      // name, last name and company, and requiring its absence would silently skip all of them.
      const removing = new Set(d.removeEmpty);
      const values: Record<string, any> = { ':k': d.key, ':p': d.phone, ...(removing.size ? { ':empty': '' } : {}) };
      const conditions = ['attribute_not_exists(phoneKey)', 'phone = :p'];
      for (const a of ['email', 'linkedin'] as const) {
        conditions.push(removing.has(a) ? `(attribute_not_exists(${a}) OR ${a} = :empty)` : `attribute_not_exists(${a})`);
      }
      if (removing.has('nameCompanyKey')) conditions.push('nameCompanyKey = :empty');
      try {
        await ddb.update({
          TableName: opts.tableName,
          Key: { listId: row.listId, leadId: row.leadId },
          UpdateExpression: `SET phoneKey = :k${d.removeEmpty.length ? ` REMOVE ${d.removeEmpty.join(', ')}` : ''}`,
          ConditionExpression: conditions.join(' AND '),
          ExpressionAttributeValues: values,
        }).promise();
        summary.written++;
      } catch (err: any) {
        if (err?.code === 'ConditionalCheckFailedException') summary.raced++;
        else {
          summary.errors++;
          log(`error on ${row.listId}/${row.leadId}: ${err?.code || ''} ${err?.message || err}`);
          if (summary.errors >= 50) throw new Error('aborting after 50 errors');
        }
      }
      await sleep(Math.ceil(1000 / Math.max(1, opts.rate)));
    }
    startKey = page.LastEvaluatedKey;
    if (startKey && opts.pageDelayMs) await sleep(opts.pageDelayMs);
    log(`scanned ${summary.scanned} (eligible ${summary.eligible}, written ${summary.written})`);
  } while (startKey);
  summary.topLists = [...perList.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([listId, eligible]) => ({ listId, eligible }));
  return summary;
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : 'true';
}

async function main(): Promise<void> {
  const { dynamodb } = await import('../config/aws');
  const { TABLE_PREFIX } = await import('../config/constants');
  const tableName = `${TABLE_PREFIX}AW-Leads`;
  const apply = arg('apply') === 'true';
  if (apply && arg('confirm-table') !== tableName) {
    console.error(`Refusing to write: pass --confirm-table=${tableName} to confirm the target table.`);
    process.exit(2);
  }
  const rate = Number(arg('rate') || 25);
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} on ${tableName}${arg('list') ? ` (list ${arg('list')})` : ''}, ${apply ? `${rate} writes/s` : 'no writes'}`);
  const summary = await runPhoneKeyBackfill(dynamodb, { tableName, apply, listId: arg('list'), rate, pageDelayMs: 250, log: console.log });
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
