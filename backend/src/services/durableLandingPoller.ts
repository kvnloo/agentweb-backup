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
import { deliverCompletion, deliverStuckFailure, STUCK_CEILING_MS } from "./durableLandingService";
import { isCronEnabled } from "../utils/instanceState";
import { cronJobRegistry } from "../utils/cronJobRegistry";
import { paginatedScan } from "../utils/dynamoPagination";

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  httpOptions: { timeout: 30_000, connectTimeout: 5_000 },
});

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const TABLE_NAME = `${TABLE_PREFIX}AW-LandingPages`;

function isStuck(page: GeneratedLandingPage, nowMs: number): boolean {
  if (page.status !== "generating" && page.status !== "deploying") return false;
  const created = page.createdAt ? new Date(page.createdAt).getTime() : nowMs;
  return nowMs - created > STUCK_CEILING_MS;
}

/**
 * Universal janitor: mark ANY abandoned in-flight build failed, not just
 * agent-session (`awaitingReconnect`) ones. Portal-initiated builds have no session
 * to deliver to, so before this sweep a crash/redeploy mid-build left them
 * `generating` forever — an eternal yellow card with no action button, and (until
 * the reuse age-ceiling in findReusablePageForRoute) a record that swallowed every
 * future build of its route. Staleness is judged on updatedAt: a build that
 * progressed recently is alive even if it started long ago. The conditional update
 * only fires if the record hasn't moved since the scan, so a live build that
 * progresses mid-sweep is untouched.
 */
export async function sweepAbandonedBuilds(
  nowMs: number = new Date().getTime()
): Promise<{ scanned: number; failed: number }> {
  // paginatedScan: a plain Scan caps at 1 MB per call, and a sweep that silently
  // misses the tail recreates the exact "eternal generating card" bug it exists
  // to prevent.
  const pages = await paginatedScan<GeneratedLandingPage>(dynamodb, {
    TableName: TABLE_NAME,
    FilterExpression:
      "(#status = :generating OR #status = :deploying) AND (attribute_not_exists(archived) OR archived = :false)",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":generating": "generating",
      ":deploying": "deploying",
      ":false": false,
    },
  });
  let failed = 0;

  for (const page of pages) {
    // Agent-session builds are handled by the awaitingReconnect sweep, which also
    // delivers the failure message back to the user's session.
    if ((page as any).awaitingReconnect) continue;
    const lastMoved = new Date(page.updatedAt || page.createdAt || 0).getTime();
    if (!Number.isFinite(lastMoved) || nowMs - lastMoved <= STUCK_CEILING_MS) continue;

    // Legacy records may lack updatedAt entirely; `undefined` in
    // ExpressionAttributeValues makes the SDK throw a serialization error (not a
    // conditional failure), which would leave the record unsweepable forever.
    const hasUpdatedAt = typeof page.updatedAt === "string" && page.updatedAt.length > 0;
    try {
      await dynamodb
        .update({
          TableName: TABLE_NAME,
          Key: { id: page.id },
          UpdateExpression:
            "SET #status = :failed, errorMessage = :error, updatedAt = :now",
          ConditionExpression: hasUpdatedAt
            ? "#status = :oldStatus AND updatedAt = :oldUpdatedAt"
            : "#status = :oldStatus AND attribute_not_exists(updatedAt)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":failed": "failed",
            ":error":
              `Build abandoned in '${page.status}' — the server restarted or the build crashed mid-run. ` +
              "Retry the generation; abandoned attempts never block a retry.",
            ":now": new Date(nowMs).toISOString(),
            ":oldStatus": page.status,
            ...(hasUpdatedAt ? { ":oldUpdatedAt": page.updatedAt } : {}),
          },
        })
        .promise();
      failed++;
      console.log(
        `[DURABLE LANDING POLLER] marked abandoned build failed: ${page.id} (${page.slug || page.name || "?"}, stuck in ${page.status})`
      );
    } catch (err: any) {
      if (err?.code === "ConditionalCheckFailedException") continue; // build moved — it's alive
      console.error(`[DURABLE LANDING POLLER] failed to sweep page ${page.id}: ${err?.message}`);
    }
  }

  return { scanned: pages.length, failed };
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

  const pages = await paginatedScan<GeneratedLandingPage>(dynamodb, {
    TableName: TABLE_NAME,
    FilterExpression:
      "awaitingReconnect = :true AND attribute_not_exists(claimedCompletionAt) AND attribute_exists(originatingSessionId)",
    ExpressionAttributeValues: { ":true": true },
  });

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
 * Start the poller on an interval (default 5 min). Registered from server.ts after
 * boot. Unlike the original durable-execution bolt-on, this is NOT gated on
 * DURABLE_LANDING_GENERATION: the abandoned-build janitor must run for portal
 * builds too, or a crash mid-build leaves records `generating` forever (ENG-287
 * hygiene). The awaitingReconnect delivery sweep no-ops when the flag has never
 * minted such records.
 */
export function startDurableLandingPoller(intervalMs = 5 * 60 * 1000): void {
  if (pollerHandle) return;
  pollerHandle = setInterval(() => {
    if (!isCronEnabled()) return;
    cronJobRegistry.track("durableLandingPoller", runDurableLandingPollerOnce()).catch((err) =>
      console.error("[DURABLE LANDING POLLER] sweep failed:", err)
    );
    cronJobRegistry.track("landingBuildJanitor", sweepAbandonedBuilds()).catch((err) =>
      console.error("[DURABLE LANDING POLLER] janitor sweep failed:", err)
    );
  }, intervalMs);
  // Don't keep the event loop alive solely for the poller.
  if (typeof pollerHandle.unref === "function") pollerHandle.unref();
  console.log("[DURABLE LANDING POLLER] started (reconnect delivery + abandoned-build janitor)");
}
