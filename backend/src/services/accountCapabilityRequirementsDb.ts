/**
 * ENG-1541 remainder (items 1-2, see `eng1541-remainder-proposal.md` in workplan-brain for the
 * full design rationale — this file implements that proposal's final agreed shape).
 *
 * Persisted per-account capability tracking for `renewalIntegrationHealthCron.ts`, which
 * previously re-derived "does this account need ad-platform integration" from scratch on every
 * run with nothing surviving between runs. This table gives that state somewhere to live, and
 * gives a human a way to correct a specific occurrence without silencing the mechanism forever.
 *
 * Only ever holds a row for a user whose paid-ads intent is or was true — a user who has never
 * expressed that intent never gets a row, keeping the table scoped to accounts that have
 * genuinely ever needed the capability.
 */
import AWS from "aws-sdk";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const TABLE_NAME = `${TABLE_PREFIX}AW-AccountCapabilityRequirements`;

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  // Leave the SDK's normal credential-provider chain intact when explicit credentials are not
  // configured — same guard as db.ts/workPlanService.ts/config/aws.ts (ENG-1603).
  ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          ...(process.env.AWS_SESSION_TOKEN
            ? { sessionToken: process.env.AWS_SESSION_TOKEN }
            : {}),
        },
      }
    : {}),
});

/** Only one capability exists today. Keyed as a range key anyway — costs nothing, doesn't
 *  foreclose a second capability type showing up later without a schema change. */
export type AccountCapability = "ad_platform_integration";

export type AccountCapabilityStatus = "unhealthy" | "healthy" | "not_entitled" | "not_required";

/** Which of the three paid-ads-intent signals actually matched — same vocabulary
 *  `renewalIntegrationHealthCron.ts`'s own `paidAdsIntentReason` already uses. */
export type AccountCapabilitySourceDetail = "goal" | "emma_help_interests" | "onboarding_event";

/**
 * ENG-2143 / OPS-4 (ENG-2149): what establishes that the capability is required NOW. `source`
 * above only records why the row was first created (historical onboarding intent), which ENG-2016
 * showed cannot distinguish a stale intent from a current requirement.
 *  - `contracted`: explicitly required by the customer's agreement, set by a human. Does not age.
 *  - `recent_ads_action`: a verified ads action or work plan; current only while
 *    `requirementVerifiedAt` is within the last 30 days.
 *  - `onboarding_intent`: only the historical onboarding signal is known. Never current on its own.
 * An absent field means unknown. No code path writes these fields yet: OPS-4 backfills them with
 * `scripts/eng2149-backfill-requirement-source.ts`.
 */
export type AccountCapabilityRequirementSource = "contracted" | "recent_ads_action" | "onboarding_intent";

export interface AccountCapabilityRequirement {
  userId: string;
  capability: AccountCapability;
  requiredSince: string;
  source: "paid_ads_intent";
  sourceDetail: AccountCapabilitySourceDetail;
  status: AccountCapabilityStatus;
  statusChangedAt: string;
  lastVerifiedAt: string;
  correctedAt?: string;
  correctedBy?: string;
  correctionNote?: string;
  correctionExpiresAt?: string;
  requirementSource?: AccountCapabilityRequirementSource;
  /** ISO time the requirement source was last confirmed. */
  requirementVerifiedAt?: string;
  /** Who set the requirement source (admin email or the backfill id), for audit. */
  requirementSetBy?: string;
}

export async function getAccountCapabilityRequirement(
  userId: string,
  capability: AccountCapability
): Promise<AccountCapabilityRequirement | null> {
  const result = await dynamodb
    .get({ TableName: TABLE_NAME, Key: { userId, capability } })
    .promise();
  return (result.Item as AccountCapabilityRequirement) || null;
}

/**
 * True once `correctionExpiresAt` has passed. Distinct from `isSuppressed` below: an expired
 * correction still counts as "corrected" until the next write clears it (see
 * `clearExpiredCorrectionFields`) — this just answers whether that clearing/re-suppression
 * decision should treat it as still active.
 */
