/**
 * ENG-1250 §9.6 — the enforcement cutover, wired DARK.
 *
 * The legacy paid-call gate counts LLM cost only (`AW-Users.tokenUsage.totalCost`).
 * The cutover moves the *spend basis* of that same gate onto the ENG-1250 spend
 * ledger, whose monthly projection (`AW-SpendProjection.settledMicroUsd`) counts
 * every AgentWeb-paid vendor, not just LLM tokens.
 *
 * ## Why this is a one-number swap, and nothing more
 *
 * Both live gates — `checkTokenUsage` and `getEffectiveLlmUsagePolicy` — run the
 * identical pipeline: take a raw cost figure, run it through
 * `applyLlmUsageCredits` (migration offsets reduce spend; purchased/admin credits
 * raise the threshold), then compare against the hard cap in
 * `evaluateLlmUsageMode`. This module changes exactly one input to that pipeline:
 * the RAW cost. Everything downstream — credit application, threshold, the
 * predicate — is reused unchanged, so credits are still applied exactly once and
 * the ONLY divergence from the legacy decision is that vendor spend is now
 * included. That is the single intended divergence documented in
 * `spendProjection.ts`; this module does not touch the projection's own allowance
 * fields, so there is no way for a second credit application to sneak in.
 *
 * ## Dark by default, reversible, canary-able
 *
 * `AW_SPEND_LEDGER_ENFORCEMENT` selects the basis:
 *   - unset / "legacy" / "false" (DEFAULT) → legacy LLM-only counter. Nothing
 *     changes; this is the state the code ships in.
 *   - "allowlist" → only accounts listed in `AW_SPEND_LEDGER_ENFORCEMENT_ACCOUNTS`
 *     use the ledger basis (a canary before a global flip).
 *   - "true" → every account uses the ledger basis.
 *
 * The flip is a single env change with no migration either way, because both
 * rails stay dual-written. A rollback is unsetting the variable.
 *
 * ## Fail-open on a missing snapshot
 *
 * If the ledger basis is enabled but no projection has been persisted for the
 * subject/month, this falls back to the legacy figure rather than hardening
 * enforcement on absent data. A real flip is gated on the would-pause capture and
 * the §8 shadow reconciliation, which are what guarantee coverage first; this
 * fallback only keeps a partial dual-write from pausing someone on a gap.
 */
import { getProjection } from "./spendProjectionDb";

export const SPEND_LEDGER_ENFORCEMENT_ENV = "AW_SPEND_LEDGER_ENFORCEMENT";
export const SPEND_LEDGER_ENFORCEMENT_ACCOUNTS_ENV = "AW_SPEND_LEDGER_ENFORCEMENT_ACCOUNTS";

/**
 * Comma-separated subscription tiers to EXCLUDE from ledger enforcement, even
 * under `=true`. Case-insensitive. Empty/unset excludes nothing.
 *
 * This is how the broad flip (`=true`) enforces every PAID tier while leaving
 * Free on the legacy rail: precise Free-tier enforcement is deferred to ENG-1688
 * (a $5 cap bites sharply — one image render can be ~40% of it), so we cut the
 * paid tiers over first. An allowlist can't express "all paid" — ~40 account ids
 * blow the 4096-char EB env limit — so exclusion by tier is the mechanism.
 */
export const SPEND_LEDGER_ENFORCEMENT_EXCLUDE_TIERS_ENV = "AW_SPEND_LEDGER_ENFORCEMENT_EXCLUDE_TIERS";

