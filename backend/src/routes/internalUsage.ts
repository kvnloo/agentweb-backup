/**
 * Internal service-to-service usage ingestion route (agent-engine -> backend).
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
 * Ingestion failures are the engine's problem to swallow (it is fail-open); on
 * our side recordUsage() itself never throws.
 *
 * ENG-1134: this is no longer shadow-only. Records now ALSO draw down the
 * submitting user's monthly quota, summed per user across the batch. Until then
 * every browser-automation task's LLM spend was visible as burn but charged to
 * nobody, which is the same rule violation (a real userId must mean a real
 * charge) that ENG-200 and ENG-454 fixed on other paths.
 */

import express, { Response } from "express";
import { createHash } from "crypto";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { recordUsage, computeCostMicroUsd } from "../services/usageRecorderService";
import { incrementUserTokenUsage } from "../services/tokenUsageService";

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

/**
 * Provenance namespace for everything ingested here.
 *
 * The ledger's sort key is `{date}#{model}#{feature}`, so `feature` is the only
 * component that can carry where the spend came from. The engine reports
 * `feature="agent_task"` — the same value agent-mode chat writes — so the two
 * merge into one row and become arithmetically inseparable. `taskId` would have
 * discriminated but usageRecordDb never persists it, and `provider`/`sessionId`
 * are written `if_not_exists` (first-write-wins), so neither can be trusted.
 *
 * This route is the agent-engine's endpoint by definition, so provenance is known
 * here regardless of what the caller claims. Namespacing in the backend rather
 * than the Python engine also means it ships on the normal deploy pipeline
 * instead of the manual GCP-VM procedure the engine requires.
 */
const ENGINE_FEATURE_PREFIX = "engine:";

/** Namespace a reported feature, preserving anything more specific than the default. */
function namespaceFeature(feature: unknown): string {
  const raw =
    typeof feature === "string" && feature.trim() ? feature.trim() : "agent_task";
  return raw.startsWith(ENGINE_FEATURE_PREFIX) ? raw : `${ENGINE_FEATURE_PREFIX}${raw}`;
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
      // ENG-1134: quota charge, summed per user across the batch rather than
      // applied per record. A batch carries up to 500 records and
      // incrementUserTokenUsage is a read-modify-write on one user row, so
      // charging per record would mean hundreds of contended sequential writes
      // for a single task run. Ledger rows stay granular (they are keyed by
      // model+feature); only the deduction is aggregated.
      const charges = new Map<string, { tokens: number; cost: number; recordFingerprints: string[] }>();

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

        const cacheReadTokens = isNonNegativeFiniteNumber(record.cacheReadTokens)
          ? record.cacheReadTokens!
          : 0;
        const cacheWriteTokens = isNonNegativeFiniteNumber(record.cacheWriteTokens)
          ? record.cacheWriteTokens!
          : 0;

        // Charge the RESOLVED user, never the record's claim — otherwise any
        // engine token could drain someone else's quota by naming them.
        // "system" is platform overhead with no one to bill, so it is skipped.
        if (userId && userId !== "system") {
          const entry = charges.get(userId) || { tokens: 0, cost: 0, recordFingerprints: [] };
          entry.tokens +=
            record.inputTokens! + record.outputTokens! + cacheReadTokens + cacheWriteTokens;
          entry.cost +=
            computeCostMicroUsd(
              record.model!,
              record.inputTokens!,
              record.outputTokens!,
              cacheReadTokens,
              cacheWriteTokens
            ) / 1e6;
          // ENG-1251: fingerprint the record's own content, not just its
          // taskId. A single task can legitimately submit usage across
          // multiple separate batches (e.g. a long-running task reporting
          // incrementally) -- keying only on taskId would make the SECOND
          // legitimate batch collide with the first and silently undercharge
          // it. Two records with identical (task, model, token counts,
          // feature) fingerprint the same; a genuine resubmission of the
          // exact same batch reproduces the same fingerprint set, while a
          // batch carrying different amounts does not.
          entry.recordFingerprints.push(
            [
              record.taskId || "",
              record.model,
              record.inputTokens,
              record.outputTokens,
              cacheReadTokens,
              cacheWriteTokens,
              namespaceFeature(record.feature),
            ].join("|")
          );
          charges.set(userId, entry);
        }

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
            feature: namespaceFeature(record.feature),
            inputTokens: record.inputTokens!,
            outputTokens: record.outputTokens!,
            cacheReadTokens,
            cacheWriteTokens,
          })
        );
        accepted++;
      }

      await Promise.all(writes);

      // Apply the aggregated quota charges. Fail-open, exactly like the ledger
      // writes above: the engine treats ingestion as best-effort, so surfacing a
      // 500 here would only make it retry — and a retry (or an engine worker
      // that crashes and resubmits a task's usage after restart) hits this
      // endpoint with no server-side signal that it already applied the first
      // attempt. ENG-1251: derive a stable idempotency key from the resolved
      // user plus a fingerprint of the exact records that contributed to this
      // charge, so a byte-identical resubmission collapses to a no-op via
      // recordLlmChargeEvent's conditional write instead of a second charge —
      // while a genuinely different batch (even for the same taskId, e.g. a
      // long task reporting incrementally) still gets its own key and is
      // charged in full rather than colliding with an earlier submission.
      await Promise.all(
        [...charges.entries()].map(([userId, { tokens, cost, recordFingerprints }]) => {
          // A charge entry only exists once at least one record contributed a
          // fingerprint, so this always has content to hash.
          const eventId = `engine:${userId}:${createHash("sha256")
            .update([...recordFingerprints].sort().join("\u0001"))
            .digest("hex")
            .slice(0, 32)}`;
          return incrementUserTokenUsage(userId, tokens, cost, {
            eventId,
            feature: "engine",
          }).catch((err: unknown) =>
            console.error(
              `[internalUsage] failed to charge usage for ${userId}:`,
              err
            )
          );
        })
      );

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
