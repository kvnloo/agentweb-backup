/**
 * usageRecorderService — fire-and-forget shadow usage recorder (Ship 1).
 *
 * Acceptance criterion: usage analytics must NEVER break (or slow) chat.
 *  - recordUsage() returns a promise that ALWAYS resolves — every error path is
 *    swallowed (logged at most once per minute on repeated failure).
 *  - Callers do not await it in hot paths; firing it is a single microtask.
 *  - Missing userId is recorded under userId "system" so platform overhead is
 *    visible, never dropped.
 *  - Unknown models record with cost 0 (llmPricing emits a deduped warn);
 *    tokens are still counted.
 */

import {
  getModelPrice,
  cacheWriteCost,
  CacheWriteByTtl,
  isPerGenerationPriced,
  LLM_PRICE_BOOK_PROVENANCE,
} from "../utils/llmPricing";
import { usageRecordDb, CostSource } from "./usageRecordDb";
import { getAllocatedRateWithVersion, VendorRateProvider } from "../utils/vendorRateCard";
import {
  buildLlmSpendEvent,
  buildShadowEvent,
  isLlmDualWriteEnabled,
  mirrorVendorUsage,
} from "./spendLedgerDualWrite";
import type { SpendEvent } from "./spendEventDb";
import {
  flushDroppedWriteAlerts,
  recordDroppedWrite,
  retryTransientWrite,
} from "./usageWriteFailureMonitor";
// tokenUsageService is lazy-required inside the billing-owner resolver (not statically imported):
// it pulls in db.ts -> config/aws.ts, and usageRecorderService is imported very widely
// (via llmClients). A static import would drag that whole graph into every consumer's
// module-load, breaking suites that mock aws-sdk without a `config` (e.g. blog.test.ts)
// and matching the existing lazy-load pattern in llmClients.ts.

export interface RecordUsageContext {
  userId?: string;
  billingUserId?: string;
  onBehalfOf?: string;
  model: string;
  provider: string;
  feature: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** ENG-893: cache-write tokens split by the TTL Bedrock applied, when reported. */
  cacheWriteByTtl?: CacheWriteByTtl;
  sessionId?: string;
  taskId?: string;
  /**
   * ENG-1251: stable identity for THIS charge, used to dedupe a retried usage
   * report against the per-user monthly cap (see llmChargeAuditDb.recordLlmChargeEvent).
   * Omit only when the caller genuinely has no natural per-call id — a retry
   * will then be double-charged, since a fresh one is minted each time.
   */
  eventId?: string;
  /**
   * Explicit USD cost for calls that are NOT token-priced (image/video are billed
   * per generation, so getModelPrice returns null and token-derived cost is 0).
   * When set, it is recorded verbatim instead of computing cost from tokens.
   */
  costUsdOverride?: number;
  /**
   * ENG-2106: what the customer's OWN provider account was charged for this call, in
   * USD, on a response OpenRouter flags as BYOK (`upstream_inference_cost`). Distinct
   * from `costUsdOverride`, which on a non-BYOK response is AgentWeb's own cost: reading
   * that as the customer's would book AgentWeb's money against their provider account.
   * Read ONLY by recordLlmUsage's customer-funded branch, for the attempt journal; it is
   * stripped before any AgentWeb metering rail sees the context and is never priced,
   * summed or stored there.
   */
  upstreamCostUsd?: number;
  /**
   * ENG-1934: where `costUsdOverride` came from, stamped on the spend event as
   * its rate version. Pass `LLM_PRICE_BOOK_PROVENANCE` when the override was
   * itself read from llmPricing (image/video generation prices). Omitted, an
   * override is attributed to `caller:<provider>` — true of a gateway-reported
   * cost such as OpenRouter's. Ignored without an override: token pricing is
   * always the price book.
   */
  costProvenance?: string;
  /**
   * ENG-1934: how many billed generations `costUsdOverride` covers, for a
   * per-generation model — a 16s video is two clips at the clip price, and
   * its spend event must say 2, not 1. Defaults to 1.
   */
  generationCount?: number;
  /**
   * ENG-1251 Greptile P1: YYYY-MM-DD override. A caller that ALSO writes a
   * paired charge event for the same logical usage (internalUsage.ts is the
   * only one today) must compute this ledger row's date from the exact same
   * instant as that charge event's occurredAt -- two independent `new
   * Date()` calls a few awaits apart can straddle a UTC-midnight boundary,
   * landing the ledger row on one date and the charge event on the next.
   * The itemization reconciliation keys on (date, model, feature), so a
   * one-day mismatch breaks the key match: the charge event can no longer
   * cover its own aggregate row, and both show up (double count). Omit for
   * every other caller -- defaults to `new Date()` at call time, unchanged.
   */
  date?: string;
  /**
   * ENG-1934: the ISO instant for this call's spend event, for the same reason
   * `date` exists — a caller that fixes `date` from an earlier instant must fix
   * this from that SAME instant, or the event can land on the next UTC day and
   * the §8 fidelity check reads one call as drift on two days. Pass it whenever
   * `date` is passed; omitted, both derive from one clock read.
   */
  occurredAt?: string;
}

