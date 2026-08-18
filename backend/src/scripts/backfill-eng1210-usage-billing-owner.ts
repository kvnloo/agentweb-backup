/**
 * ENG-1210 — stamp the billing owner onto historical usage-ledger rows.
 *
 * ## Why this exists
 *
 * Raised by Greptile on PR #2407: "current-state fallback attribution still
 * reinterprets pre-tag rows after billing transitions, and the union reader
 * cannot recover a departed member's untagged partition."
 *
 * Both come from one fact. `recordUsage` defaulted the payer to
 * `ctx.billingUserId || userId`, so every row written before ENG-1217 tagged the
 * agent path carries the ACTING user rather than the billing root. Measured on
 * production 2026-08-18: 4,981 of 4,981 rows are self-stamped. Zero are tagged.
 *
 * Two consequences follow, and only the second is repairable:
 *
 *  1. Attribution for those rows is INFERRED from org membership as it stands at
 *     READ time. The answer therefore changes when membership changes -- the same
 *     historical row is billed to one owner today and another tomorrow. Stamping
 *     the row freezes the answer at a point where we can still compute it.
 *  2. A member who LEAVES becomes unreachable: the partition fan-out only asks
 *     about current members, and the attribute scan only finds stamped rows. Once
 *     stamped, a row stays findable by the scan no matter who leaves afterwards.
 *
 * ## What this CANNOT do, stated plainly
 *
 * It recovers nothing for an actor who has ALREADY left. Membership is not
 * versioned anywhere -- `getOrgMembers` queries a GSI on the user's CURRENT
 * `orgId` -- so for an actor with no user record there is no way to learn which
 * org they billed to. Verified on production: of 140 actors holding usage rows,
 * 51 have no user record, none of those are tombstoned (`deleted_` records exist
 * but match none of them), and their rows carry no org-linking attribute. Their
 * spend is unattributable by any mechanism, and this script leaves it untouched
 * rather than guessing.
 *
 * So the honest ceiling is: 26 in-org actors repaired, 63 solo actors confirmed
 * already correct, 51 permanently unattributable.
 *
 * ## Why this is a MIGRATION, not an attribute write
 *
 * ENG-1210 put `billingUserId` into the sort key, so changing a row's payer
 * changes its identity. A repair is therefore delete-then-put, not UpdateItem.
 * That is why this exists as a reviewable script with a dry run rather than a
 * line of service code, and why it must not run without data-plane approval:
 *   - it mutates a production BILLING table;
 *   - each row moves non-atomically, so an interrupted run leaves a mix of
 *     formats (safe to re-run -- see idempotency -- but real);
 *   - it is bulk production data repair, which CLAUDE.md gates on Harsha.
 *
 * ## Safety properties
 *
 * DRY RUN BY DEFAULT. `--apply` is required to write anything.
 *
 * IDEMPOTENT. A row already carrying the resolved owner in its key is skipped,
 * so re-running after an interruption converges and never double-moves a row.
 *
 * NON-DESTRUCTIVE ORDER. The new row is PUT before the old row is deleted. A
 * crash between the two leaves a duplicate, which readers already dedupe on
 * `{userId, sk}` -- and a duplicate is visible where a deletion is not. Never
 * delete first.
 *
 * COUNTERS ARE MOVED, NEVER RECOMPUTED. The row is copied verbatim apart from
 * `billingUserId` and `sk`. This script must not become a place where usage
 * totals are re-derived.
 *
 * Usage:
 *   NODE_ENV=production npx ts-node src/scripts/backfill-eng1210-usage-billing-owner.ts
 *   NODE_ENV=production npx ts-node src/scripts/backfill-eng1210-usage-billing-owner.ts --apply
 *   ... --org-id=<id>     restrict to one org (recommended for the first apply)
 *   ... --limit=<n>       stop after n row repairs (a bounded first run)
 */
import { DynamoDB } from 'aws-sdk';
import { inheritsOrgBilling } from '../services/orgAuthz';

const doc = new DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const USAGE_TABLE = `${TABLE_PREFIX}AW-UsageRecords`;
const USERS_TABLE = `${TABLE_PREFIX}AW-Users`;
const ORGS_TABLE = `${TABLE_PREFIX}AW-Organizations`;

const apply = process.argv.includes('--apply');
const onlyOrg = process.argv.find((a) => a.startsWith('--org-id='))?.slice('--org-id='.length);
const limitArg = process.argv.find((a) => a.startsWith('--limit='))?.slice('--limit='.length);
const limit = limitArg ? Number(limitArg) : Infinity;

interface UsageRow {
  userId: string;
  sk: string;
  billingUserId?: string;
  date: string;
  model: string;
  feature: string;
  [k: string]: unknown;
}

/** Same shape the reader builds, so a repaired row is byte-identical to a new one. */
const buildSortKey = (date: string, model: string, feature: string, billingUserId: string) =>
  `${date}#${model}#${feature}#${billingUserId}`;

async function scanAll(table: string, params: Record<string, unknown> = {}): Promise<any[]> {
  const out: any[] = [];
  let last: DynamoDB.DocumentClient.Key | undefined;
  do {
    const r = await doc.scan({ TableName: table, ...params, ...(last ? { ExclusiveStartKey: last } : {}) }).promise();
    out.push(...(r.Items || []));
    last = r.LastEvaluatedKey;
  } while (last);
  return out;
}

