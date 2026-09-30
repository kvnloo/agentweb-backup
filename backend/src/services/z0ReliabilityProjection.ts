/**
 * Pure AgentWeb reliability -> z0 observational receipt projection.
 *
 * This intentionally drops userId and errorSummary. Tool transport success is
 * execution evidence only; it never sets verified_success or verification_source.
 */
import { createHash } from 'crypto';
import type { ReliabilityEvent } from './reliabilityEvent';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function pseudonymousSession(sessionId: string | undefined): string | undefined {
  return sessionId ? `agentweb:${sha256(sessionId).slice(0, 24)}` : undefined;
}

export function projectReliabilityEventToZ0(event: ReliabilityEvent): Record<string, unknown> {
  const session = pseudonymousSession(event.sessionId);
  const material = JSON.stringify({
    at: event.at,
    tool: event.tool,
    outcome: event.outcome,
    latencyMs: event.latencyMs,
    session,
    platform: event.platform ?? null,
    userEdit: event.userEdit ?? null,
  });
  const outcome: Record<string, unknown> = {
    source: 'agentweb_reliability_event',
  };

  if (event.outcome === 'success') {
    outcome.execution_completed = true;
    outcome.tool_ok = true;
    outcome.success = true;
  } else if (event.outcome === 'error' || event.outcome === 'timeout') {
    outcome.execution_completed = true;
    outcome.tool_ok = false;
  } else if (event.outcome === 'user_refused') {
    outcome.execution_completed = false;
    outcome.tool_ok = false;
    outcome.user_refused = true;
  } else {
    outcome.execution_completed = false;
    outcome.tool_ok = false;
  }

  return {
    schema: 'z0int.decision_receipt.v1',
    trace_id: `agentweb-observe-${sha256(material)}`,
    ...(session ? { session_id: session } : {}),
    capability_id: `agentweb.tool.${event.tool}`,
    provider: 'agentweb',
    route: 'shadow',
    execution: 'log_only',
    action_taken: event.outcome,
    latency_ms: event.latencyMs,
    measurement_state: 'partial',
    state_reason: 'observational_agentweb_tool_outcome_not_quality_verification',
    outcome,
    extra: {
      observational: true,
      tool: event.tool,
      reliability_outcome: event.outcome,
      ...(event.platform ? { platform: event.platform.slice(0, 64) } : {}),
      ...(event.userEdit !== undefined ? { user_edit: event.userEdit } : {}),
    },
  };
}
