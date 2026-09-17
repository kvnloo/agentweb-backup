/**
 * ENG-1250 §9.6 — the enforcement cutover, end to end at the admission chain.
 *
 * Billing-critical invariant: flipping the ledger basis must pause exactly the
 * accounts whose VENDOR spend pushes them over cap — no more, no less — and must
 * do it on the same credit terms and the same model-selection contract as the
 * legacy gate. The concrete case pinned here is the account the impact model
 * surfaced for the 2026-09 cutover (Starter, $150 cap): $115.74 of LLM (admitted
 * today) plus $102.49 of uncounted vendor spend (paused once counted).
 *
 * Like llmUsageCreditResumeAdmission.test.ts, this composes the exact chain the
 * live gate composes — resolveEnforcementCostBasisMicroUsd -> applyLlmUsageCredits
 * -> evaluateLlmUsageMode -> selectPolicyModel — with only the ledger read mocked,
 * so a regression in how the basis reaches the predicate is caught here.
 */
import type { PersistedProjection } from "../services/spendProjectionDb";

const getProjectionMock = jest.fn();
jest.mock("../services/spendProjectionDb", () => ({
  getProjection: (...args: unknown[]) => getProjectionMock(...args),
}));

import {
  resolveEnforcementCostBasisMicroUsd,
  SPEND_LEDGER_ENFORCEMENT_ENV,
} from "../services/spendEnforcementBasis";
import { getLlmUsageCreditAdjustment, applyLlmUsageCredits } from "../services/llmUsageCreditService";
import { evaluateLlmUsageMode, selectPolicyModel, type LlmUsagePolicy } from "../services/llmUsagePolicyService";

const USD = 1_000_000;
const MONTH = "2026-09";
const ACCT = "bb07579b-2d82-4d45-894f-ec74ec7e78c2";

const PREMIUM = "anthropic.claude-opus-5";
const CHEAP = "gemini-3.1-flash-lite";
const SUPPORTED = [PREMIUM, CHEAP];

// A Starter policy: $150 hard cap.
const policy: LlmUsagePolicy = {
  version: "cost-policy-2026-09-v1",
  enforcementState: "hard_only",
  optimizationCostThresholdMicroUsd: 80 * USD,
  hardCostThresholdMicroUsd: 150 * USD,
  optimizedModelIds: [CHEAP],
  optimizedDefaultModel: CHEAP,
};

const LLM_ONLY = Math.round(115.74 * USD); // legacy basis, under cap
const LLM_PLUS_VENDOR = Math.round(218.24 * USD); // ledger basis, over cap

function projection(settledMicroUsd: number): PersistedProjection {
  return {
    billingUserId: ACCT,
    billingMonth: MONTH,
    settledMicroUsd,
    reservedMicroUsd: 0,
    includedAllowanceMicroUsd: 150 * USD,
    purchasedCreditsMicroUsd: 0,
    adminAdjustmentMicroUsd: 0,
    migrationAdjustmentMicroUsd: 0,
    usableAllowanceMicroUsd: 150 * USD,
    remainingMicroUsd: 0,
    overspentMicroUsd: 0,
    unlimited: false,
    policyMode: "full_choice",
    settledEventCount: 1,
    reservedEventCount: 0,
    voidedEventCount: 0,
    excludedEventCount: 0,
    computedAt: "2026-09-17T00:00:00.000Z",
    availableMicroUsd: 0,
  };
}

/** The exact chain the live gate composes, with the ledger read mocked. */
async function admit(opts: {
  legacyRawMicroUsd: number;
  ledgerSettledMicroUsd: number | null;
  credits?: any;
  requestedModel?: string | null;
}) {
  const { rawCostUsedMicroUsd, basis } = await resolveEnforcementCostBasisMicroUsd({
    billingUserId: ACCT,
    billingMonth: MONTH,
    legacyRawCostUsedMicroUsd: opts.legacyRawMicroUsd,
  });
  const adjustment = getLlmUsageCreditAdjustment(opts.credits ?? null, MONTH);
  const adjusted = applyLlmUsageCredits({
    rawCostUsedMicroUsd,
    hardThresholdMicroUsd: policy.hardCostThresholdMicroUsd,
    adjustment,
  });
  const effectivePolicy = { ...policy, hardCostThresholdMicroUsd: adjusted.effectiveHardThresholdMicroUsd };
  const mode = evaluateLlmUsageMode({ costUsedMicroUsd: adjusted.policyCostUsedMicroUsd, policy: effectivePolicy });
  const model = selectPolicyModel({
    usageMode: mode.usageMode,
    requestedModel: opts.requestedModel ?? PREMIUM,
    backupModel: CHEAP,
    backupSource: "system",
    systemDefaultModel: CHEAP,
    supportedModelIds: SUPPORTED,
    policy: effectivePolicy,
  });
  return { basis, mode, model };
}

