/**
 * ENG-664 demo-data seeder — populates the X (Twitter) usage/cost views with
 * realistic, deterministic rows so the admin "Usage & Cost" tab, the reconciliation
 * panel, the by-account table, and the per-user X breakdown modal render with data.
 *
 * This is a DEV convenience script, NOT production plumbing:
 *   - Refuses to run against production (NODE_ENV === "production").
 *   - Writes through the SAME primitive the live meter uses
 *     (`usageRecordDb.incrementUsage`) with the SAME row shape twitterService
 *     writes: model=`twitter:{op}`, feature=`x-account:{id}`, provider="twitter",
 *     unit/quantity/costSource="allocated". So the seeded rows are indistinguishable
 *     in shape from real metered calls — the views treat them identically.
 *   - Fully deterministic (no randomness), so `--clean` regenerates the exact same
 *     keys and removes precisely what was seeded — nothing else in the ledger.
 *   - Attaches a demo twitter connected_account to each owner so the by-account
 *     table resolves an @handle (enrichment reads connected_accounts off the owner).
 *
 * Usage:
 *   NODE_ENV=development npx ts-node src/scripts/seed-eng664-demo.ts          # seed
 *   NODE_ENV=development npx ts-node src/scripts/seed-eng664-demo.ts --clean  # remove
 */

import AWS from "aws-sdk";
import { usageRecordDb } from "../services/usageRecordDb";
import { createAccount, deleteAccountById } from "../services/connectedAccountsDb";
import { userDb } from "../services/db";
import {
  computeTwitterCost,
  TwitterOperation,
  TWITTER_PROVIDER,
} from "../utils/twitterPricing";

// ── Demo cast ────────────────────────────────────────────────────────────────
// Real dev users so the per-user table shows recognizable emails. If an email is
// absent in this DB it's skipped with a warning (the seed still works for the rest).
const ACCOUNTS = [
  {
    ownerEmail: "test@example.com",
    accountId: "eng664-demo-acct-agentweb",
    handle: "agentweb_hq",
    accountName: "AgentWeb HQ",
    // A busy reply-guy account: heavy search + reads, steady posting.
    activity: 3,
  },
  {
    ownerEmail: "shanshan220@gmail.com",
    accountId: "eng664-demo-acct-growthlab",
    handle: "growthlab_ss",
    accountName: "GrowthLab",
    activity: 2,
  },
  {
    ownerEmail: "jeong@margentic.com",
    accountId: "eng664-demo-acct-margentic",
    handle: "margentic_io",
    accountName: "Margentic",
    activity: 1,
  },
] as const;

// One org member who acts on the AgentWeb HQ account (Option B: the member is the
// acting `userId`, the owner is `billingUserId`). Demonstrates the acting-vs-billing
// split in the per-user table without changing who the cost bills to.
const ACTING_MEMBER_EMAIL = "ruiwa.ng.wa.rm@gmail.com";

// Per-day operation mix. Units scale by the account's `activity` factor and a
// deterministic per-day wobble so the time series isn't a flat line. `link` marks
// post-creates that carry a URL (triggers the $0.20 rate instead of $0.015).
const DAILY_OPS: Array<{
  op: TwitterOperation;
  base: number;
  link?: boolean;
  // Fraction of this op's volume attributed to the acting member (AgentWeb HQ only).
  memberShare?: number;
}> = [
  { op: "search_tweets", base: 8, memberShare: 0.5 },
  { op: "get_user_tweets", base: 4, memberShare: 0.5 },
  { op: "get_profile", base: 3, memberShare: 0.3 },
  { op: "resolve_handle", base: 2 },
  { op: "post", base: 1 },
  { op: "reply", base: 2, memberShare: 0.5 },
  { op: "quote", base: 1, link: true },
  { op: "like", base: 5 },
  { op: "follow", base: 1 },
];

const DAYS = 21; // rolling window that fits the tab's 30-day default range

function dateNDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Deterministic 0-based wobble in {0,1,2} from (dayIndex, opIndex) — no randomness,
// so `--clean` reproduces identical quantities and keys.
function wobble(dayIndex: number, opIndex: number): number {
  return (dayIndex * 7 + opIndex * 3) % 3;
}

async function resolveOwners() {
  const resolved: Array<{
    cfg: (typeof ACCOUNTS)[number];
    ownerId: string;
  }> = [];
  for (const cfg of ACCOUNTS) {
    const user = await userDb.getUserByEmail(cfg.ownerEmail);
    if (!user?.userId) {
      console.warn(`  ⚠ skipping ${cfg.ownerEmail} — not found in this DB`);
      continue;
    }
    resolved.push({ cfg, ownerId: user.userId });
  }
  return resolved;
}

