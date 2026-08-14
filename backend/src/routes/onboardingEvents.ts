/**
 * Onboarding events — Phase 1 of the Lifecycle Drip epic.
 *
 * The frontend onboarding flow (OnboardingV2.tsx) already emits events
 * locally to `localStorage`. This route persists the same stream server-side
 * so Emma / admin tooling / drip campaigns can segment users by where they
 * are in onboarding without reading the client's local state.
 *
 * Endpoints
 *   POST /api/onboarding/events          — append one event to the log
 *   GET  /api/onboarding/events/me       — read caller's event log + derived stage
 *   GET  /api/onboarding/users           — admin: list users by onboardingStage
 */

import express, { Request, Response } from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { isAdmin } from "../middleware/admin";
import { userDb } from "../services/db";
import {
  ALLOWED_ONBOARDING_EVENTS,
  ALL_ONBOARDING_STAGES,
  deriveOnboardingStage,
  isOnboardingStage,
  OnboardingEvent,
} from "../utils/onboardingStage";
import { onOnboardingStageChanged } from "../services/contactCaptureHooks";
import { mirrorOnboardingEventToLead } from "../services/onboardingLeadSync";

const router = express.Router();

// Keep the event log bounded so User records don't grow unbounded.
const MAX_EVENTS_PER_USER = 50;
// Cap per-event payload to prevent abuse / runaway DynamoDB item size.
const MAX_DATA_BYTES = 2048;

// These beta funnel signals are analytics-only. They are persisted in the
// event log, but must never create a lifecycle transition or timeline entry.
const LATERAL_ONBOARDING_EVENTS = new Set([
  "voice_onboarding_presented",
  "voice_onboarding_started",
  "voice_onboarding_text_fallback",
]);

/**
 * POST /api/onboarding/events
 * Body: { event: string, data?: object }
 *
 * Appends the event to the caller's `onboardingEvents` log and recomputes
 * `onboardingStage`. Returns the updated stage + event count.
 */
router.post("/events", authenticateToken, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    const { event, data } = req.body ?? {};
    if (typeof event !== "string" || event.length === 0) {
      return res
        .status(400)
        .json({ message: "event must be a non-empty string" });
    }
    if (!ALLOWED_ONBOARDING_EVENTS.has(event)) {
      return res.status(400).json({ message: `Unknown event: ${event}` });
    }

    // Payload is optional, but if present must be a plain object.
    let normalisedData: Record<string, unknown> | undefined;
    if (data !== undefined && data !== null) {
      if (
        typeof data !== "object" ||
        Array.isArray(data) ||
        data.constructor !== Object
      ) {
        return res
          .status(400)
          .json({ message: "data must be a plain object if provided" });
      }
      // Defensive size cap — stringify and measure.
      const serialised = JSON.stringify(data);
      if (serialised.length > MAX_DATA_BYTES) {
        return res
          .status(400)
          .json({ message: `data payload exceeds ${MAX_DATA_BYTES} bytes` });
      }
      normalisedData = data as Record<string, unknown>;
    }

    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const existing: OnboardingEvent[] = Array.isArray(
      (user as any).onboardingEvents,
    )
      ? ((user as any).onboardingEvents as OnboardingEvent[])
      : [];

    const newEvent: OnboardingEvent = {
      event,
      ts: new Date().toISOString(),
      ...(normalisedData !== undefined && { data: normalisedData }),
    };

    // Append + cap to the last MAX_EVENTS_PER_USER events (FIFO drop).
    const appended = [...existing, newEvent].slice(-MAX_EVENTS_PER_USER);

    const derivedStage = deriveOnboardingStage(appended, {
      lastActiveAt: (user as any).lastActiveAt,
    });
    const previousStage = (user as any).onboardingStage ?? null;
    // Analytics-only voice events must not create or change lifecycle state.
    // They remain in the event stream, while all lifecycle consumers see the
    // previously persisted stage unchanged.
    const newStage = LATERAL_ONBOARDING_EVENTS.has(event)
      ? previousStage
      : derivedStage;

    const updated = await userDb.updateUser(userId, {
      onboardingEvents: appended,
      onboardingStage: newStage,
    } as any);

    if (!updated) {
      return res.status(404).json({ message: "User not found after update" });
    }

    // Mirror stage transitions into the contact activity timeline.
    // Fire-and-forget — must never break the onboarding event handler.
    if (
      newStage &&
      newStage !== previousStage &&
      !LATERAL_ONBOARDING_EVENTS.has(event) &&
      user.email
    ) {
      onOnboardingStageChanged({
        userId,
        email: user.email,
        fromStage: previousStage,
        toStage: newStage,
        triggeredByEvent: event,
        changedAt: newEvent.ts,
      }).catch(() => {});
    }

    // Onboarding v2: dual-write the full event stream to the matched Lead
    // row so Fangfang / Emma can reason over Lead records without cross-joining
    // to User. Fire-and-forget — must never break the primary User write.
    // Task: https://www.notion.so/34c09247c951812cbc90f09aa68fc5d3
    if (user.email) {
      mirrorOnboardingEventToLead({
        userId,
        email: user.email,
        event: newEvent,
        allEvents: appended,
        onboardingStage: newStage,
      }).catch(() => {});
    }

    return res.status(200).json({
      onboardingStage: newStage,
      eventCount: appended.length,
      recorded: newEvent,
    });
  } catch (error) {
    console.error("Error recording onboarding event:", error);
    return res
      .status(500)
      .json({ message: "Failed to record onboarding event" });
  }
});

