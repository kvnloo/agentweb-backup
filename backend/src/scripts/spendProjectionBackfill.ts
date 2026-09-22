/**
 * ENG-1250 §3b — initial materialization of AW-SpendProjection.
 *
 * The event-driven writer (spendProjectionDb.applySettledSpendEvents) keeps the
 * projection fresh from the moment it deploys, but it only sees events written
 * AFTER it is live. This script seeds the row for every subject with events in a
 * month from the ledger that already exists, so the projection reflects the full
 * month, not just the tail. Run it once per active month at/after the writer
 * deploys; it is idempotent (re-running recomputes and overwrites).
 *
 * Source of truth is AW-SpendEvents (what reconcilePersistedProjection checks
 * against), NOT the usageRecord aggregates the impact model reads.
 *
 * SAFE BY DEFAULT: dry-run unless --write is passed. Dry-run computes the same
 * projections and runs the same ≤1µ$ reconciliation, writing nothing.
 *
 *   npx ts-node src/scripts/spendProjectionBackfill.ts [YYYY-MM] [--write]
 */
import AWS from "aws-sdk";
import { SPEND_EVENTS_TABLE, SpendEvent, listSpendEvents } from "../services/spendEventDb";
import { projectMonth, reconcileProjection, AllowanceInputs } from "../services/spendProjection";
import {
  putProjectionIfUnchanged,
  getProjection,
  reconcilePersistedProjection,
  PERSISTED_PROJECTION_TOLERANCE_MICRO_USD,
} from "../services/spendProjectionDb";
import { getSubscriptionTypeConfig } from "../services/subscriptionService";
import { getLlmUsageCreditAdjustment } from "../services/llmUsageCreditService";
import { userDb } from "../services/db";

