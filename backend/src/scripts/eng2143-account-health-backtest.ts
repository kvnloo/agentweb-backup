/**
 * ENG-2143 backtest: classify historical accounts as of a cutoff date and compare with what
 * actually happened in the following horizon. Read-only (DynamoDB scans only). Prints counts,
 * never emails or ids.
 *
 *   npx ts-node --transpile-only src/scripts/eng2143-account-health-backtest.ts
 *   ... --cutoff=2026-06-01 --cutoff=2026-07-01 --horizon-days=30
 *
 * Default cutoffs: back-to-back windows ending today (see defaultCutoffs).
 * Unit: one (account, cutoff) pair. Population at cutoff C: accounts that had a subscription
 * (AW-Users subscription_status set), existed at C, had not already canceled by C, and whose
 * cancellation, if any, is dated by an AW-PaymentHistory `subscription_canceled` event (a
 * `canceled` status with no dated event cannot be placed in time and is excluded, counted).
 * Truth: churned = a `subscription_canceled` event in (C, C + horizon]. Prediction: churned =
 * the classifier says `at_risk`.
 *
 * Signals are rebuilt as of C: payment events and ad spend up to C, ad accounts connected by C
 * with token expiry judged at C, activity only when last seen before C. Current subscription
 * status is NOT used (it would leak the outcome). Known approximations: refresh tokens and the
 * legacy `adAccount` field are current values; no campaign-level delivery exists, so zero
 * delivery is never evaluated; requirement fields do not exist before OPS-4.
 */
import AWS from "aws-sdk";
import { classifyAccountHealth, type AccountHealthState } from "../services/accountHealthClassifier";
import type { AdConnectionAccount } from "../services/clientHealthService";
import type { RequirementFields } from "../services/accountHealthClassifier";
import { perClassMetrics, wilsonInterval, type Interval, type LabelPair } from "../loops/eval/agreement";

const DAY_MS = 24 * 60 * 60 * 1000;
const PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

export interface BacktestUser {
  userId: string;
  createdAt?: string;
  subscription_status?: string;
  adAccount?: string;
  lastActiveAt?: string;
  connected_accounts?: Array<AdConnectionAccount & { created_at?: string }>;
}

export interface BacktestPayment {
  userId: string;
  timestamp: string;
  eventType: string;
}

export interface BacktestSpendRow {
  userId: string;
  date: string;
  spend: number;
}

export interface BacktestData {
  users: BacktestUser[];
  payments: BacktestPayment[];
  requirements: Map<string, RequirementFields>;
  spend: BacktestSpendRow[];
}

export type Outcome = "churned" | "retained";

export interface BacktestCase {
  cutoff: string;
  truth: Outcome;
  state: AccountHealthState;
}

export interface CutoffPopulation {
  cases: BacktestCase[];
  excludedUndatedCancel: number;
  excludedAlreadyChurned: number;
  excludedNotYetPaying: number;
}

const byUser = <T extends { userId: string }>(rows: readonly T[]): Map<string, T[]> => {
  const map = new Map<string, T[]>();
  for (const row of rows) map.set(row.userId, [...(map.get(row.userId) ?? []), row]);
  return map;
};

