/**
 * ENG-2110 (1c): connecting a customer's subscription login that lives on the login host.
 *
 *   POST   /api/llm-connections/subscriptions/:provider/start           { reconnectConnectionId? } -> { loginId, authorizeUrl, ceremony, expiresAt }
 *   POST   /api/llm-connections/subscriptions/:provider/complete        { loginId, code }          -> { connection }
 *   DELETE /api/llm-connections/subscriptions/:provider/login/:loginId  cancel a pending sign-in
 *
 * Listing and disconnecting use the generic /api/llm-connections routes (a hosted login is disconnected through the login host).
 * Gated per user by the provider's funding flag (the `*` wildcard is not honoured). The one-time code appears in one request body and
 * in no response and no log line; errors log a code only. `loginId` is a sealed token (hostedSignInToken.ts), so a sign-in can be completed by any
 * instance and survives a deploy; 409 login_not_found now means expired, already used or cancelled, i.e. "start again".
 */
import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { authenticateToken, type AuthenticatedRequest } from "../middleware/auth";
import { getHostedSubscriptionService, HostedSubscriptionError, type HostedSubscriptionService } from "../services/funding/hostedSubscriptionService";
import { MAX_SIGNIN_TOKEN_CHARS } from "../services/funding/hostedSignInToken";
import type { Actor } from "../services/funding/llmConnectionService";

function actorOf(req: Request): Actor {
  const { user, delegateInfo } = req as unknown as AuthenticatedRequest & { delegateInfo?: { adminUserId?: string } };
  return { userId: user!.userId, ...(delegateInfo?.adminUserId ? { adminId: delegateInfo.adminUserId } : {}) };
}

function fail(res: Response, err: unknown, where: string): void {
  if (err instanceof HostedSubscriptionError) {
    res.status(err.httpStatus).json({ error: err.code });
    return;
  }
  // The error object is not logged: it could carry host output.
  console.error(`[hosted-subscription] ${where} failed: ${(err as { code?: string })?.code || (err as Error)?.name || "error"}`);
  res.status(500).json({ error: "internal_error" });
}

export function createHostedSubscriptionsRouter(service: () => HostedSubscriptionService = getHostedSubscriptionService): Router {
  const router = Router({ mergeParams: true });
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
      res.status(201).json(await service().startLogin(actorOf(req), (req.params as { provider: string }).provider, { reconnectConnectionId: reconnect }));
    } catch (err) {
      fail(res, err, "start");
    }
  });

  router.post("/complete", async (req, res) => {
    try {
      const { loginId, code } = (req.body ?? {}) as { loginId?: unknown; code?: unknown };
      if (typeof loginId !== "string" || loginId.length > MAX_SIGNIN_TOKEN_CHARS || typeof code !== "string" || code.length > 512) {
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
