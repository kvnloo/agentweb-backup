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

  /**
   * Percentage of the enforced allowance at which the proactive usage alert
   * fires (ENG-1214 AC5, ENG-1210 AC9 — tunable without a deploy).
   *
   * OPTIONAL, and it has to be: every policy already stored in production
   * predates this field, and a validator that rejected those would take
   * admission down for every tier the moment it shipped. Absent means the
   * default in `resolveAlertThresholds`.
   */
  alertUsagePercentThreshold?: number;

  /**
   * Whether an early-exhaustion FORECAST alerts, independently of the level
   * above (ENG-1217 AC12). Lets an admin roll forecast alerts out per tier, or
   * silence them, without touching the usage threshold. Absent means enabled.
   */
  alertOnForecastShortfall?: boolean;
}

/** Defaults applied when a policy predates the alert fields, or omits them. */
export const DEFAULT_ALERT_USAGE_PERCENT_THRESHOLD = 90;
export const DEFAULT_ALERT_ON_FORECAST_SHORTFALL = true;

export interface ResolvedAlertThresholds {
  usagePercent: number;
  onForecastShortfall: boolean;
}

/**
 * The thresholds a client should alert on, with defaults already applied.
 *
 * Resolved SERVER-side so there is exactly one place that knows the default. A
 * client carrying its own fallback would keep alerting at the old number for
 * anyone whose policy set a different one, and the disagreement would be
 * invisible — the customer simply gets warned at the wrong time.
 */
export function resolveAlertThresholds(
  policy: LlmUsagePolicy | null | undefined,
): ResolvedAlertThresholds {
  const raw = policy?.alertUsagePercentThreshold;
  return {
    usagePercent:
      isAlertPercent(raw) ? (raw as number) : DEFAULT_ALERT_USAGE_PERCENT_THRESHOLD,
    onForecastShortfall:
      typeof policy?.alertOnForecastShortfall === "boolean"
        ? policy.alertOnForecastShortfall
        : DEFAULT_ALERT_ON_FORECAST_SHORTFALL,
  };
}

/** 1..99. Not 100+: at the cap the user is blocked and the at-limit modal owns it. */
function isAlertPercent(v: unknown): boolean {
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 99;
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
  }
  if (!policy.optimizedDefaultModel?.trim()) errors.push("optimizedDefaultModel is required");
  // Both alert fields are optional; only a PRESENT-but-invalid value is an error.
  // `undefined` has to stay acceptable or every pre-existing stored policy breaks.
  if (policy.alertUsagePercentThreshold !== undefined && !isAlertPercent(policy.alertUsagePercentThreshold)) {
    errors.push("alertUsagePercentThreshold must be an integer between 1 and 99");
  }
  if (
    policy.alertOnForecastShortfall !== undefined &&
    typeof policy.alertOnForecastShortfall !== "boolean"
  ) {
    errors.push("alertOnForecastShortfall must be a boolean");
  }
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
  // ENG-1211: there is exactly one enforcement boundary now — the hard cap.
  // `enforce` and `hard_only` are therefore equivalent, and
  // `optimizationCostThresholdMicroUsd` no longer gates anything. It is retained
  // on the policy (and still validated) because ENG-1212's runway forecast reads
  // it as an alert threshold and ENG-1209 AC6 keeps legacy config readable for
  // rollback — but it can never again change, block, or rewrite a model.
  return { usageMode: "full_choice", admissionAllowed: true, reason: "hard_cap_only" };
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

  // ENG-1211: every non-paused mode honors the user's choice. A stored or
  // in-flight `optimized` value from before the cutover lands here too and is
  // treated as full choice — the value stays parseable for rollback (ENG-1209
  // AC6) but cannot coerce a model (ENG-1211 AC5). The former optimized branch,
  // which substituted a user backup or the admin-configured optimized default,
  // is deleted: that substitution IS the behavior this ticket removes.
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
