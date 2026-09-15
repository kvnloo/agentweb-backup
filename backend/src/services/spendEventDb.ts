/**
 * AW-SpendEvents — the immutable, cross-vendor spend ledger (ENG-1250 §1).
 *
 * This is the store `AW-LlmChargeEvents` explicitly is NOT: that table opens by
 * declaring itself "deliberately LLM-only: it is not the future cross-vendor
 * wallet", so this row's ledger had to be greenfield rather than a retrofit of
 * it. Approved by Harsha on ENG-1250 (2026-09-03) against the spec below, with
 * every parameter — key shape, GSI, retention, field list — named in the
 * approval.
 *
 * Deliberate differences from AW-LlmChargeEvents:
 *
 *  - **No TTL.** That table expires rows at 365 days. This one is the audit
 *    substrate for "a pause is explainable to the cent" (ENG-1250 AC3), so rows
 *    are kept. Measured growth at approval time was ~546 rows/day at ~392 bytes
 *    — seven years is ~1.4M rows / ~520 MB, about $0.13/month. Note this means
 *    there is NO `ttl` attribute to enable in the console: absence is the
 *    decision, not an oversight.
 *  - **Cross-vendor.** provider/operation/unit are open strings so an adapter
 *    family can be added without a schema change.
 *  - **A lifecycle.** Reservations exist here (`reserved -> settled | voided`)
 *    because admission has to count in-flight spend, not just settled spend.
 *
 * Scope: this module is the store only. The charging API that decides *when* to
 * write (classification, rate resolution, admission) is ENG-1250 §2 and lands
 * separately; nothing here reads or moves enforcement, per AC6.
 */
import AWS from "aws-sdk";

export const SPEND_EVENTS_TABLE = `${process.env.NODE_ENV === "development" ? "Dev-" : ""}AW-SpendEvents`;

/**
 * Monthly and date-range queries go through this GSI, never the base table.
 * Same lesson as ENG-1251: `eventId` is caller-supplied (a provider response
 * id, a task-derived key) and does not sort by time, so a range query on the
 * base table's sort key silently misses events. `occurredAt` is always a real
 * timestamp.
 */
export const SPEND_EVENTS_OCCURRED_AT_INDEX = "BillingUserOccurredAtIndex";

let client: AWS.DynamoDB.DocumentClient | null = null;
const db = () => (client ||= new AWS.DynamoDB.DocumentClient());

/**
 * `reserved` — spend is committed against the balance but the vendor call has
 * not returned. Counts against admission (ENG-1250 §4) and NOT against settled
 * spend.
 * `settled` — the vendor call happened and `costMicroUsd` is final.
 * `voided` — the reservation was released; the row stays as evidence that an
 * attempt was made and cost nothing.
 */
export type SpendEventLifecycle = "reserved" | "settled" | "voided";

/**
 * Note what is absent: `"unpriced"`, which usageRecordDb's CostSource does
 * carry. ENG-1250's billing boundary is explicit that an unpriced unit "must
 * fail closed or be explicitly allowlisted as platform-funded; it must never
 * become a silent $0 charge" — so an unpriced call has no business becoming a
 * row in the spend ledger at all. Rejecting it at the type level is what stops
 * a $0 row from quietly diluting the reconciliation in §8.
 */
export type SpendEventCostSource = "measured" | "allocated";

/** Correlation handles back to the work that caused the spend (ENG-1250 §1). */
export type SpendEventReferences = {
  sessionId?: string;
  taskId?: string;
  runId?: string;
  requestId?: string;
};

/**
 * The 18 fields of ENG-1250 Architecture §1, as approved.
 *
 * `costMicroUsd` is an integer count of micro-dollars, never a float dollar
 * amount: §3's invariant is that summing settled events reproduces the monthly
 * projection to within one micro-dollar, and floating-point dollars cannot
 * satisfy that over ~1.4M rows.
 */
