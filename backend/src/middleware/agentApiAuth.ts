import { Request, Response, NextFunction } from "express";
import { agentApiKeyService, AgentApiKey } from "../services/agentApiKeyService";
import { rateLimiter } from "./rateLimiter";

export interface AgentApiRequest extends Request {
  agentApiKey: AgentApiKey;
  agentUserId: string;
}

export async function authenticateAgentApiKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "Missing Authorization header" });
    }

    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : authHeader;

    if (!token.startsWith("aw_")) {
      return res.status(401).json({ error: "Invalid API key format" });
    }

    const keyRecord = await agentApiKeyService.validateKey(token);
    if (!keyRecord) {
      return res.status(401).json({ error: "Invalid or expired API key" });
    }

    // Check rate limit
    const rateLimitResult = rateLimiter.check(
      keyRecord.keyId,
      keyRecord.rateLimitPerMin
    );

    // Set rate limit headers
    res.set({
      "X-RateLimit-Limit": String(keyRecord.rateLimitPerMin),
      "X-RateLimit-Remaining": String(rateLimitResult.remaining),
      "X-RateLimit-Reset": String(
        Math.ceil((Date.now() + rateLimitResult.resetInMs) / 1000)
      ),
    });

    if (!rateLimitResult.allowed) {
      return res.status(429).json({
        error: "Rate limit exceeded",
        retryAfterMs: rateLimitResult.resetInMs,
      });
    }

    // Attach key info to request
    const agentReq = req as AgentApiRequest;
    agentReq.agentApiKey = keyRecord;
    agentReq.agentUserId = keyRecord.userId;

    next();
  } catch (error) {
    console.error("Agent API auth error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export function requireScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const agentReq = req as AgentApiRequest;

    if (!agentReq.agentApiKey) {
      return res.status(401).json({ error: "Authentication required" });
    }

    if (!agentReq.agentApiKey.scopes.includes(scope)) {
      return res
        .status(403)
        .json({ error: `Missing required scope: ${scope}` });
    }

    next();
  };
}
