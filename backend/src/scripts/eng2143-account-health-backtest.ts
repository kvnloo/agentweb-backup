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
 * cancellation, if any, is dated by an AW-PaymentHistory `subscription_canceled` event.
 * No stored field holds Stripe's `canceled_at` (AW-PaymentHistory keeps no raw event, AW-Users no
 * cancel timestamp). A `canceled` account with no Stripe-sourced payment event at all, created
 * before the payment log began, is placed before that start: every Stripe webhook since then
 * writes one (a cancellation writes `subscription_canceled`, every renewal `payment_succeeded`),
 * so it canceled — and stopped paying — before the log began, and is already churned at any
 * cutoff after it. Any other `canceled` status with no dated event is excluded, counted.
 * Truth: churned = a `subscription_canceled` event in (C, C + horizon]. Prediction: churned =
 * the classifier says `at_risk`.
 *
 * Signals are rebuilt as of C: payment events, ad days (campaign-row spend, account-day leads)
 * and explicit ratings up to C, ad accounts connected by C
 * with token expiry judged at C (an ad connection with no created_at excludes the pair), activity
 * only when last seen before C. Current subscription
 * status is NOT used (it would leak the outcome). Known approximations: refresh tokens and the
 * legacy `adAccount` field are current values; no campaign-level delivery exists, so zero
 * delivery is never evaluated; requirement fields do not exist before OPS-4; the tracking
 * monitor keeps no history, so pixel findings are never available as of C.
 */
import AWS from "aws-sdk";
import {
  buildAdDays,
  classifyAccountHealth,
  type AccountHealthState,
  type EvidenceCode,
} from "../services/accountHealthClassifier";
import type { AdConnectionAccount } from "../services/clientHealthService";
import { AD_HEALTH_PLATFORMS } from "../services/accountHealthService";
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

/** A campaign snapshot row's spend (account-day rows store spend 0 by design). */
export interface BacktestSpendRow {
  userId: string;
  date: string;
  spend: number;
}

/** An account-day snapshot row: marks the date as collected and carries its lead count. */
export interface BacktestLeadRow {
  userId: string;
  date: string;
  totalLeadCount?: number;
}

export interface BacktestFeedback {
  userId: string;
  type: string;
  timestamp: string;
}

export interface BacktestData {
  users: BacktestUser[];
  payments: BacktestPayment[];
  requirements: Map<string, RequirementFields>;
  spend: BacktestSpendRow[];
  accountDays: BacktestLeadRow[];
  feedback: BacktestFeedback[];
}

/** Payment events Stripe webhooks write; admin credit grants/adjustments are not Stripe's. */
const STRIPE_EVENT_TYPES = new Set([
  "subscription_created",
  "subscription_updated",
  "subscription_canceled",
  "payment_succeeded",
  "payment_failed",
  "refund",
]);

export type Outcome = "churned" | "retained";

export interface BacktestCase {
  cutoff: string;
  truth: Outcome;
  state: AccountHealthState;
  /** The risk and activation evidence codes that fired. */
  signals: EvidenceCode[];
}

export interface CutoffPopulation {
  cases: BacktestCase[];
  excludedUndatedCancel: number;
  /** Canceled with no Stripe event and created before the payment log: churned before it began. */
  canceledBeforePaymentLog: number;
  excludedAlreadyChurned: number;
  excludedNotYetPaying: number;
  /** An ad connection with no created_at may postdate the cutoff, so the pair is not scored. */
  excludedUndatedConnection: number;
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
  const accountDays = byUser(data.accountDays);
  const feedback = byUser(data.feedback);
  const firstSpendDate = data.spend.reduce<string | null>((min, r) => (min === null || r.date < min ? r.date : min), null);
  const paymentLogStart = Math.min(...data.payments.map((p) => Date.parse(p.timestamp)).filter(Number.isFinite));
  const cutoffIso = new Date(cutoffMs).toISOString();
  const out: CutoffPopulation = {
    cases: [],
    excludedUndatedCancel: 0,
    canceledBeforePaymentLog: 0,
    excludedAlreadyChurned: 0,
    excludedNotYetPaying: 0,
    excludedUndatedConnection: 0,
  };

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
      const noStripeEvent = !events.some((e) => STRIPE_EVENT_TYPES.has(e.eventType));
      if (noStripeEvent && createdMs < paymentLogStart && paymentLogStart <= cutoffMs) out.canceledBeforePaymentLog++;
      else out.excludedUndatedCancel++;
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
    const adConnections = (user.connected_accounts ?? []).filter((acc) => AD_HEALTH_PLATFORMS.has(acc.platform ?? ""));
    if (adConnections.some((acc) => !Number.isFinite(acc.created_at ? Date.parse(acc.created_at) : NaN))) {
      out.excludedUndatedConnection++;
      continue;
    }
    const truth: Outcome = cancels.some((t) => t > cutoffMs && t <= cutoffMs + horizonMs) ? "churned" : "retained";

