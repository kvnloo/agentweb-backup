/**
 * Redeploy backstop for durable landing-page execution.
 *
 * The in-process completion hook (agentModeController.attachInProcessCompletion)
 * delivers a finished build's result back to its session — but it runs in the same
 * Node process as the build, so a backend redeploy can kill it. This poller is the
 * safety net for exactly that case. It ONLY touches records flagged
 * `awaitingReconnect` (a build whose run timed out and showed "still building"),
 * so builds that completed normally are never re-delivered.
 *
 * Per tick, for each unclaimed awaiting-reconnect build:
 *   - status `deployed`            → deliver the completion (recover a missed hook)
 *   - stuck in generating/deploying past the ceiling → mark failed + tell the user
 *   - otherwise (still building, not yet stuck) → leave it for the in-process hook
 *
 * Exactly-once is guaranteed by claimCompletion's conditional write, shared with
 * the in-process hook — whichever claims first delivers; the other no-ops.
 */
import AWS from "aws-sdk";
import type { GeneratedLandingPage } from "./v0Service";
import { deliverCompletion, deliverStuckFailure } from "./durableLandingService";

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  httpOptions: { timeout: 30_000, connectTimeout: 5_000 },
});

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const TABLE_NAME = `${TABLE_PREFIX}AW-LandingPages`;

/** A build still in this state past the ceiling is considered dead. */
const STUCK_CEILING_MS = 30 * 60 * 1000;

function isStuck(page: GeneratedLandingPage, nowMs: number): boolean {
  if (page.status !== "generating" && page.status !== "deploying") return false;
  const created = page.createdAt ? new Date(page.createdAt).getTime() : nowMs;
  return nowMs - created > STUCK_CEILING_MS;
}

/**
 * Run one poller sweep. Returns counts for logging/metrics. `nowMs` is injectable
 * for tests. Best-effort per record: one bad record never aborts the sweep.
 */
export async function runDurableLandingPollerOnce(
  nowMs: number = new Date().getTime()
): Promise<{ scanned: number; delivered: number; failed: number }> {
  let delivered = 0;
  let failed = 0;

  const result = await dynamodb
    .scan({
      TableName: TABLE_NAME,
      FilterExpression:
        "awaitingReconnect = :true AND attribute_not_exists(claimedCompletionAt) AND attribute_exists(originatingSessionId)",
      ExpressionAttributeValues: { ":true": true },
    })
    .promise();

  const pages = (result.Items || []) as GeneratedLandingPage[];

  for (const page of pages) {
    try {
      if (page.status === "deployed") {
        if (await deliverCompletion(page)) delivered++;
      } else if (isStuck(page, nowMs)) {
        if (await deliverStuckFailure(page)) failed++;
      }
      // else: still building and not yet stuck — leave it for the in-process hook.
    } catch (err: any) {
      console.error(`[DURABLE LANDING POLLER] failed to process page ${page.id}: ${err?.message}`);
    }
  }

  if (pages.length > 0) {
    console.log(
      `[DURABLE LANDING POLLER] swept ${pages.length} awaiting-reconnect build(s): ${delivered} delivered, ${failed} failed`
    );
  }
  return { scanned: pages.length, delivered, failed };
}

let pollerHandle: NodeJS.Timeout | undefined;

/**
 * Start the poller on an interval (default 5 min). No-op if the durable-execution
 * flag is off, or if already started. Registered from server.ts after boot.
 */
export function startDurableLandingPoller(intervalMs = 5 * 60 * 1000): void {
  if (process.env.DURABLE_LANDING_GENERATION !== "true") return;
  if (pollerHandle) return;
  pollerHandle = setInterval(() => {
    runDurableLandingPollerOnce().catch((err) =>
      console.error("[DURABLE LANDING POLLER] sweep failed:", err)
    );
  }, intervalMs);
  // Don't keep the event loop alive solely for the poller.
  if (typeof pollerHandle.unref === "function") pollerHandle.unref();
  console.log("[DURABLE LANDING POLLER] started");
}
