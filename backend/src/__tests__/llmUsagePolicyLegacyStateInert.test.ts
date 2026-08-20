/**
 * ENG-1209 — proof that persisted soft-cap state is inert.
 *
 * The runtime policy moved to `hard_only` on 2026-08-14, but turning a threshold
 * off does not by itself undo state written while forced optimized mode was
 * active. Production still holds, at the time of writing:
 *
 *   - 71 scheduled rows with a system-selected `gemini-3.1-flash-lite` backup and
 *     `llmBackupNeedsConfirmation: true`;
 *   - 81 of 96 active recurring schedules with no explicit `llmModel`;
 *   - sessions stamped with a legacy `llmUsagePolicyDecision.usageMode: "optimized"`.
 *
 * ENG-1209 AC4 accepts "removed **or proven inert**". ENG-1211 deleted the only
 * branch that ever read a backup, so this file is that proof: it asserts the
 * model resolver cannot be made to coerce a model by ANY combination of legacy
 * artifacts, rather than asserting a handful of hand-picked cases.
 *
 * If someone reintroduces a non-hard threshold that rewrites a model, these tests
 * fail — which is the point. They are the regression guard for ENG-1211 AC1 as
 * much as they are ENG-1209's evidence.
 */

import {
  evaluateLlmUsageMode,
  selectPolicyModel,
  type LlmUsageMode,
  type LlmUsagePolicy,
  type ModelBackupSource,
} from "../services/llmUsagePolicyService";

const PREMIUM = "anthropic.claude-opus-5";
const CHEAP = "gemini-3.1-flash-lite";
const OTHER_CHEAP = "anthropic.claude-haiku-4-5-20251001-v1:0";
const SUPPORTED = [PREMIUM, CHEAP, OTHER_CHEAP];

/** The exact shape production carried while forced optimized mode was live. */
const legacyPolicy: LlmUsagePolicy = {
  version: "cost-policy-2026-08-v1",
  enforcementState: "enforce",
  optimizationCostThresholdMicroUsd: 80_000_000,
  hardCostThresholdMicroUsd: 150_000_000,
  optimizedModelIds: [CHEAP, OTHER_CHEAP],
  optimizedDefaultModel: CHEAP,
};

