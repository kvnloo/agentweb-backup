import crypto from 'crypto';
import { runZ0NoulExperiment } from '../emma/z0Adapter';

export const STOP_REQUEST_Z0_DECISION_ID = 'stop_request_v1';
export const STOP_REQUEST_Z0_PROPOSITION =
  "The user's message explicitly asks the assistant to stop, pause, wait, not continue, or do no more work right now.";

export type StopRequestZ0ShadowBand = 'stop' | 'continue' | 'ambiguous';

export function readStopRequestZ0ShadowMode(
  env: NodeJS.ProcessEnv = process.env,
): 'off' | 'shadow' {
  return (env.Z0_STOP_REQUEST_SHADOW ?? '').trim().toLowerCase() === 'shadow'
    ? 'shadow'
    : 'off';
}

export function stopRequestZ0Band(probability: number): StopRequestZ0ShadowBand {
  if (probability >= 0.90) return 'stop';
  if (probability <= 0.10) return 'continue';
  return 'ambiguous';
}

export function buildStopRequestZ0Experiment(
  sessionId: string,
  content: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const message = content.slice(0, 2500);
  return {
    request: {
      operation_id: crypto.createHash('sha256').update(message).digest('hex'),
      decision_id: STOP_REQUEST_Z0_DECISION_ID,
      state: { message },
      proposition: STOP_REQUEST_Z0_PROPOSITION,
      allow_remote: env.Z0INT_STOP_REQUEST_ALLOW_REMOTE === '1',
    },
    options: { scopeId: sessionId },
  };
}

export function runStopRequestZ0Shadow(
  sessionId: string,
  content: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (readStopRequestZ0ShadowMode(env) === 'off') return null;
  const experiment = buildStopRequestZ0Experiment(sessionId, content, env);
  return runZ0NoulExperiment(experiment.request, experiment.options);
}

export function logStopRequestZ0Shadow(
  result: any,
  incumbentStop: boolean | null,
  incumbentFailed = false,
): void {
  if (!result?.ok || !result?.output) {
    console.log(JSON.stringify({
      event: 'z0_stop_request_shadow',
      ok: false,
      reason: result?.reason ?? 'unknown',
      traceId: result?.trace_id ?? null,
      reconcileRequired: result?.reconcile_required === true,
      incumbentStop,
      incumbentFailed,
    }));
    return;
  }
  const probability = result.output.probability;
  const band = typeof probability === 'number'
    ? stopRequestZ0Band(probability)
    : 'ambiguous';
  console.log(JSON.stringify({
    event: 'z0_stop_request_shadow',
    ok: true,
    decisionId: STOP_REQUEST_Z0_DECISION_ID,
    traceId: result.trace_id ?? null,
    dispatchReceiptId: result.dispatch_receipt_id ?? null,
    replayed: result.replayed === true,
    applied: result.applied === true,
    model: result.output.model ?? null,
    pStop: typeof probability === 'number' ? probability : null,
    band,
    incumbentStop,
    incumbentFailed,
    highConfidenceAgreement:
      incumbentStop === null || band === 'ambiguous'
        ? null
        : (band === 'stop') === incumbentStop,
    providerLatencyMs: result.output.latency_ms ?? null,
    usage: result.output.usage ?? null,
  }));
}
