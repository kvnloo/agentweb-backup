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
 *     does not. A request that is not from loopback, or carries a forwarding header,
 *     gets a plain 404, as if the route did not exist.
 *  2. The run token, checked on every request by the adapter.
 *
 * When the runner moves to the worker host (ENG-2114) the first check has to change;
 * the second does not.
 */

import express, { Request, Response } from "express";
import { toolBridgeMcp } from "../services/funding/toolBridgeService";
import type { ToolBridgeMcpAdapter } from "../services/funding/toolBridgeMcp";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLocalOnlyRequest(req: Pick<Request, "headers" | "socket">): boolean {
  if (req.headers["x-forwarded-for"] !== undefined || req.headers["forwarded"] !== undefined) return false;
  return LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress ?? "");
}

export function createToolBridgeRouter(adapter: ToolBridgeMcpAdapter): express.Router {
  const router = express.Router();

  router.all("/:runId/mcp", async (req: Request, res: Response) => {
    if (!isLocalOnlyRequest(req)) {
      res.status(404).end();
      return;
    }
    try {
      await adapter.handle(req, res, req.params.runId);
    } catch (err) {
      console.error("[tool-bridge] request failed:", err instanceof Error ? err.message : String(err));
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    }
  });

  return router;
}

export default createToolBridgeRouter(toolBridgeMcp);
