/**
 * ENG-2110 (B3): connecting a customer's Claude subscription.
 *
 *   POST   /api/llm-connections/claude-subscription/start          { reconnectConnectionId? } -> { loginId, authorizeUrl, expiresAt }
 *   POST   /api/llm-connections/claude-subscription/complete       { loginId, code }          -> { connection }
 *   DELETE /api/llm-connections/claude-subscription/login/:loginId  cancel a pending sign-in
 *
 * Listing and disconnecting use the existing /api/llm-connections routes. Gated per user
 * by the `claudeSubscription` flag (the `*` wildcard is not honoured). The one-time code
 * appears in one request body and in no response and no log line; errors log a code only.
 * A sign-in is pending in this process's memory: if it is completed on another instance
 * (or after a deploy) the answer is 409 login_not_found, meaning "start again".
 */
import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { authenticateToken, type AuthenticatedRequest } from "../middleware/auth";
import { ClaudeSubscriptionError, getClaudeSubscriptionService, type Actor, type ClaudeSubscriptionService } from "../services/funding/claudeSubscriptionService";

function actorOf(req: Request): Actor {
  const { user, delegateInfo } = req as unknown as AuthenticatedRequest & { delegateInfo?: { adminUserId?: string } };
  return { userId: user!.userId, ...(delegateInfo?.adminUserId ? { adminId: delegateInfo.adminUserId } : {}) };
}

function fail(res: Response, err: unknown, where: string): void {
  if (err instanceof ClaudeSubscriptionError) {
    res.status(err.httpStatus).json({ error: err.code });
    return;
  }
  // The error object is not logged: it could carry process output.
  console.error(`[claude-subscription] ${where} failed: ${(err as { code?: string })?.code || (err as Error)?.name || "error"}`);
  res.status(500).json({ error: "internal_error" });
}

export function createClaudeSubscriptionRouter(service: () => ClaudeSubscriptionService = getClaudeSubscriptionService): Router {
  const router = Router();
  router.use(authenticateToken);
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 10,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => (req as AuthenticatedRequest).user!.userId,
    }),
  );
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.post("/start", async (req, res) => {
    try {
      const reconnect = (req.body ?? {}).reconnectConnectionId;
      if (reconnect !== undefined && (typeof reconnect !== "string" || reconnect.length > 100)) {
        res.status(400).json({ error: "bad_request" });
        return;
      }
      res.status(201).json(await service().startLogin(actorOf(req), { reconnectConnectionId: reconnect }));
    } catch (err) {
      fail(res, err, "start");
    }
  });

  router.post("/complete", async (req, res) => {
    try {
      const { loginId, code } = (req.body ?? {}) as { loginId?: unknown; code?: unknown };
      if (typeof loginId !== "string" || loginId.length > 64 || typeof code !== "string" || code.length > 512) {
        res.status(400).json({ error: "bad_request" });
        return;
      }
      res.status(201).json({ connection: await service().completeLogin(actorOf(req), loginId, code) });
    } catch (err) {
      fail(res, err, "complete");
    }
  });

  router.delete("/login/:loginId", async (req, res) => {
    try {
      await service().cancelLogin(actorOf(req), req.params.loginId);
      res.status(204).end();
    } catch (err) {
      fail(res, err, "cancel");
    }
  });

  return router;
}
