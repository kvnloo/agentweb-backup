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
import { SPEND_EVENTS_TABLE, SpendEvent } from "../services/spendEventDb";
import { projectMonth, reconcileProjection, AllowanceInputs } from "../services/spendProjection";
import {
  putProjection,
  getProjection,
  reconcilePersistedProjection,
  PERSISTED_PROJECTION_TOLERANCE_MICRO_USD,
} from "../services/spendProjectionDb";
import { getSubscriptionTypeConfig } from "../services/subscriptionService";
import { getLlmUsageCreditAdjustment } from "../services/llmUsageCreditService";
import { userDb } from "../services/db";

const MICRO = 1e6;
const usd = (m: number) => `$${(m / MICRO).toFixed(2)}`;

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

async function main(): Promise<void> {
  const month = process.argv.find((a) => /^\d{4}-\d{2}$/.test(a)) || new Date().toISOString().slice(0, 7);
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
      await putProjection(projection);
      const persisted = await getProjection(billingUserId, month);
      const rec = reconcilePersistedProjection(persisted, projectMonth(billingUserId, month, events, allowance));
      if (!rec.ok) {
        drifters.push(`${billingUserId} (persist drift ${rec.driftMicroUsd}µ)`);
        worstDriftMicroUsd = Math.max(worstDriftMicroUsd, Math.abs(rec.driftMicroUsd));
      }
      written += 1;
    }

    console.log(
      `  ${billingUserId}  settled=${usd(projection.settledMicroUsd)} ` +
        `(${projection.settledEventCount} events)  usable=${usd(projection.usableAllowanceMicroUsd)}` +
        (projection.unlimited ? "  [uncapped]" : ""),
    );
  }

  console.log(`\n${write ? `wrote ${written} projection row(s)` : "dry-run complete, nothing written"}.`);
  console.log(`worst reconciliation drift: ${worstDriftMicroUsd}µ (tolerance ${PERSISTED_PROJECTION_TOLERANCE_MICRO_USD}µ)`);
  if (drifters.length) {
    console.error(`DRIFT beyond tolerance for ${drifters.length} subject(s):\n  ${drifters.join("\n  ")}`);
    process.exit(2);
  }
  console.log("all subjects reconcile within tolerance.\n");
}

main().catch((e) => {
  console.error("projection backfill failed:", e);
  process.exit(1);
});