/** Classify every eligible account as of `cutoffMs` and label it with the horizon outcome. */
export function buildCutoffPopulation(data: BacktestData, cutoffMs: number, horizonMs: number): CutoffPopulation {
  const payments = byUser(data.payments);
  const spend = byUser(data.spend);
  const firstSpendDate = data.spend.reduce<string | null>((min, r) => (min === null || r.date < min ? r.date : min), null);
  const cutoffIso = new Date(cutoffMs).toISOString();
  const out: CutoffPopulation = { cases: [], excludedUndatedCancel: 0, excludedAlreadyChurned: 0, excludedNotYetPaying: 0 };

  for (const user of data.users) {
    if (!user.subscription_status || user.userId.startsWith("eval_")) continue;
    const createdMs = user.createdAt ? Date.parse(user.createdAt) : NaN;
    if (!(createdMs <= cutoffMs)) continue;
    const events = (payments.get(user.userId) ?? []).map((e) => ({ ...e, at: Date.parse(e.timestamp) }));
    const cancels = events.filter((e) => e.eventType === "subscription_canceled").map((e) => e.at);
    const creates = events.filter((e) => e.eventType === "subscription_created").map((e) => e.at);
    // A later subscription or successful payment means the account came back after a cancellation.
    const reactivations = events
      .filter((e) => e.eventType === "subscription_created" || e.eventType === "payment_succeeded")
      .map((e) => e.at);

    if (user.subscription_status === "canceled" && cancels.length === 0) {
      out.excludedUndatedCancel++;
      continue;
    }
    const lastCancelBefore = Math.max(-Infinity, ...cancels.filter((t) => t <= cutoffMs));
    if (lastCancelBefore > -Infinity && !reactivations.some((t) => t > lastCancelBefore && t <= cutoffMs)) {
      out.excludedAlreadyChurned++;
      continue;
    }
    // An account whose first subscription starts after C was not paying yet. Only subscription
    // evidence counts: a failed checkout before C does not make the account a paying one.
    if (creates.length > 0 && Math.min(...creates) > cutoffMs && !reactivations.some((t) => t <= cutoffMs)) {
      out.excludedNotYetPaying++;
      continue;
    }
    const truth: Outcome = cancels.some((t) => t > cutoffMs && t <= cutoffMs + horizonMs) ? "churned" : "retained";

    const windowStart = new Date(cutoffMs - 30 * DAY_MS).toISOString().slice(0, 10);
    const cutoffDate = cutoffIso.slice(0, 10);
    const recentAdSpend =
      firstSpendDate !== null && firstSpendDate <= windowStart
        ? (spend.get(user.userId) ?? [])
            .filter((r) => r.date > windowStart && r.date <= cutoffDate)
            .reduce((sum, r) => sum + r.spend, 0)
        : null;
    const requirement = data.requirements.get(user.userId) ?? null;
    const verifiedMs = requirement?.requirementVerifiedAt ? Date.parse(requirement.requirementVerifiedAt) : NaN;

    const result = classifyAccountHealth({
      nowMs: cutoffMs,
      connectedAccounts: (user.connected_accounts ?? []).filter(
        (acc) => !acc.created_at || Date.parse(acc.created_at) <= cutoffMs,
      ),
      legacyAdAccount: user.adAccount,
      requirement: requirement && verifiedMs <= cutoffMs ? requirement : null,
      payments: events.filter((e) => e.at <= cutoffMs).map(({ eventType, timestamp }) => ({ eventType, timestamp })),
      campaigns: null,
      recentAdSpend,
      lastActiveAt: user.lastActiveAt && Date.parse(user.lastActiveAt) <= cutoffMs ? user.lastActiveAt : null,
    });
    out.cases.push({ cutoff: cutoffDate, truth, state: result.state });
  }
  return out;
}

export interface BacktestMetrics {
  n: number;
  positives: number;
  predictedPositives: number;
  tp: number;
  precision: number | null;
  precisionCI: Interval | null;
  recall: number | null;
  recallCI: Interval | null;
  stateByTruth: Record<Outcome, Record<AccountHealthState, number>>;
}

export function scoreBacktest(cases: readonly BacktestCase[]): BacktestMetrics {
  const empty = (): Record<AccountHealthState, number> => ({ activation_incomplete: 0, at_risk: 0, healthy: 0, insufficient_evidence: 0 });
  const stateByTruth: Record<Outcome, Record<AccountHealthState, number>> = { churned: empty(), retained: empty() };
  for (const c of cases) stateByTruth[c.truth][c.state]++;
  const positives = cases.filter((c) => c.truth === "churned").length;
  const predictedPositives = cases.filter((c) => c.state === "at_risk").length;
  const tp = stateByTruth.churned.at_risk;
  const pairs: LabelPair<Outcome>[] = cases.map((c) => ({ truth: c.truth, predicted: c.state === "at_risk" ? "churned" : "retained" }));
  const churned = pairs.length > 0 ? perClassMetrics(pairs).churned : undefined;
  return {
    n: cases.length,
    positives,
    predictedPositives,
    tp,
    precision: churned?.precision ?? null,
    precisionCI: predictedPositives > 0 ? wilsonInterval(tp, predictedPositives) : null,
    recall: churned?.recall ?? null,
    recallCI: positives > 0 ? wilsonInterval(tp, positives) : null,
    stateByTruth,
  };
}