export type SpendEvent = {
  /** Partition key: the subject whose balance this debits. */
  billingUserId: string;
  /** Sort key, and the idempotency token. Supplied by the call site. */
  eventId: string;
  /** ISO-8601 instant the vendor call was made. */
  occurredAt: string;
  /** `YYYY-MM`, the billing month this lands in. Must agree with occurredAt. */
  billingMonth: string;
  orgId?: string;
  /** The user who triggered the call. */
  actingUserId: string;
  /** Set only when acting user !== billing subject (delegated/agent work). */
  onBehalfOf?: string;
  provider: string;
  operation: string;
  feature?: string;
  unit: string;
  quantity: number;
  costMicroUsd: number;
  costSource: SpendEventCostSource;
  /** Required when `costSource` is `allocated` — see §5 on rate versioning. */
  rateCardVersion?: string;
  references?: SpendEventReferences;
  lifecycle: SpendEventLifecycle;
  /** Vendor's own id for the call, when it returns one. */
  vendorReference?: string;
};

export type RecordSpendEventResult = {
  /** false when the idempotency key was already present — see recordSpendEvent. */
  stored: boolean;
  /** The stored event: the new one, or the pre-existing one on a replay. */
  event: SpendEvent;
};

/** Thrown for a malformed event. A bad row is worse than a rejected write here. */
export class SpendEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendEventValidationError";
  }
}

/**
 * A canonical UTC instant, and nothing else.
 *
 * A prefix match on the date is not enough (CodeRabbit, PR #2787): with an
 * offset timestamp, `"2026-10-01T00:30:00+01:00"` carries billing month
 * `2026-10` while the real instant is 2026-09-30T23:30Z. The GSI sorts these
 * strings raw, so the row lands in October's projection *and* is invisible to a
 * September range query -- the reconciliation in §8 would report it as drift
 * with no way to see which field was wrong. Requiring `Z` makes the string's
 * sort order and its instant the same thing.
 */
const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;
const BILLING_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * The `YYYY-MM` of a canonical UTC instant, or null if it is not one.
 *
 * Round-trips every field through `Date` because the regex alone still admits
 * dates that do not exist: `2026-02-30T00:00:00Z` matches it, and `Date` then
 * silently rolls it forward to March 2. Comparing the parsed fields back
 * against the literal is what rejects those instead of storing a real event on
 * an unreal day.
 */
function utcMonthOf(value: string): string | null {
  const m = UTC_INSTANT.exec(value);
  if (!m) return null;

  const [, year, month, day, hour, minute, second] = m;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  const sameInstant =
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() + 1 === Number(month) &&
    parsed.getUTCDate() === Number(day) &&
    parsed.getUTCHours() === Number(hour) &&
    parsed.getUTCMinutes() === Number(minute) &&
    parsed.getUTCSeconds() === Number(second);

  return sameInstant ? `${year}-${month}` : null;
}

/**
 * The canonical `toISOString()` form of an accepted instant, or null.
 *
 * The GSI sorts `occurredAt` as a raw string, and variable fractional precision
 * makes that ordering disagree with time (CodeRabbit, PR #2787) -- lexically,
 * `...10:00:00.123Z` < `...10:00:00.12Z` < `...10:00:00.1Z` < `...10:00:00Z`,
 * the exact reverse of the true order, because `.` sorts below `Z` and a
 * shorter fraction is not a numeric prefix. A BETWEEN range query on that key
 * then excludes or misorders events.
 *
 * So the store accepts any valid instant but persists exactly one shape:
 * always three fractional digits, which is what `Date.toISOString()` emits and
 * therefore what every caller building a timestamp already produces.
 */
function canonicalUtcInstant(value: string): string | null {
  if (utcMonthOf(value) === null) return null;
  return new Date(value).toISOString();
}

/**
 * Reject anything that would make the §3 invariant unprovable later. These are
 * cheap to check now and effectively unfixable once written: an event whose
 * billingMonth disagrees with its occurredAt lands in one month's projection
 * and a different month's date-range query, and the two can never be
 * reconciled without knowing which field lied.
 */