/**
 * A spend entry for a vendor billed per unit rather than per token (v0 renders,
 * You.com queries, ElevenLabs characters, …).
 *
 * Note what is NOT here: any rate table. This entry point records the dollar
 * figure its caller hands it and states, via `costSource`, where that figure came
 * from. Choosing the allocated rate is a pricing decision owned by ENG-703.
 */
interface VendorUsageFields {
  userId?: string;
  billingUserId?: string;
  onBehalfOf?: string;
  sessionId?: string;
  /** Vendor id: "v0", "you.com", "remotion", "elevenlabs", … */
  provider: string;
  /** What was bought from that vendor: "generate", "search", "render", … */
  operation: string;
  feature: string;
  /** The thing being counted: "render", "query", "character", … */
  unit: string;
  quantity: number;
  /**
   * ENG-702 AC1: a stable token for THIS vendor call, supplied at the call
   * site. When present, the daily aggregate row and the immutable spend event
   * are written in ONE transaction guarded on it, so a retried call increases
   * recorded spend exactly once on BOTH rails.
   *
   * Omit only when the call site genuinely has no natural per-call id. A retry
   * is then counted twice — which is what every vendor path did before this
   * field existed, and is deliberately preserved so adoption can be
   * incremental rather than a single flag day across seven adapters.
   */
  idempotencyKey?: string;
}

/**
 * How a vendor call's cost is given — exactly one of two shapes.
 *
 * **`rateKey` (preferred for anything priced by the vendor rate card).** The
 * recorder looks the rate up itself, INSIDE its never-throw boundary
 * (ENG-1929). Computing the cost at the call site instead —
 * `costUsd: computeAllocatedCost(...)` — evaluates as an argument BEFORE the
 * fire-and-forget call, so a missing rate threw straight into the vendor
 * request and failed the user's search or render over a metering config gap.
 * A missing rate here is recorded `unpriced` and reported loudly; never $0.
 *
 * **`costSource` + `costUsd`** for a figure priced elsewhere — X's own pricing
 * module, or a measured amount. The value must already be computed: the
 * coverage guard rejects a function call inside `costUsd`.
 */
type VendorUsagePricing =
  | {
      costSource: CostSource;
      /** Dollar cost of this call. Omitted means 0 — ENG-700 makes an unpriced unit loud. */
      costUsd?: number;
      rateKey?: never;
    }
  | {
      /** Vendor rate-card key; the recorder prices `quantity` from it. */
      rateKey: string;
      costSource?: never;
      costUsd?: never;
    };

export type RecordVendorUsageContext = VendorUsageFields & VendorUsagePricing;

/** A vendor call once its cost is settled — what every write path below takes. */
type ResolvedVendorUsageContext = VendorUsageFields & { costSource: CostSource; costUsd?: number; rateCardVersion?: string };

/** provider:rateKey pairs already reported as unpriced by this process. */
const reportedUnpricedRateKeys = new Set<string>();

/**
 * Settle a vendor call's cost from the rate card, never throwing.
 *
 * An unpriced key keeps ENG-703 AC2 — it is never booked as $0 spend: the row
 * is tagged `unpriced` (the ledger then writes no spend event for it) and a
 * loud, marker-tagged error is logged once per key per process, the same
 * shape llmPricing uses for an unknown model. What changed is WHERE it fails:
 * in the metering, not in the vendor request (ENG-1929).
 */
