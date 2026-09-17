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
export async function putProjection(projection: MonthlyProjection, computedAt: string = new Date().toISOString()): Promise<PersistedProjection> {
  if (projection.billingUserId === "" || !MONTH.test(projection.billingMonth)) {
    throw new Error(
      `refusing to persist a projection with an empty subject or bad month: ` +
        `${JSON.stringify({ billingUserId: projection.billingUserId, billingMonth: projection.billingMonth })}`,
    );
  }
  const item: PersistedProjection = { ...projection, computedAt };
  await db().put({ TableName: SPEND_PROJECTION_TABLE, Item: item }).promise();
  return item;
}

export async function getProjection(billingUserId: string, billingMonth: string): Promise<PersistedProjection | null> {
  const result = await db()
    .get({ TableName: SPEND_PROJECTION_TABLE, Key: { billingUserId, billingMonth } })
    .promise();
  return (result.Item as PersistedProjection) ?? null;
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
