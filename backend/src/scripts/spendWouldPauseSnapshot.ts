/**
 * ENG-1250 §9.6 gate 5 — capture the would-pause list as a durable, recordable
 * artifact, to be run immediately BEFORE an enforcement flip and attached to the
 * issue as the evidence that the blast radius was known at cutover time.
 *
 * It is the same blast-radius model as `spendCutoverImpact.ts` (same scan, same
 * cap arithmetic, same `classifyCutoverImpact`), but instead of printing a
 * report it writes:
 *   - a JSON record (machine evidence: counts, the full would-pause list, the
 *     enforcement flag state at capture time, and the git head if available), and
 *   - a Markdown summary (for pasting onto the Linear issue),
 * both timestamped, and echoes the Markdown to stdout.
 *
 * Signed-off remedies (the customer-facing decisions already made) are annotated
 * per account, so the record distinguishes an account that WILL pause from one a
 * remedy already covers.
 *
 *   npx ts-node src/scripts/spendWouldPauseSnapshot.ts [YYYY-MM] [outDir]
 */
import { execSync } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import { isVendorEntry, usageRecordDb } from "../services/usageRecordDb";
import { getSubscriptionTypeConfig } from "../services/subscriptionService";
import { getLlmUsageCreditAdjustment } from "../services/llmUsageCreditService";
import { userDb } from "../services/db";
import { classifyCutoverImpact, CutoverAccountInput } from "../services/spendCutoverImpact";
import { SPEND_LEDGER_ENFORCEMENT_ENV, SPEND_LEDGER_ENFORCEMENT_ACCOUNTS_ENV } from "../services/spendEnforcementBasis";

const MICRO = 1e6;
const usd = (m: number) => `$${(m / MICRO).toFixed(2)}`;

/**
 * The customer-facing cutover decisions already signed off, keyed by account.
 * An account listed here that would pause is covered by a remedy rather than a
 * cold pause — the record says which, so nobody is surprised at flip time.
 */
const SIGNED_OFF_REMEDIES: Record<string, { decision: string; note: string }> = {
  "bb07579b-2d82-4d45-894f-ec74ec7e78c2": {
    decision: "grandfather-notify (option 1b, 2026-09)",
    note:
      "Let the current cycle ride; notify the account that vendor spend now counts and they are over cap so the next cycle is expected. Ramping Starter; overage is legitimate Apollo enrichment.",
  },
};

