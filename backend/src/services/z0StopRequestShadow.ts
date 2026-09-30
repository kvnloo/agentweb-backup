import crypto from 'crypto';
import { runZ0NoulExperiment } from '../emma/z0Adapter';
import { runStopRequestIncumbentJudge } from './stopRequestJudgeService';

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


export async function runStopRequestStudyCase(
  content: string,
  options: {
    scopeId?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const env = options.env ?? process.env;
  const scopeId = options.scopeId ?? STOP_REQUEST_Z0_DECISION_ID;
  const built = buildStopRequestZ0Experiment(scopeId, content, env);

  const incumbentPromise = runStopRequestIncumbentJudge(content);
  const z0StartedAt = Date.now();
  const z0Promise = runZ0NoulExperiment(
    built.request,
    built.options,
  ).then((result: any) => ({
    result,
    wall_latency_ms: Date.now() - z0StartedAt,
  }));

  const [incumbent, z0] = await Promise.all([incumbentPromise, z0Promise]);
  const output = z0.result?.output ?? {};
  return {
    decision_id: STOP_REQUEST_Z0_DECISION_ID,
    operation_id: built.request.operation_id,
    incumbent_stop: incumbent.stop,
    incumbent_failed: incumbent.failed,
    incumbent_truncated: incumbent.truncated,
    incumbent_latency_ms: incumbent.latency_ms,
    z0_ok: z0.result?.ok === true,
    p_stop: typeof output.probability === 'number' ? output.probability : null,
    z0_latency_ms: z0.wall_latency_ms,
    z0_provider_latency_ms:
      typeof output.latency_ms === 'number' ? output.latency_ms : null,
    z0_input_tokens:
      typeof output.usage?.input_tokens === 'number'
        ? output.usage.input_tokens
        : null,
    z0_output_tokens:
      typeof output.usage?.output_tokens === 'number'
        ? output.usage.output_tokens
        : null,
    band:
      typeof output.probability === 'number'
        ? stopRequestZ0Band(output.probability)
        : null,
    applied: z0.result?.applied === true,
    replayed: z0.result?.replayed === true,
    dispatch_receipt_id: z0.result?.dispatch_receipt_id ?? null,
    z0_trace_id: z0.result?.trace_id ?? null,
    z0_reason: z0.result?.reason ?? null,
  };
}
