/**
 * ENG-1217 AC9 — append-only evidence for a customer-confirmed model change.
 *
 * The record exists so a switch can be explained and reversed: what work
 * changed, from which model to which, what we estimated at the time, who
 * confirmed it, and whether it was later undone.
 *
 * ## What is deliberately absent
 *
 * AC9 says "without recording prompts". This names the WORK (a schedule id and
 * the title as it read at the time) and the MODELS. Never the content. A model
 * change is a billing decision, and an audit trail for a billing decision has no
 * business holding what the customer wrote.
 *
 * ## Why the sort key carries the timestamp
 *
 * `llmChargeAuditDb` keys on `{billingUserId, eventId}` and learned the hard way
 * (ENG-1251) that a caller-controlled id does not sort by time: a date-range
 * query silently missed events whose id happened to fall outside the bounds, and
 * it needed a GSI added to recover. Putting `changedAt` first in the sort key
 * makes the base table range-queryable by construction and removes the need for
 * that index entirely. The composite is handed back to callers as the id to undo
 * with, so nothing has to reconstruct it.
 *
 * ## Append-only, including the undo
 *
 * An undo stamps `undoneAt` rather than deleting the row. Deleting would erase
 * the fact that the change ever happened, which is precisely what an audit trail
 * exists to prevent — and "this was tried and reverted" is more useful history
 * than silence.
 */
import AWS from "aws-sdk";

export const MODEL_CHANGE_AUDIT_TABLE = `${
  process.env.NODE_ENV === "development" ? "Dev-" : ""
}AW-ModelChangeAudit`;

/** A year. Long enough to explain any billing cycle a customer might query. */
const TTL_SECONDS = 365 * 24 * 60 * 60;

let client: AWS.DynamoDB.DocumentClient | null = null;
const db = () => (client ||= new AWS.DynamoDB.DocumentClient());

/** The scopes a switch can actually be applied to today. */
export type ModelChangeScope = "schedule" | "session";

export interface ModelChangeAuditRecord {
  /** Partition: the billing subject, so an org's changes live together. */
  billingUserId: string;
  changeId: string;
  /** ISO instant; also the leading component of the sort key. */
  changedAt: string;
  scope: ModelChangeScope;
  scopeId: string;
  /**
   * The work's name AS IT READ when the change was made. Denormalised on
   * purpose: a schedule deleted afterwards still has to be explainable, and
   * joining to a row that no longer exists yields "unknown" exactly when the
   * customer most wants to know what they changed.
   */
  scopeLabel: string | null;
  /**
   * The model the work ran on before, or NULL when it inherited the platform
   * default rather than pinning one.
   *
   * Null is not "unknown" — it is a distinct, meaningful state. Two thirds of
   * production schedules (66 of 91 active) carry no `llmModel` at all, so a
   * switch there PINS a model where none was set, and undoing it must restore
   * inheritance rather than write back whatever the default happened to be at
   * the time. The default can move; inheritance follows it, a pinned copy does
   * not.
   */
  modelBefore: string | null;
  modelAfter: string;
  /** What we told the customer this would recover, at the moment they agreed. */
  estimatedDaysRecoveredAtDecision: number | null;
  confidenceAtDecision: string | null;
  /** The ACTING user who confirmed — not the billing subject. */
  confirmedByUserId: string;
  undoneAt: string | null;
  undoneByUserId?: string | null;
}

/** `{changedAt}#{changeId}` — time-sortable, and the id callers undo with. */
export function buildChangeSortKey(changedAt: string, changeId: string): string {
  return `${changedAt}#${changeId}`;
}

/**
 * Append one change. Returns the sort key, which is the handle for undo.
 *
 * Conditioned on the key not existing so a retry cannot rewrite history — an
 * append-only table that silently accepts an overwrite is not append-only.
 */
export async function recordModelChange(record: ModelChangeAuditRecord): Promise<string> {
  const sk = buildChangeSortKey(record.changedAt, record.changeId);
  // `undoneAt` is OMITTED while null rather than written as null. DynamoDB
  // treats an explicit null as a present attribute, so storing it would make
  // `attribute_not_exists(undoneAt)` false from the moment the row is created
  // and every undo would be rejected as "already undone". The absence IS the
  // not-yet-undone state.
  const { undoneAt, undoneByUserId, ...rest } = record;
  await db()
    .put({
      TableName: MODEL_CHANGE_AUDIT_TABLE,
      Item: {
        ...rest,
        ...(undoneAt ? { undoneAt, ...(undoneByUserId ? { undoneByUserId } : {}) } : {}),
        sk,
        ttl: Math.floor(Date.now() / 1000) + TTL_SECONDS,
      },
      ConditionExpression: "attribute_not_exists(billingUserId) AND attribute_not_exists(sk)",
    })
    .promise();
  return sk;
}

/**
 * Changes for a billing subject within an inclusive date range, newest first.
 *
 * Newest first because the question this answers is almost always "what did I
 * just do, and can I put it back". Pagination is followed rather than truncated:
 * a partial audit trail presented as a whole one is worse than none.
 */
export async function listModelChanges(
  billingUserId: string,
  startDate: string,
  endDate: string,
): Promise<ModelChangeAuditRecord[]> {
  const items: ModelChangeAuditRecord[] = [];
  let lastKey: AWS.DynamoDB.DocumentClient.Key | undefined;

  do {
    const result = await db()
      .query({
        TableName: MODEL_CHANGE_AUDIT_TABLE,
        KeyConditionExpression: "billingUserId = :user AND sk BETWEEN :start AND :end",
        ExpressionAttributeValues: {
          ":user": billingUserId,
          ":start": startDate,
          // `~` sorts above every character the sort key can contain, so the
          // range covers every instant within `endDate` regardless of its time
          // component. Same trick, and same reason, as `llmChargeAuditDb`.
          ":end": `${endDate}~`,
        },
        ScanIndexForward: false,
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      })
      .promise();
    items.push(...((result.Items || []) as ModelChangeAuditRecord[]));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

/**
 * Stamp a change as undone. Returns false if it was already undone.
 *
 * Conditioned rather than blind so a double-click cannot record two undos of one
 * change, which would make the history claim something that did not happen.
 */
export async function markModelChangeUndone(
  billingUserId: string,
  sk: string,
  undoneByUserId: string,
): Promise<boolean> {
  try {
    await db()
      .update({
        TableName: MODEL_CHANGE_AUDIT_TABLE,
        Key: { billingUserId, sk },
        UpdateExpression: "SET undoneAt = :at, undoneByUserId = :by",
        ConditionExpression: "attribute_exists(sk) AND attribute_not_exists(undoneAt)",
        ExpressionAttributeValues: {
          ":at": new Date().toISOString(),
          ":by": undoneByUserId,
        },
      })
      .promise();
    return true;
  } catch (error: unknown) {
    if ((error as { code?: string })?.code === "ConditionalCheckFailedException") return false;
    throw error;
  }
}