function isCorrectionExpired(row: AccountCapabilityRequirement, now: number): boolean {
  if (!row.correctionExpiresAt) return false;
  return now >= new Date(row.correctionExpiresAt).getTime();
}

/**
 * The suppression rule. `statusChangedAt <= correctedAt` (not `lastVerifiedAt`) is load-bearing:
 * `lastVerifiedAt` advances on every touch regardless of whether anything changed, so using it
 * here would defeat a correction on the very next run even if the account stayed genuinely
 * fixed. `correctionExpiresAt` is equally load-bearing — without it, a correction on an account
 * that's simply never fixed (status never transitions) suppresses that alert forever with zero
 * signal to anyone.
 */
export function isSuppressed(row: AccountCapabilityRequirement | null, now: number = Date.now()): boolean {
  if (!row?.correctedAt) return false;
  const statusChangedAt = new Date(row.statusChangedAt).getTime();
  const correctedAt = new Date(row.correctedAt).getTime();
  if (statusChangedAt > correctedAt) return false;
  return !isCorrectionExpired(row, now);
}

/**
 * The write every scanned user with `hasPaidAdsIntent` true this run (or previously true, now
 * lapsing to `not_required`) goes through. Attribute-scoped `UpdateItem` only — never touches
 * `correctedAt`/`correctedBy`/`correctionNote`/`correctionExpiresAt`, which are owned exclusively
 * by `setAccountCapabilityCorrection` below. A full-object `Put` here could silently clobber a
 * correction an admin just set.
 *
 * Symmetric across every caller: pass the row you already read (or `null` if none exists) so
 * this never does its own extra lookup, and it decides create-vs-update and whether
 * `statusChangedAt` moves entirely from that plus the new status.
 *
 * Returns the post-write row — callers that need to check `isSuppressed` right after writing
 * (the cron does) must use this return value, not the pre-write row they passed in: using the
 * stale value would check suppression against the WRONG `statusChangedAt` on exactly the run
 * that matters most — a real recurrence transitioning back to unhealthy, which needs its own
 * fresh `statusChangedAt` to correctly un-suppress, not the previous transition's.
 */
export async function upsertAccountCapabilityStatus(
  existing: AccountCapabilityRequirement | null,
  userId: string,
  capability: AccountCapability,
  status: AccountCapabilityStatus,
  // `null` for the not_required transition: there's no current paid-ads-intent reason to
  // report once intent has lapsed, so the last real value is preserved rather than
  // overwritten with something meaningless — more informative than clearing it.
  sourceDetail: AccountCapabilitySourceDetail | null,
  now: string = new Date().toISOString()
): Promise<AccountCapabilityRequirement> {
  const statusChanged = !existing || existing.status !== status;
  // A correction that has expired stops being active as of this same write — clear it here
  // rather than in a separate pass, since this write already touches the row.
  const expired = existing ? isCorrectionExpired(existing, new Date(now).getTime()) : false;

  const setParts = ["#status = :status", "statusChangedAt = :statusChangedAt", "lastVerifiedAt = :now"];
  const values: Record<string, any> = {
    ":status": status,
    ":statusChangedAt": statusChanged ? now : (existing?.statusChangedAt ?? now),
    ":now": now,
  };

  if (sourceDetail !== null) {
    setParts.push("sourceDetail = :sourceDetail");
    values[":sourceDetail"] = sourceDetail;
  }

  if (!existing) {
    setParts.push("requiredSince = :now", "#source = :source");
    values[":source"] = "paid_ads_intent";
  }

  // REMOVE, not SET-to-null: an admin using the read surface should see the field genuinely
  // gone, not present-with-a-null-value (see isSuppressed's own doc comment — this pairing is
  // what makes expiry actually mean something instead of leaving a stale-looking correction
  // next to a resumed alert).
  const removeClause = expired
    ? " REMOVE correctedAt, correctedBy, correctionNote, correctionExpiresAt"
    : "";

  const result = await dynamodb
    .update({
      TableName: TABLE_NAME,
      Key: { userId, capability },
      UpdateExpression: `SET ${setParts.join(", ")}${removeClause}`,
      ExpressionAttributeNames: { "#status": "status", ...(!existing ? { "#source": "source" } : {}) },
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    })
    .promise();
  return result.Attributes as AccountCapabilityRequirement;
}