/** The excluded-tier set (lowercased), or empty. */
function excludedTiers(): Set<string> {
  return new Set(
    (process.env[SPEND_LEDGER_ENFORCEMENT_EXCLUDE_TIERS_ENV] || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Max age of a projection snapshot before enforcement stops trusting it and
 * fails open to legacy. Minutes; unset or <= 0 disables the guard.
 *
 * Deliberately OFF by default. The event-driven writer restamps `computedAt` on
 * every settled event, so an ACTIVE account's snapshot is always fresh — but an
 * over-cap account that has been paused makes no new settled charges, so its
 * `computedAt` would age naturally, and a default-on guard would let it back in
 * on a timer (oscillation). The guard exists for the operational case it is
 * actually needed in: a lagging periodic materializer or a stopped writer, where
 * an operator sets a threshold and would rather under-enforce visibly on stale
 * data than enforce on a figure the pipeline can no longer vouch for.
 */
export const SPEND_PROJECTION_MAX_STALENESS_MIN_ENV = "AW_SPEND_PROJECTION_MAX_STALENESS_MIN";

/**
 * ENG-2286 / ENG-1250 AC7 -- a MISSING or UNREADABLE projection never falls back to the
 * legacy `AW-Users.tokenUsage` counter (retired; no longer written). The ledger is the
 * only basis for an enforced subject:
 *   - no projection row  -> no spend recorded this month -> counts as $0. That is
 *     the ordinary state of an account's first request of a new month (the row is
 *     created by its first settled event).
 *   - read error         -> FAIL OPEN: admit, and log loudly. Availability over
 *     precision, the same posture as the rest of the metering path.
 *
 * Two other legacy fallbacks remain: the opt-in staleness guard (default off) and a
 * subject the mode flags leave dark or excludes by tier.
 */

/** Log a "no projection yet" subject once per process, not on every request. */
const missingLogged = new Set<string>();
const MISSING_LOG_MAX = 5_000;
export function __resetMissingProjectionLogForTests(): void {
  missingLogged.clear();
}

/** Parsed staleness threshold in ms, or null when the guard is disabled. */
export function projectionStalenessThresholdMs(): number | null {
  const raw = Number(process.env[SPEND_PROJECTION_MAX_STALENESS_MIN_ENV]);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw * 60_000;
}

export type EnforcementBasis = "legacy" | "spend_ledger";

/**
 * Whether the ledger (vendor-inclusive) basis is enabled for a given subject.
 * Pure over env + the id (+ optional tier), so it is trivially testable and has
 * no I/O.
 *
 * `tier` is the subject's subscription tier when the caller has it. An EXCLUDED
 * tier is never enforced on the ledger rail regardless of mode — so a broad
 * `=true` flip can enforce all paid tiers while leaving Free on legacy. When the
 * caller can't supply a tier, exclusion simply can't apply (the mode decides).
 */
export function isSpendLedgerEnforcementEnabled(billingUserId: string, tier?: string | null): boolean {
  const mode = (process.env[SPEND_LEDGER_ENFORCEMENT_ENV] || "").trim().toLowerCase();

  let enabled: boolean;
  if (mode === "true") {
    enabled = true;
  } else if (mode === "allowlist") {
    const list = (process.env[SPEND_LEDGER_ENFORCEMENT_ACCOUNTS_ENV] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    enabled = list.includes(billingUserId);
  } else {
    // "", "legacy", "false", or anything unrecognised → dark (legacy).
    enabled = false;
  }

  // An excluded tier stays on legacy even when otherwise enabled.
  if (enabled && tier && excludedTiers().has(tier.trim().toLowerCase())) {
    return false;
  }
  return enabled;
}

export interface EnforcementCostBasis {
  /** The raw (pre-credit) cost figure to feed the existing enforcement pipeline. */
  rawCostUsedMicroUsd: number;
  /** Which rail produced it. */
  basis: EnforcementBasis;
  /** True when the ledger basis was requested but no snapshot existed (fell back). */
  projectionMissing: boolean;
  /** True when a snapshot existed but was too stale to trust, so it fell back. */
  stale: boolean;
}

/**
 * Resolve the raw cost basis for the enforcement decision.
 *
 * The legacy figure is passed in (the caller already computed it), so this only
 * decides whether to REPLACE it with the ledger's settled all-vendor total. It
 * never applies credits or thresholds — that stays in the one place it already
 * lives, downstream of here.
 */
export async function resolveEnforcementCostBasisMicroUsd(input: {
  billingUserId: string;
  billingMonth: string;
  /**
   * The legacy per-user counter figure. Pass a function: it is invoked ONLY on the paths that fall
   * back to the legacy basis (enforcement off for this subject, or the opt-in staleness guard), so
   * with the ledger live the retiring counter is never read at all (ENG-1250 AC7).
   */
  legacyRawCostUsedMicroUsd: number | (() => number | Promise<number>);
  /** Subscription tier, when the caller has it — lets an excluded tier (e.g. Free) stay on legacy under a broad flip. */
  tier?: string | null;
}): Promise<EnforcementCostBasis> {
  const legacy = async (): Promise<number> =>
    typeof input.legacyRawCostUsedMicroUsd === "function"
      ? input.legacyRawCostUsedMicroUsd()
      : input.legacyRawCostUsedMicroUsd;

  if (!isSpendLedgerEnforcementEnabled(input.billingUserId, input.tier)) {
    return { rawCostUsedMicroUsd: await legacy(), basis: "legacy", projectionMissing: false, stale: false };
  }

  let projection = null;
  try {
    projection = await getProjection(input.billingUserId, input.billingMonth);
  } catch (err) {
    // A ledger read failure must not take the gate down.
    // FAIL OPEN — admit — and say so loudly, because an
    // over-cap account is admitted for as long as this keeps failing.
    console.error(
      `[spendEnforcementBasis] projection read FAILED for ${input.billingUserId} ${input.billingMonth}; ` +
        `failing OPEN (counting $0 spend, admitting):`,
      err,
    );
    return { rawCostUsedMicroUsd: 0, basis: "spend_ledger", projectionMissing: true, stale: false };
  }

  if (!projection) {
    // No row means no settled spend has been recorded for this subject this
    // month — the normal state of a first request in a new month — so it counts $0.
    const key = `${input.billingUserId}|${input.billingMonth}`;
    if (!missingLogged.has(key)) {
      if (missingLogged.size >= MISSING_LOG_MAX) missingLogged.clear();
      missingLogged.add(key);
      console.log(
        `[spendEnforcementBasis] no projection yet for ${input.billingUserId} ${input.billingMonth}; counting $0 spend.`,
      );
    }
    return { rawCostUsedMicroUsd: 0, basis: "spend_ledger", projectionMissing: true, stale: false };
  }

  // Freshness guard: a snapshot older than the configured threshold is not
  // trusted for enforcement — fail open to legacy and say so, rather than
  // enforce on a figure a lagging writer can no longer vouch for. Disabled by
  // default (see the env doc above).
  const thresholdMs = projectionStalenessThresholdMs();
  if (thresholdMs !== null) {
    const computedAtMs = Date.parse(projection.computedAt ?? "");
    const ageMs = Number.isNaN(computedAtMs) ? Infinity : Date.now() - computedAtMs;
    if (ageMs > thresholdMs) {
      console.warn(
        `[spendEnforcementBasis] projection STALE for ${input.billingUserId} ${input.billingMonth}: ` +
          `computedAt=${projection.computedAt ?? "(missing)"} age=${Number.isFinite(ageMs) ? Math.round(ageMs / 1000) + "s" : "unknown"} ` +
          `> threshold=${Math.round(thresholdMs / 1000)}s; falling back to legacy basis.`,
      );
      return { rawCostUsedMicroUsd: await legacy(), basis: "legacy", projectionMissing: false, stale: true };
    }
  }

  // The ledger's settled all-vendor total, and nothing else from the projection.
  // Credits/threshold are applied downstream, identically to the legacy figure.
  const rawCostUsedMicroUsd = Math.max(0, Math.round(projection.settledMicroUsd));

  // No legacy comparison here any more: the canary that diffed ledger against the legacy counter
  // served the cutover, and it would force a counter read on every admission (ENG-1250 AC7).
  console.log(
    `[spendEnforcementBasis] ledger basis for ${input.billingUserId} ${input.billingMonth}: ledger=${rawCostUsedMicroUsd}µ`,
  );

  return { rawCostUsedMicroUsd, basis: "spend_ledger", projectionMissing: false, stale: false };
}
