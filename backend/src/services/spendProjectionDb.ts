/**
 * AW-SpendProjection — the persisted monthly projection of ENG-1250 §3b.
 *
 * §3a (spendProjection.ts) DERIVES the projection by scanning a subject's spend
 * events. That is correct but O(events); admission (§4) cannot afford it per
 * call. This store holds the projection at `billingUserId + month` so a read is
 * a single Get.
 *
 * The value written here is produced by §3a's `projectMonth`, so it is
 * derived-by-construction: the §3 invariant (summing settled events reproduces
 * the projection within one micro-dollar) holds because the persisted value IS
 * that computation, snapshotted. `reconcilePersistedProjection` re-checks it
 * against a fresh derivation, the same way §8 re-checks the event ledger
 * against the live rail.
 *
 * Observe-only. Nothing reads this for enforcement — AC6 keeps that with the
 * cutover. This slice deliberately does NOT do per-event atomic maintenance:
 * that is the concurrent-admission path (§4), wired at cutover time. Here the
 * projection is (re)computed from events and written whole, exactly as the
 * dual-write slice mirrored events before anything read them.
 */
import AWS from "aws-sdk";
import { MonthlyProjection } from "./spendProjection";
import { SpendEvent } from "./spendEventDb";

export const SPEND_PROJECTION_TABLE = `${process.env.NODE_ENV === "development" ? "Dev-" : ""}AW-SpendProjection`;

let client: AWS.DynamoDB.DocumentClient | null = null;
const db = () => (client ||= new AWS.DynamoDB.DocumentClient());

/**
 * A stored projection is the derived shape plus provenance: WHEN it was
 * computed. A stale snapshot is worse than none for admission, so the read side
 * can compare `computedAt` against how fresh it needs to be.
 */
