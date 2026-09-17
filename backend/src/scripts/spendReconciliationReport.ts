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
 * SPEND_LEDGER_LLM_MIRROR_STARTED_AT does the same for LLM events (ENG-1934). It
 * defaults to LLM_SPEND_LEDGER_STARTED_ON, the day they began in production;
 * set it to `off` to reconcile the vendor rail alone.
 *
 * With no billingUserId it reports every subject that has spend events in the
 * month, which is what you want while the ledger is small.
 */
import { SpendEvent, SPEND_EVENTS_TABLE } from "../services/spendEventDb";
import { UsageRecordRow, usageRecordDb } from "../services/usageRecordDb";
import { reconcileMonth, selectReconcilableSubjects } from "../services/spendReconciliation";
import { LLM_SPEND_LEDGER_STARTED_ON } from "../services/spendLedgerDualWrite";
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
  const llmSetting = process.env.SPEND_LEDGER_LLM_MIRROR_STARTED_AT;
  const llmMirrorStartedAt =
    llmSetting === "off" ? undefined : llmSetting || `${LLM_SPEND_LEDGER_STARTED_ON}T00:00:00.000Z`;

  const events = await scanAllSpendEvents(month);
  const liveRowsForMonth = await usageRecordDb.scanByDateRange(`${month}-01`, `${month}-31`);

  // Subjects come from BOTH rails, not just the ledger (CodeRabbit, PR #2805).
  // Deriving them from spend events alone hides the single worst case this
  // report exists to catch: a subject whose mirror writes ALL failed has no
  // events, so it would be absent from the list, never loaded, and its
  // unmirrored spend would be invisible -- the report would print clean
  // precisely when the mirror had failed hardest.
  const { reconcilable, llmOnly } = selectReconcilableSubjects(events, liveRowsForMonth, {
    includeLlm: !!llmMirrorStartedAt,
  });
  const subjects = only ? [only] : reconcilable;

  console.log(`\nENG-1250 §8 internal reconciliation — ${month}`);
  console.log(`table: ${SPEND_EVENTS_TABLE}   spend events in month: ${events.length}`);
  console.log(
    mirrorStartedAt
      ? `fidelity scoped to days after the mirror started (${mirrorStartedAt})`
      : "fidelity UNSCOPED — set SPEND_LEDGER_MIRROR_STARTED_AT or every pre-mirror row reads as a failure",
  );
  console.log(
    llmMirrorStartedAt
      ? `LLM fidelity from ${llmMirrorStartedAt} (LLM groups print as llm:<model>)`
      : "LLM fidelity OFF — vendor rail only",
  );

  if (!only && llmOnly.length > 0) {
    console.log(`${llmOnly.length} subject(s) with LLM spend only — not reconciled with LLM fidelity off, not listed`);
  }

  if (subjects.length === 0) {
    console.log("\nNo spend events and no vendor usage this month. Nothing to reconcile.\n");
    return;
  }

  // Grouped once from the single scan above rather than re-queried per subject:
  // the same rows, one pass instead of N.
  const liveRowsBySubject = new Map<string, UsageRecordRow[]>();
  for (const row of liveRowsForMonth) {
    const list = liveRowsBySubject.get(row.billingUserId);
    if (list) list.push(row);
    else liveRowsBySubject.set(row.billingUserId, [row]);
  }

  for (const billingUserId of subjects) {
    const liveRows: UsageRecordRow[] = liveRowsBySubject.get(billingUserId) ?? [];
    const report = reconcileMonth(billingUserId, month, events, liveRows, { mirrorStartedAt, llmMirrorStartedAt });
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
