import { Router, Request, Response } from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { agentApiKeyService } from "../services/agentApiKeyService";

const router = Router();

// ─── Key Management (JWT auth - for logged-in users) ───

router.post(
  "/api-keys",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { keyName, scopes, rateLimitPerMin, expiresAt } = req.body;
      const authReq = req as AuthenticatedRequest;

      if (!keyName) {
        return res.status(400).json({ error: "keyName is required" });
      }

      // API key access is available to all authenticated users.
      // Usage is controlled via per-key rate limiting (rateLimitPerMin)
      // and token usage tracking at the session level.

      const { rawKey, keyRecord } = await agentApiKeyService.generateKey(
        authReq.user.userId,
        keyName,
        scopes,
        rateLimitPerMin,
        expiresAt
      );

      // Strip hash from response
      const { keyHash, ...safeRecord } = keyRecord;

      return res.status(201).json({ rawKey, key: safeRecord });
    } catch (error: any) {
      console.error("Error generating API key:", error);
      return res.status(500).json({ error: "Failed to generate API key" });
    }
  }
);

router.get(
  "/api-keys",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const keys = await agentApiKeyService.getKeysByUserId(
        authReq.user.userId
      );

      // Strip hashes from all keys
      const safeKeys = keys.map(({ keyHash, ...rest }) => rest);

      return res.status(200).json({ keys: safeKeys });
    } catch (error: any) {
      console.error("Error listing API keys:", error);
      return res.status(500).json({ error: "Failed to list API keys" });
    }
  }
);

router.delete(
  "/api-keys/:keyId",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      await agentApiKeyService.revokeKey(
        req.params.keyId,
        authReq.user.userId
      );
      return res.status(200).json({ message: "API key revoked" });
    } catch (error: any) {
      if (error.message === "API key not found") {
        return res.status(404).json({ error: "API key not found" });
      }
      if (error.message === "Unauthorized") {
        return res.status(403).json({ error: "Not authorized to revoke this key" });
      }
      console.error("Error revoking API key:", error);
      return res.status(500).json({ error: "Failed to revoke API key" });
    }
  }
);

export default router;