async function scanAll<T>(
  dynamodb: AWS.DynamoDB.DocumentClient,
  params: AWS.DynamoDB.DocumentClient.ScanInput,
): Promise<T[]> {
  const items: T[] = [];
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  do {
    const page = await dynamodb.scan({ ...params, ...(lastKey ? { ExclusiveStartKey: lastKey } : {}) }).promise();
    items.push(...((page.Items ?? []) as T[]));
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function loadData(): Promise<BacktestData> {
  const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
  const [users, payments, capabilityRows, spend] = await Promise.all([
    scanAll<BacktestUser>(dynamodb, {
      TableName: `${PREFIX}AW-Users`,
      ProjectionExpression: "userId, createdAt, subscription_status, adAccount, lastActiveAt, connected_accounts",
    }),
    scanAll<BacktestPayment>(dynamodb, {
      TableName: `${PREFIX}AW-PaymentHistory`,
      ProjectionExpression: "userId, #ts, eventType",
      ExpressionAttributeNames: { "#ts": "timestamp" },
    }),
    scanAll<RequirementFields & { userId: string; capability: string }>(dynamodb, {
      TableName: `${PREFIX}AW-AccountCapabilityRequirements`,
    }),
    scanAll<BacktestSpendRow>(dynamodb, {
      TableName: `${PREFIX}AW-AdsMetricsSnapshots`,
      FilterExpression: "rowType = :accountDay",
      ProjectionExpression: "userId, #date, spend",
      ExpressionAttributeNames: { "#date": "date" },
      ExpressionAttributeValues: { ":accountDay": "account_day" },
    }),
  ]);
  const requirements = new Map<string, RequirementFields>();
  for (const row of capabilityRows) {
    if (row.capability === "ad_platform_integration") requirements.set(row.userId, row);
  }
  return {
    users: users.filter((u) => !u.userId.startsWith("deleted_")),
    payments: payments.filter((p) => p.userId !== "__dedup__"),
    requirements,
    spend,
  };
}

const pct = (x: number | null) => (x === null ? "n/a" : x.toFixed(2));
const ci = (i: Interval | null) => (i === null ? "n/a" : `[${i.low.toFixed(2)}, ${i.high.toFixed(2)}]`);

function report(label: string, metrics: BacktestMetrics): void {
  console.log(
    `${label}: n=${metrics.n} churned=${metrics.positives} predicted_at_risk=${metrics.predictedPositives} tp=${metrics.tp} ` +
      `precision=${pct(metrics.precision)} ${ci(metrics.precisionCI)} recall=${pct(metrics.recall)} ${ci(metrics.recallCI)}`,
  );
  for (const truth of ["churned", "retained"] as const) {
    console.log(`  ${truth.padEnd(8)} ${JSON.stringify(metrics.stateByTruth[truth])}`);
  }
}

/**
 * Back-to-back, non-overlapping horizon windows ending today, so each cancellation is counted in
 * exactly one window. The earliest window starts no earlier than the first payment event.
 */
export function defaultCutoffs(horizonMs: number, nowMs: number, earliestMs: number): number[] {
  const cutoffs: number[] = [];
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  for (let cutoff = today - horizonMs; cutoff >= earliestMs; cutoff -= horizonMs) cutoffs.unshift(cutoff);
  return cutoffs;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const horizonDays = Number(argv.find((a) => a.startsWith("--horizon-days="))?.split("=")[1] ?? 30);
  const horizonMs = horizonDays * DAY_MS;
  const explicit = argv.filter((a) => a.startsWith("--cutoff=")).map((a) => Date.parse(a.split("=")[1]));
  if (!(horizonDays > 0) || explicit.some((c) => !Number.isFinite(c))) throw new Error("bad --cutoff or --horizon-days");
  const data = await loadData();
  const firstEvent = Math.min(...data.payments.map((p) => Date.parse(p.timestamp)).filter(Number.isFinite));
  const cutoffs = explicit.length > 0 ? explicit : defaultCutoffs(horizonMs, Date.now(), firstEvent);
  console.log(
    `[eng2143-backtest] read-only: users=${data.users.length} payment_events=${data.payments.length} ` +
      `capability_rows=${data.requirements.size} spend_rows=${data.spend.length} horizon=${horizonDays}d`,
  );
  const all: BacktestCase[] = [];
  for (const cutoff of cutoffs) {
    const population = buildCutoffPopulation(data, cutoff, horizonMs);
    all.push(...population.cases);
    report(`cutoff ${new Date(cutoff).toISOString().slice(0, 10)}`, scoreBacktest(population.cases));
    console.log(
      `  excluded: undated_cancel=${population.excludedUndatedCancel} already_churned=${population.excludedAlreadyChurned} ` +
        `not_yet_paying=${population.excludedNotYetPaying}`,
    );
  }
  report(`pooled over ${cutoffs.length} cutoff(s) (pairs, not independent accounts)`, scoreBacktest(all));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(`[eng2143-backtest] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
