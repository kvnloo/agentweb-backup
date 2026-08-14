import {
  evaluateLlmUsageMode,
  selectPolicyModel,
  validateLlmUsagePolicy,
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

describe("validateLlmUsagePolicy optimized catalog lifecycle", () => {
  it("accepts an admin-configured catalog made only of stable model ids", () => {
    expect(validateLlmUsagePolicy(policy)).toEqual([]);
  });

  it("rejects preview models from optimized mode", () => {
    expect(validateLlmUsagePolicy({
      ...policy,
      optimizedModelIds: ["gemini-3-flash-preview"],
      optimizedDefaultModel: "gemini-3-flash-preview",
    })).toContain("optimizedModelIds must contain only stable models; 'gemini-3-flash-preview' is preview");
  });

  it.each(["vendor-model-beta", "vendor-model-experimental"])(
    "rejects the non-GA lifecycle marker in %s",
    (model) => {
      expect(validateLlmUsagePolicy({
        ...policy,
        optimizedModelIds: [model],
        optimizedDefaultModel: model,
      }).join("; ")).toContain(`'${model}'`);
    }
  );

  it.each(["vendor-model-legacy", "vendor-model-deprecated"])(
    "rejects the retired lifecycle marker in %s",
    (model) => {
      expect(validateLlmUsagePolicy({
        ...policy,
        optimizedModelIds: [model],
        optimizedDefaultModel: model,
      }).join("; ")).toContain(`'${model}'`);
    }
  );
});

describe("evaluateLlmUsageMode", () => {
  it.each([
    ['Free', 3, 5],
    ['Starter', 30, 60],
    ['Pro', 80, 150],
    ['Super Premium', 80, 150],
  ])('%s follows the approved dollar boundaries when configured by admin', (_tier, optimizeUsd, hardUsd) => {
    const configured = {
      ...policy,
      version: `${_tier}-v1`,
      optimizationCostThresholdMicroUsd: optimizeUsd * 1_000_000,
      hardCostThresholdMicroUsd: hardUsd * 1_000_000,
    };
    expect(evaluateLlmUsageMode({ costUsedMicroUsd: optimizeUsd * 1_000_000 - 1, policy: configured }).usageMode)
      .toBe('full_choice');
    expect(evaluateLlmUsageMode({ costUsedMicroUsd: optimizeUsd * 1_000_000, policy: configured }).usageMode)
      .toBe('optimized');
    expect(evaluateLlmUsageMode({ costUsedMicroUsd: hardUsd * 1_000_000, policy: configured }).usageMode)
      .toBe('paused');
  });

  it("keeps full model choice immediately below the optimization boundary", () => {
    expect(evaluateLlmUsageMode({ costUsedMicroUsd: 29_999_999, policy })).toEqual({
      usageMode: "full_choice",
      admissionAllowed: true,
      reason: "below_optimization_threshold",
    });
  });

  it("enters optimized mode exactly at the optimization boundary", () => {
    expect(evaluateLlmUsageMode({ costUsedMicroUsd: 30_000_000, policy })).toEqual({
      usageMode: "optimized",
      admissionAllowed: true,
      reason: "optimization_threshold_reached",
    });
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

  it("uses the user's eligible backup after their preferred model is blocked", () => {
    expect(selectPolicyModel({
      usageMode: "optimized",
      requestedModel: "anthropic.claude-opus-5",
      backupModel: "anthropic.claude-haiku-4-5-20251001-v1:0",
      backupSource: "user",
      systemDefaultModel: "gemini-3.1-flash-lite",
      supportedModelIds: supported,
      policy,
    })).toMatchObject({
      effectiveModel: "anthropic.claude-haiku-4-5-20251001-v1:0",
      modelSelection: "corrected",
      backupSource: "user",
      reason: "requested_model_blocked_using_user_backup",
    });
  });

  it("uses the admin-configured optimized default when no eligible backup exists", () => {
    expect(selectPolicyModel({
      usageMode: "optimized",
      requestedModel: "anthropic.claude-opus-5",
      backupModel: "retired-model",
      backupSource: "user",
      systemDefaultModel: "anthropic.claude-opus-5",
      supportedModelIds: supported,
      policy,
    })).toMatchObject({
      effectiveModel: "gemini-3.1-flash-lite",
      modelSelection: "corrected",
      backupSource: "system",
      reason: "requested_model_blocked_using_optimized_default",
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