export function validateSpendEvent(event: SpendEvent): void {
  const fail = (m: string) => {
    throw new SpendEventValidationError(m);
  };

  if (!event.billingUserId) fail("billingUserId is required");
  if (!event.eventId) fail("eventId is required (it is the idempotency key)");
  if (!event.actingUserId) fail("actingUserId is required");
  if (!event.provider) fail("provider is required");
  if (!event.operation) fail("operation is required");
  if (!event.unit) fail("unit is required");

  const month = utcMonthOf(event.occurredAt || "");
  if (!month) {
    fail(
      `occurredAt must be a canonical UTC ISO-8601 instant ending in Z (e.g. 2026-09-07T10:00:00.000Z), ` +
        `got ${JSON.stringify(event.occurredAt)}`,
    );
  }
  if (!BILLING_MONTH.test(event.billingMonth)) {
    fail(`billingMonth must be YYYY-MM with a real month, got ${JSON.stringify(event.billingMonth)}`);
  }
  if (month !== event.billingMonth) {
    fail(`billingMonth ${event.billingMonth} disagrees with occurredAt ${event.occurredAt}`);
  }

  if (!Number.isFinite(event.quantity) || event.quantity < 0) {
    fail(`quantity must be a non-negative number, got ${event.quantity}`);
  }
  if (!Number.isInteger(event.costMicroUsd) || event.costMicroUsd < 0) {
    fail(`costMicroUsd must be a non-negative integer of micro-dollars, got ${event.costMicroUsd}`);
  }

  // §5: "historical events retain the rate version used". An allocated cost
  // whose rate version is unknown cannot be re-derived or corrected later.
  if (event.costSource === "allocated" && !event.rateCardVersion) {
    fail("rateCardVersion is required when costSource is 'allocated'");
  }
}

/**
 * Append one spend event, idempotently.
 *
 * ENG-1250 §1: "Retries with the same idempotency key must return the original
 * event and add $0." So a replay is not an error and not a second row — it
 * returns `{ stored: false }` with the event already on record, which is what
 * lets a caller distinguish "I just charged" from "this was already charged"
 * without reading first and racing.
 */
export async function recordSpendEvent(event: SpendEvent): Promise<RecordSpendEventResult> {
  validateSpendEvent(event);

  // Persist one fixed serialization so the GSI's lexical order IS chronological
  // order. validateSpendEvent has already proven this cannot be null.
  const canonical: SpendEvent = { ...event, occurredAt: canonicalUtcInstant(event.occurredAt)! };

  try {
    await db()
      .put({
        TableName: SPEND_EVENTS_TABLE,
        Item: canonical,
        ConditionExpression: "attribute_not_exists(billingUserId) AND attribute_not_exists(eventId)",
      })
      .promise();
    return { stored: true, event: canonical };
  } catch (error: any) {
    if (error?.code !== "ConditionalCheckFailedException") throw error;

    const existing = await getSpendEvent(event.billingUserId, event.eventId);
    if (!existing) {
      // The row lost the race to exist and then vanished. Never expected —
      // this table has no TTL and no delete path — so surface it rather than
      // silently retrying into a double charge.
      throw new Error(
        `spendEvent ${event.eventId} for ${event.billingUserId} conflicted on write but could not be read back`,
      );
    }
    return { stored: false, event: existing };
  }
}

export async function getSpendEvent(billingUserId: string, eventId: string): Promise<SpendEvent | null> {
  const result = await db()
    .get({ TableName: SPEND_EVENTS_TABLE, Key: { billingUserId, eventId } })
    .promise();
  return (result.Item as SpendEvent) ?? null;
}

/** Legal lifecycle moves. Both terminal states are final. */
const LEGAL_TRANSITIONS: Record<SpendEventLifecycle, readonly SpendEventLifecycle[]> = {
  reserved: ["settled", "voided"],
  settled: [],
  voided: [],
};

export function isLegalLifecycleTransition(from: SpendEventLifecycle, to: SpendEventLifecycle): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * Settle a reservation with its actual cost, or void it.
 *
 * The row is updated in place rather than superseded by a second row. That is
 * the reading of §1 the field list forces — `lifecycle` is listed as a field
 * *of* the event, not as a separate event type — and it keeps §3's invariant a
 * one-pass sum over rows where `lifecycle = 'settled'` instead of a fold that
 * has to pair reservations with their settlements.
 *
 * "Immutable" is preserved where it pays: the conditional write below means a
 * lifecycle only ever advances out of `reserved`, so a settled amount can never
 * be rewritten and a voided row can never be resurrected. A same-state repeat
 * returns `false` rather than throwing, so a retried settle is a no-op.
 */
