/**
 * Okareo source for the offline eval gate (ENG-2145; ENG-782 item 2).
 *
 * Reads one finished Okareo test run and turns its per-datapoint check values into pass counts
 * per check, for offlineSuite.ts to compare with the baseline. The run itself — a scenario set
 * driven against the STAGING target — is started by the Atem runner; this adapter only reads it.
 *
 * Built against Okareo's published OpenAPI (https://api.okareo.com/openapi.json, v0):
 *   GET  /v0/test_runs/{test_run_id}      header `api-key` → TestRunItem { id, status, failure_message, ... }
 *   POST /v0/find_test_data_points        { test_run_id, full_data_point: true }
 *                                         → FullDataPointItem[] { check_values: CheckValueItem[], error_code, error_message }
 *   CheckValueItem { name, value: number | boolean, value_type, check_id, is_issue? }
 *
 * Credentials are external configuration (OPS-6, ENG-2151): OKAREO_API_KEY, never committed.
 * Unset key or run id → `not_configured`, which the suite turns into `unavailable` for any
 * baseline metric that expects Okareo. Anything configured but broken fails closed here:
 * 401/403 → unauthenticated, no finished run in time → timeout, an unexpected body → malformed,
 * a failed run, errored datapoints, network or 5xx → unavailable. No automatic fallback.
 */

import type { EvaluatorFailure, MetricCategory, MetricObservation, SourceResult, SuiteSource } from './offlineSuite';

export const OKAREO_API_KEY_ENV = 'OKAREO_API_KEY';
export const OKAREO_BASE_URL_ENV = 'OKAREO_BASE_URL';
export const DEFAULT_OKAREO_BASE_URL = 'https://api.okareo.com';

/** A numeric check (Okareo scores are 1-5) passes at or above this unless the check says otherwise. */
export const DEFAULT_NUMERIC_PASS_AT = 4;

/** Okareo check name → eval-registry grader id. An unlisted check is reported under `okareo:<name>`,
 * which is not a registry grader, so it can never block. */
export const OKAREO_CHECK_GRADERS: Readonly<Record<string, string>> = {
  'emma-no_hallucinated_capabilities_v2': 'okareo-no-hallucinated-capabilities-v2',
};

/** Checks that judge security behaviour: never gated on an LLM judge (ENG-782). */
export const OKAREO_SECURITY_CHECKS: ReadonlySet<string> = new Set<string>();

export interface OkareoConfig {
  apiKey: string;
  baseUrl: string;
  testRunId: string;
  /** Total time allowed for the run to finish and its datapoints to be read. */
  timeoutMs: number;
  pollIntervalMs: number;
  /** Per-check pass threshold for numeric checks. */
  numericPassAt?: Readonly<Record<string, number>>;
}

