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

const router = express.Router();

// Keep the event log bounded so User records don't grow unbounded.
const MAX_EVENTS_PER_USER = 50;
// Cap per-event payload to prevent abuse / runaway DynamoDB item size.
const MAX_DATA_BYTES = 2048;

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

    const newStage = deriveOnboardingStage(appended, {
      lastActiveAt: (user as any).lastActiveAt,
    });

    const updated = await userDb.updateUser(userId, {
      onboardingEvents: appended,
      onboardingStage: newStage,
    } as any);

    if (!updated) {
      return res.status(404).json({ message: "User not found after update" });
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

/**
 * GET /api/onboarding/users?stage=<stage>
 *
 * Admin-only: list users filtered by `onboardingStage`. Used by Emma tools
 * and the drip campaign segmentation UI. Returns a slim view — `userId`,
 * `email`, `onboardingStage`, plus a handful of signal fields the drip
 * campaign needs to pick a template.
 *
 * If `stage` is omitted we return all users with any stage set.
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

      const slim = items.map((u) => ({
        userId: u.userId,
        email: u.email,
        displayName: u.displayName,
        onboardingStage: u.onboardingStage,
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
