export type LlmUsageMode = "full_choice" | "optimized" | "paused";
export type ModelSelection = "honored" | "corrected" | "defaulted" | "blocked";
export type ModelBackupSource = "user" | "system";

export interface LlmUsagePolicy {
  version: string;
  enforcementState: "observe" | "hard_only" | "enforce";
  optimizationCostThresholdMicroUsd: number;
  hardCostThresholdMicroUsd: number;
  optimizedModelIds: string[];
  optimizedDefaultModel: string;
}

export interface LlmUsageModeDecision {
  usageMode: LlmUsageMode;
  admissionAllowed: boolean;
  reason:
    | "policy_not_enforced"
    | "hard_cap_only"
    | "below_optimization_threshold"
    | "optimization_threshold_reached"
    | "hard_threshold_reached";
}

export interface PolicyModelDecision {
  requestedModel: string | null;
  effectiveModel: string | null;
  backupModel: string | null;
  backupSource: ModelBackupSource | null;
  modelSelection: ModelSelection;
  reason:
    | "usage_paused"
    | "requested_model_allowed"
    | "requested_model_unavailable_using_default"
    | "no_requested_model_using_default"
    | "requested_model_allowed_in_optimized_mode"
    | "requested_model_blocked_using_user_backup"
    | "requested_model_blocked_using_optimized_default";
}

export class InvalidLlmUsagePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLlmUsagePolicyError";
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

const NON_STABLE_MODEL_ID_MARKER =
  /(?:^|[._:-])(preview|beta|experimental|legacy|deprecated)(?:$|[._:-])/i;

/**
 * Optimized mode is the margin-protection catalog, so it may only contain
 * production-stable model ids. Admins still choose the catalog; this guard
 * rejects lifecycle-marked ids generically instead of hard-coding vendors or
 * individual models that will go stale.
 */
function getNonStableLifecycle(model: unknown): string | null {
  if (typeof model !== "string") return null;
  return model.match(NON_STABLE_MODEL_ID_MARKER)?.[1]?.toLowerCase() || null;
}

export function validateLlmUsagePolicy(policy: LlmUsagePolicy): string[] {
  const errors: string[] = [];
  if (!policy.version?.trim()) errors.push("version is required");
  if (!["observe", "hard_only", "enforce"].includes(policy.enforcementState)) {
    errors.push("enforcementState must be observe, hard_only, or enforce");
  }
  if (!isNonNegativeInteger(policy.optimizationCostThresholdMicroUsd)) {
    errors.push("optimizationCostThresholdMicroUsd must be a non-negative integer");
  }
  if (!isNonNegativeInteger(policy.hardCostThresholdMicroUsd)) {
    errors.push("hardCostThresholdMicroUsd must be a non-negative integer");
  }
  if (
    isNonNegativeInteger(policy.optimizationCostThresholdMicroUsd) &&
    isNonNegativeInteger(policy.hardCostThresholdMicroUsd) &&
    policy.hardCostThresholdMicroUsd <= policy.optimizationCostThresholdMicroUsd
  ) {
    errors.push("hardCostThresholdMicroUsd must be greater than optimizationCostThresholdMicroUsd");
  }
  if (!Array.isArray(policy.optimizedModelIds) || policy.optimizedModelIds.length === 0) {
    errors.push("optimizedModelIds must contain at least one model");
  } else {
    for (const model of policy.optimizedModelIds) {
      const lifecycle = getNonStableLifecycle(model);
      if (lifecycle) {
        errors.push(`optimizedModelIds must contain only stable models; '${model}' is ${lifecycle}`);
      }
    }
  }
  if (!policy.optimizedDefaultModel?.trim()) errors.push("optimizedDefaultModel is required");
  if (
    Array.isArray(policy.optimizedModelIds) &&
    policy.optimizedDefaultModel &&
    !policy.optimizedModelIds.includes(policy.optimizedDefaultModel)
  ) {
    errors.push("optimizedDefaultModel must be in optimizedModelIds");
  }
  return errors;
}

