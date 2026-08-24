/**
 * Reconciles per-charge audit events (exact, but only exist going forward
 * from ENG-1251) against the legacy per-day (date, model, feature) usage
 * aggregate (`usageRecordDb`, still the only record for calls made before
 * charge events existed, and for any engine that hasn't rolled out
 * `reportId` yet).
 *
 * A single aggregate row can be PARTIALLY covered by charge events — the day
 * the charge-event rollout reached a given user/engine, or a $0 (unpriced
 * model) key where only some of that day's calls got an audit event. Dollar
 * amount alone cannot represent that: two calls on an unpriced model both
 * cost $0, so "1 of 2 calls covered" and "2 of 2 calls covered" are both
 * `coveredMicroUsd === 0` and indistinguishable by a scalar coverage check
 * (this is what produced the run of Greptile P1s on this file — every patch
 * fixed one instance of the same structural gap). Tracking coverage
 * per-dimension (cost, tokens, calls) independently, and taking each
 * dimension's remainder independently, removes the ambiguity: a dimension
 * with 0 remainder is exactly covered regardless of what the other
 * dimensions show.
 */
import type { LlmChargeAuditEvent } from "./llmChargeAuditDb";
import type { UsageRecordRow } from "./usageRecordDb";

export interface ItemizedUsageItem {
  date: string;
  model: string;
  provider: string;
  feature: string;
  tokens: number;
  calls: number;
  costMicroUsd: number;
  source: "charge_event" | "daily_aggregate";
  sessionId?: string;
}

export type ItemizedUsagePrecision = "per_charge" | "daily_aggregate" | "mixed";

export interface ItemizedUsageResult {
  items: ItemizedUsageItem[];
  precision: ItemizedUsagePrecision;
}

// ENG-1251 Greptile P1: keyed by acting user too, not just (date, model,
// feature). Once itemization could pull in multiple acting users' rows for
// one billing owner (pooled org members), two different members can share a
// (date, model, feature) slot -- their aggregate rows are still separate
// (usageRecordDb's partition key is the acting user), but a coverage map
// keyed without the actor would apply ONE member's charge-event coverage to
// the OTHER member's aggregate row, since both hash to the same key. Every
// charge event carries actingUserId and every aggregate row carries userId,
// so both sides can always be scoped correctly.
// Deliberately NOT keyed on the payer, and that is load-bearing (ENG-1210,
// Greptile PR #2407).
//
// Keying it on `billingUserId` looked safer and was strictly worse. Legacy rows
// stored the ACTING user as their payer -- `recordUsage` defaulted
// `ctx.billingUserId || userId`, and measured on production 0 of 4,629 rows carry
// a payer that differs from the actor -- while charge events carry the real
// billing ROOT. Keyed on the payer those two stop hashing together, coverage
// silently stops matching, and the full aggregate is reported alongside the
// charge events that already itemise it: an OVERCOUNT on a customer's bill.
//
// The cross-payer leakage that motivated adding it is already handled by grouping
// rows into slots below: two rows for one slot are combined and their coverage is
// netted once, which gives the same total whether or not the payer is in the key.
// Grouping was the fix; the payer was redundant, and its redundancy cost money.
const aggregateKey = (actingUserId: string, date: string, model: string, feature: string) =>
  `${actingUserId}#${date}#${model}#${feature}`;