function resolveVendorCost(ctx: RecordVendorUsageContext): ResolvedVendorUsageContext {
  if (ctx.rateKey == null) return ctx as ResolvedVendorUsageContext;

  const { rateKey, ...fields } = ctx;
  const priced = getAllocatedRateWithVersion(ctx.provider as VendorRateProvider, rateKey);
  if (priced === null) {
    const key = `${ctx.provider}:${rateKey}`;
    if (!reportedUnpricedRateKeys.has(key)) {
      reportedUnpricedRateKeys.add(key);
      console.error(
        `[vendorRateCard] UNPRICED vendor unit ${key} — recorded as unpriced, not $0. ` +
          "Add the rate to vendorRateCard.ts (ENG-703 AC2).",
      );
    }
    return { ...fields, costSource: "unpriced" };
  }
  const quantity = Number.isFinite(ctx.quantity) && ctx.quantity > 0 ? ctx.quantity : 0;
  return { ...fields, costSource: "allocated", costUsd: quantity * priced.rate, rateCardVersion: priced.version };
}

/** Test hook: forget which unpriced keys were already reported. */
export function __resetUnpricedVendorReportsForTests(): void {
  reportedUnpricedRateKeys.clear();
}

/** Log at most one shadow-ledger failure per minute, on its own throttle so a
 * spend-ledger outage cannot crowd out the recorder's own error channel. */
let lastShadowErrorLogAt = 0;
function logShadowLedgerFailure(reason: string): void {
  const now = Date.now();
  if (now - lastShadowErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
    lastShadowErrorLogAt = now;
    console.error(
      "[spendLedgerShadow] Failed to mirror vendor usage (further failures suppressed for 60s):",
      reason,
    );
  }
}

/** Log at most one recorder failure per minute to avoid log spam on outages. */
const ERROR_LOG_INTERVAL_MS = 60_000;
let lastErrorLogAt = 0;

/** Swallow-and-throttle: metering must never fail or slow the caller's operation. */
function logRecorderFailure(error: unknown): void {
  const now = Date.now();
  if (now - lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
    lastErrorLogAt = now;
    console.error(
      "[usageRecorder] Failed to record usage (further failures suppressed for 60s):",
      error instanceof Error ? error.message : error
    );
  }
}

// ── Billing-owner resolution (ENG-2286) ──────────────────────────────────────────
//
// A spend record's `billingUserId` is the account whose cap it counts against. The
// enforcement gate resolves it through `resolveBillingUserId` — an org member's
// usage pools onto the org's billing root — so a record that names the MEMBER is
// invisible to the gate, which never looks at that id.
//
// Callers were expected to supply `billingUserId`, and many vendor call sites do
// not (Apollo, enrich.so, Enigma, voiceover, Remotion, You.com, Google CSE,
// reCAPTCHA pass only `userId`). The old fallback — `ctx.billingUserId || userId` —
// then billed the member: 7 org members, $301.64 (97% vendor) outside any owner's
// pool as of 2026-10-05. The recorder is the one place every record passes
// through, so the owner is resolved here once instead of at ~15 call sites.
//
// It is resolved ONCE per call, at the public entry points, and written back into
// the context. Everything downstream — the aggregate row, the spend event, the
// legacy fallback, the dropped-write alert — then reads the same id. Resolving
// separately at each of those sites could split one call across two owners.
//
// FORWARD-ONLY. Spend events are immutable and already-written records keep the id
// they were written with; this changes new records, not history.
const BILLING_OWNER_CACHE_TTL_MS = 60_000;
const BILLING_OWNER_CACHE_MAX = 2_000;
const billingOwnerCache = new Map<string, { id: string; expiresAt: number }>();

type BillingOwnerResolver = (userId: string) => Promise<string>;
let billingOwnerResolverOverride: BillingOwnerResolver | null = null;

/** Test seam: install a resolver (or null to clear it) and drop cached results. */
export function __setBillingOwnerResolverForTests(resolver: BillingOwnerResolver | null): void {
  billingOwnerResolverOverride = resolver;
  billingOwnerCache.clear();
}

/**
 * Kill switch, default ON. Set SPEND_RECORDER_RESOLVE_ORG_OWNER=false to return to
 * billing the acting user, without a deploy.
 */
export const SPEND_RECORDER_RESOLVE_ORG_OWNER_ENV = "SPEND_RECORDER_RESOLVE_ORG_OWNER";

let lastBillingResolveErrorLogAt = 0;

/**
 * The billing subject for a record: the caller's explicit `billingUserId` when
 * given, otherwise the acting user's org billing root (their own id when they are
 * not an org member, or inherit nothing from the org).
 *
 * Never throws. If the owner cannot be resolved it falls back to the acting user,
 * which is exactly the pre-ENG-2286 behaviour — a record is never lost over this.
 */