/**
 * GET /api/onboarding/events/me
 *
 * Returns the caller's full event log and current derived stage. Used by the
 * frontend to reconcile with localStorage after a session is resumed on a
 * new device.
 */
router.get("/events/me", authenticateToken, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    const events: OnboardingEvent[] = Array.isArray(
      (user as any).onboardingEvents,
    )
      ? ((user as any).onboardingEvents as OnboardingEvent[])
      : [];
    const stage = deriveOnboardingStage(events, {
      lastActiveAt: (user as any).lastActiveAt,
    });
    return res.json({
      onboardingEvents: events,
      onboardingStage: stage,
    });
  } catch (error) {
    console.error("Error fetching onboarding events:", error);
    return res
      .status(500)
      .json({ message: "Failed to fetch onboarding events" });
  }
});

/** Phase 2: server-side cap on `limit` to prevent abuse + DynamoDB scan blowups. */
const MAX_USERS_LIMIT = 500;

/**
 * Pull the user's most recent `goal_selected` event's `data.goal` out of their
 * onboarding event log. Returns null if no `goal_selected` event was seen or
 * the event had no `goal` field. Phase 2 — used by Emma segmentation so the
 * drip engine can pick a goal-specific template (e.g. "paid_ads" → ads drip).
 */
function extractOnboardingGoal(
  events: OnboardingEvent[] | undefined,
): string | null {
  if (!Array.isArray(events) || events.length === 0) return null;
  // Iterate newest-first. Events may arrive out of order so sort defensively.
  const goalEvents = events
    .filter((e) => e?.event === "goal_selected")
    .slice()
    .sort((a, b) => {
      const ta = a?.ts ? Date.parse(a.ts) : 0;
      const tb = b?.ts ? Date.parse(b.ts) : 0;
      return tb - ta;
    });
  for (const e of goalEvents) {
    const goal = (e?.data as any)?.goal;
    if (typeof goal === "string" && goal.length > 0) return goal;
  }
  return null;
}

/**
 * GET /api/onboarding/users
 *   ?stage=<stage>
 *   ?lastActivityBefore=<ISO date>   (Phase 2: inactive-cutoff filter)
 *   ?limit=<n>                        (Phase 2: cap result count, max 500)
 *
 * Admin-only: list users filtered by `onboardingStage`. Used by Emma tools
 * and the drip campaign segmentation UI. Returns a slim view — `userId`,
 * `email`, `companyName`, `onboardingStage`, `onboardingGoal`, plus a handful
 * of signal fields the drip campaign needs to pick a template.
 *
 * If `stage` is omitted we return all users with any stage set.
 * If `lastActivityBefore` is provided, users with no `lastActiveAt` are
 * EXCLUDED (we can't prove they were inactive before the cutoff — safer to
 * skip than to spam cold users).
 */