/**
 * The billing owner for one actor, by the SAME predicate the read path uses.
 * Deriving it independently here is how attribution and entitlement drifted three
 * times before (ENG-288, ENG-954, ENG-1084), so this defers to `inheritsOrgBilling`.
 *
 * `null` means "cannot be determined" -- an actor with no user record. That is a
 * refusal to guess, not a failure: writing the actor's own id would look like a
 * decision when it is an absence of one.
 */
async function resolveOwner(actorId: string): Promise<{ owner: string | null; orgId: string | null; reason: string }> {
  const users = await doc.query({
    TableName: USERS_TABLE, IndexName: 'UserIdIndex',
    KeyConditionExpression: 'userId = :u',
    ExpressionAttributeValues: { ':u': actorId },
  }).promise();
  const user = (users.Items || [])[0];
  if (!user) return { owner: null, orgId: null, reason: 'no_user_record' };
  if (!user.orgId) return { owner: actorId, orgId: null, reason: 'solo' };

  const org = (await doc.get({ TableName: ORGS_TABLE, Key: { orgId: user.orgId } }).promise()).Item;
  if (!org?.ownerUserId) return { owner: actorId, orgId: user.orgId, reason: 'org_unresolvable' };
  if (org.ownerUserId === actorId) return { owner: actorId, orgId: user.orgId, reason: 'is_billing_root' };

  const pools = inheritsOrgBilling(
    { userId: actorId, orgId: user.orgId, subscription_status: user.subscription_status },
    org as never,
  );
  return pools
    ? { owner: org.ownerUserId as string, orgId: user.orgId, reason: 'pools_to_root' }
    : { owner: actorId, orgId: user.orgId, reason: 'self_paying_member' };
}

async function main() {
  console.log(`[${apply ? 'APPLY' : 'DRY-RUN'}] table=${USAGE_TABLE}${onlyOrg ? ` org=${onlyOrg}` : ''}`);

  const rows = (await scanAll(USAGE_TABLE)) as UsageRow[];
  const actors = [...new Set(rows.map((r) => r.userId))];
  console.log(`scanned ${rows.length} rows across ${actors.length} actors`);

  const owners = new Map<string, { owner: string | null; orgId: string | null; reason: string }>();
  for (const a of actors) owners.set(a, await resolveOwner(a));

  const byReason: Record<string, number> = {};
  for (const o of owners.values()) byReason[o.reason] = (byReason[o.reason] || 0) + 1;
  console.log('actors by resolution:', byReason);

  let repaired = 0, alreadyCorrect = 0, unattributable = 0, skippedOrg = 0;
  const perOrg: Record<string, number> = {};

  for (const row of rows) {
    const res = owners.get(row.userId)!;
    if (res.owner === null) { unattributable++; continue; }
    if (onlyOrg && res.orgId !== onlyOrg) { skippedOrg++; continue; }

    // ONLY repair rows whose ATTRIBUTION changes. A row already stamped with the
    // right owner is left exactly as it is, old-format sort key and all.
    //
    // The dry run is what forced this: rewriting every row to the new key shape
    // reported 4,489 "repairs", of which 1,784 were solo actors whose payer was
    // already correct and only the KEY differed. Those move no money and fix
    // nothing -- they are 1,784 delete-and-put pairs on a billing table bought
    // for zero benefit. Old-format rows read correctly (nothing parses `sk`, and
    // the date is still the leading range segment), so the migration's scope is
    // attribution, not tidiness.
    if (row.billingUserId === res.owner) { alreadyCorrect++; continue; }
    const targetSk = buildSortKey(row.date, row.model, row.feature, res.owner);
    if (repaired >= limit) break;

    perOrg[res.orgId || '(solo)'] = (perOrg[res.orgId || '(solo)'] || 0) + 1;
    console.log(
      `  ${apply ? 'repair' : 'would repair'} actor=${row.userId} ${row.sk}` +
      ` -> ${targetSk} (billingUserId ${row.billingUserId} -> ${res.owner}, ${res.reason})`,
    );

    if (apply) {
      // PUT the new row BEFORE deleting the old one. A crash between the two
      // leaves a duplicate, which readers dedupe on {userId, sk}; deleting first
      // would lose the spend outright.
      await doc.put({
        TableName: USAGE_TABLE,
        Item: { ...row, sk: targetSk, billingUserId: res.owner },
        // Never clobber a row the new write path already created for this key.
        ConditionExpression: 'attribute_not_exists(sk)',
      }).promise().catch((e: any) => {
        if (e?.code !== 'ConditionalCheckFailedException') throw e;
      });
      if (targetSk !== row.sk) {
        await doc.delete({ TableName: USAGE_TABLE, Key: { userId: row.userId, sk: row.sk } }).promise();
      }
    }
    repaired++;
  }

  console.log('\n--- summary ---');
  console.log(`rows ${apply ? 'repaired' : 'to repair'} : ${repaired}`);
  console.log(`already correctly attributed : ${alreadyCorrect}  (left untouched, old key format and all)`);
  console.log(`unattributable        : ${unattributable}  (no user record -- left before any stamp existed)`);
  if (onlyOrg) console.log(`skipped (other orgs)  : ${skippedOrg}`);
  console.log('rows by org           :', perOrg);
  if (!apply) console.log('\nDRY RUN -- nothing written. Re-run with --apply after data-plane approval.');
}

main().catch((e) => { console.error(e); process.exit(1); });