export function evaluateLlmUsageMode(input: {
  costUsedMicroUsd: number;
  tokenUsed?: number;
  policy: LlmUsagePolicy | null | undefined;
}): LlmUsageModeDecision {
  const { policy } = input;
  if (!policy || policy.enforcementState === "observe") {
    return { usageMode: "full_choice", admissionAllowed: true, reason: "policy_not_enforced" };
  }
  const errors = validateLlmUsagePolicy(policy);
  if (errors.length > 0) throw new InvalidLlmUsagePolicyError(errors.join("; "));

  const costUsedMicroUsd = Math.max(0, Math.round(input.costUsedMicroUsd || 0));
  if (costUsedMicroUsd >= policy.hardCostThresholdMicroUsd) {
    return { usageMode: "paused", admissionAllowed: false, reason: "hard_threshold_reached" };
  }
  if (policy.enforcementState === "hard_only") {
    return { usageMode: "full_choice", admissionAllowed: true, reason: "hard_cap_only" };
  }
  if (costUsedMicroUsd >= policy.optimizationCostThresholdMicroUsd) {
    return { usageMode: "optimized", admissionAllowed: true, reason: "optimization_threshold_reached" };
  }
  return { usageMode: "full_choice", admissionAllowed: true, reason: "below_optimization_threshold" };
}

export function selectPolicyModel(input: {
  usageMode: LlmUsageMode;
  requestedModel?: string | null;
  backupModel?: string | null;
  backupSource?: ModelBackupSource | null;
  systemDefaultModel: string;
  supportedModelIds: readonly string[];
  policy: LlmUsagePolicy | null | undefined;
}): PolicyModelDecision {
  const requestedModel = input.requestedModel?.trim() || null;
  const backupModel = input.backupModel?.trim() || null;
  const supported = new Set(input.supportedModelIds);

  if (input.usageMode === "paused") {
    return {
      requestedModel,
      effectiveModel: null,
      backupModel,
      backupSource: input.backupSource || null,
      modelSelection: "blocked",
      reason: "usage_paused",
    };
  }

  if (input.usageMode === "full_choice") {
    if (requestedModel && supported.has(requestedModel)) {
      return {
        requestedModel,
        effectiveModel: requestedModel,
        backupModel,
        backupSource: input.backupSource || null,
        modelSelection: "honored",
        reason: "requested_model_allowed",
      };
    }
    if (!supported.has(input.systemDefaultModel)) {
      throw new InvalidLlmUsagePolicyError("system default model is not supported");
    }
    return {
      requestedModel,
      effectiveModel: input.systemDefaultModel,
      backupModel,
      backupSource: input.backupSource || null,
      modelSelection: requestedModel ? "corrected" : "defaulted",
      reason: requestedModel ? "requested_model_unavailable_using_default" : "no_requested_model_using_default",
    };
  }

  if (!input.policy) throw new InvalidLlmUsagePolicyError("optimized mode requires a policy");
  const errors = validateLlmUsagePolicy(input.policy);
  if (errors.length > 0) throw new InvalidLlmUsagePolicyError(errors.join("; "));
  const optimized = new Set(
    input.policy.optimizedModelIds.filter((model) => supported.has(model))
  );
  if (optimized.size === 0 || !optimized.has(input.policy.optimizedDefaultModel)) {
    throw new InvalidLlmUsagePolicyError("optimized catalog has no valid supported default");
  }
  if (requestedModel && optimized.has(requestedModel)) {
    return {
      requestedModel,
      effectiveModel: requestedModel,
      backupModel,
      backupSource: input.backupSource || null,
      modelSelection: "honored",
      reason: "requested_model_allowed_in_optimized_mode",
    };
  }
  if (backupModel && input.backupSource === "user" && optimized.has(backupModel)) {
    return {
      requestedModel,
      effectiveModel: backupModel,
      backupModel,
      backupSource: "user",
      modelSelection: "corrected",
      reason: "requested_model_blocked_using_user_backup",
    };
  }
  return {
    requestedModel,
    effectiveModel: input.policy.optimizedDefaultModel,
    backupModel: input.policy.optimizedDefaultModel,
    backupSource: "system",
    modelSelection: "corrected",
    reason: "requested_model_blocked_using_optimized_default",
  };
}
