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
import { recordUsage, computeCostMicroUsd, RecordUsageContext } from "../services/usageRecorderService";
import { resolveBillingUserId } from "../services/tokenUsageService";
import { usageRecordDb } from "../services/usageRecordDb";
import { retryTransientWrite } from "../services/usageWriteFailureMonitor";
import { allocateMicroUsd, buildLlmSpendEvent, isLlmDualWriteEnabled } from "../services/spendLedgerDualWrite";
import { getModelPrice, isPerGenerationPriced, LLM_PRICE_BOOK_PROVENANCE } from "../utils/llmPricing";

/** ENG-1934: rate provenance for a dollar figure the agent engine computed itself. */
const ENGINE_COST_PROVENANCE = "caller:agent-engine";

const router = express.Router();

/** ENG-1934: one (pricing source, provider) slice of a charge group. */
interface PricedPortion {
  source: "book" | "engine";
  provider: string;
  tokens: number;
  calls: number;
  costUsd: number;
}

/**
 * Most spend events one charge group may add to its transaction.
 *
 * DynamoDB allows 100 actions per TransactWriteItems, and the group already
 * spends two (aggregate + charge event). `provider` arrives from the engine
 * per record, so a batch can name any number of them. Past this bound the
 * portions collapse to one per pricing source under provider "mixed", which
 * keeps the write atomic and idempotent rather than overflowing into the
 * non-atomic fallback (CodeRabbit, PR #2904). Real groups have one or two.
 */
export const MAX_SPEND_EVENTS_PER_GROUP = 10;
export const MIXED_PROVIDER = "mixed";

function collapsePortionsForTransaction(portions: PricedPortion[]): PricedPortion[] {
  if (portions.length <= MAX_SPEND_EVENTS_PER_GROUP) return portions;
  const bySource = new Map<PricedPortion["source"], PricedPortion>();
  for (const portion of portions) {
    const merged =
      bySource.get(portion.source) ||
      { source: portion.source, provider: MIXED_PROVIDER, tokens: 0, calls: 0, costUsd: 0 };
    merged.tokens += portion.tokens;
    merged.calls += portion.calls;
    merged.costUsd += portion.costUsd;
    bySource.set(portion.source, merged);
  }
  return [...bySource.values()];
}

/** Hard cap on batch size — one task run produces far fewer records. */
const MAX_RECORDS_PER_BATCH = 500;
/** Keep a full batch's summed micro-USD cost within JavaScript's safe integer range. */
const MAX_COST_USD_OVERRIDE_PER_RECORD =
  Number.MAX_SAFE_INTEGER / (MAX_RECORDS_PER_BATCH * 1_000_000);

interface IncomingUsageRecord {
  userId?: string;
  taskId?: string;
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsdOverride?: number;
  feature?: string;
}

function isNonNegativeFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidCostUsdOverride(value: unknown): value is number {
  return (
    isNonNegativeFiniteNumber(value) &&
    (value as number) <= MAX_COST_USD_OVERRIDE_PER_RECORD
  );
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
  if (r.costUsdOverride !== undefined && !isValidCostUsdOverride(r.costUsdOverride)) return false;
  return true;
}