async function resolveRecordBillingUserId(supplied: string | undefined, userId: string): Promise<string> {
  // A SUPPLIED id is resolved too, not trusted as the payer. Callers name the owner of a connected
  // resource (e.g. the X account's owner), which for an org member is the member, not the org's
  // billing root: honouring it verbatim kept that spend outside the owner's cap. Resolving is
  // idempotent for an id that is already a billing root (an owner, a solo user, a member holding their
  // own subscription), so callers that pass a resolved payer are unaffected.
  const subject = supplied || userId;
  if (process.env[SPEND_RECORDER_RESOLVE_ORG_OWNER_ENV] === "false") return subject;
  // No AW-Users row to pool from, so there is nothing to resolve.
  if (!subject || subject === "system" || subject.startsWith("anon_")) return subject;
  // Unit tests that run the recorder over an unmocked data layer must never reach
  // a live DynamoDB (same precedent as llmUsagePolicyResolverService). They keep
  // the old behaviour unless a test installs a resolver explicitly.
  if (!billingOwnerResolverOverride && process.env.NODE_ENV === "test") return subject;

  const now = Date.now();
  const hit = billingOwnerCache.get(subject);
  if (hit && hit.expiresAt > now) return hit.id;

  try {
    const resolve: BillingOwnerResolver =
      billingOwnerResolverOverride ??
      // Lazy-required, not imported: see the note on tokenUsageService above.
      (require("./tokenUsageService") as typeof import("./tokenUsageService")).resolveBillingUserId;
    const id = await resolve(subject);
    if (billingOwnerCache.size >= BILLING_OWNER_CACHE_MAX) billingOwnerCache.clear();
    billingOwnerCache.set(subject, { id, expiresAt: now + BILLING_OWNER_CACHE_TTL_MS });
    return id;
  } catch (error) {
    // Not cached: the next call retries. Logged (throttled) because silently
    // reverting to the member re-opens the very gap this closes.
    if (now - lastBillingResolveErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
      lastBillingResolveErrorLogAt = now;
      console.error(
        "[usageRecorder] Could not resolve the org billing owner; billing the acting user (further failures suppressed for 60s):",
        error instanceof Error ? error.message : error,
      );
    }
    return subject;
  }
}

/**
 * Compute cost in INTEGER microdollars for a call.
 * USD-per-1M-token prices mean: microUsd = tokens * pricePerM (since 1e6/1e6 cancels).
 * Returns 0 (never throws) when the model has no price entry.
 */
export function computeCostMicroUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
  /** ENG-893: per-TTL cache-write split from Bedrock's `usage.cacheDetails`. */
  cacheWriteByTtl?: CacheWriteByTtl
): number {
  const price = getModelPrice(model);
  if (!price) return 0;
  const cacheReadPerM = price.cacheReadPerM ?? price.inPerM * 0.1;
  return Math.round(
    inputTokens * price.inPerM +
      outputTokens * price.outPerM +
      cacheReadTokens * cacheReadPerM +
      cacheWriteCost(price, cacheWriteTokens, cacheWriteByTtl)
  );
}

/**
 * ENG-700: true when `model` has no entry in the price book. Used to mark a
 * usage row's costSource as "unpriced" (0 dollars because the rate is
 * missing) rather than "allocated" (0 or more real dollars from a known
 * rate) — the two must stay distinguishable so an unpriced model never reads
 * as confirmed-free spend.
 */
function isUnpriced(model: string): boolean {
  return getModelPrice(model) === null;
}

/**
 * Record one LLM call into the shadow usage table.
 *
 * Fire-and-forget: call it WITHOUT await in hot paths. The returned promise
 * always resolves — a recording failure can never fail or slow an LLM response.
 */
