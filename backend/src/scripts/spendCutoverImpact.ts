/**
 * READ-ONLY blast-radius report for the ENG-1250 §9 enforcement cutover.
 *
 * A thin orchestrator over `classifyCutoverImpact` (services/spendCutoverImpact):
 * fetch the month's usage, pool it onto the billing owner the gate would use,
 * resolve each account's cap the way the projection does, classify, print. All the
 * logic worth trusting lives in the tested service; this file only does IO and
 * formatting.
 *
 * Spend is POOLED by billing owner (ENG-2286): the gate measures an org member
 * against their owner's cap, so summing by the recorded id modelled a gate that
 * does not exist.
 *
 *   npx ts-node src/scripts/spendCutoverImpact.ts [YYYY-MM]
 */
import { isVendorEntry, usageRecordDb } from "../services/usageRecordDb";
import { getSubscriptionTypeConfig } from "../services/subscriptionService";
import { getLlmUsageCreditAdjustment } from "../services/llmUsageCreditService";
import { userDb } from "../services/db";
import { resolveBillingUserId } from "../services/tokenUsageService";
import { classifyCutoverImpact, CutoverAccountInput, poolSpendByOwner } from "../services/spendCutoverImpact";

const MICRO = 1e6;
const usd = (m: number) => `$${(m / MICRO).toFixed(2)}`;

async function main(): Promise<void> {
  const month = process.argv[2] || new Date().toISOString().slice(0, 7);
  const rows = await usageRecordDb.scanByDateRange(`${month}-01`, `${month}-31`);

  const perSubject = new Map<string, { llm: number; vendor: number }>();
  for (const r of rows) {
    if (!r.billingUserId) continue;
    const acc = perSubject.get(r.billingUserId) || { llm: 0, vendor: 0 };
    if (isVendorEntry(r)) acc.vendor += r.costMicroUsd;
    else acc.llm += r.costMicroUsd;
    perSubject.set(r.billingUserId, acc);
  }

  // Pool onto the billing owner the gate checks. An id that cannot be resolved stays
  // its own subject — the restrictive direction, exactly as resolveBillingUserId does.
  const ownerOf = new Map<string, string>();
  for (const id of perSubject.keys()) {
    try {
      ownerOf.set(id, await resolveBillingUserId(id));
    } catch (e) {
      console.error(`could not resolve a billing owner for ${id}; treating it as its own subject:`, e instanceof Error ? e.message : e);
    }
  }
  const pooled = poolSpendByOwner(perSubject, ownerOf);

  const inputs: CutoverAccountInput[] = [];
  for (const [billingUserId, agg] of pooled) {
    const user = await userDb.getUserById(billingUserId);
    const tier = user?.subscriptionType || "Unknown";
    const policy = (await getSubscriptionTypeConfig(tier))?.llmUsagePolicy ?? null;
    // Same allowance arithmetic the projection uses, so this model and the
    // shipped enforcement path cannot disagree about what an account may spend.
    const adj = getLlmUsageCreditAdjustment(user?.llmUsageCredits, month);
    inputs.push({
      billingUserId,
      tier,
      llmMicroUsd: agg.llm,
      vendorMicroUsd: agg.vendor,
      capMicroUsd:
        policy == null
          ? null
          : policy.hardCostThresholdMicroUsd + adj.purchasedMicroUsd + adj.adminGrantedMicroUsd + adj.migrationOffsetMicroUsd,
    });
  }

  const s = classifyCutoverImpact(inputs);

  console.log(`\nENG-1250 §9 cutover impact — ${month}`);
  console.log(`subjects with usage: ${s.assessed}   with a configured cap: ${s.capped}   uncapped: ${s.uncapped}\n`);
  console.log(`  already paused on today's basis : ${s.alreadyPaused}`);
  console.log(`  NEWLY paused by the cutover     : ${s.newlyPaused}`);
  console.log(`  pushed past 50% but not paused  : ${s.pushedPast50}\n`);

  const folded = [...pooled.values()].filter((p) => p.pooledFrom.length > 0);
  if (folded.length) {
    console.log("  Org members pooled onto their billing owner (as the gate does):");
    for (const p of folded) {
      for (const m of p.pooledFrom) {
        console.log(
          `    ${m.id} -> ${p.billingUserId}  llm=${usd(m.llm)} vendor=${usd(m.vendor)}`,
        );
      }
    }
    console.log("");
  }

  const newly = s.accounts.filter((a) => a.newlyPaused);
  if (newly.length) {
    console.log("  Accounts that would pause the moment enforcement moves:");
    for (const a of newly) {
      console.log(
        `    ${a.billingUserId}  tier=${a.tier}  cap=${usd(a.capMicroUsd!)}  ` +
          `llm=${usd(a.llmMicroUsd)} (${a.percentNow!.toFixed(1)}%) -> all-vendor=${usd(a.llmMicroUsd + a.vendorMicroUsd)} (${a.percentAfter!.toFixed(1)}%)`,
      );
    }
  }

  console.log("  Largest vendor-share accounts, against their real caps:");
  for (const a of [...s.accounts].filter((x) => x.capMicroUsd != null).sort((x, y) => y.vendorMicroUsd - x.vendorMicroUsd).slice(0, 6)) {
    console.log(
      `    ${a.billingUserId}  tier=${a.tier}  cap=${usd(a.capMicroUsd!)}  ` +
        `llm=${usd(a.llmMicroUsd)}  vendor=${usd(a.vendorMicroUsd)}  now=${a.percentNow!.toFixed(1)}% -> after=${a.percentAfter!.toFixed(1)}%`,
    );
  }
  console.log("");
}

main().catch((e) => {
  console.error("cutover impact model failed:", e);
  process.exit(1);
});
