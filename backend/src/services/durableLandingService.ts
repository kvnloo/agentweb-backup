/**
 * Durable execution for long-running landing-page generation.
 *
 * Background: `generate_landing_page` runs inside the agent-mode HTTP request.
 * When the run times out (agentModeController GENERATION_TIMEOUT_MS) the work is
 * NOT cancelled — it keeps running detached and finishes, but nothing reconnects
 * to it, so a build that succeeded is reported as a failure and a retry starts a
 * second competing build. This module gives a generation an explicit, claimable
 * identity so:
 *   - a retry can RECONNECT to the in-flight build instead of starting a new one
 *     (findInFlightJobForSession), and
 *   - a late completion is delivered back to the originating session EXACTLY once
 *     (claimCompletion's conditional write is the single source of truth shared by
 *     the in-process hook and the redeploy-backstop poller).
 *
 * This module is intentionally I/O-only and side-effect-light: socket delivery
 * lives in the controller wiring where the `io` instance is available.
 */
import AWS from "aws-sdk";
import { paginatedQuery } from "../utils/dynamoPagination";
import type { GeneratedLandingPage } from "./v0Service";

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  httpOptions: { timeout: 30_000, connectTimeout: 5_000 },
});

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const TABLE_NAME = `${TABLE_PREFIX}AW-LandingPages`;

/** A landing-page build that has not reached a terminal state yet. */
const IN_FLIGHT_STATUSES: ReadonlyArray<GeneratedLandingPage["status"]> = [
  "generating",
  "deploying",
];

/**
 * Find the in-flight landing-page build (if any) that the given session spawned.
 * Used by the retry-reconnect path: when a user re-asks to build a page while one
 * is still generating, we return THIS instead of starting a second build (which
 * is what corrupts the single repo). Best-effort: any query failure resolves to
 * null so a transient DB error degrades to today's behavior rather than throwing
 * in the agent-mode hot path.
 */
export async function findInFlightJobForSession(
  userId: string,
  sessionId: string
): Promise<GeneratedLandingPage | null> {
  try {
    const pages = await paginatedQuery<GeneratedLandingPage>(dynamodb, {
      TableName: TABLE_NAME,
      IndexName: "UserIdIndex",
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: { ":userId": userId },
    });
    const inFlight = pages.filter(
      (p) =>
        p.originatingSessionId === sessionId &&
        IN_FLIGHT_STATUSES.includes(p.status)
    );
    if (inFlight.length === 0) return null;
    // Newest first — if somehow more than one is in flight, reconnect to the latest.
    inFlight.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    return inFlight[0];
  } catch (err: any) {
    console.error(
      `[DURABLE LANDING] findInFlightJobForSession failed for user=${userId} session=${sessionId}: ${err?.message}`
    );
    return null;
  }
}

/**
 * Atomically claim the right to deliver a completion for this page. Returns true
 * exactly once across all callers (the in-process hook AND the poller race for
 * the same record); every subsequent caller gets false and must no-op.
 *
 * Implemented as a conditional update that only succeeds when claimedCompletionAt
 * does not yet exist. A ConditionalCheckFailedException means "already claimed"
 * (return false). Any OTHER error is unexpected and propagates so it isn't
 * silently swallowed as a no-op.
 */
export async function claimCompletion(pageId: string): Promise<boolean> {
  try {
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id: pageId },
        UpdateExpression: "SET claimedCompletionAt = :now, updatedAt = :now",
        ConditionExpression: "attribute_not_exists(claimedCompletionAt)",
        ExpressionAttributeValues: { ":now": new Date().toISOString() },
      })
      .promise();
    return true;
  } catch (err: any) {
    if (err?.code === "ConditionalCheckFailedException") return false;
    throw err;
  }
}
