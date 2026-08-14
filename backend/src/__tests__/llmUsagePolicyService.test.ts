import {
  evaluateLlmUsageMode,
  selectPolicyModel,
  type LlmUsagePolicy,
} from "../services/llmUsagePolicyService";

const policy: LlmUsagePolicy = {
  version: "policy-v1",
  enforcementState: "enforce",
  optimizationCostThresholdMicroUsd: 30_000_000,
  hardCostThresholdMicroUsd: 60_000_000,
  optimizedModelIds: ["gemini-3.1-flash-lite", "anthropic.claude-haiku-4-5-20251001-v1:0"],
  optimizedDefaultModel: "gemini-3.1-flash-lite",
};

describe("evaluateLlmUsageMode", () => {
  it.each([
    ['Free', 3, 5],
    ['Starter', 30, 60],
    ['Pro', 80, 150],
    ['Super Premium', 80, 150],
  ])('%s keeps full choice right up to its hard boundary (ENG-1211)', (_tier, optimizeUsd, hardUsd) => {
    const configured = {
      ...policy,
      version: `${_tier}-v1`,
      optimizationCostThresholdMicroUsd: optimizeUsd * 1_000_000,
      hardCostThresholdMicroUsd: hardUsd * 1_000_000,
    };
    // The optimization threshold is still configured and still validated, but it
    // no longer changes the mode — only the hard cap does.
    expect(evaluateLlmUsageMode({ costUsedMicroUsd: optimizeUsd * 1_000_000 - 1, policy: configured }).usageMode)
      .toBe('full_choice');
    expect(evaluateLlmUsageMode({ costUsedMicroUsd: optimizeUsd * 1_000_000, policy: configured }).usageMode)
      .toBe('full_choice');
    expect(evaluateLlmUsageMode({ costUsedMicroUsd: hardUsd * 1_000_000 - 1, policy: configured }).usageMode)
      .toBe('full_choice');
    expect(evaluateLlmUsageMode({ costUsedMicroUsd: hardUsd * 1_000_000, policy: configured }).usageMode)
      .toBe('paused');
  });

  it("reports hard-cap-only reasoning on both sides of the former optimization boundary", () => {
    // ENG-1211: one boundary remains, so the reason no longer distinguishes
    // "below" from "at" the optimization threshold.
    for (const cost of [29_999_999, 30_000_000]) {
      expect(evaluateLlmUsageMode({ costUsedMicroUsd: cost, policy })).toEqual({
        usageMode: "full_choice",
        admissionAllowed: true,
        reason: "hard_cap_only",
      });
    }
  });

  it("pauses exactly at the hard boundary", () => {
    expect(evaluateLlmUsageMode({ costUsedMicroUsd: 60_000_000, policy })).toEqual({
      usageMode: "paused",
      admissionAllowed: false,
      reason: "hard_threshold_reached",
    });
  });

  it("can enforce the hard cap before enabling model optimization", () => {
    const hardOnly = { ...policy, enforcementState: "hard_only" as const };
    expect(evaluateLlmUsageMode({ costUsedMicroUsd: 45_000_000, policy: hardOnly })).toEqual({
      usageMode: "full_choice",
      admissionAllowed: true,
      reason: "hard_cap_only",
    });
    expect(evaluateLlmUsageMode({ costUsedMicroUsd: 60_000_000, policy: hardOnly }).usageMode)
      .toBe("paused");
  });

  it("ignores raw token volume when cost policy is enforced", () => {
    expect(evaluateLlmUsageMode({ costUsedMicroUsd: 1_000_000, tokenUsed: 300_000_000, policy }).usageMode)
      .toBe("full_choice");
  });
});

describe("selectPolicyModel", () => {
  const supported = [
    "anthropic.claude-opus-5",
    "anthropic.claude-haiku-4-5-20251001-v1:0",
    "gemini-3.1-flash-lite",
  ];

  it("honors an eligible requested model in full-choice mode", () => {
    expect(selectPolicyModel({
      usageMode: "full_choice",
      requestedModel: "anthropic.claude-opus-5",
      systemDefaultModel: "gemini-3.1-flash-lite",
      supportedModelIds: supported,
      policy,
    })).toMatchObject({
      effectiveModel: "anthropic.claude-opus-5",
      modelSelection: "honored",
      reason: "requested_model_allowed",
    });
  });

  it("no longer substitutes a user backup for a blocked preferred model (ENG-1211)", () => {
    // Was: opus blocked -> haiku backup used. The preferred model now stands.
    expect(selectPolicyModel({
      usageMode: "optimized",
      requestedModel: "anthropic.claude-opus-5",
      backupModel: "anthropic.claude-haiku-4-5-20251001-v1:0",
      backupSource: "user",
      systemDefaultModel: "gemini-3.1-flash-lite",
      supportedModelIds: supported,
      policy,
    })).toMatchObject({
      effectiveModel: "anthropic.claude-opus-5",
      modelSelection: "honored",
      reason: "requested_model_allowed",
    });
  });

  it("no longer falls back to the admin-configured optimized default (ENG-1211)", () => {
    // Was: opus blocked, backup unusable -> flash-lite forced. This substitution
    // is precisely what produced the ENG-1200 incident and is now deleted.
    expect(selectPolicyModel({
      usageMode: "optimized",
      requestedModel: "anthropic.claude-opus-5",
      backupModel: "retired-model",
      backupSource: "user",
      systemDefaultModel: "anthropic.claude-opus-5",
      supportedModelIds: supported,
      policy,
    })).toMatchObject({
      effectiveModel: "anthropic.claude-opus-5",
      modelSelection: "honored",
      reason: "requested_model_allowed",
    });
  });

  it("returns no model while paused", () => {
    expect(selectPolicyModel({
      usageMode: "paused",
      requestedModel: "gemini-3.1-flash-lite",
      systemDefaultModel: "gemini-3.1-flash-lite",
      supportedModelIds: supported,
      policy,
    })).toMatchObject({
      effectiveModel: null,
      modelSelection: "blocked",
      reason: "usage_paused",
    });
  });
});