/**
 * The write `setCorrectedAt`'s caller (the admin endpoint) uses — never called by the cron.
 * Deliberately separate from `upsertAccountCapabilityStatus` so the cron's per-run write can
 * never accidentally touch these fields.
 */
export async function setAccountCapabilityCorrection(
  userId: string,
  capability: AccountCapability,
  correctedBy: string,
  correctionNote: string | undefined,
  correctionLifetimeDays: number = 30
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + correctionLifetimeDays * 24 * 60 * 60 * 1000);
  const setParts = ["correctedAt = :correctedAt", "correctedBy = :correctedBy", "correctionExpiresAt = :expiresAt"];
  const values: Record<string, any> = {
    ":correctedAt": now.toISOString(),
    ":correctedBy": correctedBy,
    ":expiresAt": expiresAt.toISOString(),
  };
  // Omit rather than SET-to-null when no note is given, so the field is genuinely absent
  // (matching how it's cleared on expiry above), not present with a null value.
  if (correctionNote) {
    setParts.push("correctionNote = :note");
    values[":note"] = correctionNote;
  }

  await dynamodb
    .update({
      TableName: TABLE_NAME,
      Key: { userId, capability },
      UpdateExpression: `SET ${setParts.join(", ")}`,
      ConditionExpression: "attribute_exists(userId)",
      ExpressionAttributeValues: values,
    })
    .promise();
}

/**
 * ENG-2143: dedupe state for account-health signals. One row per account under its own range key,
 * so it never touches (or creates) a paid-ads `ad_platform_integration` row. Written only by
 * `accountHealthClassifierCron`, which runs only when ACCOUNT_HEALTH_ALERTS_ENABLED=true.
 */
export const ACCOUNT_HEALTH_SIGNAL_CAPABILITY = "account_health_signal";

export interface AccountHealthSignalState {
  /** The classifier state last recorded for this account. */
  state: string;
  /** When the account entered `state`. A new value starts a new episode, which may alert again. */
  stateSince: string;
  /** `state|billingCycle|stateSince` of the last emitted signal. */
  lastEpisodeKey?: string;
  /** Evidence codes already reported in that episode. */
  lastSignalCodes?: string[];
  lastSignalAt?: string;
  /** Channel of the last emitted signal, so a later needs_review → oncall escalation is not
   * mistaken for an unchanged repeat. */
  lastSignalChannel?: string;
  /** Optimistic-concurrency counter: every instance runs the cron, and only one may emit. */
  version: number;
}

export async function getAccountHealthSignalState(userId: string): Promise<AccountHealthSignalState | null> {
  const result = await dynamodb
    .get({ TableName: TABLE_NAME, Key: { userId, capability: ACCOUNT_HEALTH_SIGNAL_CAPABILITY } })
    .promise();
  if (!result.Item) return null;
  const { state, stateSince, lastEpisodeKey, lastSignalCodes, lastSignalAt, lastSignalChannel, version } = result.Item;
  return { state, stateSince, lastEpisodeKey, lastSignalCodes, lastSignalAt, lastSignalChannel, version };
}

/**
 * Writes `next` only if the row is still at `expectedVersion` (null = no row yet). Returns false
 * when another writer got there first, in which case the caller must not emit: that writer did.
 */
export async function putAccountHealthSignalState(
  userId: string,
  next: AccountHealthSignalState,
  expectedVersion: number | null
): Promise<boolean> {
  try {
    await dynamodb
      .put({
        TableName: TABLE_NAME,
        Item: { userId, capability: ACCOUNT_HEALTH_SIGNAL_CAPABILITY, ...next },
        ...(expectedVersion === null
          ? { ConditionExpression: "attribute_not_exists(userId)" }
          : {
              ConditionExpression: "version = :expected",
              ExpressionAttributeValues: { ":expected": expectedVersion },
            }),
      })
      .promise();
    return true;
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "ConditionalCheckFailedException") return false;
    throw error;
  }
}