async function buildInputs(month: string): Promise<CutoverAccountInput[]> {
  const rows = await usageRecordDb.scanByDateRange(`${month}-01`, `${month}-31`);
  const perSubject = new Map<string, { llm: number; vendor: number }>();
  for (const r of rows) {
    if (!r.billingUserId) continue;
    const acc = perSubject.get(r.billingUserId) || { llm: 0, vendor: 0 };
    if (isVendorEntry(r)) acc.vendor += r.costMicroUsd;
    else acc.llm += r.costMicroUsd;
    perSubject.set(r.billingUserId, acc);
  }

  const inputs: CutoverAccountInput[] = [];
  for (const [billingUserId, agg] of perSubject) {
    const user = await userDb.getUserById(billingUserId);
    const tier = user?.subscriptionType || "Unknown";
    const policy = (await getSubscriptionTypeConfig(tier))?.llmUsagePolicy ?? null;
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
  return inputs;
}

function headCommit(): string | null {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function enforcementFlagState() {
  return {
    [SPEND_LEDGER_ENFORCEMENT_ENV]: process.env[SPEND_LEDGER_ENFORCEMENT_ENV] ?? null,
    [SPEND_LEDGER_ENFORCEMENT_ACCOUNTS_ENV]: process.env[SPEND_LEDGER_ENFORCEMENT_ACCOUNTS_ENV] ?? null,
  };
}

function markdown(record: ReturnType<typeof buildRecord>): string {
  const lines: string[] = [];
  lines.push(`## ENG-1250 §9.6 would-pause snapshot — ${record.month}`);
  lines.push("");
  lines.push(`Captured ${record.capturedAt}${record.headCommit ? ` at \`${record.headCommit.slice(0, 12)}\`` : ""}.`);
  lines.push(
    `Enforcement flag at capture: \`${SPEND_LEDGER_ENFORCEMENT_ENV}=${record.enforcementFlag[SPEND_LEDGER_ENFORCEMENT_ENV] ?? "(unset → legacy/dark)"}\`.`,
  );
  lines.push("");
  lines.push(
    `Subjects ${record.summary.assessed} · capped ${record.summary.capped} · uncapped ${record.summary.uncapped} · ` +
      `already paused ${record.summary.alreadyPaused} · **newly paused ${record.summary.newlyPaused}** · past-50% ${record.summary.pushedPast50}`,
  );
  lines.push("");
  if (record.wouldPause.length === 0) {
    lines.push("**No accounts would newly pause at the flip.**");
  } else {
    lines.push(`### Would pause the moment enforcement flips (${record.wouldPause.length})`);
    lines.push("");
    lines.push("| account | tier | cap | now | after | remedy |");
    lines.push("|---|---|---|---|---|---|");
    for (const a of record.wouldPause) {
      const remedy = a.remedy ? a.remedy.decision : "**none — cold pause**";
      lines.push(
        `| \`${a.billingUserId.slice(0, 12)}…\` | ${a.tier} | ${usd(a.capMicroUsd!)} | ` +
          `${usd(a.llmMicroUsd)} (${a.percentNow!.toFixed(1)}%) | ${usd(a.llmMicroUsd + a.vendorMicroUsd)} (${a.percentAfter!.toFixed(1)}%) | ${remedy} |`,
      );
    }
    lines.push("");
    const uncovered = record.wouldPause.filter((a) => !a.remedy);
    if (uncovered.length) {
      lines.push(`⚠️ ${uncovered.length} would-pause account(s) have NO signed-off remedy — do not flip until each is decided.`);
    } else {
      lines.push("✅ Every would-pause account is covered by a signed-off remedy.");
    }
  }
  return lines.join("\n");
}

function buildRecord(month: string, summary: ReturnType<typeof classifyCutoverImpact>, head: string | null) {
  const wouldPause = summary.accounts
    .filter((a) => a.newlyPaused)
    .map((a) => ({ ...a, remedy: SIGNED_OFF_REMEDIES[a.billingUserId] ?? null }));
  return {
    artifact: "eng1250-would-pause-snapshot",
    month,
    capturedAt: new Date().toISOString(),
    headCommit: head,
    enforcementFlag: enforcementFlagState(),
    summary: {
      assessed: summary.assessed,
      capped: summary.capped,
      uncapped: summary.uncapped,
      alreadyPaused: summary.alreadyPaused,
      newlyPaused: summary.newlyPaused,
      pushedPast50: summary.pushedPast50,
    },
    wouldPause,
  };
}

async function main(): Promise<void> {
  const month = process.argv[2] || new Date().toISOString().slice(0, 7);
  const outDir = process.argv[3] || process.cwd();

  const inputs = await buildInputs(month);
  const summary = classifyCutoverImpact(inputs);
  const record = buildRecord(month, summary, headCommit());
  const md = markdown(record);

  const stamp = record.capturedAt.replace(/[:.]/g, "-");
  const base = path.join(outDir, `eng1250-would-pause-${month}-${stamp}`);
  await fs.writeFile(`${base}.json`, JSON.stringify(record, null, 2));
  await fs.writeFile(`${base}.md`, md + "\n");

  console.log(md);
  console.log(`\nwrote ${base}.json`);
  console.log(`wrote ${base}.md`);
}

main().catch((e) => {
  console.error("would-pause snapshot failed:", e);
  process.exit(1);
});
