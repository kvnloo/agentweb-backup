export type ExecutionTransport = 'direct_mcp' | 'api' | 'browser' | 'manual';
export type ActionRisk = 'read' | 'routine_write' | 'sensitive_write';

export interface CapabilityManifest {
  name: string;
  transports: ExecutionTransport[];
  risk: ActionRisk;
  requiresUserGesture?: boolean;
}

export interface ExecutionContext {
  available: ExecutionTransport[];
  userGesturePresent?: boolean;
}

export interface PathDecision {
  transport: ExecutionTransport;
  handoff: boolean;
  reason: string;
}

const ORDER: ExecutionTransport[] = ['direct_mcp', 'api', 'browser', 'manual'];

export function chooseExecutionPath(
  capability: CapabilityManifest,
  context: ExecutionContext,
): PathDecision {
  if (capability.requiresUserGesture && !context.userGesturePresent) {
    return {
      transport: 'manual',
      handoff: true,
      reason: 'user_gesture_required',
    };
  }

  const allowed = ORDER.filter(
    (transport) => capability.transports.includes(transport) && context.available.includes(transport),
  );

  if (capability.risk === 'sensitive_write') {
    return {
      transport: 'manual',
      handoff: true,
      reason: 'sensitive_write_confirmation',
    };
  }

  const selected = allowed[0] ?? 'manual';
  return {
    transport: selected,
    handoff: selected === 'manual',
    reason: selected === 'manual' ? 'no_safe_automated_transport' : 'best_available_transport',
  };
}

export function countManualHandoffs(decisions: PathDecision[]): number {
  return decisions.filter((decision) => decision.handoff).length;
}