export async function recordUsage(ctx: RecordUsageContext): Promise<void> {
  try {
    // ENG-1691: a model priced PER GENERATION (image, video clip) carries no
    // token rate, so token-metering it writes a $0 row beside the real
    // per-generation row — two ledger entries for one API call, on a model that
    // produces no text. `llmClients.ts` already states the rule; this enforces
    // it at the single point every caller passes through.
    //
    // Keyed on the ABSENCE of an override rather than on the feature name: the
    // legitimate per-generation record supplies `costUsdOverride`, and that is
    // what distinguishes it from a wrapper that merely observed the same call.
    // Guarding on `feature` instead would break the moment a caller relabels.
    //
    // ENG-700 is unaffected: a model in NEITHER price book has no override and
    // is not per-generation priced, so it still records and still tags
    // `unpriced`.
    if (ctx.costUsdOverride == null && isPerGenerationPriced(ctx.model)) {
      return;
    }

    const userId = ctx.userId || "system";
    // ENG-2286: resolved ONCE, then used for both the aggregate and the spend event.
    const billingUserId = await resolveRecordBillingUserId(ctx.billingUserId, userId);
    // One clock read for both rails (ENG-1934): the aggregate's date and the
    // spend event's instant must never straddle UTC midnight.
    const occurredAt = ctx.occurredAt || new Date().toISOString();
    const date = ctx.date || occurredAt.slice(0, 10);
    const inputTokens = Math.max(0, Math.round(ctx.inputTokens || 0));
    const outputTokens = Math.max(0, Math.round(ctx.outputTokens || 0));
    const cacheReadTokens = Math.max(0, Math.round(ctx.cacheReadTokens || 0));
    const cacheWriteTokens = Math.max(0, Math.round(ctx.cacheWriteTokens || 0));

    const costMicroUsd =
      ctx.costUsdOverride != null
        ? Math.max(0, Math.round(ctx.costUsdOverride * 1e6))
        : computeCostMicroUsd(
            ctx.model,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            ctx.cacheWriteByTtl
          );

    // ENG-700: an override or a known price is real allocated spend (possibly
    // $0 for a genuinely free call). No override AND no price entry means the
    // 0 in costMicroUsd is a missing rate, not a fact about the call — tag it
    // "unpriced" so it never reads as confirmed-free spend. Token counts are
    // written either way (see inputTokens/outputTokens below), unaffected by
    // costSource.
    const costSource =
      ctx.costUsdOverride != null || !isUnpriced(ctx.model) ? "allocated" : "unpriced";

    const increment = {
      userId,
      date,
      model: ctx.model || "unknown",
      feature: ctx.feature || "unknown",
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costMicroUsd,
      billingUserId,
      costSource,
      ...(ctx.onBehalfOf ? { onBehalfOf: ctx.onBehalfOf } : {}),
      ...(ctx.provider ? { provider: ctx.provider } : {}),
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    } as const;

    if (!isLlmDualWriteEnabled()) {
      await usageRecordDb.incrementUsage(increment);
      return;
    }

    // ENG-1934. Built ONCE, before any retry, so every attempt carries the same
    // eventId and a replay is a no-op rather than a second event.
    const built = buildLlmSpendEvent(
      {
        actingUserId: userId,
        billingUserId,
        onBehalfOf: ctx.onBehalfOf,
        sessionId: ctx.sessionId,
        taskId: ctx.taskId,
        provider: ctx.provider,
        model: increment.model,
        feature: increment.feature,
        totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
        perGeneration: isPerGenerationPriced(ctx.model),
        generationCount: ctx.generationCount,
        costMicroUsd,
        costSource,
        rateProvenance:
          ctx.costUsdOverride != null
            ? ctx.costProvenance || `caller:${ctx.provider || "unknown"}`
            : LLM_PRICE_BOOK_PROVENANCE,
        callId: ctx.eventId,
      },
      occurredAt,
    );

    if ("skip" in built) {
      // Unpriced: no event may exist, so the aggregate is written exactly as
      // before this change.
      await usageRecordDb.incrementUsage(increment);
      return;
    }

    await writeLlmUsageWithSpendEvent(increment, built.event);
  } catch (error) {
    logRecorderFailure(error);
  }
}

/**
 * The aggregate row and its spend event, in one transaction (ENG-1934).
 *
 * Mirrors `recordVendorUsageIdempotent` deliberately — the two rails must fail
 * the same way or the §8 reconciliation measures the difference between two
 * error policies instead of the difference between two ledgers:
 *  - "duplicate": this call was already recorded on BOTH rails; nothing to do.
 *    This is also what makes a retried `recordUsage` add its cost once.
 *  - a transient conflict is retried; the retry is safe because the event is
 *    conditional.
 *  - anything else falls back to the plain aggregate write, so a spend-ledger
 *    outage never also costs the rail that predates it, and the loss is
 *    counted and alerted rather than thrown into a fire-and-forget caller.
 */
