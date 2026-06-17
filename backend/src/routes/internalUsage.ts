/**
 * Internal service-to-service usage ingestion route (Ship 1 — shadow metering).
 *
 * Mounted at /api/internal so the path is:
 *   POST /api/internal/usage
 *
 * Called by the Python agent-engine at task end with a batch of usage records
 * collected from LLM responses during a task run.
 *
 * Auth: the agent-engine authenticates to the backend with short-lived JWTs it
 * signs itself with the shared JWT_SECRET (task_utils.create_jwt_token), the
 * exact same mechanism it already uses for /api/tasks/.../executions/revision
 * and /api/tasks/executions/update-report. So this route reuses the standard
 * `authenticateToken` middleware — no new secret, no new auth path.
 *
 * Anti-spoofing: a record's userId is honored only when it matches the
 * authenticated user (the engine signs the token for the task's owner) or when
 * the caller is an admin/service token. Otherwise the record is attributed to
 * the authenticated user.
 *
 * This is SHADOW metering — ingestion failures are the engine's problem to
 * swallow (it is fail-open); on our side recordUsage() itself never throws.
 */

import express, { Response } from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { recordUsage } from "../services/usageRecorderService";

const router = express.Router();

/** Hard cap on batch size — one task run produces far fewer records. */
const MAX_RECORDS_PER_BATCH = 500;

interface IncomingUsageRecord {
  userId?: string;
  taskId?: string;
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  feature?: string;
}

function isNonNegativeFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** A record is usable when it names a model and has at least valid token counts. */
function isValidRecord(record: unknown): record is IncomingUsageRecord {
  if (!record || typeof record !== "object") return false;
  const r = record as IncomingUsageRecord;
  if (typeof r.model !== "string" || r.model.trim() === "") return false;
  if (!isNonNegativeFiniteNumber(r.inputTokens)) return false;
  if (!isNonNegativeFiniteNumber(r.outputTokens)) return false;
  return true;
}

router.post(
  "/usage",
  authenticateToken,
  async (req: express.Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const records = (req.body || {}).records;

      if (!Array.isArray(records) || records.length === 0) {
        return res
          .status(400)
          .json({ message: "records must be a non-empty array" });
      }
      if (records.length > MAX_RECORDS_PER_BATCH) {
        return res.status(400).json({
          message: `records batch too large (max ${MAX_RECORDS_PER_BATCH})`,
        });
      }

      const authedUserId = authReq.user.userId;
      const callerIsAdmin = !!authReq.user.isAdmin;

      let accepted = 0;
      let skipped = 0;
      const writes: Promise<void>[] = [];

      for (const record of records) {
        if (!isValidRecord(record)) {
          skipped++;
          continue;
        }

        // Only admins/service tokens may attribute usage to another user.
        const userId =
          record.userId && (callerIsAdmin || record.userId === authedUserId)
            ? record.userId
            : authedUserId;

        // recordUsage is fail-open by contract (always resolves).
        writes.push(
          recordUsage({
            userId,
            taskId: typeof record.taskId === "string" ? record.taskId : undefined,
            model: record.model!,
            provider:
              typeof record.provider === "string" && record.provider
                ? record.provider
                : "unknown",
            feature:
              typeof record.feature === "string" && record.feature
                ? record.feature
                : "agent_task",
            inputTokens: record.inputTokens!,
            outputTokens: record.outputTokens!,
            cacheReadTokens: isNonNegativeFiniteNumber(record.cacheReadTokens)
              ? record.cacheReadTokens
              : 0,
            cacheWriteTokens: isNonNegativeFiniteNumber(record.cacheWriteTokens)
              ? record.cacheWriteTokens
              : 0,
          })
        );
        accepted++;
      }

      await Promise.all(writes);

      return res.status(202).json({ accepted, skipped });
    } catch (error) {
      console.error("[internalUsage] ingestion failed:", error);
      return res.status(500).json({
        message: "Failed to ingest usage records",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

export default router;