const MICRO = 1e6;
const usd = (m: number) => `$${(m / MICRO).toFixed(2)}`;
// Same strict contract spendProjectionDb enforces: YYYY-(01..12). A loose
// \d{4}-\d{2} accepts 2026-00 / 2026-99, whose scan finds nothing and reports
// a false success on a typo (F1).
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Scan the ledger for one month's events, grouped by billing subject. */
async function eventsBySubject(month: string): Promise<Map<string, SpendEvent[]>> {
  const client = new AWS.DynamoDB.DocumentClient();
  const bySubject = new Map<string, SpendEvent[]>();
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  do {
    const result = await client
      .scan({
        TableName: SPEND_EVENTS_TABLE,
        FilterExpression: "billingMonth = :m",
        ExpressionAttributeValues: { ":m": month },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      })
      .promise();
    for (const item of (result.Items || []) as SpendEvent[]) {
      if (!item.billingUserId) continue;
      const list = bySubject.get(item.billingUserId) || [];
      list.push(item);
      bySubject.set(item.billingUserId, list);
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return bySubject;
}

/** Resolve a subject's allowance the same way the impact/snapshot scripts do. */
async function allowanceFor(billingUserId: string, month: string): Promise<AllowanceInputs> {
  const user = await userDb.getUserById(billingUserId);
  const policy = (await getSubscriptionTypeConfig(user?.subscriptionType || "Unknown"))?.llmUsagePolicy ?? null;
  const adj = getLlmUsageCreditAdjustment(user?.llmUsageCredits, month);
  if (policy == null) {
    // No configured cap → uncapped; allowance figures are not meaningful.
    return { includedAllowanceMicroUsd: 0, unlimited: true };
  }
  return {
    includedAllowanceMicroUsd: policy.hardCostThresholdMicroUsd,
    purchasedCreditsMicroUsd: adj.purchasedMicroUsd,
    adminAdjustmentMicroUsd: adj.adminGrantedMicroUsd,
    migrationAdjustmentMicroUsd: adj.migrationOffsetMicroUsd,
    unlimited: false,
  };
}

/**
 * Persist one subject's projection with optimistic concurrency (F2).
 *
 * putProjection is an unconditional whole-item put, which races the event-driven
 * writer: an ADD to settledMicroUsd landing between our read and our write would
 * be silently reverted. So we: read the row STRONGLY CONSISTENT, and write only
 * if it is still what we observed (putProjectionIfUnchanged). On a conditional
 * miss — or when our (eventually-consistent GSI) event list is behind the row —
 * we re-derive from a fresh per-subject events read and retry, never re-using the
 * stale snapshot. Bounded attempts; the verify read is strongly consistent too.
 */
export async function persistSubjectProjection(
  billingUserId: string,
  month: string,
  allowance: AllowanceInputs,
  initialEvents: SpendEvent[],
  maxAttempts = 3,
): Promise<{ settledMicroUsd: number; driftMicroUsd: number; attempts: number }> {
  const start = `${month}-01`;
  const end = `${month}-31`;
  let events = initialEvents;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const observed = await getProjection(billingUserId, month, /* consistentRead */ true);
    const projection = projectMonth(billingUserId, month, events, allowance);

    // Our event list can lag the row (GSI eventual consistency vs the writer's
    // atomic ADDs). Writing a smaller settled than the row already holds would
    // revert real spend — re-derive from a fresh read and retry instead.
    if (observed && projection.settledMicroUsd < observed.settledMicroUsd) {
      events = await listSpendEvents(billingUserId, start, end);
      continue;
    }

    const expected = observed
      ? { settledMicroUsd: observed.settledMicroUsd, settledEventCount: observed.settledEventCount }
      : null;
    const { written } = await putProjectionIfUnchanged(projection, expected);
    if (written) {
      const persisted = await getProjection(billingUserId, month, /* consistentRead */ true);
      const rec = reconcilePersistedProjection(persisted, projection);
      return { settledMicroUsd: projection.settledMicroUsd, driftMicroUsd: Math.abs(rec.driftMicroUsd), attempts: attempt };
    }

    // Row changed under us: re-derive from a fresh read, do NOT retry the stale snapshot.
    events = await listSpendEvents(billingUserId, start, end);
  }
  throw new Error(`backfill: could not converge on a conditional write for ${billingUserId} after ${maxAttempts} attempts`);
}

async function main(): Promise<void> {
  const monthArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (monthArg !== undefined && !MONTH_RE.test(monthArg)) {
    console.error(`invalid month argument ${JSON.stringify(monthArg)}; expected YYYY-MM with a real month (01–12), e.g. 2026-09`);
    process.exit(1);
  }
  const month = monthArg ?? new Date().toISOString().slice(0, 7);
  const write = process.argv.includes("--write");

  console.log(`\nENG-1250 §3b projection backfill — ${month} — ${write ? "WRITE" : "DRY-RUN (no writes; pass --write to persist)"}\n`);

  const bySubject = await eventsBySubject(month);
  console.log(`subjects with events this month: ${bySubject.size}\n`);

  let written = 0;
  let worstDriftMicroUsd = 0;
  const drifters: string[] = [];

  for (const [billingUserId, events] of bySubject) {
    const allowance = await allowanceFor(billingUserId, month);
    const projection = projectMonth(billingUserId, month, events, allowance);

    // Self-consistency: projectMonth's settled figure must equal the event sum.
    const selfCheck = reconcileProjection(events, projection);
    if (!selfCheck.ok) {
      drifters.push(`${billingUserId} (derive drift ${selfCheck.driftMicroUsd}µ)`);
      worstDriftMicroUsd = Math.max(worstDriftMicroUsd, Math.abs(selfCheck.driftMicroUsd));
    }

    if (write) {
      const res = await persistSubjectProjection(billingUserId, month, allowance, events);
      if (res.driftMicroUsd > PERSISTED_PROJECTION_TOLERANCE_MICRO_USD) {
        drifters.push(`${billingUserId} (persist drift ${res.driftMicroUsd}µ)`);
      }
      worstDriftMicroUsd = Math.max(worstDriftMicroUsd, res.driftMicroUsd);
      written += 1;
      console.log(
        `  ${billingUserId}  settled=${usd(res.settledMicroUsd)} ` +
          `(${projection.settledEventCount} events, ${res.attempts} attempt(s))  usable=${usd(projection.usableAllowanceMicroUsd)}` +
          (projection.unlimited ? "  [uncapped]" : ""),
      );
    } else {
      console.log(
        `  ${billingUserId}  settled=${usd(projection.settledMicroUsd)} ` +
          `(${projection.settledEventCount} events)  usable=${usd(projection.usableAllowanceMicroUsd)}` +
          (projection.unlimited ? "  [uncapped]" : ""),
      );
    }
  }

  console.log(`\n${write ? `wrote ${written} projection row(s)` : "dry-run complete, nothing written"}.`);
  console.log(`worst reconciliation drift: ${worstDriftMicroUsd}µ (tolerance ${PERSISTED_PROJECTION_TOLERANCE_MICRO_USD}µ)`);
  if (drifters.length) {
    console.error(`DRIFT beyond tolerance for ${drifters.length} subject(s):\n  ${drifters.join("\n  ")}`);
    process.exit(2);
  }
  console.log("all subjects reconcile within tolerance.\n");
}

// Guard so tests can import persistSubjectProjection without running the scan.
if (require.main === module) {
  main().catch((e) => {
    console.error("projection backfill failed:", e);
    process.exit(1);
  });
}