async function writeLlmUsageWithSpendEvent(
  increment: Parameters<typeof usageRecordDb.incrementUsage>[0],
  event: SpendEvent,
): Promise<void> {
  try {
    await retryTransientWrite(async () => {
      const result = await usageRecordDb.incrementUsageWithSpendEvent(increment, event);
      if (result === "conflict") {
        throw Object.assign(new Error("transaction conflict on LLM usage"), {
          code: "TransactionConflictException",
        });
      }
      return result;
    });
    flushDroppedWriteAlerts();
  } catch (error) {
    // Counted BEFORE the fallback: if the aggregate write fails too, the
    // rejection escapes to recordUsage's console-only catch, and the loss would
    // otherwise never reach the dropped-write monitor (CodeRabbit, PR #2904).
    recordDroppedWrite({
      provider: event.provider,
      operation: event.operation,
      costMicroUsd: event.costMicroUsd,
      billingUserId: event.billingUserId,
      reason: error instanceof Error ? error.message : String(error),
    });
    await usageRecordDb.incrementUsage(increment);
  }
}

/**
 * Record one per-unit vendor call into the SAME ledger `recordUsage` writes to.
 *
 * Fire-and-forget with identical guarantees: the returned promise always
 * resolves, and a recording failure can never fail or slow the caller.
 *
 * The row's model slot is namespaced `{provider}:{operation}`. The sort key
 * format stays `{date}#{model}#{feature}` (changing it is out of scope and would
 * be a real key change) — namespacing the model component is what guarantees two
 * different vendors can never aggregate into one row and overwrite each other's
 * `provider`. For token-priced LLM rows that ambiguity is ENG-700's job.
 */
/**
 * The idempotent vendor write (ENG-702 AC1).
 *
 * Never throws, for the same reason the shadow mirror never does: every caller
 * invokes recordVendorUsage fire-and-forget, so a rejection here becomes an
 * unhandled promise rejection and takes the process down. AC3's "surfaced
 * rather than silently discarded" is served by the failure counter and alert,
 * not by throwing into a caller that cannot catch it.
 */
