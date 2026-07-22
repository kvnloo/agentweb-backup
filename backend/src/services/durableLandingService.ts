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
 * A build still sitting in an in-flight status this long after it was created has
 * no live process behind it — the owning run has long since timed out (and, if it
 * were still legitimately running detached, finished). Past this age an in-flight
 * record is a zombie: reconnecting to it would wedge the session on "still building"
 * forever. Shared with the redeploy poller (its stuck ceiling) so both agree on the
 * exact moment an in-flight build is considered dead.
 */
export const STUCK_CEILING_MS = 30 * 60 * 1000;

/**
 * True when an in-flight record is old enough that no live process can still own it
 * (see {@link STUCK_CEILING_MS}). A record with no timestamp is treated as fresh
 * (never a zombie) — the same lenient default the poller uses.
 *
 * Measured from `updatedAt`, matching the abandoned-build janitor: a build that PROGRESSED
 * recently is alive even if it started long ago. Keying this on `createdAt` while the
 * janitor keyed on `updatedAt` meant the two disagreed about what "dead" means — a long but
 * healthy build (slow generation + a correction round + a slow Vercel build) was declared a
 * zombie, `deliverStuckFailure` burned its one-shot completion claim to tell the user
 * "nothing was deployed", and then the real success could never be delivered because the
 * claim was already spent. The page was live at a URL the user was never given.
 * (ENG-287 residual)
 */
function isZombieInFlight(page: GeneratedLandingPage, nowMs: number): boolean {
  const ts = page.updatedAt || page.createdAt;
  if (!ts) return false;
  const ageMs = nowMs - new Date(ts).getTime();
  return Number.isFinite(ageMs) && ageMs > STUCK_CEILING_MS;
}

/**
 * Find the in-flight landing-page build (if any) that the given session spawned.
 * Used by the retry-reconnect path: when a user re-asks to build a page while one
 * is still generating, we return THIS instead of starting a second build (which
 * is what corrupts the single repo). Best-effort: any query failure resolves to
 * null so a transient DB error degrades to today's behavior rather than throwing
 * in the agent-mode hot path. Records stuck in-flight past {@link STUCK_CEILING_MS}
 * are treated as dead (zombies) and skipped so a crashed build never blocks retries.
 */
export async function findInFlightJobForSession(
  userId: string,
  sessionId: string,
  nowMs: number = Date.now()
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
        IN_FLIGHT_STATUSES.includes(p.status) &&
        // Skip zombies: a build stuck in-flight past the ceiling has no live process,
        // so reconnecting would wedge the session on "still building" forever. Ignoring
        // it lets a fresh build start instead.
        !isZombieInFlight(p, nowMs)
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
        // Clear awaitingReconnect in the same atomic write: once a completion is
        // claimed (by the in-process hook or the poller), the build no longer owes
        // its session anything, so it must drop off the poller's awaiting-reconnect
        // sweep. Leaving the flag set was harmless (claimedCompletionAt already
        // blocks re-delivery) but left stale state on the record.
        UpdateExpression: "SET claimedCompletionAt = :now, updatedAt = :now REMOVE awaitingReconnect",
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

/**
 * Mark that a build's run timed out and it still owes its session a completion.
 * The redeploy poller only acts on records flagged this way, so normally-completed
 * builds are never re-delivered. Best-effort — a failure here just means the
 * poller won't pick this build up if the in-process hook also dies.
 */
export async function markAwaitingReconnect(pageId: string): Promise<void> {
  try {
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id: pageId },
        UpdateExpression: "SET awaitingReconnect = :t, updatedAt = :now",
        ExpressionAttributeValues: { ":t": true, ":now": new Date().toISOString() },
      })
      .promise();
  } catch (err: any) {
    console.error(`[DURABLE LANDING] markAwaitingReconnect failed for ${pageId}: ${err?.message}`);
  }
}

/** The user-facing completion line for a finished build, derived from the record. */
export function buildCompletionMessage(page: GeneratedLandingPage): string {
  const url = page.customDomainUrl || page.deployedUrl;
  return url
    ? `✅ Your landing page **${page.name}** is live: ${url}`
    : `✅ Your landing page **${page.name}** finished building.`;
}

/**
 * Deliver a finished build's result back into the session that spawned it, EXACTLY
 * once. Used by the redeploy-backstop poller (which holds only the page record, not
 * the original agent response) — it appends the completion line to the session and
 * pushes it live to the user. The in-process controller hook delivers its own
 * (already-persisted) response and only needs claimCompletion + the socket emit.
 *
 * Returns true if THIS call delivered, false if another deliverer already claimed
 * it or the page has no originating session. Delivery-side failures (session gone,
 * socket down) are swallowed after the claim so the poller doesn't retry forever.
 */
export async function deliverCompletion(page: GeneratedLandingPage): Promise<boolean> {
  if (!page.originatingSessionId) return false;
  const claimed = await claimCompletion(page.id);
  if (!claimed) return false;

  await postToSession(page, buildCompletionMessage(page));
  return true;
}

/**
 * Deliver a truthful FAILURE for a build that has been stuck past the ceiling
 * (e.g. the run timed out, then a redeploy killed the detached work mid-build so
 * it never reached `deployed`). Claims exactly once, marks the record failed, and
 * tells the user plainly instead of leaving "still building" forever.
 */
export async function deliverStuckFailure(page: GeneratedLandingPage): Promise<boolean> {
  if (!page.originatingSessionId) return false;
  const claimed = await claimCompletion(page.id);
  if (!claimed) return false;

  try {
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id: page.id },
        UpdateExpression: "SET #s = :failed, errorMessage = :msg, updatedAt = :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": "failed",
          ":msg": "Generation exceeded the maximum build time and was marked failed by the poller.",
          ":now": new Date().toISOString(),
        },
      })
      .promise();
  } catch (err: any) {
    console.error(`[DURABLE LANDING] deliverStuckFailure status update failed for ${page.id}: ${err?.message}`);
  }

  await postToSession(
    page,
    `⚠️ Your landing page **${page.name}** didn't finish building in time. Nothing was deployed — just ask me to try again and I'll rebuild it.`
  );
  return true;
}

/** Append a message to the originating session (if it still exists) and push it live. */
async function postToSession(page: GeneratedLandingPage, content: string): Promise<void> {
  if (!page.originatingSessionId) return;
  try {
    const { chatbotDb } = await import("./chatbotService");
    const session = await chatbotDb.getChatSession(page.originatingSessionId).catch(() => null);
    if (session) {
      await chatbotDb.addMessageToSession(page.originatingSessionId, { role: "assistant", content });
    }
    const { io } = await import("../server");
    io.to(`user:${page.userId}`).emit("session-message-appended", {
      sessionId: page.originatingSessionId,
      message: { role: "assistant", content },
    });
  } catch (err: any) {
    console.error(
      `[DURABLE LANDING] post-back delivery failed for page ${page.id} (claim already held): ${err?.message}`
    );
  }
}