export type PersistedProjection = MonthlyProjection & {
  /** ISO-8601 instant this snapshot was computed. */
  computedAt: string;
  /**
   * The UNFLOORED admission balance: usableAllowance − settled − reserved.
   *
   * Distinct from `remainingMicroUsd`, which floors at 0 for display. Admission
   * (§4) needs the true signed value and a SINGLE attribute to condition on,
   * because DynamoDB condition expressions cannot do arithmetic across
   * attributes — so `available >= :est` is the concurrency-safe gate, and it
   * must be able to go negative to represent an overrun honestly.
   */
  availableMicroUsd: number;
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Write the snapshot whole.
 *
 * Unconditional put on purpose: this is a recomputed materialisation, not an
 * event, so the latest computation always wins. Idempotency lives on the event
 * ledger (§1), not here — re-persisting the same month simply overwrites with
 * an equal-or-fresher value.
 */
/**
 * Validate and materialise the row to persist. Shared by putProjection and the
 * conditional putProjectionIfUnchanged so the two can never build it differently.
 */
function buildPersistedItem(projection: MonthlyProjection, computedAt: string): PersistedProjection {
  if (projection.billingUserId === "" || !MONTH.test(projection.billingMonth)) {
    throw new Error(
      `refusing to persist a projection with an empty subject or bad month: ` +
        `${JSON.stringify({ billingUserId: projection.billingUserId, billingMonth: projection.billingMonth })}`,
    );
  }
  // computedAt is documented as an ISO-8601 instant. A caller-supplied value is
  // otherwise written unchanged (CodeRabbit, PR #2951), so a garbage string
  // would silently violate the contract a reader relies on for freshness.
  // Canonicalise a valid instant; reject anything unparseable.
  const parsed = Date.parse(computedAt);
  if (Number.isNaN(parsed)) {
    throw new Error(`computedAt must be an ISO-8601 instant, got ${JSON.stringify(computedAt)}`);
  }
  return {
    ...projection,
    computedAt: new Date(parsed).toISOString(),
    // Seed the admission balance unfloored, so §4 can condition and decrement it
    // atomically. usable − settled − reserved; negative means already over cap.
    availableMicroUsd: projection.usableAllowanceMicroUsd - projection.settledMicroUsd - projection.reservedMicroUsd,
  };
}

export async function putProjection(projection: MonthlyProjection, computedAt: string = new Date().toISOString()): Promise<PersistedProjection> {
  const item = buildPersistedItem(projection, computedAt);
  await db().put({ TableName: SPEND_PROJECTION_TABLE, Item: item }).promise();
  return item;
}

/**
 * Conditional whole-item put for the backfill's optimistic concurrency (F2).
 *
 * `putProjection` overwrites unconditionally, which races the event-driven
 * writer: if it ADDs settledMicroUsd between the backfill's read and its write,
 * a plain whole-item put silently reverts that add. This variant writes only if
 * the row is still what the caller observed — absent, or with the same
 * settledMicroUsd AND settledEventCount — and returns false (rather than throw)
 * on a conditional miss so the caller can re-derive from a fresh read and retry.
 *
 * `expected` is the row the caller last read (null = observed absent).
 */
export async function putProjectionIfUnchanged(
  projection: MonthlyProjection,
  expected: { settledMicroUsd: number; settledEventCount: number } | null,
  computedAt: string = new Date().toISOString(),
): Promise<{ written: boolean; item: PersistedProjection }> {
  const item = buildPersistedItem(projection, computedAt);
  const condition =
    expected === null
      ? "attribute_not_exists(billingUserId)"
      : "settledMicroUsd = :expSettled AND settledEventCount = :expCount";
  try {
    await db()
      .put({
        TableName: SPEND_PROJECTION_TABLE,
        Item: item,
        ConditionExpression: condition,
        ...(expected === null
          ? {}
          : { ExpressionAttributeValues: { ":expSettled": expected.settledMicroUsd, ":expCount": expected.settledEventCount } }),
      })
      .promise();
    return { written: true, item };
  } catch (error: any) {
    if (error?.code === "ConditionalCheckFailedException") return { written: false, item };
    throw error;
  }
}

export async function getProjection(
  billingUserId: string,
  billingMonth: string,
  consistentRead = false,
): Promise<PersistedProjection | null> {
  const result = await db()
    .get({
      TableName: SPEND_PROJECTION_TABLE,
      Key: { billingUserId, billingMonth },
      // Strongly-consistent reads matter right after a write (the backfill's
      // observe + verify reads): an eventually-consistent get can return a stale
      // or missing item and read as false drift.
      ...(consistentRead ? { ConsistentRead: true } : {}),
    })
    .promise();
  return (result.Item as PersistedProjection) ?? null;
}

// ── Event-driven writer (ENG-1250 §3b, the missing production writer) ─────────
//
// §3b shipped this table plus `putProjection`, but nothing called it in
// production, so `AW-SpendProjection` stayed empty and the §9.6 enforcement
// switch (`spendEnforcementBasis`) had nothing to read. This is the writer that
// keeps `settledMicroUsd` current, hooked at the single `usageRecordDb`
// transaction seam every settled spend event already funnels through.
//
// ## Why an atomic ADD, never `putProjection`, on the hot path
//
// `putProjection` is an unconditional WHOLE-ITEM put. Calling it per event would
// overwrite `reservedMicroUsd` / `availableMicroUsd` — the fields §4 admission
// maintains under its own atomic conditions — and a reservation taken between
// this read and write would vanish. An `ADD` on `settledMicroUsd` alone touches
// no sibling attribute, creates the row on first touch, and can never clobber a
// reservation. It is the same additive, condition-free shape §4's settle uses.
//
// ## The deliberate boundary: this path owns ONLY settled spend
//
// A row created here by first-touch has no allowance baseline, so this path must
// NOT decrement `availableMicroUsd` (it would start negative and read as
// over-cap). Seeding allowance + `availableMicroUsd` belongs to the backfill /
// materializer (`putProjection`), and reservations belong to §4. For the §9.6
// flip that is sufficient: `spendEnforcementBasis` reads only `settledMicroUsd`.
// `computedAt` is restamped so the enforcement staleness guard sees a fresh row.

export const SPEND_PROJECTION_WRITER_ENV = "SPEND_PROJECTION_WRITER";

/**
 * Kill switch, default ON (like the dual-write shims this rides alongside). Set
 * SPEND_PROJECTION_WRITER=false to stop maintaining the projection without a
 * deploy; the table simply stops advancing and enforcement, if flipped, falls
 * open on staleness.
 */
export function isProjectionWriterEnabled(): boolean {
  return process.env[SPEND_PROJECTION_WRITER_ENV] !== "false";
}

/**
 * Fold a batch of just-committed spend events into the persisted projection.
 *
 * Never throws: this is observe-only maintenance invoked from the charging
 * transaction's success path, and a projection write failing must never break
 * the metering it mirrors (identical stance to `spendLedgerDualWrite`).
 *
 * Only `settled` events move `settledMicroUsd`; reserved/voided are ignored here
 * (reservations are §4's, voided cost nothing). Events are grouped by subject +
 * month so one batch that spans a midnight boundary still lands in the right
 * months.
 */
/**
 * One subject+month's settled delta, applied with a monotonic computedAt (F4).
 *
 * Concurrent writers each carry their own `now`; out-of-order completion could
 * SET an older computedAt over a newer one, which would make the staleness guard
 * misjudge freshness. So the combined SET+ADD is guarded to only move computedAt
 * FORWARD (`attribute_not_exists(computedAt) OR computedAt <= :now`). If a newer
 * timestamp is already present the condition fails — and we then retry the SAME
 * delta as an ADD-only update with no computedAt SET, so the settled spend and
 * count are NEVER dropped, only the backwards timestamp write is.
 */
async function applyGroup(
  g: { billingUserId: string; billingMonth: string; micro: number; count: number },
  now: string,
): Promise<void> {
  const Key = { billingUserId: g.billingUserId, billingMonth: g.billingMonth };
  try {
    await db()
      .update({
        TableName: SPEND_PROJECTION_TABLE,
        Key,
        // SET stamps freshness (only forward); ADD both creates the row on first
        // touch and never overwrites reserved/available/allowance siblings.
        UpdateExpression: "SET computedAt = :now ADD settledMicroUsd :m, settledEventCount :c",
        ConditionExpression: "attribute_not_exists(computedAt) OR computedAt <= :now",
        ExpressionAttributeValues: { ":now": now, ":m": g.micro, ":c": g.count },
      })
      .promise();
  } catch (error: any) {
    if (error?.code !== "ConditionalCheckFailedException") throw error;
    // A newer computedAt already exists: keep it, but the settled spend still
    // has to land. ADD-only, no computedAt SET.
    await db()
      .update({
        TableName: SPEND_PROJECTION_TABLE,
        Key,
        UpdateExpression: "ADD settledMicroUsd :m, settledEventCount :c",
        ExpressionAttributeValues: { ":m": g.micro, ":c": g.count },
      })
      .promise();
  }
}

export async function applySettledSpendEvents(
  events: readonly SpendEvent[],
  now: string = new Date().toISOString(),
): Promise<void> {
  try {
    if (!isProjectionWriterEnabled()) return;

    const groups = new Map<string, { billingUserId: string; billingMonth: string; micro: number; count: number }>();
    for (const e of events) {
      if (e.lifecycle !== "settled") continue;
      if (!e.billingUserId || !MONTH.test(e.billingMonth)) continue;
      const key = `${e.billingUserId}\u0000${e.billingMonth}`;
      const g = groups.get(key) ?? { billingUserId: e.billingUserId, billingMonth: e.billingMonth, micro: 0, count: 0 };
      g.micro += e.costMicroUsd;
      g.count += 1;
      groups.set(key, g);
    }
    if (groups.size === 0) return;

    await Promise.all([...groups.values()].map((g) => applyGroup(g, now)));
  } catch (err) {
    console.error(
      "[spendProjectionWriter] settled-spend projection maintenance failed (observe-only, swallowed):",
      err,
    );
  }
}

export interface PersistedProjectionReconciliation {
  ok: boolean;
  /** Present when a snapshot exists but disagrees with a fresh derivation. */
  driftMicroUsd: number;
  /** True when no snapshot has been persisted for this subject/month. */
  missing: boolean;
  persistedSettledMicroUsd: number | null;
  derivedSettledMicroUsd: number;
}

/**
 * §3 invariant at the persistence layer: the stored snapshot must reproduce a
 * fresh derivation's settled total within one micro-dollar.
 *
 * A missing snapshot is a distinct outcome from a drifting one — it means the
 * projection was never persisted for this subject/month, not that it is wrong.
 * Conflating the two would let "we never wrote it" read as "it reconciles."
 */
export const PERSISTED_PROJECTION_TOLERANCE_MICRO_USD = 1;

export function reconcilePersistedProjection(
  persisted: PersistedProjection | null,
  derived: MonthlyProjection,
): PersistedProjectionReconciliation {
  if (persisted === null) {
    return {
      ok: false,
      missing: true,
      driftMicroUsd: derived.settledMicroUsd,
      persistedSettledMicroUsd: null,
      derivedSettledMicroUsd: derived.settledMicroUsd,
    };
  }
  const driftMicroUsd = persisted.settledMicroUsd - derived.settledMicroUsd;
  return {
    ok: Math.abs(driftMicroUsd) <= PERSISTED_PROJECTION_TOLERANCE_MICRO_USD,
    missing: false,
    driftMicroUsd,
    persistedSettledMicroUsd: persisted.settledMicroUsd,
    derivedSettledMicroUsd: derived.settledMicroUsd,
  };
}