async function recordVendorUsageIdempotent(ctx: ResolvedVendorUsageContext, now: Date): Promise<void> {
  const userId = ctx.userId || "system";
  const billingUserId = ctx.billingUserId || userId;

  try {
    const built = buildShadowEvent(ctx, now.toISOString());
    if ("skip" in built) {
      // Unpriced: no spend event may exist for it (the billing boundary forbids
      // a $0 one), so it can't dedupe via the spend-event transaction.
      const increment = buildVendorIncrement(ctx, userId, billingUserId, now);
      if (ctx.idempotencyKey) {
        // ENG-1958: a KEYED unpriced call can still be replayed, and a plain
        // ADD double-counts the aggregate on retry. Guard it with a conditional
        // dedupe marker in the same transaction so a replay is a no-op. Conflict
        // is a write that didn't happen, so retry it as transient (matches the
        // priced path); "applied" and "duplicate" are both terminal successes.
        await retryTransientWrite(async () => {
          const outcome = await usageRecordDb.incrementUsageWithDedupeMarker(
            increment,
            billingUserId,
            ctx.idempotencyKey!,
          );
          if (outcome === "conflict") {
            throw Object.assign(new Error("transaction conflict on unpriced vendor usage"), {
              code: "TransactionConflictException",
            });
          }
          return outcome;
        });
      } else {
        // Unkeyed: a replay is not detectable anyway, so keep the plain write
        // rather than pay for a marker that could never match (ENG-1958 AC3).
        await usageRecordDb.incrementUsage(increment);
      }
      // Recovery on ANY successful path closes an open window, not just the
      // priced+keyed one (CodeRabbit, PR #2807) — otherwise an account whose
      // vendor traffic is all unpriced never reports its final alert.
      flushDroppedWriteAlerts();
      return;
    }

    // ENG-702 AC3. Retrying is safe here and ONLY here: the conditional
    // transaction makes a replay a no-op, so a lost response cannot become a
    // second charge. A "conflict" outcome is a write that did not happen at
    // all, so it is retried as a transient failure rather than reported as a
    // loss.
    const outcome = await retryTransientWrite(async () => {
      const result = await usageRecordDb.incrementUsageWithSpendEvent(
        buildVendorIncrement(ctx, userId, billingUserId, now),
        built.event,
      );
      if (result === "conflict") {
        throw Object.assign(new Error("transaction conflict on vendor usage"), {
          code: "TransactionConflictException",
        });
      }
      return result;
    });

    void outcome;

    // A window only closes when the NEXT drop arrives, so when an outage ENDS
    // -- exactly when someone starts investigating -- its final and often
    // largest batch would never be reported. The first successful write after
    // recovery flushes it. Cheaper and more reliable than a timer, since it
    // fires precisely when there is evidence the rail is healthy again.
    flushDroppedWriteAlerts();
  } catch (error) {
    // The transaction failed after retries. Fall back to the pre-ENG-702 path so
    // the LIVE rail still gets its row: a spend-ledger outage must not also stop
    // the metering that predates it, which would turn one table's problem into
    // lost attribution on both.
    //
    // The fallback leaves the rails divergent — live row, no event — which is
    // exactly what §8 reports as `unmirroredGroups`. Detectable and honest,
    // where a silent double-failure would not be.
    await recordVendorUsageLegacy(ctx, now, false);

    // Still counted: the ledger write was lost even though the aggregate landed.
    // Surfaced as an aggregated alert rather than thrown — every caller is
    // fire-and-forget, so throwing would be an unhandled rejection and take the
    // process down (ENG-1804).
    recordDroppedWrite({
      provider: ctx.provider,
      operation: ctx.operation,
      costMicroUsd: Math.max(0, Math.round((ctx.costUsd || 0) * 1e6)),
      billingUserId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The daily-aggregate shape for a vendor call, shared by both write paths. */
function buildVendorIncrement(
  ctx: ResolvedVendorUsageContext,
  userId: string,
  billingUserId: string,
  now: Date,
) {
  return {
    userId,
    date: now.toISOString().slice(0, 10),
    model: `${ctx.provider}:${ctx.operation}`,
    feature: ctx.feature || "unknown",
    inputTokens: 0,
    outputTokens: 0,
    costMicroUsd: Math.max(0, Math.round((ctx.costUsd || 0) * 1e6)),
    billingUserId,
    provider: ctx.provider,
    unit: ctx.unit,
    quantity: ctx.quantity,
    costSource: ctx.costSource,
    ...(ctx.onBehalfOf ? { onBehalfOf: ctx.onBehalfOf } : {}),
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
  };
}

export async function recordVendorUsage(ctx: RecordVendorUsageContext): Promise<void> {
  const now = new Date();

  // ENG-1929: pricing happens here, inside the boundary, never at the call site.
  let resolved: ResolvedVendorUsageContext;
  try {
    resolved = resolveVendorCost(ctx);
  } catch (error) {
    logRecorderFailure(error);
    return;
  }

  // ENG-2286: resolve the billing owner ONCE and write it back, so the atomic path,
  // its legacy fallback, and the dropped-write alert below all agree on one id.
  // Never throws (falls back to the acting user), so this cannot lose a record.
  resolved = {
    ...resolved,
    billingUserId: await resolveRecordBillingUserId(resolved.billingUserId, resolved.userId || "system"),
  };

  // ENG-702 AC1 / ENG-1250 §6. EVERY vendor call takes the atomic path now, not
  // only the ones whose call site supplies a token.
  //
  // Threading a token through the remaining adapters was the obvious plan and
  // the wrong one: none of them has a natural pre-call identifier, and none
  // re-enters metering on a retry (twitter meters only on success; apollo's and
  // enrich.so's `attempt` loops are DynamoDB bookkeeping; the search providers
  // have no retry at all). A call-site token there would be a freshly minted
  // nonce — exactly what buildShadowEvent already mints — delivered by editing
  // eleven sites across six files for no semantic gain.
  //
  // What the atomic path actually buys them is worth having: the aggregate row
  // and the spend event move together instead of as two independent writes, and
  // AC3's retry becomes safe because a replay cannot double-count. Both hold
  // whether the token is deterministic or minted, and both now extend to any
  // vendor added later with no further edit.
  //
  // A call-site token still wins where one genuinely exists — v0 supplies the
  // guard's key (ENG-1812), which collapses retries within one reservation.
  // This does not replace that; it raises the floor for everyone else.
  await recordVendorUsageIdempotent(resolved, now);
}

/** The pre-ENG-702 behaviour, retained as the fallback used above. */
async function recordVendorUsageLegacy(
  ctx: ResolvedVendorUsageContext,
  now: Date,
  /**
   * False when called as the fallback below, whose own catch already records
   * the loss. Without this a single failed write is counted TWICE — inflating
   * the lost-dollars figure that AC3 exists to make trustworthy, which is a
   * worse outcome than not counting it at all.
   */
  countLoss = true,
): Promise<void> {

  try {
    const userId = ctx.userId || "system";
    const billingUserId = ctx.billingUserId || userId;
    const date = now.toISOString().slice(0, 10);

    await usageRecordDb.incrementUsage({
      userId,
      date,
      model: `${ctx.provider}:${ctx.operation}`,
      feature: ctx.feature || "unknown",
      // Token counters are meaningless here; the adapter omits them entirely
      // because `unit` is set, so these three are never written.
      inputTokens: 0,
      outputTokens: 0,
      costMicroUsd: Math.max(0, Math.round((ctx.costUsd || 0) * 1e6)),
      billingUserId,
      provider: ctx.provider,
      unit: ctx.unit,
      quantity: ctx.quantity,
      costSource: ctx.costSource,
      ...(ctx.onBehalfOf ? { onBehalfOf: ctx.onBehalfOf } : {}),
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    });
    // Recovery on the legacy path closes an open window too.
    flushDroppedWriteAlerts();
  } catch (error) {
    logRecorderFailure(error);
    // ENG-702 AC3: counted even here, so an outage's cost is visible whether or
    // not the call site has adopted a token. NOT retried, though: this path's
    // aggregate write is an unconditional ADD, so a retry after a lost response
    // double-counts — the exact failure AC1 exists to prevent.
    if (countLoss) {
      recordDroppedWrite({
        provider: ctx.provider,
        operation: ctx.operation,
        costMicroUsd: Math.max(0, Math.round((ctx.costUsd || 0) * 1e6)),
        billingUserId: ctx.billingUserId || ctx.userId || "system",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    // Do NOT mirror a row the live rail failed to write (CodeRabbit, PR #2793).
    // The shadow exists to measure ONE difference -- all-vendor spend against
    // LLM-only -- and a ledger row with no matching usage record is not that
    // difference, it is an outage artifact. §8 cannot tell the two apart, so
    // letting them mix would pollute the very measurement this phase produces.
    // The shadow mirrors the live rail; it never leads it.
    return;
  }

  // ENG-1250 §9 step 2 -- observe-only shadow of the row just written.
  // Fire-and-forget and fail-open: nothing reads these rows, and a failure here
  // must never break the metering it mirrors. Stamped from the same `now` as
  // the live row above, so the two cannot straddle UTC midnight.
  void mirrorVendorUsage(
    {
      ...ctx,
      ...(ctx.feature ? { feature: ctx.feature } : {}),
    },
    now.toISOString(),
  )
    .then((result) => {
      if (result.status === "failed") logShadowLedgerFailure(result.reason);
    })
    // mirrorVendorUsage is written never to reject, but this is a
    // fire-and-forget call on a hot path: if that contract is ever broken, an
    // unhandled rejection takes the process down. Cheap insurance against the
    // shadow ledger killing the rail it observes.
    .catch((error) => logShadowLedgerFailure(error instanceof Error ? error.message : String(error)));
}

/**
 * Meter one LLM call for a direct-provider call site that spends a real user's
 * tokens but bypasses callLLM (crm enrichment, growth-genius, workflow-gen,
 * report-revision, invite-note shortening, ...): records it to the spend ledger via
 * recordUsage(), which is the record admission and the usage views read.
 *
 * Fire-and-forget + fail-open: metering must never fail or slow an LLM response.
 * (The legacy per-user `AW-Users.tokenUsage` counter charge that used to ride along
 * was retired in ENG-2286.)
 */
export function meterUserUsage(ctx: RecordUsageContext): void {
  void meterUserUsageAsync(ctx);
}

/**
 * `meterUserUsage`, awaitable: resolves once the usage write has settled
 * (ENG-1858). Never rejects; the write keeps its own fail-open handling. Use it
 * where something must wait for the metering to be durable, such as registering
 * it with the graceful-shutdown drain; hot paths keep calling `meterUserUsage`
 * and never wait.
 */
export async function meterUserUsageAsync(ctx: RecordUsageContext): Promise<void> {
  // Records under "system" when userId is absent.
  await recordUsage(ctx);
}

/** Test hook: reset the error-log throttle. */
export function __resetErrorLogThrottleForTests(): void {
  lastErrorLogAt = 0;
}