router.get(
  "/users",
  authenticateToken,
  isAdmin,
  async (req: Request, res: Response) => {
    try {
      const stage = typeof req.query.stage === "string" ? req.query.stage : "";
      if (stage && !isOnboardingStage(stage)) {
        return res.status(400).json({
          message: `Invalid stage. Must be one of: ${ALL_ONBOARDING_STAGES.join(", ")}`,
        });
      }

      // Phase 2: parse optional `lastActivityBefore` (ISO date).
      let activityCutoff: number | null = null;
      if (typeof req.query.lastActivityBefore === "string" && req.query.lastActivityBefore) {
        const parsed = Date.parse(req.query.lastActivityBefore);
        if (Number.isNaN(parsed)) {
          return res.status(400).json({
            message:
              "Invalid lastActivityBefore. Must be an ISO 8601 date string (e.g. 2026-04-10T00:00:00Z).",
          });
        }
        activityCutoff = parsed;
      }

      // Phase 2: parse optional `limit`, cap at MAX_USERS_LIMIT.
      let limit: number | null = null;
      if (typeof req.query.limit === "string" && req.query.limit) {
        const parsedLimit = Number(req.query.limit);
        if (!Number.isFinite(parsedLimit) || !Number.isInteger(parsedLimit)) {
          return res.status(400).json({
            message: "Invalid limit. Must be a positive integer.",
          });
        }
        if (parsedLimit <= 0) {
          return res.status(400).json({
            message: "Invalid limit. Must be a positive integer.",
          });
        }
        limit = Math.min(parsedLimit, MAX_USERS_LIMIT);
      }

      // Full-table scan + JS filter. Scale caveat matches getAllUsers()
      // — no GSI on `onboardingStage` yet. The user base is small enough
      // today (~5k) that a scan is fine; add a GSI if this gets hot.
      const allUsers = await userDb.getAllUsers();
      let items = allUsers.filter((u) => !u.userId?.startsWith("deleted_"));
      if (stage) {
        items = items.filter(
          (u) => (u as any).onboardingStage === stage,
        );
      } else {
        items = items.filter(
          (u) =>
            typeof (u as any).onboardingStage === "string" &&
            (u as any).onboardingStage,
        );
      }

      if (activityCutoff !== null) {
        items = items.filter((u) => {
          const la = (u as any).lastActiveAt;
          if (typeof la !== "string" || !la) return false; // skip unknown-activity users
          const ts = Date.parse(la);
          if (Number.isNaN(ts)) return false;
          return ts < (activityCutoff as number);
        });
      }

      if (limit !== null) {
        items = items.slice(0, limit);
      } else if (items.length > MAX_USERS_LIMIT) {
        // Hard safety cap even if caller didn't ask, so Emma / drip UI never
        // accidentally blasts 10k users.
        items = items.slice(0, MAX_USERS_LIMIT);
      }

      const slim = items.map((u) => ({
        userId: u.userId,
        email: u.email,
        displayName: u.displayName,
        companyName: (u as any).companyName,
        onboardingStage: u.onboardingStage,
        onboardingGoal: extractOnboardingGoal(
          (u as any).onboardingEvents as OnboardingEvent[] | undefined,
        ),
        onboardingEventCount: Array.isArray(u.onboardingEvents)
          ? u.onboardingEvents.length
          : 0,
        lastActiveAt: u.lastActiveAt,
        createdAt: u.createdAt,
        emmaHelpInterests: u.emmaHelpInterests ?? [],
      }));

      return res.json({ stage: stage || null, count: slim.length, users: slim });
    } catch (error) {
      console.error("Error listing users by onboarding stage:", error);
      return res
        .status(500)
        .json({ message: "Failed to list users by onboarding stage" });
    }
  },
);

export default router;