export async function transitionSpendEvent(
  billingUserId: string,
  eventId: string,
  to: Exclude<SpendEventLifecycle, "reserved">,
  finalCostMicroUsd?: number,
): Promise<boolean> {
  if (to === "settled") {
    if (finalCostMicroUsd === undefined) {
      throw new SpendEventValidationError("settling requires the final costMicroUsd");
    }
    if (!Number.isInteger(finalCostMicroUsd) || finalCostMicroUsd < 0) {
      throw new SpendEventValidationError(
        `costMicroUsd must be a non-negative integer of micro-dollars, got ${finalCostMicroUsd}`,
      );
    }
  } else if (finalCostMicroUsd !== undefined) {
    // A voided reservation costs nothing by definition; accepting an amount
    // here would let a caller book spend under the one lifecycle that means
    // "no spend happened".
    throw new SpendEventValidationError("voiding must not supply a cost");
  }

  const setsCost = to === "settled";
  try {
    await db()
      .update({
        TableName: SPEND_EVENTS_TABLE,
        Key: { billingUserId, eventId },
        UpdateExpression: setsCost
          ? "SET lifecycle = :to, costMicroUsd = :cost"
          : "SET lifecycle = :to, costMicroUsd = :zero",
        ConditionExpression: "attribute_exists(billingUserId) AND lifecycle = :reserved",
        ExpressionAttributeValues: {
          ":to": to,
          ":reserved": "reserved" satisfies SpendEventLifecycle,
          ...(setsCost ? { ":cost": finalCostMicroUsd } : { ":zero": 0 }),
        },
      })
      .promise();
    return true;
  } catch (error: any) {
    if (error?.code === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

/**
 * Every event for a billing subject in [start, end], oldest last.
 *
 * Paginates to exhaustion deliberately: this feeds reconciliation (§8), where a
 * silently truncated page reads as drift and would block enabling enforcement
 * for a provider.
 */
export async function listSpendEvents(
  billingUserId: string,
  start: string,
  end: string,
): Promise<SpendEvent[]> {
  const items: SpendEvent[] = [];
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;

  do {
    const result = await db()
      .query({
        TableName: SPEND_EVENTS_TABLE,
        IndexName: SPEND_EVENTS_OCCURRED_AT_INDEX,
        KeyConditionExpression: "billingUserId = :user AND occurredAt BETWEEN :start AND :end",
        // `~` sorts above every character legal in an ISO-8601 timestamp, so an
        // end bound of "2026-09-30" still catches "2026-09-30T23:59:59.999Z".
        ExpressionAttributeValues: { ":user": billingUserId, ":start": start, ":end": `${end}~` },
        ScanIndexForward: false,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      })
      .promise();
    items.push(...((result.Items || []) as SpendEvent[]));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

/**
 * Settled micro-dollars only — the figure §3's invariant must reproduce.
 * Reservations are excluded on purpose: they are admission input, not spend.
 */
export function sumSettledMicroUsd(events: readonly SpendEvent[]): number {
  return events.reduce((total, e) => (e.lifecycle === "settled" ? total + e.costMicroUsd : total), 0);
}

/** The outcome of a read that refuses to run past a ceiling (ENG-1841). */
export interface BoundedSpendEventRead {
  events: SpendEvent[];
  /**
   * True when the subject has MORE than `maxEvents` events in the range. The
   * events are then incomplete, and nothing may be summed from them — a
   * truncated aggregate is a wrong aggregate.
   */
  exceeded: boolean;
}

/**
 * `listSpendEvents` for an interactive reader: stops paging once it holds more
 * than `maxEvents`, and says so.
 *
 * `listSpendEvents` itself keeps paging to exhaustion, deliberately — the §8
 * reconciliation must see every event. This variant bounds the admin read so a
 * very large subject-month costs a fixed amount of work and returns an explicit
 * "too large" answer instead of silently understating every total.
 */
export async function listSpendEventsBounded(
  billingUserId: string,
  start: string,
  end: string,
  maxEvents: number,
): Promise<BoundedSpendEventRead> {
  const items: SpendEvent[] = [];
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;

  do {
    const result = await db()
      .query({
        TableName: SPEND_EVENTS_TABLE,
        IndexName: SPEND_EVENTS_OCCURRED_AT_INDEX,
        KeyConditionExpression: "billingUserId = :user AND occurredAt BETWEEN :start AND :end",
        ExpressionAttributeValues: { ":user": billingUserId, ":start": start, ":end": `${end}~` },
        ScanIndexForward: false,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      })
      .promise();
    items.push(...((result.Items || []) as SpendEvent[]));
    if (items.length > maxEvents) return { events: items, exceeded: true };
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return { events: items, exceeded: false };
}