router.post(
  "/usage",
  authenticateToken,
  async (req: express.Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const records = (req.body || {}).records;
      // ENG-1251: a genuine per-flush nonce from the engine (one UsageReporter
      // instance per task-execution process, generated once, sent on every
      // flush attempt for that instance — see agent-engine/usage_reporter.py).
      // A retried HTTP submission of the SAME instance's buffered totals
      // carries the SAME reportId; a genuinely new execution (new process,
      // new instance) always gets a new one, so it's charged in full even if
      // its measurements happen to be identical to a prior run's. Optional
      // for backward compatibility during rollout — an engine version predating
      // this falls through to the content+time-bucket fingerprint below.
      //
      // Greptile P1 (security): reportId is embedded verbatim into the
      // charge event's DynamoDB sort key (eventId). DynamoDB sort keys are
      // capped at 1024 bytes -- an oversized reportId (a real UUID is ~36
      // chars, so anything past a generous multiple of that is not a
      // legitimate engine value) would make recordLlmChargeEvent's PUT fail
      // validation, which the fail-open charging path swallows, silently
      // omitting the batch from BOTH the counter and itemization. Rejecting
      // it here and falling through to the content+time-bucket fingerprint
      // (the same path an absent reportId already takes) keeps the batch
      // charged instead of silently dropped.
      const MAX_REPORT_ID_LENGTH = 256;
      const rawReportId = typeof (req.body || {}).reportId === "string" ? (req.body || {}).reportId.trim() : "";
      const reportId =
        rawReportId && rawReportId.length <= MAX_REPORT_ID_LENGTH ? rawReportId : undefined;

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
      // ENG-1251 Greptile P1: captured ONCE and reused for both the ledger
      // row (below, via recordUsage's `date` override) and the charge
      // event's occurredAt (below, via the charge event
      // `occurredAt` override). Two independent `new Date()` calls a few
      // awaits apart can straddle a UTC-midnight boundary -- the ledger row
      // lands on one date, the charge event on the next -- and the
      // itemization reconciliation's (date, model, feature) key no longer
      // matches between them.
      const requestReceivedAt = new Date();
      const requestDate = requestReceivedAt.toISOString().slice(0, 10);

      let accepted = 0;
      let skipped = 0;
      // ENG-1134: quota charge, summed per (user, model, feature) across the
      // batch rather than applied per record. A batch carries up to 500
      // records and a per-user counter write would be a read-modify-write on one
      // user row, so charging per record would mean hundreds of contended
      // sequential writes for a single task run.
      //
      // ENG-1251 Greptile P1: keyed by (userId, model, feature), not userId
      // alone. The itemization reconciliation (subscription.ts) matches a
      // charge event against its covered daily-aggregate row by
      // (date, model, feature) -- a single charge event summed across every
      // model in the batch cannot carry one true model/feature, so it could
      // never key-match the aggregate row it's supposed to cover, and the
      // itemized view double-counted the batch (event + full aggregate,
      // both shown). Splitting by model/feature makes each charge event
      // exactly reconcilable against its own aggregate row.
      const charges = new Map<
        string,
        {
          userId: string; model: string; feature: string; tokens: number; cost: number;
          // ENG-1251 Greptile P1: how many records (calls) contributed to
          // this charge entry -- a batch sums several calls' tokens/cost
          // into one entry, so the entry's own "call count" is NOT 1.
          calls: number;
          recordFingerprints: string[];
          // ENG-1251 Greptile P1 ("coverage suppresses unrelated aggregate
          // usage"): tracked per-dimension (not just the combined `tokens`
          // above) so the atomic ledger+charge-event write below can
          // populate the ledger row's separate counters directly from this
          // group, instead of via N separate per-record recordUsage() calls.
          inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
          // First non-empty provider wins -- matches the ledger row's own
          // if_not_exists(provider) semantic (first writer sticks).
          provider: string;
          // ENG-1934: subtotals by WHO PRICED each record and WHICH PROVIDER
          // served it. One group (user, model, feature) can mix records the
          // engine priced (costUsdOverride) with records this backend's book
          // priced, can span providers, and — for a model the book does not
          // know — can hold records nobody priced. A spend event carries one
          // provenance and one provider, so each (pricing, provider) portion
          // becomes its own event and the unpriced records become none
          // (CodeRabbit, PR #2904). Insertion order is the records' order, so
          // a resubmitted batch rebuilds the same portions and ids.
          pricedPortions: Map<string, PricedPortion>;
        }
      >();

      // ENG-1251 Greptile P1: resolve each contributing actor's TRUE billing
      // owner up front. recordUsage() below previously wrote every ledger
      // row's billingUserId as the ACTING user's own id (its own default
      // when none is passed), not the resolved owner -- for a pooled org
      // member that is wrong, and made the row unreachable from any query
      // keyed on the real billing owner (current OR former pooling status).
      // Resolved once per distinct actor, not per record, since a batch
      // typically shares one or few actors.
      const actorUserIds = new Set<string>();
      for (const record of records) {
        if (!isValidRecord(record)) continue;
        const uid =
          record.userId && (callerIsAdmin || record.userId === authedUserId)
            ? record.userId
            : authedUserId;
        actorUserIds.add(uid);
      }
      const billingUserIdByActor = new Map<string, string>();
      await Promise.all(
        [...actorUserIds].map(async (uid) => {
          billingUserIdByActor.set(uid, await resolveBillingUserId(uid));
        })
      );

      // ENG-1251 Greptile P1 ("retries duplicate aggregate usage"): a
      // record's ledger write is deferred to a SECOND pass, gated on
      // whether its charge group turns out to be genuinely new. Tagging
      // each record with its chargeKey (or null when uncharged, e.g. a
      // "system" actor) here, before that's known.
      interface PendingLedgerWrite { chargeKey: string | null; ctx: RecordUsageContext }
      const pendingWrites: PendingLedgerWrite[] = [];

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
        const recordProvider =
          typeof record.provider === "string" && record.provider ? record.provider : "unknown";
        const costUsdOverride = isValidCostUsdOverride(record.costUsdOverride)
          ? record.costUsdOverride
          : undefined;

        // Charge the RESOLVED user, never the record's claim — otherwise any
        // engine token could drain someone else's quota by naming them.
        // "system" is platform overhead with no one to bill, so it is skipped.
        let chargeKey: string | null = null;
        if (userId && userId !== "system") {
          const chargeFeature = namespaceFeature(record.feature);
          chargeKey = [userId, record.model, chargeFeature].join("\u0001");
          const entry =
            charges.get(chargeKey) ||
            {
              userId, model: record.model!, feature: chargeFeature, tokens: 0, cost: 0, calls: 0,
              recordFingerprints: [], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
              provider: recordProvider,
              pricedPortions: new Map<string, PricedPortion>(),
            };
          entry.tokens +=
            record.inputTokens! + record.outputTokens! + cacheReadTokens + cacheWriteTokens;
          entry.cost += costUsdOverride ?? (
            computeCostMicroUsd(
              record.model!,
              record.inputTokens!,
              record.outputTokens!,
              cacheReadTokens,
              cacheWriteTokens
            ) / 1e6
          );
          // "book" only when this route's own pricing produced the cost: a
          // token-priced model the book knows. An image/video record without
          // an engine cost is priced at $0 here (computeCostMicroUsd has no
          // per-generation rate), so it is unpriced, not a confirmed $0
          // allocation (CodeRabbit, PR #2904).
          const source: PricedPortion["source"] | null =
            costUsdOverride != null ? "engine" : getModelPrice(record.model!) !== null ? "book" : null;
          if (source) {
            const portionKey = `${source}\u0001${recordProvider}`;
            const portion =
              entry.pricedPortions.get(portionKey) ||
              { source, provider: recordProvider, tokens: 0, calls: 0, costUsd: 0 };
            portion.tokens +=
              record.inputTokens! + record.outputTokens! + cacheReadTokens + cacheWriteTokens;
            portion.calls += 1;
            portion.costUsd += costUsdOverride ?? (
              computeCostMicroUsd(
                record.model!,
                record.inputTokens!,
                record.outputTokens!,
                cacheReadTokens,
                cacheWriteTokens
              ) / 1e6
            );
            entry.pricedPortions.set(portionKey, portion);
          }
          entry.calls += 1;
          entry.inputTokens += record.inputTokens!;
          entry.outputTokens += record.outputTokens!;
          entry.cacheReadTokens += cacheReadTokens;
          entry.cacheWriteTokens += cacheWriteTokens;
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
              costUsdOverride ?? "",
              chargeFeature,
            ].join("|")
          );
          charges.set(chargeKey, entry);
        }

        pendingWrites.push({
          chargeKey,
          ctx: {
            userId,
            billingUserId: billingUserIdByActor.get(userId) || userId,
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
            costUsdOverride,
            // ENG-1934: an engine-supplied amount was priced by the engine, not
            // by this backend's book — say so on the spend event.
            ...(costUsdOverride != null ? { costProvenance: ENGINE_COST_PROVENANCE } : {}),
            date: requestDate,
            occurredAt: requestReceivedAt.toISOString(),
          },
        });
        accepted++;
      }

      // ENG-1251: prefer the engine's own reportId (a genuine per-execution
      // nonce -- see agent-engine/usage_reporter.py) as the idempotency key.
      // It is exact: a retried HTTP submission of the same UsageReporter
      // instance carries the identical reportId (dedupe correctly), while a
      // genuinely new execution -- a new process, a new instance -- always
      // gets a new one and is charged in full even if its measurements
      // happen to be identical to a prior run's.
      //
      // Falls back to a content fingerprint + a coarse 10-minute time bucket
      // only when reportId is absent (an engine version predating this
      // field, during rollout). That fallback is a heuristic, not exact: a
      // genuinely separate rerun is charged unless it happens to land in the
      // same 10-minute bucket as an identical-shaped prior submission, and a
      // true retry straddling a bucket boundary is still double-charged.
      // Both residual risks disappear once every engine instance sends
      // reportId.
      const RETRY_COLLAPSE_WINDOW_MS = 10 * 60 * 1000;
      const timeBucket = Math.floor(Date.now() / RETRY_COLLAPSE_WINDOW_MS);
      const eventIdByChargeKey = new Map<string, string>();
      for (const [chargeKey, { userId, model, feature, recordFingerprints }] of charges.entries()) {
        // A charge entry only exists once at least one record contributed a
        // fingerprint, so both branches below always have content to hash.
        // Includes model/feature: one engine flush (one reportId) can carry
        // several (model, feature) charge entries, so reportId alone is not
        // unique per entry.
        //
        // Greptile P1 (security): reportId is caller-controlled and
        // otherwise unvalidated -- an authenticated caller resubmitting a
        // DIFFERENT batch under a reused reportId (engine bug or actual
        // misuse) would collapse into the same eventId as a prior batch
        // and get silently suppressed, undercharging real usage with no
        // signal that anything was dropped. Folding the content
        // fingerprint into the eventId even when reportId is present
        // closes that: a genuine retry resends identical content under
        // the same reportId (same fingerprint, same eventId, still
        // dedupes exactly as intended), while a reused reportId carrying
        // different content now produces a different eventId and is
        // charged in full -- fail toward charging, never toward a silent
        // drop.
        const contentFingerprint = createHash("sha256")
          .update([...recordFingerprints].sort().join("\u0001"))
          .digest("hex")
          .slice(0, 32);
        const eventId = reportId
          ? `engine:${userId}:${model}:${feature}:${reportId}:${contentFingerprint}`
          : `engine:${userId}:${model}:${feature}:${createHash("sha256")
              .update([...recordFingerprints].sort().join("\u0001"))
              .update(`bucket:${timeBucket}`)
              .digest("hex")
              .slice(0, 32)}`;
        eventIdByChargeKey.set(chargeKey, eventId);
      }

      // ENG-1251 Greptile P1 ("retries duplicate aggregate usage" +
      // "coverage suppresses unrelated aggregate usage"): the ledger write
      // for a charged group and its paired charge event are now written in
      // ONE DynamoDB transaction (usageRecordDb.incrementUsageWithChargeEvent)
      // instead of two independent steps. This closes both findings at once:
      // a retried batch's charge event no-ops AND its ledger contribution is
      // skipped together (never independently duplicated), and a real ledger
      // write failure can no longer leave a charge event recorded with no
      // matching ledger contribution for reconciliation to (wrongly) assume
      // exists. Built directly from each charge GROUP (not per record) since
      // every record in a group shares the exact same (userId, date, model,
      // feature) ledger row by construction (chargeKey = userId+model+feature,
      // date is the single batch-wide requestDate).
      const chargeOutcomeByKey = new Map<string, "applied" | "duplicate" | "conflict" | "error">();
      await Promise.all(
        [...charges.entries()].map(async ([chargeKey, entry]) => {
          const eventId = eventIdByChargeKey.get(chargeKey)!;
          const billingUserId = billingUserIdByActor.get(entry.userId) || entry.userId;
          const costMicroUsd = Math.max(0, Math.round(entry.cost * 1_000_000));
          // ENG-1934: the group's spend events ride the same transaction, keyed
          // off its charge event's id, so a retried batch no-ops every item
          // together. One event per priced portion — see the subtotals above.
          const priced = collapsePortionsForTransaction([...entry.pricedPortions.values()]);
          // One integer total split across the portions by their exact costs, so
          // the events sum EXACTLY to the aggregate row whatever the rounding.
          const shares = allocateMicroUsd(costMicroUsd, priced.map((portion) => portion.costUsd));
          const portions = priced.map((portion, i) => ({
            ...portion,
            costMicroUsd: shares[i],
            rateProvenance: portion.source === "engine" ? ENGINE_COST_PROVENANCE : LLM_PRICE_BOOK_PROVENANCE,
            // The group's own provider keeps the plain ids; another provider's
            // portion is suffixed with it. Deterministic, and distinct per portion.
            callId:
              (portion.source === "engine" ? `${eventId}#engine` : eventId) +
              (portion.provider === entry.provider ? "" : `@${portion.provider}`),
          }));
          const spendEvents = isLlmDualWriteEnabled()
            ? portions
                .map((portion) =>
                  buildLlmSpendEvent(
                    {
                      actingUserId: entry.userId,
                      billingUserId,
                      provider: portion.provider,
                      model: entry.model,
                      feature: entry.feature,
                      totalTokens: portion.tokens,
                      perGeneration: isPerGenerationPriced(entry.model),
                      generationCount: portion.calls,
                      costMicroUsd: portion.costMicroUsd,
                      costSource: "allocated",
                      rateProvenance: portion.rateProvenance,
                      callId: portion.callId,
                    },
                    requestReceivedAt.toISOString(),
                  ),
                )
                .flatMap((built) => ("event" in built ? [built.event] : []))
            : [];
          try {
            // Retry the SAME grouped transaction before falling back
            // (CodeRabbit, PR #2904). A conflict or throttle can arrive after
            // DynamoDB committed; replaying the identical items then returns
            // "duplicate" instead of the per-record fallback writing the
            // aggregate twice and minting a second, unkeyed spend event. The
            // fallback below still runs when the retries cannot settle it.
            const outcome = await retryTransientWrite(async () => {
              const attempt = await usageRecordDb.incrementUsageWithChargeEvent(
                {
                  userId: entry.userId,
                  date: requestDate,
                  model: entry.model,
                  feature: entry.feature,
                  inputTokens: entry.inputTokens,
                  outputTokens: entry.outputTokens,
                  cacheReadTokens: entry.cacheReadTokens,
                  cacheWriteTokens: entry.cacheWriteTokens,
                  costMicroUsd,
                  billingUserId,
                  // ENG-700 semantics, previously skipped on this path: a group in
                  // which nobody priced anything is "unpriced", not a confirmed $0.
                  costSource: entry.pricedPortions.size > 0 ? "allocated" : "unpriced",
                  provider: entry.provider,
                  calls: entry.calls,
                },
                {
                  billingUserId,
                  eventId,
                  occurredAt: requestReceivedAt.toISOString(),
                  actingUserId: entry.userId,
                  tokens: Math.max(0, Math.round(entry.tokens)),
                  costMicroUsd,
                  model: entry.model,
                  feature: entry.feature,
                  calls: entry.calls,
                },
                // Passed only when there are any: with the kill switch off, or an
                // unpriced group, the call is exactly the two-item transaction it
                // always was.
                ...(spendEvents.length ? [spendEvents] : [])
              );
              if (attempt === "conflict") {
                throw Object.assign(new Error("transaction conflict on engine usage"), {
                  code: "TransactionConflictException",
                });
              }
              return attempt;
            });
            chargeOutcomeByKey.set(chargeKey, outcome);
          } catch (err: any) {
            if (err?.code === "TransactionConflictException") {
              chargeOutcomeByKey.set(chargeKey, "conflict");
            } else {
              console.error(`[internalUsage] atomic ledger+charge write failed for eventId=${eventId}:`, err);
              chargeOutcomeByKey.set(chargeKey, "error");
            }
          }
        })
      );

      // Ledger writes: always for uncharged (system) records (unaffected by
      // any of this -- they never had a charge event to couple with).
      //
      // For charged records: "applied" already wrote the ledger row
      // atomically above -- nothing more to do. "duplicate" is a confirmed
      // retry -- the group's ledger contribution was already written the
      // first time this exact charge was recorded, so skipping here is
      // correct, not a gap (this is the ENG-1251 "retries duplicate
      // aggregate usage" fix). "conflict"/"error" are ambiguous, not a
      // confirmed duplicate -- fall back to the pre-atomic per-record write
      // path so a real infra error never silently drops real usage
      // (undercounting is worse than an occasional double-count).
      const writes: Promise<void>[] = [];
      for (const pending of pendingWrites) {
        if (pending.chargeKey === null) {
          writes.push(recordUsage(pending.ctx));
          continue;
        }
        const outcome = chargeOutcomeByKey.get(pending.chargeKey);
        if (outcome === "conflict" || outcome === "error") {
          writes.push(recordUsage(pending.ctx));
        }
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