describe("ENG-1250 §9.6 enforcement cutover — admission chain", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    getProjectionMock.mockReset();
    delete process.env[SPEND_LEDGER_ENFORCEMENT_ENV];
  });
  afterAll(() => {
    process.env = savedEnv;
  });

  it("DARK: admits the Starter account on the legacy LLM-only basis (the account's today)", async () => {
    // Flag unset. Even though a projection exists, it is never consulted.
    getProjectionMock.mockResolvedValue(projection(LLM_PLUS_VENDOR));
    const res = await admit({ legacyRawMicroUsd: LLM_ONLY, ledgerSettledMicroUsd: LLM_PLUS_VENDOR });
    expect(res.basis).toBe("legacy");
    expect(res.mode.usageMode).toBe("full_choice");
    expect(res.mode.admissionAllowed).toBe(true);
    expect(res.model.effectiveModel).toBe(PREMIUM);
    expect(getProjectionMock).not.toHaveBeenCalled();
  });

  it("FLIPPED: pauses the Starter account once its vendor spend is counted", async () => {
    process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
    getProjectionMock.mockResolvedValue(projection(LLM_PLUS_VENDOR));
    const res = await admit({ legacyRawMicroUsd: LLM_ONLY, ledgerSettledMicroUsd: LLM_PLUS_VENDOR });
    expect(res.basis).toBe("spend_ledger");
    expect(res.mode.usageMode).toBe("paused");
    expect(res.mode.admissionAllowed).toBe(false);
    expect(res.model.effectiveModel).toBeNull();
    expect(res.model.modelSelection).toBe("blocked");
  });

  it("FLIPPED but under cap on BOTH bases: still admits (no false pause)", async () => {
    process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
    // llm $40 + vendor $30 = $70, under the $150 cap.
    getProjectionMock.mockResolvedValue(projection(70 * USD));
    const res = await admit({ legacyRawMicroUsd: 40 * USD, ledgerSettledMicroUsd: 70 * USD });
    expect(res.basis).toBe("spend_ledger");
    expect(res.mode.usageMode).toBe("full_choice");
    expect(res.model.effectiveModel).toBe(PREMIUM);
  });

  it("FLIPPED: the 1(b) grandfather lever — a one-time credit covering the vendor overage resumes the account", async () => {
    // Signed-off option 1(c)-style remedy expressed as credit: granting the
    // $102.49 of previously-uncounted vendor spend as admin credit lifts the cap
    // enough to re-admit, on the SAME model, without touching enforcement.
    process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
    getProjectionMock.mockResolvedValue(projection(LLM_PLUS_VENDOR));
    const credits = {
      month: MONTH,
      totalPurchasedMicroUsd: 0,
      totalPurchasedReversedMicroUsd: 0,
      totalAdminGrantedMicroUsd: Math.round(102.49 * USD),
      totalMigrationOffsetMicroUsd: 0,
    };
    const res = await admit({ legacyRawMicroUsd: LLM_ONLY, ledgerSettledMicroUsd: LLM_PLUS_VENDOR, credits });
    expect(res.basis).toBe("spend_ledger");
    expect(res.mode.usageMode).toBe("full_choice");
    expect(res.model.effectiveModel).toBe(PREMIUM);
    expect(res.model.modelSelection).toBe("honored");
  });

  it("FLIPPED with no persisted projection: fails open and admits on legacy (no flip-day surprise pause)", async () => {
    process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
    getProjectionMock.mockResolvedValue(null);
    const res = await admit({ legacyRawMicroUsd: LLM_ONLY, ledgerSettledMicroUsd: null });
    expect(res.basis).toBe("legacy");
    expect(res.mode.usageMode).toBe("full_choice");
    expect(res.model.effectiveModel).toBe(PREMIUM);
  });
});