    const windowStart = new Date(cutoffMs - 30 * DAY_MS).toISOString().slice(0, 10);
    const cutoffDate = cutoffIso.slice(0, 10);
    const recentAdSpend =
      firstSpendDate !== null && firstSpendDate <= windowStart
        ? (spend.get(user.userId) ?? [])
            // The 30 complete date labels before the cutoff day.
            .filter((r) => r.date >= windowStart && r.date < cutoffDate)
            .reduce((sum, r) => sum + r.spend, 0)
        : null;
    const cutoffDay = <T extends { date: string }>(rows: readonly T[]) => rows.filter((r) => r.date < cutoffDate);
    // Ad days exist only where snapshots were collected, so earlier cutoffs read "not evaluable".
    const adDays = buildAdDays(cutoffDay(accountDays.get(user.userId) ?? []), cutoffDay(spend.get(user.userId) ?? []));
    const requirement = data.requirements.get(user.userId) ?? null;
    const verifiedMs = requirement?.requirementVerifiedAt ? Date.parse(requirement.requirementVerifiedAt) : NaN;

    const result = classifyAccountHealth({
      nowMs: cutoffMs,
      connectedAccounts: (user.connected_accounts ?? []).filter(
        (acc) => !!acc.created_at && Date.parse(acc.created_at) <= cutoffMs,
      ),
      legacyAdAccount: user.adAccount,
      requirement: requirement && verifiedMs <= cutoffMs ? requirement : null,
      payments: events.filter((e) => e.at <= cutoffMs).map(({ eventType, timestamp }) => ({ eventType, timestamp })),
      campaigns: null,
      recentAdSpend,
      lastActiveAt: user.lastActiveAt && Date.parse(user.lastActiveAt) <= cutoffMs ? user.lastActiveAt : null,
      adDays,
      feedback: (feedback.get(user.userId) ?? []).filter((f) => Date.parse(f.timestamp) <= cutoffMs),
      tracking: null,
    });
    const signals = result.evidence.filter((e) => e.kind === "risk" || e.kind === "activation").map((e) => e.code);
    out.cases.push({ cutoff: cutoffDate, truth, state: result.state, signals });
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
  /** Per risk/activation code: pairs it fired on, and how many of those churned. */
  signalCounts: Record<string, { fired: number; churned: number }>;
}

export function scoreBacktest(cases: readonly BacktestCase[]): BacktestMetrics {
  const empty = (): Record<AccountHealthState, number> => ({ activation_incomplete: 0, at_risk: 0, healthy: 0, insufficient_evidence: 0 });
  const stateByTruth: Record<Outcome, Record<AccountHealthState, number>> = { churned: empty(), retained: empty() };
  const signalCounts: BacktestMetrics["signalCounts"] = {};
  for (const c of cases) {
    stateByTruth[c.truth][c.state]++;
    for (const code of new Set(c.signals)) {
      const counts = (signalCounts[code] ??= { fired: 0, churned: 0 });
      counts.fired++;
      if (c.truth === "churned") counts.churned++;
    }
  }
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
    signalCounts,
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
  const [users, payments, capabilityRows, snapshots, ratedSessions] = await Promise.all([
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
    scanAll<BacktestSpendRow & BacktestLeadRow & { rowType: string }>(dynamodb, {
      TableName: `${PREFIX}AW-AdsMetricsSnapshots`,
      FilterExpression: "rowType IN (:accountDay, :campaign)",
      ProjectionExpression: "userId, #date, spend, totalLeadCount, rowType",
      ExpressionAttributeNames: { "#date": "date" },
      ExpressionAttributeValues: { ":accountDay": "account_day", ":campaign": "campaign" },
    }),
    scanAll<{ userId?: string; feedbacks?: Record<string, { type?: string; timestamp?: string }> }>(dynamodb, {
      TableName: `${PREFIX}AW-ChatSessions`,
      FilterExpression: "attribute_exists(feedbacks)",
      ProjectionExpression: "userId, feedbacks",
    }),
  ]);
  const requirements = new Map<string, RequirementFields>();
  for (const row of capabilityRows) {
    if (row.capability === "ad_platform_integration") requirements.set(row.userId, row);
  }
  const feedback: BacktestFeedback[] = [];
  for (const session of ratedSessions) {
    for (const rating of Object.values(session.feedbacks ?? {})) {
      if (session.userId && rating?.type && rating.timestamp) {
        feedback.push({ userId: session.userId, type: rating.type, timestamp: rating.timestamp });
      }
    }
  }
  return {
    users: users.filter((u) => !u.userId.startsWith("deleted_")),
    payments: payments.filter((p) => p.userId !== "__dedup__"),
    requirements,
    spend: snapshots.filter((r) => r.rowType === "campaign"),
    accountDays: snapshots.filter((r) => r.rowType === "account_day"),
    feedback,
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
  console.log(`  signals  ${JSON.stringify(metrics.signalCounts)}`);
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
      `capability_rows=${data.requirements.size} campaign_spend_rows=${data.spend.length} ` +
      `account_day_rows=${data.accountDays.length} ratings=${data.feedback.length} horizon=${horizonDays}d`,
  );
  const all: BacktestCase[] = [];
  for (const cutoff of cutoffs) {
    const population = buildCutoffPopulation(data, cutoff, horizonMs);
    all.push(...population.cases);
    report(`cutoff ${new Date(cutoff).toISOString().slice(0, 10)}`, scoreBacktest(population.cases));
    console.log(
      `  excluded: undated_cancel=${population.excludedUndatedCancel} canceled_before_payment_log=${population.canceledBeforePaymentLog} ` +
        `already_churned=${population.excludedAlreadyChurned} ` +
        `not_yet_paying=${population.excludedNotYetPaying} undated_connection=${population.excludedUndatedConnection}`,
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
