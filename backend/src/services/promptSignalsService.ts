/**
 * Prompt-quality feedback signals.
 *
 * Every interaction the user has with a generated ad variant is logged
 * here against the prompt version + archetype that produced it. The
 * partner-portal "Prompt Templates" tab aggregates these into like-rates,
 * skip-rates, and recent failures per archetype so we can iterate on
 * prompt quality with real numbers instead of vibes.
 *
 * Signal types:
 *   - "like"           — user hit the heart on the swipe deck
 *   - "skip"           — user hit the X on the swipe deck
 *   - "continue_set"   — user accepted the full set ("Looks good — continue")
 *   - "regenerate_set" — user regenerated the full set
 *
 * Table: Dev-AW-PromptSignals (or AW-PromptSignals in prod).
 *   PK:  signalId (UUID)
 *   GSI: PromptVersionIndex (promptVersion + ts) — for "show me recent
 *        signals for v2-brick5"
 *
 * Writes are fire-and-forget at the call site — a metrics outage cannot
 * break the user's onboarding flow.
 */

import AWS from "aws-sdk";
import { v4 as uuidv4 } from "uuid";

const TABLE_PREFIX =
  process.env.NODE_ENV === "development" ? "Dev-" : "";
const SIGNALS_TABLE = `${TABLE_PREFIX}AW-PromptSignals`;

const docClient = new AWS.DynamoDB.DocumentClient();

export type PromptSignalType =
  | "like"
  | "skip"
  | "continue_set"
  | "regenerate_set";

export interface PromptSignalInput {
  userId: string;
  /** Variant id (e.g. "variant-1"). Optional for set-level signals. */
  variantId?: string;
  /** Prompt builder + template version (e.g. "v2-brick5-2026-04-26"). */
  promptVersion?: string;
  /** Format archetype id (A-L). Optional for set-level signals. */
  archetype?: string;
  signal: PromptSignalType;
}

/**
 * Fire-and-forget write. Returns immediately; errors are swallowed with
 * a console.warn so a metrics outage doesn't cascade into broken UX.
 * Tests can `await` the returned promise to assert the write happened.
 */
export async function logPromptSignal(
  input: PromptSignalInput,
): Promise<void> {
  const env =
    process.env.NODE_ENV === "production"
      ? "prod"
      : process.env.NODE_ENV === "staging"
        ? "staging"
        : "dev";
  const item: Record<string, unknown> = {
    signalId: uuidv4(),
    userId: input.userId,
    signal: input.signal,
    ts: new Date().toISOString(),
    env,
  };
  if (input.variantId) item.variantId = input.variantId;
  if (input.promptVersion) item.promptVersion = input.promptVersion;
  if (input.archetype) item.archetype = input.archetype;
  // The PromptVersionIndex GSI requires promptVersion to exist. Stamp a
  // sentinel so set-level signals (continue_set, regenerate_set) without
  // a specific variant context still index cleanly.
  if (!item.promptVersion) item.promptVersion = "unknown";
  try {
    await docClient.put({ TableName: SIGNALS_TABLE, Item: item }).promise();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[promptSignalsService] write failed", {
      signal: input.signal,
      userId: input.userId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Aggregate signal counts for a given prompt version. Used by the
 * partner-portal Prompt Templates tab for the "live metrics" panel.
 */
export interface PromptSignalSummary {
  promptVersion: string;
  totals: Record<PromptSignalType, number>;
  /** Per-archetype breakdown, archetype id -> totals. */
  byArchetype: Record<string, Record<PromptSignalType, number>>;
  /** Number of signal rows examined. */
  sampleSize: number;
}

const ZERO_TOTALS: Record<PromptSignalType, number> = {
  like: 0,
  skip: 0,
  continue_set: 0,
  regenerate_set: 0,
};

export async function getPromptSignalSummary(
  promptVersion: string,
  limit = 1000,
): Promise<PromptSignalSummary> {
  const totals: Record<PromptSignalType, number> = { ...ZERO_TOTALS };
  const byArchetype: Record<string, Record<PromptSignalType, number>> = {};
  let sampleSize = 0;
  try {
    const resp = await docClient
      .query({
        TableName: SIGNALS_TABLE,
        IndexName: "PromptVersionIndex",
        KeyConditionExpression: "#pv = :pv",
        ExpressionAttributeNames: { "#pv": "promptVersion" },
        ExpressionAttributeValues: { ":pv": promptVersion },
        ScanIndexForward: false,
        Limit: limit,
      })
      .promise();
    for (const row of resp.Items || []) {
      const sig = row.signal as PromptSignalType | undefined;
      if (!sig || !(sig in totals)) continue;
      totals[sig] += 1;
      sampleSize += 1;
      const arch = typeof row.archetype === "string" ? row.archetype : "?";
      if (!byArchetype[arch]) byArchetype[arch] = { ...ZERO_TOTALS };
      byArchetype[arch][sig] += 1;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[promptSignalsService] summary query failed", {
      promptVersion,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return { promptVersion, totals, byArchetype, sampleSize };
}

/**
 * Compute like-rate from totals. Excludes set-level signals (continue /
 * regenerate) since those judge the full set, not individual variants.
 *
 * Returns null when there are no per-variant signals (avoids 0/0).
 */
export function computeLikeRate(
  totals: Record<PromptSignalType, number>,
): number | null {
  const denom = totals.like + totals.skip;
  if (denom === 0) return null;
  return totals.like / denom;
}