/**
 * ENG-1211 — forced optimized-mode switching is removed. Below the hard cost
 * threshold every entitled model stays usable on every path; at the hard
 * threshold admission pauses. There is no longer any middle state that
 * rewrites a user's model.
 *
 * The `optimized` value is deliberately RETAINED in the LlmUsageMode union so
 * persisted rows and a not-yet-redeployed instance still parse (ENG-1209 AC6
 * keeps legacy fields read-compatible for rollback). It simply can no longer be
 * produced, and can no longer affect admission (ENG-1211 AC5).
 */
describe("ENG-1211 — no forced optimized mode", () => {
  const enforcing: LlmUsagePolicy = { ...policy, enforcementState: "enforce" };

  it("stays on full choice between the old optimization threshold and the hard cap", () => {
    // $45 sits above the $30 optimization threshold and below the $60 hard cap —
    // exactly the band that used to coerce the model.
    const decision = evaluateLlmUsageMode({ costUsedMicroUsd: 45_000_000, policy: enforcing });
    expect(decision.usageMode).toBe("full_choice");
    expect(decision.admissionAllowed).toBe(true);
  });

  it("never returns optimized at any cost, including exactly on the old boundary", () => {
    for (const cost of [0, 1, 29_999_999, 30_000_000, 45_000_000, 59_999_999]) {
      expect(evaluateLlmUsageMode({ costUsedMicroUsd: cost, policy: enforcing }).usageMode).not.toBe("optimized");
    }
  });

  it("still pauses exactly at the hard cap", () => {
    expect(evaluateLlmUsageMode({ costUsedMicroUsd: 59_999_999, policy: enforcing }).usageMode).toBe("full_choice");
    const at = evaluateLlmUsageMode({ costUsedMicroUsd: 60_000_000, policy: enforcing });
    expect(at.usageMode).toBe("paused");
    expect(at.admissionAllowed).toBe(false);
  });

  it("honors an expensive model in the old optimization band", () => {
    const decision = selectPolicyModel({
      usageMode: evaluateLlmUsageMode({ costUsedMicroUsd: 45_000_000, policy: enforcing }).usageMode,
      requestedModel: "anthropic.claude-opus-5",
      systemDefaultModel: "anthropic.claude-opus-5",
      supportedModelIds: ["anthropic.claude-opus-5", "gemini-3.1-flash-lite"],
      policy: enforcing,
    });
    expect(decision.effectiveModel).toBe("anthropic.claude-opus-5");
    expect(decision.modelSelection).toBe("honored");
  });

  it("treats a legacy stored `optimized` mode as full choice, never as a coercion", () => {
    // A row written before the cutover, or an older instance mid-deploy.
    const decision = selectPolicyModel({
      usageMode: "optimized",
      requestedModel: "anthropic.claude-opus-5",
      systemDefaultModel: "anthropic.claude-opus-5",
      supportedModelIds: ["anthropic.claude-opus-5", "gemini-3.1-flash-lite"],
      policy: enforcing,
    });
    expect(decision.effectiveModel).toBe("anthropic.claude-opus-5");
    expect(decision.modelSelection).toBe("honored");
  });

  it("ignores a system-selected backup entirely — it can never become effective", () => {
    const decision = selectPolicyModel({
      usageMode: "optimized",
      requestedModel: "anthropic.claude-opus-5",
      backupModel: "gemini-3.1-flash-lite",
      backupSource: "system",
      systemDefaultModel: "anthropic.claude-opus-5",
      supportedModelIds: ["anthropic.claude-opus-5", "gemini-3.1-flash-lite"],
      policy: enforcing,
    });
    expect(decision.effectiveModel).toBe("anthropic.claude-opus-5");
  });

  it("still blocks every model at the hard cap", () => {
    const decision = selectPolicyModel({
      usageMode: "paused",
      requestedModel: "anthropic.claude-opus-5",
      systemDefaultModel: "anthropic.claude-opus-5",
      supportedModelIds: ["anthropic.claude-opus-5"],
      policy: enforcing,
    });
    expect(decision.effectiveModel).toBeNull();
    expect(decision.modelSelection).toBe("blocked");
  });
});
