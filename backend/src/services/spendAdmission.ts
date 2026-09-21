/**
 * ENG-1250 §4 — admission reservation and concurrency semantics.
 *
 * The gate that decides whether a new call is admitted and reserves its cost so
 * two concurrent calls cannot both spend the last of a balance. It operates on
 * the persisted projection (§3b, AW-SpendProjection), maintaining the admission
 * balance atomically.
 *
 * ## Why a single `availableMicroUsd` attribute
 *
 * DynamoDB condition expressions cannot do arithmetic across attributes — you
 * cannot write `CONDITION settled + reserved + :est <= usable`. So the balance
 * is materialised as one field, `availableMicroUsd = usable − settled −
 * reserved` (seeded by §3b, unfloored), and admission conditions on it alone:
 * `availableMicroUsd >= :est`. The conditional UpdateItem is the whole point —
 * DynamoDB serialises it, so two racing admissions cannot both pass when only
 * one fits. That is the concurrency guarantee, and it lives in the condition,
 * not in application code.
 *
 * ## Observe-only
 *
 * Nothing calls this for real enforcement. The live gate stays on the legacy
 * counter until the cutover (§9.6), which AC6 keeps with Harsha. This slice
 * makes the gate exist and proves it correct.
 */
import AWS from "aws-sdk";
import { SPEND_PROJECTION_TABLE } from "./spendProjectionDb";

let client: AWS.DynamoDB.DocumentClient | null = null;
const db = () => (client ||= new AWS.DynamoDB.DocumentClient());

export type AdmissionReason =
  | "admitted"
  | "insufficient_balance"
  | "missing_projection"
  | "over_allowed"; // admitted under the overrun rule, not against the balance

export interface AdmissionResult {
  admitted: boolean;
  reason: AdmissionReason;
}

export interface AdmitOptions {
  /**
   * Admit regardless of the balance. This is the "admitted-work may finish"
   * rule (§4): a job reserved before the boundary settles even if it lands over
   * cap. It applies to work already in flight, NOT to fresh admission — the
   * caller, not this function, decides an in-flight job qualifies.
   */
  allowOverrun?: boolean;
}

function assertPositiveInt(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer of micro-dollars, got ${value}`);
  }
}

/**
 * Reserve `estimatedMicroUsd` against the subject's month, atomically.
 *
 * Returns `admitted: false` when the balance cannot cover the reservation — no
 * write happens in that case, so a rejected admission costs nothing and leaves
 * the balance untouched for the call that does fit.
 */
export async function admitAndReserve(
  billingUserId: string,
  billingMonth: string,
  estimatedMicroUsd: number,
  options: AdmitOptions = {},
): Promise<AdmissionResult> {
  assertPositiveInt("estimatedMicroUsd", estimatedMicroUsd);

  const base = {
    TableName: SPEND_PROJECTION_TABLE,
    Key: { billingUserId, billingMonth },
    UpdateExpression: "ADD reservedMicroUsd :est, availableMicroUsd :negEst",
    ExpressionAttributeValues: { ":est": estimatedMicroUsd, ":negEst": -estimatedMicroUsd },
  };

  if (options.allowOverrun) {
    // Still require the row to exist — reserving against a subject that has no
    // projection is a seeding bug, not an overrun.
    try {
      await db()
        .update({ ...base, ConditionExpression: "attribute_exists(billingUserId)" })
        .promise();
      return { admitted: true, reason: "over_allowed" };
    } catch (error: any) {
      if (error?.code === "ConditionalCheckFailedException") return { admitted: false, reason: "missing_projection" };
      throw error;
    }
  }

  try {
    await db()
      .update({
        ...base,
        ConditionExpression: "attribute_exists(billingUserId) AND availableMicroUsd >= :est",
      })
      .promise();
    return { admitted: true, reason: "admitted" };
  } catch (error: any) {
    if (error?.code !== "ConditionalCheckFailedException") throw error;
    // The condition failed: either the row is missing or the balance is short.
    // The admission decision (false) is already made; this read is observational
    // only, to tell a seeding bug apart from an ordinary pause. It is not part
    // of the atomic path and never changes the outcome.
    const existing = await db()
      .get({ TableName: SPEND_PROJECTION_TABLE, Key: { billingUserId, billingMonth } })
      .promise();
    return {
      admitted: false,
      reason: existing.Item ? "insufficient_balance" : "missing_projection",
    };
  }
}

/**
 * Settle a reservation with its actual cost: move `reserved → settled` and
 * return the estimate/actual difference to the balance.
 *
 * available = usable − settled − reserved, so settling changes it by
 * (reserved − actual): a call that cost less than reserved refunds the
 * difference; one that cost more drives available further negative, which is
 * the honest record of an overrun. Never gated — a reservation that happened
 * always settles.
 */
export async function settleReservation(
  billingUserId: string,
  billingMonth: string,
  reservedMicroUsd: number,
  actualMicroUsd: number,
): Promise<void> {
  assertPositiveInt("reservedMicroUsd", reservedMicroUsd);
  assertPositiveInt("actualMicroUsd", actualMicroUsd);

  const availableDelta = reservedMicroUsd - actualMicroUsd;
  await db()
    .update({
      TableName: SPEND_PROJECTION_TABLE,
      Key: { billingUserId, billingMonth },
      UpdateExpression: "ADD settledMicroUsd :actual, reservedMicroUsd :negReserved, availableMicroUsd :availDelta",
      ConditionExpression: "attribute_exists(billingUserId)",
      ExpressionAttributeValues: {
        ":actual": actualMicroUsd,
        ":negReserved": -reservedMicroUsd,
        ":availDelta": availableDelta,
      },
    })
    .promise();
}

/**
 * Release a reservation that will not settle (the vendor call failed, or the
 * work was abandoned): give the whole reservation back to the balance.
 */
export async function voidReservation(
  billingUserId: string,
  billingMonth: string,
  reservedMicroUsd: number,
): Promise<void> {
  assertPositiveInt("reservedMicroUsd", reservedMicroUsd);
  await db()
    .update({
      TableName: SPEND_PROJECTION_TABLE,
      Key: { billingUserId, billingMonth },
      UpdateExpression: "ADD reservedMicroUsd :negReserved, availableMicroUsd :reserved",
      ConditionExpression: "attribute_exists(billingUserId)",
      ExpressionAttributeValues: { ":negReserved": -reservedMicroUsd, ":reserved": reservedMicroUsd },
    })
    .promise();
}