export function reconcileItemizedUsage(
  events: LlmChargeAuditEvent[],
  rows: UsageRecordRow[]
): ItemizedUsageResult {
  const perChargeItems: ItemizedUsageItem[] = events.map((event) => ({
    date: event.occurredAt,
    model: event.model || "unknown",
    provider: event.provider || "unknown",
    feature: event.feature || "unknown",
    tokens: event.tokens,
    // ENG-1251 Greptile P1: a batch-charge event (internalUsage.ts sums an
    // engine batch into one event per (user, model, feature)) can stand in
    // for several calls, not one. `calls` is undefined on every event
    // recorded before this field existed and on every single-call caller
    // today -- both cases mean exactly 1.
    calls: event.calls ?? 1,
    costMicroUsd: event.costMicroUsd,
    source: "charge_event",
    sessionId: event.sessionId,
  }));

  const coverageByKey = new Map<string, { microUsd: number; tokens: number; calls: number }>();
  for (const event of events) {
    const key = aggregateKey(
      event.actingUserId,
      event.occurredAt.slice(0, 10),
      event.model || "unknown",
      event.feature || "unknown"
    );
    const entry = coverageByKey.get(key) || { microUsd: 0, tokens: 0, calls: 0 };
    entry.microUsd += event.costMicroUsd;
    entry.tokens += event.tokens || 0;
    entry.calls += event.calls ?? 1;
    coverageByKey.set(key, entry);
  }

  // Rows sharing a slot are COMBINED before coverage is netted, because coverage
  // is per slot and subtracting it from each row would remove it more than once.
  //
  // One row per slot was guaranteed until the payer joined the sort key
  // (ENG-1210). Now a day that was accumulating under `date#model#feature` stops
  // there and a new row starts at `date#model#feature#payer`, so for as long as a
  // cycle spans the cutover a slot holds two rows with the SAME payer. Netting
  // each independently understated the bill by a full day's coverage -- an
  // undercount, which is the direction a customer cannot see.
  //
  // With one row per slot this is arithmetically identical to the previous
  // behaviour, so the ordinary case is unchanged.
  const slots = new Map<
    string,
    { row: UsageRecordRow; microUsd: number; tokens: number; calls: number }
  >();
  for (const row of rows) {
    const key = aggregateKey(row.userId, row.date, row.model, row.feature);
    const slot = slots.get(key);
    if (slot) {
      slot.microUsd += row.costMicroUsd || 0;
      slot.tokens += row.totalTokens || 0;
      slot.calls += row.callCount || 0;
      continue;
    }
    slots.set(key, {
      row,
      microUsd: row.costMicroUsd || 0,
      tokens: row.totalTokens || 0,
      calls: row.callCount || 0,
    });
  }

  const aggregateItems: ItemizedUsageItem[] = [...slots.entries()].flatMap(([key, slot]) => {
    const row = slot.row;
    const coverage = coverageByKey.get(key);
    // Already micro-USD, same unit as the charge events summed above.
    const rowMicroUsd = slot.microUsd;
    const rowTokens = slot.tokens;
    const rowCalls = slot.calls;

    if (!coverage) {
      // No charge-event coverage exists for this (date, model, feature) at
      // all -- the row cannot be redundant with anything, so it shows in
      // full, even at $0 cost.
      return [{
        date: row.date, model: row.model, provider: row.provider || "unknown", feature: row.feature,
        tokens: rowTokens, calls: rowCalls, costMicroUsd: rowMicroUsd, source: "daily_aggregate",
      }];
    }

    // Each dimension's remainder is computed independently -- a $0 remainder
    // on cost does NOT imply a 0 remainder on tokens/calls, and vice versa.
    // Clamped to 0: charge events and the aggregate table are independently
    // written, so a transient inconsistency (event count temporarily ahead
    // of the aggregate) must never surface as a negative remainder.
    const remainderMicroUsd = Math.max(0, rowMicroUsd - coverage.microUsd);
    const remainderTokens = Math.max(0, rowTokens - coverage.tokens);
    const remainderCalls = Math.max(0, rowCalls - coverage.calls);

    if (remainderMicroUsd === 0 && remainderTokens === 0 && remainderCalls === 0) {
      return []; // fully covered by charge events on every dimension
    }

    return [{
      date: row.date, model: row.model, provider: row.provider || "unknown", feature: row.feature,
      tokens: remainderTokens, calls: remainderCalls, costMicroUsd: remainderMicroUsd, source: "daily_aggregate",
    }];
  });

  const items = [...perChargeItems, ...aggregateItems].sort(
    (a, b) => b.date.localeCompare(a.date) || b.costMicroUsd - a.costMicroUsd
  );
  const precision: ItemizedUsagePrecision =
    perChargeItems.length && aggregateItems.length
      ? "mixed"
      : perChargeItems.length
      ? "per_charge"
      : "daily_aggregate";

  return { items, precision };
}
