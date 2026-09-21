/**
 * ENG-1211 AC3 / AC7 — verified credits resume admission WITHOUT changing the model.
 *
 * AC7 asks for tests proving "below-hard unrestricted choice, exact hard-boundary
 * pause, top-up resume, and no model correction". The first, second and fourth
 * are covered in `llmUsagePolicyService.test.ts` and
 * `llmUsagePolicyLegacyStateInert.test.ts`. **Top-up resume was not covered
 * anywhere** — the credit services were tested for package/markup config and for
 * ledger arithmetic, but nothing asserted that buying credit actually re-opens
 * admission, and nothing asserted the resumed call runs on the model the customer
 * originally chose.
 *
 * That second half is the one that matters here. ENG-1200's whole failure was a
 * customer being moved to a weaker model without asking; a resume path that
 * restored service on a *substituted* model would reproduce the incident at the
 * one moment the customer just paid to avoid it.
 *
 * These tests compose the same three steps `getEffectiveLlmUsagePolicy` composes
 * — `getLlmUsageCreditAdjustment` -> `applyLlmUsageCredits` -> `evaluateLlmUsageMode`
 * -> `selectPolicyModel` — rather than restating the arithmetic, so a change to
 * how credit reaches the threshold is caught here instead of passing silently.
 */

import {
  getLlmUsageCreditAdjustment,
  applyLlmUsageCredits,
} from "../services/llmUsageCreditService";
import {
  evaluateLlmUsageMode,
  selectPolicyModel,
  type LlmUsagePolicy,
} from "../services/llmUsagePolicyService";

const USD = 1_000_000;
const MONTH = "2026-08";

const PREMIUM = "anthropic.claude-opus-5";
const CHEAP = "gemini-3.1-flash-lite";
const SUPPORTED = [PREMIUM, CHEAP];

const policy: LlmUsagePolicy = {
  version: "cost-policy-2026-08-v1",
  enforcementState: "hard_only",
  optimizationCostThresholdMicroUsd: 80 * USD,
  hardCostThresholdMicroUsd: 150 * USD,
  optimizedModelIds: [CHEAP],
  optimizedDefaultModel: CHEAP,
};

/** The ledger shape `userDb` stores on the billing user. */
const ledger = (over: Record<string, unknown> = {}) => ({
  month: MONTH,
  totalPurchasedMicroUsd: 0,
  totalPurchasedReversedMicroUsd: 0,
  totalAdminGrantedMicroUsd: 0,
  totalMigrationOffsetMicroUsd: 0,
  ...over,
}) as any;

/** The exact chain `getEffectiveLlmUsagePolicy` runs, minus the IO. */
function admit(rawCostUsedMicroUsd: number, credits: any, requestedModel: string | null = PREMIUM) {
  const adjustment = getLlmUsageCreditAdjustment(credits, MONTH);
  const adjusted = applyLlmUsageCredits({
    rawCostUsedMicroUsd,
    hardThresholdMicroUsd: policy.hardCostThresholdMicroUsd,
    adjustment,
  });
  const effectivePolicy = { ...policy, hardCostThresholdMicroUsd: adjusted.effectiveHardThresholdMicroUsd };
  const mode = evaluateLlmUsageMode({
    costUsedMicroUsd: adjusted.policyCostUsedMicroUsd,
    policy: effectivePolicy,
  });
  const model = selectPolicyModel({
    usageMode: mode.usageMode,
    requestedModel,
    backupModel: CHEAP,
    backupSource: "system",
    systemDefaultModel: CHEAP,
    supportedModelIds: SUPPORTED,
    policy: effectivePolicy,
  });
  return { mode, model, effectiveHardThresholdMicroUsd: adjusted.effectiveHardThresholdMicroUsd };
}

describe("ENG-1211 AC3 — purchased credits resume admission without changing the model", () => {
  // $160 spent against a $150 cap: paused, and stays paused until credit lands.
  const OVER_CAP = 160 * USD;

  it("pauses at the hard cap before any credit is purchased", () => {
    const before = admit(OVER_CAP, null);
    expect(before.mode.usageMode).toBe("paused");
    expect(before.mode.admissionAllowed).toBe(false);
    expect(before.model.effectiveModel).toBeNull();
    expect(before.model.modelSelection).toBe("blocked");
  });

  it("resumes admission once a verified purchase lands", () => {
    const after = admit(OVER_CAP, ledger({ totalPurchasedMicroUsd: 50 * USD }));
    expect(after.effectiveHardThresholdMicroUsd).toBe(200 * USD);
    expect(after.mode.usageMode).toBe("full_choice");
    expect(after.mode.admissionAllowed).toBe(true);
  });

  it("resumes on the SAME model the customer chose, never a cheaper substitute", () => {
    // The point of AC3. A resume that silently downgraded would reproduce
    // ENG-1200 at the exact moment the customer paid to avoid it — and note the
    // account carries a stale system-selected Flash Lite backup throughout.
    const after = admit(OVER_CAP, ledger({ totalPurchasedMicroUsd: 50 * USD }));
    expect(after.model.effectiveModel).toBe(PREMIUM);
    expect(after.model.modelSelection).toBe("honored");
    expect(after.model.effectiveModel).not.toBe(CHEAP);
  });

  it("admin-granted credit resumes admission on the same terms as a purchase", () => {
    const after = admit(OVER_CAP, ledger({ totalAdminGrantedMicroUsd: 50 * USD }));
    expect(after.mode.admissionAllowed).toBe(true);
    expect(after.model.effectiveModel).toBe(PREMIUM);
  });

  it("pauses exactly at the credit-extended boundary, not a dollar either side", () => {
    const credits = ledger({ totalPurchasedMicroUsd: 50 * USD }); // cap becomes $200
    expect(admit(200 * USD - 1, credits).mode.usageMode).toBe("full_choice");
    expect(admit(200 * USD, credits).mode.usageMode).toBe("paused");
  });

  it("re-pauses when a purchase is reversed, and blocks rather than downgrading", () => {
    // ENG-1140 revokes capacity on chargeback by writing the reversal here. The
    // account must fall back to blocked — NOT to a cheap model that would keep
    // billing provider spend against a payment that was taken back.
    const reversed = ledger({
      totalPurchasedMicroUsd: 50 * USD,
      totalPurchasedReversedMicroUsd: 50 * USD,
    });
    const after = admit(OVER_CAP, reversed);
    expect(after.effectiveHardThresholdMicroUsd).toBe(150 * USD);
    expect(after.mode.usageMode).toBe("paused");
    expect(after.model.effectiveModel).toBeNull();
    expect(after.model.modelSelection).toBe("blocked");
  });

  it("ignores a credit ledger belonging to a previous month", () => {
    // Credits are monthly; last month's top-up must not extend this month's cap.
    const stale = ledger({ month: "2026-07", totalPurchasedMicroUsd: 500 * USD });
    const after = admit(OVER_CAP, stale);
    expect(after.effectiveHardThresholdMicroUsd).toBe(150 * USD);
    expect(after.mode.usageMode).toBe("paused");
  });

  it("keeps every entitled model choosable after a resume, not just the one requested", () => {
    // AC1 below-hard freedom must be restored in full by the resume, not narrowed
    // to whatever the customer happened to ask for first.
    const credits = ledger({ totalPurchasedMicroUsd: 50 * USD });
    for (const requested of SUPPORTED) {
      const after = admit(OVER_CAP, credits, requested);
      expect(after.model.effectiveModel).toBe(requested);
      expect(after.model.modelSelection).toBe("honored");
    }
  });
});
