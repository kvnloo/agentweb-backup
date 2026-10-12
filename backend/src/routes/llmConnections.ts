/**
 * ENG-2105 (A1): a customer's own LLM provider keys.
 *
 *   GET    /api/llm-connections               list (masked)
 *   POST   /api/llm-connections               add  { provider, apiKey, shareWithOrg? }
 *   POST   /api/llm-connections/:id/validate  re-check the stored key with its provider
 *   PATCH  /api/llm-connections/:id           { sharedWithOrg: boolean }
 *   DELETE /api/llm-connections/:id           revoke (deletes the stored key)
 *
 * No caller-supplied user or org ids: both come from the session. A delegated admin
 * acts as the customer they are delegated to, and is recorded on what they add or revoke.
 *
 * The key appears in one request body and in no response and no log line. Errors are
 * logged by code only.
 */

import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { authenticateToken, type AuthenticatedRequest } from "../middleware/auth";
import {
  getLlmConnectionService,
  LlmConnectionError,
  type Actor,
  type LlmConnectionService,
} from "../services/funding/llmConnectionService";

function actorOf(req: Request): Actor {
  const { user, delegateInfo } = req as unknown as AuthenticatedRequest & { delegateInfo?: { adminUserId?: string } };
  return { userId: user!.userId, ...(delegateInfo?.adminUserId ? { adminId: delegateInfo.adminUserId } : {}) };
}

function fail(res: Response, err: unknown, where: string): void {
  if (err instanceof LlmConnectionError) {
    res.status(err.httpStatus).json({ error: err.code, ...(err.checkResult ? { checkResult: err.checkResult } : {}) });
    return;
  }
  // The error object is not logged: an SDK or HTTP error can carry request headers.
  console.error(`[llm-connections] ${where} failed: ${(err as { code?: string })?.code || (err as Error)?.name || "error"}`);
  res.status(500).json({ error: "internal_error" });
}

export function createLlmConnectionsRouter(service: () => LlmConnectionService = getLlmConnectionService): Router {
  const router = Router();
  router.use(authenticateToken);
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 30,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => (req as AuthenticatedRequest).user!.userId,
    }),
  );
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/", async (req, res) => {
    try {
      res.json(await service().list(actorOf(req).userId));
    } catch (err) {
      fail(res, err, "list");
    }
  });

  router.post("/", async (req, res) => {
    try {
      const body = (req.body ?? {}) as { provider?: unknown; apiKey?: unknown; shareWithOrg?: unknown };
      const connection = await service().add(actorOf(req), {
        provider: body.provider,
        apiKey: body.apiKey,
        shareWithOrg: body.shareWithOrg === true,
      });
      res.status(201).json({ connection });
    } catch (err) {
      fail(res, err, "add");
    }
  });

  router.post("/:id/validate", async (req, res) => {
    try {
      res.json(await service().validate(actorOf(req), req.params.id));
    } catch (err) {
      fail(res, err, "validate");
    }
  });

  router.patch("/:id", async (req, res) => {
    try {
      const shared = (req.body ?? {}).sharedWithOrg;
      if (typeof shared !== "boolean") {
        res.status(400).json({ error: "sharedWithOrg must be true or false" });
        return;
      }
      res.json({ connection: await service().setShared(actorOf(req), req.params.id, shared) });
    } catch (err) {
      fail(res, err, "share");
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      await service().revoke(actorOf(req), req.params.id);
      res.status(204).end();
    } catch (err) {
      fail(res, err, "revoke");
    }
  });

  return router;
}
