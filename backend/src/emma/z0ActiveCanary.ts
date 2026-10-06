/**
 * Bounded AgentWeb -> z0 active canary for #101.
 *
 * This module only decides whether the existing z0_route seam is allowed to
 * upgrade from shadow planning to the existing active /v1/intelligence lane.
 * It never executes AgentWeb tools and never widens AgentWeb authority.
 */
import { createHash } from 'crypto';
import {
  pseudonymousAgentWebParent,
  readZ0AgentWebConfig,
  runZ0Route,
  type Z0AgentWebConfig,
  type Z0FetchLike,
  type Z0RouteArgs,
} from './z0Adapter';
import type { Z0BridgeRiskClass } from './z0BridgeProtocol';

export const Z0_ACTIVE_CANARY_SCHEMA = 'agentweb.z0.active_canary.v1' as const;
export const Z0_ACTIVE_CANARY_EXPERIMENT_ID = 'agentweb-z0-active-canary-v1' as const;

export interface Z0ActiveCanaryConfig {
  enabled: boolean;
  fraction: number;
  killSwitch: boolean;
}

export interface Z0CanaryAssignment {
  cohortId: string;
  bucket: number;
  arm: 'candidate' | 'reference';
  treatmentHash: string;
}

export interface Z0CanaryRouteOptions {
  sessionId: string;
  riskClass: Z0BridgeRiskClass;
  agentConfig?: Z0AgentWebConfig;
  canaryConfig?: Z0ActiveCanaryConfig;
  fetchImpl?: Z0FetchLike;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function enabledValue(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'on' || value === 'enabled';
}

function parseFraction(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
}

export function readZ0ActiveCanaryConfig(
  env: NodeJS.ProcessEnv = process.env,
): Z0ActiveCanaryConfig {
  return {
    enabled: enabledValue(env.Z0INT_AGENTWEB_CANARY),
    fraction: parseFraction(env.Z0INT_AGENTWEB_CANARY_FRACTION),
    killSwitch: enabledValue(env.Z0INT_AGENTWEB_CANARY_KILL_SWITCH),
  };
}

function treatmentHash(config: Z0ActiveCanaryConfig): string {
  return sha256(JSON.stringify({
    schema: Z0_ACTIVE_CANARY_SCHEMA,
    experiment_id: Z0_ACTIVE_CANARY_EXPERIMENT_ID,
    enabled: config.enabled,
    fraction: config.fraction,
    kill_switch: config.killSwitch,
    active_risk_classes: ['read', 'generate'],
    required_deployment: 'sidecar',
    required_backpressure: 'enforce',
  }));
}

export function assignZ0ActiveCanary(
  parentAgent: string,
  config: Z0ActiveCanaryConfig,
): Z0CanaryAssignment {
  const digest = sha256(`${Z0_ACTIVE_CANARY_EXPERIMENT_ID}\0${parentAgent}`);
  const bucket = Number.parseInt(digest.slice(0, 8), 16) / 0x1_0000_0000;
  return {
    cohortId: `agentweb-canary:${digest.slice(8, 32)}`,
    bucket,
    arm: bucket < config.fraction ? 'candidate' : 'reference',
    treatmentHash: treatmentHash(config),
  };
}

function activeBlockReason(params: {
  config: Z0ActiveCanaryConfig;
  agentConfig: Z0AgentWebConfig;
  assignment: Z0CanaryAssignment;
  riskClass: Z0BridgeRiskClass;
}): string | null {
  if (!params.config.enabled) return 'canary_disabled';
  if (params.agentConfig.mode === 'off') return 'base_mode_off';
  if (params.assignment.arm !== 'candidate') return 'reference_arm';
  if (params.config.killSwitch) return 'kill_switch';
  if (params.riskClass !== 'read' && params.riskClass !== 'generate') {
    return 'forbidden_risk_class';
  }
  if (params.agentConfig.deploymentMode !== 'sidecar') return 'sidecar_required';
  if (params.agentConfig.backpressureMode !== 'enforce') return 'backpressure_required';
  return null;
}

export async function runZ0CanaryRoute(
  args: Z0RouteArgs,
  options: Z0CanaryRouteOptions,
) {
  const agentConfig = options.agentConfig ?? readZ0AgentWebConfig();
  const canaryConfig = options.canaryConfig ?? readZ0ActiveCanaryConfig();

  let parentAgent: string;
  try {
    parentAgent = pseudonymousAgentWebParent(options.sessionId);
  } catch {
    const result = await runZ0Route(args, {
      sessionId: options.sessionId,
      config: { ...agentConfig, mode: 'off' },
      fetchImpl: options.fetchImpl,
      riskClass: options.riskClass,
    });
    return {
      ...result,
      canary: {
        schema: Z0_ACTIVE_CANARY_SCHEMA,
        experiment_id: Z0_ACTIVE_CANARY_EXPERIMENT_ID,
        cohort_id: null,
        treatment_hash: treatmentHash(canaryConfig),
        arm: 'reference',
        selected: false,
        risk_class: options.riskClass,
        capability: args.function,
        operation_id: args.operation_id,
        active_requested: false,
        active_applied: false,
        block_reason: 'missing_session',
      },
    };
  }

  const assignment = assignZ0ActiveCanary(parentAgent, canaryConfig);
  const blockReason = activeBlockReason({
    config: canaryConfig,
    agentConfig,
    assignment,
    riskClass: options.riskClass,
  });
  const activeRequested = blockReason === null;

  // The canary owns the upgrade to active. Reference/blocked arms keep the
  // incumbent z0 comparison lane shadow-only; base off still stays fully off.
  const mode = activeRequested
    ? 'active'
    : agentConfig.mode === 'off'
      ? 'off'
      : 'shadow';

  const result = await runZ0Route(args, {
    sessionId: options.sessionId,
    config: { ...agentConfig, mode },
    fetchImpl: options.fetchImpl,
    riskClass: options.riskClass,
  });

  return {
    ...result,
    canary: {
      schema: Z0_ACTIVE_CANARY_SCHEMA,
      experiment_id: Z0_ACTIVE_CANARY_EXPERIMENT_ID,
      cohort_id: assignment.cohortId,
      treatment_hash: assignment.treatmentHash,
      arm: assignment.arm,
      selected: assignment.arm === 'candidate',
      bucket: assignment.bucket,
      risk_class: options.riskClass,
      capability: args.function,
      operation_id: args.operation_id,
      active_requested: activeRequested,
      active_applied:
        activeRequested &&
        result.skipped === false &&
        (result as Record<string, unknown>).applied === true,
      block_reason: blockReason,
    },
  };
}
