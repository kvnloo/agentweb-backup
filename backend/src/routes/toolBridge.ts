/**
 * ENG-2109 (B2): internal MCP endpoint for the tool bridge.
 *
 *   /internal/tool-bridge/:runId/mcp
 *
 * Reached only by a `claude -p` process this backend spawned, on the same host, with
 * the run's own bearer token. Two independent checks guard it:
 *
 *  1. Local only. Every request from outside reaches Node through nginx, which always
 *     adds X-Forwarded-For; a process on this host connecting to the port directly
 *     does not.
 *  2. The run token, checked on every request by the adapter.
 *
 * A request that fails either check is passed on untouched, so it gets the app's own
 * response for a path that does not exist and cannot be told apart from one.
 *
 * When the runner moves to the worker host (ENG-2114) the first check has to change;
 * the second does not.
 */

import express, { NextFunction, Request, Response } from "express";
import type { ToolBridgeMcpAdapter } from "../services/funding/toolBridgeMcp";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLocalOnlyRequest(req: Pick<Request, "headers" | "socket">): boolean {
  if (req.headers["x-forwarded-for"] !== undefined || req.headers["forwarded"] !== undefined) return false;
  return LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress ?? "");
}

function runIdFromPath(path: string): string | null {
  const match = /^\/([^/]+)\/mcp\/?$/.exec(path);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function createToolBridgeRouter(adapter: ToolBridgeMcpAdapter): express.Router {
  const router = express.Router();

  // Matched by hand rather than with a `:runId` pattern: Express answers an undecodable
  // path parameter with its own error before any handler runs, which would tell this
  // route apart from a missing path.
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    const runId = runIdFromPath(req.path);
    if (runId === null || !isLocalOnlyRequest(req)) {
      next();
      return;
    }
    try {
      if (!(await adapter.handle(req, res, runId))) next();
    } catch (err) {
      console.error("[tool-bridge] request failed:", err instanceof Error ? err.message : String(err));
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    }
  });

  return router;
}
