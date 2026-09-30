/**
 * Default-off, fail-open exporter for privacy-minimized AgentWeb reliability observations.
 */
import type { ReliabilityEvent } from './reliabilityEvent';
import { projectReliabilityEventToZ0 } from './z0ReliabilityProjection';

export type Z0ReliabilityExportMode = 'off' | 'shadow';
export type Z0ReliabilityFetchLike = typeof fetch;

const DEFAULT_TIMEOUT_MS = 1000;
const MAX_IN_FLIGHT = 16;
let inFlight = 0;

export function readZ0ReliabilityExportMode(
  env: NodeJS.ProcessEnv = process.env,
): Z0ReliabilityExportMode {
  return (env.Z0INT_AGENTWEB_OBSERVE ?? '').trim().toLowerCase() === 'shadow'
    ? 'shadow'
    : 'off';
}

function readTimeout(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(env.Z0INT_AGENTWEB_OBSERVE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 5000 ? parsed : DEFAULT_TIMEOUT_MS;
}

export async function exportReliabilityEventToZ0Safe(
  event: ReliabilityEvent,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: Z0ReliabilityFetchLike;
  } = {},
): Promise<{ exported: boolean; reason: string; receipt_id?: string; replayed?: boolean }> {
  const env = options.env ?? process.env;
  if (readZ0ReliabilityExportMode(env) === 'off') {
    return { exported: false, reason: 'disabled' };
  }
  if (inFlight >= MAX_IN_FLIGHT) {
    return { exported: false, reason: 'inflight_cap' };
  }

  const receipt = projectReliabilityEventToZ0(event);
  const baseUrl = (env.Z0INT_SERVICE_URL ?? 'http://127.0.0.1:11501').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), readTimeout(env));
  const fetchImpl = options.fetchImpl ?? fetch;
  inFlight += 1;
  try {
    const response = await fetchImpl(`${baseUrl}/v1/observe/reliability`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(receipt),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { exported: false, reason: `http_${response.status}` };
    }
    const payload = (await response.json()) as any;
    if (!payload || payload.ok !== true || typeof payload.receipt_id !== 'string') {
      return { exported: false, reason: 'invalid_response' };
    }
    return {
      exported: true,
      reason: payload.replayed === true ? 'replayed' : 'stored',
      receipt_id: payload.receipt_id,
      replayed: payload.replayed === true,
    };
  } catch (error) {
    return {
      exported: false,
      reason: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'transport_error',
    };
  } finally {
    clearTimeout(timer);
    inFlight -= 1;
  }
}

export function getZ0ReliabilityExporterInFlightForTests(): number {
  return inFlight;
}
