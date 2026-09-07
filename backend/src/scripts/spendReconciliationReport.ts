/**
 * Print the ENG-1250 §8 internal reconciliation for a billing subject and month.
 *
 * READ-ONLY. Two scans and some arithmetic; it writes nothing and cannot move
 * enforcement. Exists so the shadow phase can be checked from a terminal
 * instead of by hand-reading DynamoDB, which is exactly the "no admin should
 * need direct DynamoDB inspection" complaint in §7.
 *
 *   npx ts-node src/scripts/spendReconciliationReport.ts [YYYY-MM] [billingUserId]
 *
 * SPEND_LEDGER_MIRROR_STARTED_AT scopes fidelity to the period the dual-write
 * actually existed. Without it, every row predating the mirror reads as "not
 * mirrored" and the check can never go green — see FidelityOptions.
 *
 * With no billingUserId it reports every subject that has spend events in the
 * month, which is what you want while the ledger is small.
 */
import { SpendEvent, SPEND_EVENTS_TABLE } from "../services/spendEventDb";
import { UsageRecordRow, usageRecordDb } from "../services/usageRecordDb";
import { reconcileMonth } from "../services/spendReconciliation";
import AWS from "aws-sdk";

const usd = (micro: number) => `$${(micro / 1e6).toFixed(6)}`;

/**
 * Scans rather than querying the GSI: the GSI is keyed by billingUserId, and
 * the point of a no-argument run is to find subjects we do not know yet. Fine
 * at shadow-phase volumes and explicitly not a production read path.
 */
async function scanAllSpendEvents(month: string): Promise<SpendEvent[]> {
  const db = new AWS.DynamoDB.DocumentClient();
  const items: SpendEvent[] = [];
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;

  do {
    const result = await db
      .scan({
        TableName: SPEND_EVENTS_TABLE,
        FilterExpression: "billingMonth = :m",
        ExpressionAttributeValues: { ":m": month },
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      })
      .promise();
    items.push(...((result.Items || []) as SpendEvent[]));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

async function main(): Promise<void> {
  const month = process.argv[2] || new Date().toISOString().slice(0, 7);
  const only = process.argv[3];
  const mirrorStartedAt = process.env.SPEND_LEDGER_MIRROR_STARTED_AT;

  const events = await scanAllSpendEvents(month);
  const subjects = only ? [only] : [...new Set(events.map((e) => e.billingUserId))].sort();

  console.log(`\nENG-1250 §8 internal reconciliation — ${month}`);
  console.log(`table: ${SPEND_EVENTS_TABLE}   spend events in month: ${events.length}`);
  console.log(
    mirrorStartedAt
      ? `fidelity scoped to days after the mirror started (${mirrorStartedAt})`
      : "fidelity UNSCOPED — set SPEND_LEDGER_MIRROR_STARTED_AT or every pre-mirror row reads as a failure",
  );

  if (subjects.length === 0) {
    console.log("\nNo spend events yet for this month. Nothing to reconcile.\n");
    return;
  }

  const start = `${month}-01`;
  const end = `${month}-31`;

  for (const billingUserId of subjects) {
    const liveRows: UsageRecordRow[] = await usageRecordDb.queryByBillingUserDateRange(billingUserId, start, end);
    const report = reconcileMonth(billingUserId, month, events, liveRows, { mirrorStartedAt });
    const f = report.fidelity;
    const d = report.divergence;

    console.log(`\n── ${billingUserId}`);
    console.log(
      `   FIDELITY        ${f.assessedGroupCount === 0 ? "NOT ASSESSED" : f.ok ? "CLEAN" : "PROBLEM"}` +
        `   assessed=${f.assessedGroupCount} of ${f.groupCount}` +
        `   (pre-mirror ${f.preMirrorGroups.length}, changeover day ${f.partialGroups.length})`,
    );
    console.log(`     ledger ${usd(f.ledgerMicroUsd)}   live ${usd(f.liveMicroUsd)}   drift ${usd(f.driftMicroUsd)}`);

    for (const g of f.unmirroredGroups) {
      console.log(`     NOT MIRRORED  ${g.date} ${g.provider}:${g.operation}  live ${usd(g.liveMicroUsd)} over ${g.liveCallCount} call(s)`);
    }
    for (const g of f.orphanGroups) {
      console.log(`     ORPHAN EVENT  ${g.date} ${g.provider}:${g.operation}  ledger ${usd(g.ledgerMicroUsd)} over ${g.ledgerEventCount} event(s)`);
    }
    for (const g of f.driftingGroups) {
      console.log(`     DRIFT         ${g.date} ${g.provider}:${g.operation}  ledger ${usd(g.ledgerMicroUsd)} vs live ${usd(g.liveMicroUsd)}  = ${usd(g.driftMicroUsd)}`);
    }

    console.log(`   BASIS DIVERGENCE${d.trustworthy ? "" : "   (NOT TRUSTWORTHY — fidelity failed)"}`);
    console.log(`     llm-only ${usd(d.llmOnlyMicroUsd)}   vendor ${usd(d.vendorMicroUsd)}   all-vendor ${usd(d.allVendorMicroUsd)}`);
    console.log(`     the new basis is ${d.increasePercent.toFixed(2)}% larger than the one the live gate enforces on`);
    console.log(`   readyForCutoverEvidence: ${report.readyForCutoverEvidence}  (data trustworthy only — AC6 still needs Harsha)`);
  }

  console.log("");
}

main().catch((error) => {
  console.error("reconciliation report failed:", error);
  process.exit(1);
});
