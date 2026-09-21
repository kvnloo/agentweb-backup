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

export type EnforcementBasis = "legacy" | "spend_ledger";

/**
 * Whether the ledger (vendor-inclusive) basis is enabled for a given subject.
 * Pure over env + the id, so it is trivially testable and has no I/O.
 */
export function isSpendLedgerEnforcementEnabled(billingUserId: string): boolean {
  const mode = (process.env[SPEND_LEDGER_ENFORCEMENT_ENV] || "").trim().toLowerCase();
  if (mode === "true") return true;
  if (mode === "allowlist") {
    const list = (process.env[SPEND_LEDGER_ENFORCEMENT_ACCOUNTS_ENV] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return list.includes(billingUserId);
  }
  // "", "legacy", "false", or anything unrecognised → dark (legacy).
  return false;
}

export interface EnforcementCostBasis {
  /** The raw (pre-credit) cost figure to feed the existing enforcement pipeline. */
  rawCostUsedMicroUsd: number;
  /** Which rail produced it. */
  basis: EnforcementBasis;
  /** True when the ledger basis was requested but no snapshot existed (fell back). */
  projectionMissing: boolean;
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
  legacyRawCostUsedMicroUsd: number;
}): Promise<EnforcementCostBasis> {
  if (!isSpendLedgerEnforcementEnabled(input.billingUserId)) {
    return { rawCostUsedMicroUsd: input.legacyRawCostUsedMicroUsd, basis: "legacy", projectionMissing: false };
  }

  let projection = null;
  try {
    projection = await getProjection(input.billingUserId, input.billingMonth);
  } catch (err) {
    // A ledger read failure must not take the gate down: fall back to legacy,
    // which is exactly the state we are cutting over FROM, and surface it.
    console.error(
      `[spendEnforcementBasis] projection read failed for ${input.billingUserId} ${input.billingMonth}; ` +
        `falling back to legacy basis:`,
      err,
    );
    return { rawCostUsedMicroUsd: input.legacyRawCostUsedMicroUsd, basis: "legacy", projectionMissing: true };
  }

  if (!projection) {
    return { rawCostUsedMicroUsd: input.legacyRawCostUsedMicroUsd, basis: "legacy", projectionMissing: true };
  }

  // The ledger's settled all-vendor total, and nothing else from the projection.
  // Credits/threshold are applied downstream, identically to the legacy figure.
  const rawCostUsedMicroUsd = Math.max(0, Math.round(projection.settledMicroUsd));

  // One terse observability line so a canary flip can be watched: how much the
  // basis moved for this subject (the vendor spend the legacy counter never saw).
  const deltaMicroUsd = rawCostUsedMicroUsd - Math.max(0, Math.round(input.legacyRawCostUsedMicroUsd));
  console.log(
    `[spendEnforcementBasis] ledger basis for ${input.billingUserId} ${input.billingMonth}: ` +
      `legacy=${input.legacyRawCostUsedMicroUsd}µ ledger=${rawCostUsedMicroUsd}µ delta=${deltaMicroUsd}µ`,
  );

  return { rawCostUsedMicroUsd, basis: "spend_ledger", projectionMissing: false };
}
