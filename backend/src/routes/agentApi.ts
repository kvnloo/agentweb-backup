import { Router, Request, Response } from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { agentApiKeyService } from "../services/agentApiKeyService";
import {
  API_KEY_SCOPE_EMAIL_READ,
  API_KEY_SCOPE_EXECUTE,
  API_KEY_SCOPE_GTM_EMAIL,
  API_KEY_SCOPE_MEMORY_ORG,
  API_KEY_SCOPE_READ,
  API_KEY_SCOPE_SMARTLEAD_CONTROL,
  API_KEY_SCOPE_SMARTLEAD_READ,
} from "../mcp/server/apiKeyScopes";

const GRANTABLE_API_KEY_SCOPES: readonly string[] = [
  API_KEY_SCOPE_READ,
  API_KEY_SCOPE_EXECUTE,
  API_KEY_SCOPE_EMAIL_READ,
  API_KEY_SCOPE_SMARTLEAD_READ,
  API_KEY_SCOPE_SMARTLEAD_CONTROL,
  API_KEY_SCOPE_MEMORY_ORG,
  API_KEY_SCOPE_GTM_EMAIL,
];

/** Highest per-minute rate a key may be minted with: ten times the default of 60, far above what any agent has used (prod: 60 and 10). */
export const MAX_API_KEY_RATE_LIMIT_PER_MIN = 600;

/** `undefined` or `null` means "use the default"; anything else must be a whole number from 1 to the maximum. */
export function checkRateLimitPerMin(value: unknown): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_API_KEY_RATE_LIMIT_PER_MIN) {
    return { ok: false, error: `rateLimitPerMin must be a whole number from 1 to ${MAX_API_KEY_RATE_LIMIT_PER_MIN} (the default is 60).` };
  }
  return { ok: true, value };
}

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

      // The limiter trusts this number, so a key minted with a huge (or NaN, negative, text) rate would have no limit at all.
      const rate = checkRateLimitPerMin(rateLimitPerMin);
      if (!rate.ok) {
        return res.status(400).json({ error: rate.error });
      }

      // Scopes are a closed set: an unknown string would be stored verbatim and
      // later read as an opt-in scope, so reject it here rather than at use.
      if (scopes !== undefined) {
        if (
          !Array.isArray(scopes) ||
          scopes.length === 0 ||
          scopes.some((s: unknown) => typeof s !== "string" || !GRANTABLE_API_KEY_SCOPES.includes(s))
        ) {
          return res.status(400).json({
            error: `scopes must be a non-empty array of: ${GRANTABLE_API_KEY_SCOPES.join(", ")}`,
          });
        }
        // Mailbox read is a personal grant: an admin acting through delegated
        // access may not mint a key that reads the customer's email.
        if (scopes.includes(API_KEY_SCOPE_EMAIL_READ) && authReq.delegateInfo?.isDelegated) {
          return res.status(403).json({
            error: `The '${API_KEY_SCOPE_EMAIL_READ}' scope cannot be granted from a delegated session.`,
          });
        }
        // Org memory is written into every member's prompt: the account owner grants it, not someone acting for them.
        if (scopes.includes(API_KEY_SCOPE_MEMORY_ORG) && authReq.delegateInfo?.isDelegated) {
          return res.status(403).json({
            error: `The '${API_KEY_SCOPE_MEMORY_ORG}' scope cannot be granted from a delegated session.`,
          });
        }
        // A GTM report is emailed from AgentWeb to the people on the customer's plan: the account owner grants that, not someone acting for them.
        if (scopes.includes(API_KEY_SCOPE_GTM_EMAIL) && authReq.delegateInfo?.isDelegated) {
          return res.status(403).json({
            error: `The '${API_KEY_SCOPE_GTM_EMAIL}' scope cannot be granted from a delegated session.`,
          });
        }
        // Same for the customer's own Smartlead account: the customer grants it, not someone acting for them.
        const smartleadScope = [API_KEY_SCOPE_SMARTLEAD_READ, API_KEY_SCOPE_SMARTLEAD_CONTROL].find((s) => scopes.includes(s));
        if (smartleadScope && authReq.delegateInfo?.isDelegated) {
          return res.status(403).json({
            error: `The '${smartleadScope}' scope cannot be granted from a delegated session.`,
          });
        }
      }

      // API key access is available to all authenticated users.
      // Usage is controlled via per-key rate limiting (rateLimitPerMin)
      // and token usage tracking at the session level.

      const { rawKey, keyRecord } = await agentApiKeyService.generateKey(
        authReq.user.userId,
        keyName,
        scopes === undefined ? undefined : Array.from(new Set<string>(scopes)),
        rate.value,
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