export class OkareoError extends Error {
  constructor(readonly failure: EvaluatorFailure, message: string) {
    super(message);
    this.name = 'OkareoError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Okareo config for a run, `not_configured` with the reason, or a malformed-config error. */
export function resolveOkareoConfig(
  env: NodeJS.ProcessEnv,
  opts: { testRunId?: string; timeoutMs?: number; pollIntervalMs?: number },
): { status: 'ok'; config: OkareoConfig } | { status: 'not_configured'; reason: string } {
  const apiKey = env[OKAREO_API_KEY_ENV]?.trim();
  if (!apiKey) return { status: 'not_configured', reason: `${OKAREO_API_KEY_ENV} is not set (OPS-6, ENG-2151)` };
  if (!opts.testRunId) return { status: 'not_configured', reason: 'no Okareo test run id given (--okareo-run)' };
  if (!UUID.test(opts.testRunId)) throw new OkareoError('malformed', `Okareo test run id must be a UUID, got "${opts.testRunId}"`);
  const baseUrl = (env[OKAREO_BASE_URL_ENV]?.trim() || DEFAULT_OKAREO_BASE_URL).replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new OkareoError('malformed', `${OKAREO_BASE_URL_ENV} is not a URL`);
  }
  if (parsed.protocol !== 'https:') throw new OkareoError('malformed', `${OKAREO_BASE_URL_ENV} must be https`);
  return {
    status: 'ok',
    config: { apiKey, baseUrl, testRunId: opts.testRunId, timeoutMs: opts.timeoutMs ?? 10 * 60 * 1000, pollIntervalMs: opts.pollIntervalMs ?? 15_000 },
  };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Runtime {
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  clock: () => number;
}

async function request(rt: Runtime, config: OkareoConfig, path: string, deadline: number, body?: unknown): Promise<unknown> {
  const remaining = deadline - rt.clock();
  if (remaining <= 0) throw new OkareoError('timeout', `Okareo did not answer within ${Math.round(config.timeoutMs / 1000)}s`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await rt.fetchImpl(`${config.baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'api-key': config.apiKey, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new OkareoError('timeout', `Okareo request ${path} timed out`);
    throw new OkareoError('unavailable', `Okareo request ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) {
    throw new OkareoError('unauthenticated', `Okareo rejected the API key (HTTP ${response.status}); check ${OKAREO_API_KEY_ENV} (OPS-6, ENG-2151)`);
  }
  if (!response.ok) throw new OkareoError('unavailable', `Okareo ${path} returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new OkareoError('malformed', `Okareo ${path} returned a body that is not JSON`);
  }
}

const FINISHED = /^(finished|complete|completed|succeeded|success)$/i;
const FAILED = /(fail|error|cancel|abort)/i;

async function waitForRun(rt: Runtime, config: OkareoConfig, deadline: number): Promise<void> {
  const path = `/v0/test_runs/${encodeURIComponent(config.testRunId)}`;
  for (;;) {
    const run = await request(rt, config, path, deadline);
    if (!isRecord(run) || typeof run.id !== 'string') throw new OkareoError('malformed', 'Okareo test run response has no id');
    const status = typeof run.status === 'string' ? run.status : '';
    if (FINISHED.test(status)) return;
    if (FAILED.test(status)) {
      const why = typeof run.failure_message === 'string' && run.failure_message ? `: ${run.failure_message}` : '';
      throw new OkareoError('unavailable', `Okareo test run ${config.testRunId} ended ${status}${why}`);
    }
    if (rt.clock() + config.pollIntervalMs >= deadline) {
      throw new OkareoError('timeout', `Okareo test run ${config.testRunId} still ${status || 'without a status'} after ${Math.round(config.timeoutMs / 1000)}s`);
    }
    await rt.sleep(config.pollIntervalMs);
  }
}

interface CheckTally {
  /** Okareo check id: a redefined check gets a new id, so it is the check's version. */
  checkId: string;
  n: number;
  passes: number;
  failures: string[];
}

/** Pure: Okareo datapoints → pass counts per check. Throws OkareoError on errored or malformed rows. */
export function tallyOkareoChecks(dataPoints: unknown, numericPassAt: Readonly<Record<string, number>> = {}): Map<string, CheckTally> {
  if (!Array.isArray(dataPoints)) throw new OkareoError('malformed', 'Okareo datapoints response is not an array');
  if (dataPoints.length === 0) throw new OkareoError('malformed', 'Okareo test run has no datapoints');
  const errored = dataPoints.filter((p) => isRecord(p) && (p.error_code || p.error_message));
  if (errored.length > 0) {
    throw new OkareoError('unavailable', `${errored.length} of ${dataPoints.length} Okareo datapoints errored; a partial run is not a result`);
  }
  const tallies = new Map<string, CheckTally>();
  for (const [index, point] of dataPoints.entries()) {
    if (!isRecord(point) || !Array.isArray(point.check_values)) throw new OkareoError('malformed', `Okareo datapoint ${index} has no check_values`);
    const pointId = typeof point.id === 'string' ? point.id : `#${index}`;
    for (const cv of point.check_values) {
      if (!isRecord(cv) || typeof cv.name !== 'string' || !cv.name) throw new OkareoError('malformed', `Okareo datapoint ${pointId} has a check without a name`);
      let passed: boolean;
      if (typeof cv.is_issue === 'boolean') passed = !cv.is_issue;
      else if (typeof cv.value === 'boolean') passed = cv.value;
      else if (typeof cv.value === 'number' && Number.isFinite(cv.value)) passed = cv.value >= (numericPassAt[cv.name] ?? DEFAULT_NUMERIC_PASS_AT);
      else throw new OkareoError('malformed', `Okareo check ${cv.name} on datapoint ${pointId} has no boolean or numeric value`);
      if (typeof cv.check_id !== 'string' || !cv.check_id) throw new OkareoError('malformed', `Okareo check ${cv.name} on datapoint ${pointId} has no check_id`);
      const checkId = cv.check_id;
      const tally = tallies.get(cv.name) ?? { checkId, n: 0, passes: 0, failures: [] };
      if (tally.checkId !== checkId) throw new OkareoError('malformed', `Okareo check ${cv.name} appears with two check ids in one run`);
      tally.n++;
      if (passed) tally.passes++;
      else tally.failures.push(pointId);
      tallies.set(cv.name, tally);
    }
  }
  if (tallies.size === 0) throw new OkareoError('malformed', 'Okareo test run has no check values');
  return tallies;
}

export function okareoObservations(tallies: ReadonlyMap<string, CheckTally>): MetricObservation[] {
  return [...tallies.entries()].map(([check, t]) => {
    const graderId = OKAREO_CHECK_GRADERS[check] ?? `okareo:${check}`;
    const category: MetricCategory = OKAREO_SECURITY_CHECKS.has(check) ? 'security' : 'quality';
    return {
      metricId: `okareo:${check}`,
      graderId,
      graderVersion: t.checkId,
      kind: 'probabilistic',
      category,
      n: t.n,
      passes: t.passes,
      placeholder: false,
      failures: t.failures,
    };
  });
}

export function okareoSource(opts: {
  env?: NodeJS.ProcessEnv;
  testRunId?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}): SuiteSource {
  return {
    id: 'okareo',
    async run(): Promise<SourceResult> {
      try {
        const resolved = resolveOkareoConfig(opts.env ?? process.env, opts);
        if (resolved.status === 'not_configured') return { source: 'okareo', status: 'not_configured', reason: resolved.reason };
        const { config } = resolved;
        const rt: Runtime = {
          fetchImpl: opts.fetchImpl ?? fetch,
          sleep: opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
          clock: opts.clock ?? Date.now,
        };
        const deadline = rt.clock() + config.timeoutMs;
        await waitForRun(rt, config, deadline);
        const points = await request(rt, config, '/v0/find_test_data_points', deadline, { test_run_id: config.testRunId, full_data_point: true });
        const observations = okareoObservations(tallyOkareoChecks(points, config.numericPassAt));
        return { source: 'okareo', status: 'ok', observations, notes: [`test run ${config.testRunId}`] };
      } catch (error) {
        if (error instanceof OkareoError) return { source: 'okareo', status: 'failed', failure: error.failure, message: error.message };
        return { source: 'okareo', status: 'failed', failure: 'unavailable', message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