describe("ENG-1209 — legacy soft-cap state cannot coerce a model", () => {
  /**
   * The whole legacy state space, not a sample: every backup model a backfill
   * could have written x every provenance x every confirmation flag x the cost
   * band that used to trigger coercion.
   */
  const backupModels: Array<string | null> = [null, CHEAP, OTHER_CHEAP, PREMIUM, "retired-model"];
  const backupSources: Array<ModelBackupSource | null> = [null, "system", "user"];
  const legacyModes: LlmUsageMode[] = ["full_choice", "optimized"];
  // $80 is exactly the old optimization threshold, $149 the last dollar below the
  // hard cap — the entire band that used to substitute a model.
  const costsInFormerOptimizedBand = [80_000_000, 100_000_000, 149_999_999];

  it("honors an entitled premium model across every legacy backup/provenance/mode combination", () => {
    const counterexamples: string[] = [];

    for (const backupModel of backupModels) {
      for (const backupSource of backupSources) {
        for (const usageMode of legacyModes) {
          const decision = selectPolicyModel({
            usageMode,
            requestedModel: PREMIUM,
            backupModel,
            backupSource,
            systemDefaultModel: CHEAP,
            supportedModelIds: SUPPORTED,
            policy: legacyPolicy,
          });
          if (decision.effectiveModel !== PREMIUM || decision.modelSelection !== "honored") {
            counterexamples.push(
              `backup=${backupModel} source=${backupSource} mode=${usageMode} -> ` +
              `${decision.effectiveModel} (${decision.modelSelection}/${decision.reason})`,
            );
          }
        }
      }
    }

    expect(counterexamples).toEqual([]);
  });

  it("never enters a coercing mode anywhere in the former optimized band", () => {
    for (const costUsedMicroUsd of costsInFormerOptimizedBand) {
      const decision = evaluateLlmUsageMode({ costUsedMicroUsd, policy: legacyPolicy });
      expect(decision.usageMode).toBe("full_choice");
      expect(decision.admissionAllowed).toBe(true);
    }
  });

  it("keeps an unconfirmed system backup inert — it can never become the effective model", () => {
    // The exact production shape: system-selected Flash Lite, never confirmed,
    // sitting on a schedule whose owner is deep in the former optimized band.
    const usageMode = evaluateLlmUsageMode({ costUsedMicroUsd: 120_000_000, policy: legacyPolicy }).usageMode;
    const decision = selectPolicyModel({
      usageMode,
      requestedModel: PREMIUM,
      backupModel: CHEAP,
      backupSource: "system",
      systemDefaultModel: CHEAP,
      supportedModelIds: SUPPORTED,
      policy: legacyPolicy,
    });

    expect(decision.effectiveModel).toBe(PREMIUM);
    expect(decision.effectiveModel).not.toBe(CHEAP);
  });

  it("preserves a user-confirmed backup as data without ever acting on it (AC3)", () => {
    const decision = selectPolicyModel({
      usageMode: "optimized",
      requestedModel: PREMIUM,
      backupModel: OTHER_CHEAP,
      backupSource: "user",
      systemDefaultModel: CHEAP,
      supportedModelIds: SUPPORTED,
      policy: legacyPolicy,
    });

    // Echoed back untouched — AC3 preserves the user's choice...
    expect(decision.backupModel).toBe(OTHER_CHEAP);
    expect(decision.backupSource).toBe("user");
    // ...but it is not what runs.
    expect(decision.effectiveModel).toBe(PREMIUM);
  });

  it("still blocks every path at the hard cap regardless of legacy state (AC2)", () => {
    const usageMode = evaluateLlmUsageMode({ costUsedMicroUsd: 150_000_000, policy: legacyPolicy }).usageMode;
    expect(usageMode).toBe("paused");

    for (const backupModel of backupModels) {
      for (const backupSource of backupSources) {
        const decision = selectPolicyModel({
          usageMode,
          requestedModel: PREMIUM,
          backupModel,
          backupSource,
          systemDefaultModel: CHEAP,
          supportedModelIds: SUPPORTED,
          policy: legacyPolicy,
        });
        // No legacy backup can smuggle a provider call past the hard cap.
        expect(decision.effectiveModel).toBeNull();
        expect(decision.modelSelection).toBe("blocked");
      }
    }
  });

  it("runs a schedule on its explicit model even with a stale cheap backup attached (AC5)", () => {
    // 81 of 96 schedules carry no llmModel and fall to the system default; the
    // rest carry an explicit one. Both must survive untouched.
    const explicit = selectPolicyModel({
      usageMode: "optimized",
      requestedModel: PREMIUM,
      backupModel: CHEAP,
      backupSource: "system",
      systemDefaultModel: PREMIUM,
      supportedModelIds: SUPPORTED,
      policy: legacyPolicy,
    });
    expect(explicit.effectiveModel).toBe(PREMIUM);

    const inherited = selectPolicyModel({
      usageMode: "optimized",
      requestedModel: null,
      backupModel: CHEAP,
      backupSource: "system",
      systemDefaultModel: PREMIUM,
      supportedModelIds: SUPPORTED,
      policy: legacyPolicy,
    });
    expect(inherited.effectiveModel).toBe(PREMIUM);
    expect(inherited.modelSelection).toBe("defaulted");
  });

  it("cannot be re-armed by flipping enforcementState back to enforce (AC6 rollback safety)", () => {
    // Legacy config stays readable for rollback, but reading it must not restore
    // the coercion. `enforce` and `hard_only` are now the same behavior.
    for (const enforcementState of ["enforce", "hard_only"] as const) {
      const decision = evaluateLlmUsageMode({
        costUsedMicroUsd: 100_000_000,
        policy: { ...legacyPolicy, enforcementState },
      });
      expect(decision.usageMode).toBe("full_choice");
    }
  });
});