async function seed() {
  const owners = await resolveOwners();
  if (!owners.length) {
    console.error("No demo owners resolved — nothing to seed.");
    return;
  }

  const member = await userDb.getUserByEmail(ACTING_MEMBER_EMAIL);
  const memberId = member?.userId as string | undefined;
  if (!memberId) {
    console.warn(
      `  ⚠ acting member ${ACTING_MEMBER_EMAIL} not found — member rows fall back to owner attribution`
    );
  }

  let rowWrites = 0;
  for (const { cfg, ownerId } of owners) {
    // Attach a demo twitter account to the owner so the by-account table resolves
    // the @handle (idempotent — createAccount upserts on platform+account_id).
    await createAccount(ownerId, "twitter", {
      account_id: cfg.accountId,
      account_name: cfg.accountName,
      config: { username: cfg.handle } as any,
    });

    for (let day = 0; day < DAYS; day++) {
      const date = dateNDaysAgo(day);
      for (let oi = 0; oi < DAILY_OPS.length; oi++) {
        const spec = DAILY_OPS[oi];
        const units = spec.base * cfg.activity + wobble(day, oi);
        if (units <= 0) continue;

        const memberUnits =
          cfg.accountId === "eng664-demo-acct-agentweb" && memberId && spec.memberShare
            ? Math.floor(units * spec.memberShare)
            : 0;
        const ownerUnits = units - memberUnits;

        for (const [actingId, u] of [
          [ownerId, ownerUnits],
          [memberId, memberUnits],
        ] as Array<[string | undefined, number]>) {
          if (!actingId || u <= 0) continue;
          const cost = computeTwitterCost(spec.op, u, { hasLink: spec.link });
          await usageRecordDb.incrementUsage({
            userId: actingId,
            billingUserId: ownerId,
            date,
            model: `${TWITTER_PROVIDER}:${spec.op}`,
            feature: `x-account:${cfg.accountId}`,
            inputTokens: 0,
            outputTokens: 0,
            costMicroUsd: Math.round(cost.costUsd * 1e6),
            provider: TWITTER_PROVIDER,
            unit: cost.unit,
            quantity: cost.quantity,
            costSource: "allocated",
          });
          rowWrites++;
        }
      }
    }
    console.log(`  ✓ seeded ${cfg.handle} (@${cfg.accountId}) owned by ${cfg.ownerEmail}`);
  }
  console.log(`Done. ${rowWrites} incrementUsage writes across ${owners.length} account(s).`);
}

async function clean() {
  const docClient = new AWS.DynamoDB.DocumentClient();
  const owners = await resolveOwners();
  const member = await userDb.getUserByEmail(ACTING_MEMBER_EMAIL);
  const memberId = member?.userId as string | undefined;
  const actingIds = new Set<string>();
  owners.forEach((o) => actingIds.add(o.ownerId));
  if (memberId) actingIds.add(memberId);

  const demoAccountIds = new Set<string>(ACCOUNTS.map((a) => a.accountId));
  const startDate = dateNDaysAgo(DAYS - 1);
  const endDate = dateNDaysAgo(0);

  let deleted = 0;
  for (const actingId of actingIds) {
    const rows = await usageRecordDb.queryByUserDateRange(actingId, startDate, endDate);
    for (const row of rows) {
      // Only remove rows this seeder could have written: twitter provider on a demo
      // account feature. Never touch real metered rows or any LLM row.
      const feat = row.feature || "";
      const acctId = feat.startsWith("x-account:") ? feat.slice("x-account:".length) : "";
      if (row.provider === TWITTER_PROVIDER && demoAccountIds.has(acctId)) {
        await docClient
          .delete({
            TableName: usageRecordDb.tableName,
            Key: { userId: actingId, sk: row.sk },
          })
          .promise();
        deleted++;
      }
    }
  }

  // Remove the demo connected_accounts from each owner.
  for (const { cfg, ownerId } of owners) {
    await deleteAccountById(ownerId, "twitter", cfg.accountId).catch(() => undefined);
  }
  console.log(`Cleaned ${deleted} demo ledger row(s) and detached demo accounts.`);
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run against production. Set NODE_ENV=development.");
    process.exit(1);
  }
  const mode = process.argv.includes("--clean") ? "clean" : "seed";
  console.log(`ENG-664 demo seeder — mode=${mode}, table=${usageRecordDb.tableName}`);
  if (mode === "clean") {
    await clean();
  } else {
    await seed();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
