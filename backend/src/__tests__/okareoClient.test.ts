/**
 * ENG-2145 / ENG-782 AC5: the Okareo source reads a finished staging run and fails closed —
 * unauthenticated, timed out, malformed or failed runs never yield a result. Fake HTTP only.
 */
import {
  OkareoError,
  okareoSource,
  resolveOkareoConfig,
  tallyOkareoChecks,
} from '../loops/eval/okareoClient';
import { runOfflineSuite, type SourceResult } from '../loops/eval/offlineSuite';

const RUN_ID = '9aba310b-77d2-4834-8f89-bb604fa5dd53';
const CHECK_ID = 'b2c81d35-3f07-489f-bf23-0405f66962e8';
const ENV = { OKAREO_API_KEY: 'test-key' } as NodeJS.ProcessEnv;

interface Reply {
  status: number;
  body?: unknown;
  notJson?: boolean;
}

function fakeFetch(routes: Record<string, Reply | Reply[] | Error>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const impl = jest.fn(async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, ...init });
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) throw new Error(`unexpected ${path}`);
    if (route instanceof Error) throw route;
    const reply = Array.isArray(route) ? (route.length > 1 ? route.shift() as Reply : route[0]) : route;
    return {
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      json: async () => {
        if (reply.notJson) throw new SyntaxError('Unexpected token <');
        return reply.body;
      },
    };
  });
  return { impl, calls };
}

const point = (id: string, checks: Array<{ name: string; value: number | boolean; is_issue?: boolean }>) => ({
  id,
  test_run_id: RUN_ID,
  check_values: checks.map((c) => ({ ...c, value_type: typeof c.value === 'boolean' ? 'bool' : 'float', check_id: CHECK_ID })),
});

const RUN_PATH = `/v0/test_runs/${RUN_ID}`;
const POINTS_PATH = '/v0/find_test_data_points';

function source(routes: Record<string, Reply | Reply[] | Error>, opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  const fetch = fakeFetch(routes);
  let now = 0;
  const s = okareoSource({
    env: opts.env ?? ENV,
    testRunId: RUN_ID,
    timeoutMs: opts.timeoutMs ?? 60_000,
    pollIntervalMs: 10_000,
    fetchImpl: fetch.impl,
    clock: () => now,
    sleep: async (ms) => { now += ms; },
  });
  return { s, fetch };
}

describe('Okareo source', () => {
  it('reads a finished run and counts passes per check with the check id as its version', async () => {
    const { s, fetch } = source({
      [RUN_PATH]: { status: 201, body: { id: RUN_ID, project_id: 'p', status: 'FINISHED' } },
      [POINTS_PATH]: {
        status: 201,
        body: [
          point('dp1', [{ name: 'emma-no_hallucinated_capabilities_v2', value: true }, { name: 'emma-actionable_response', value: 5 }]),
          point('dp2', [{ name: 'emma-no_hallucinated_capabilities_v2', value: false }, { name: 'emma-actionable_response', value: 3.5 }]),
        ],
      },
    });
    const result = await s.run();
    expect(result.status).toBe('ok');
    const obs = (result as Extract<SourceResult, { status: 'ok' }>).observations;
    expect(obs).toEqual([
      expect.objectContaining({ metricId: 'okareo:emma-no_hallucinated_capabilities_v2', graderId: 'okareo-no-hallucinated-capabilities-v2', graderVersion: CHECK_ID, n: 2, passes: 1, failures: ['dp2'], kind: 'probabilistic' }),
      expect.objectContaining({ metricId: 'okareo:emma-actionable_response', graderId: 'okareo:emma-actionable_response', n: 2, passes: 1 }),
    ]);
    expect(fetch.calls[0].headers['api-key']).toBe('test-key');
    expect(JSON.parse(fetch.calls[1].body as string)).toEqual({ test_run_id: RUN_ID, full_data_point: true });
  });

  it('polls a running test run until it finishes', async () => {
    const { s, fetch } = source({
      [RUN_PATH]: [{ status: 201, body: { id: RUN_ID, status: 'RUNNING' } }, { status: 201, body: { id: RUN_ID, status: 'FINISHED' } }],
      [POINTS_PATH]: { status: 201, body: [point('dp1', [{ name: 'c', value: true }])] },
    });
    expect((await s.run()).status).toBe('ok');
    expect(fetch.calls.filter((c) => c.url.endsWith(RUN_PATH))).toHaveLength(2);
  });

  it.each<[string, Record<string, Reply | Reply[] | Error>, string]>([
    ['unauthenticated on 401', { [RUN_PATH]: { status: 401, body: { detail: 'bad key' } } }, 'unauthenticated'],
    ['unauthenticated on 403', { [RUN_PATH]: { status: 403 } }, 'unauthenticated'],
    ['unavailable on 5xx', { [RUN_PATH]: { status: 503 } }, 'unavailable'],
    ['unavailable on a network error', { [RUN_PATH]: new Error('ECONNRESET') }, 'unavailable'],
    ['unavailable when the run failed', { [RUN_PATH]: { status: 201, body: { id: RUN_ID, status: 'FAILED', failure_message: 'target 500' } } }, 'unavailable'],
    ['malformed on a non-JSON body', { [RUN_PATH]: { status: 201, notJson: true } }, 'malformed'],
    ['malformed when the run has no id', { [RUN_PATH]: { status: 201, body: { status: 'FINISHED' } } }, 'malformed'],
    ['timeout when the run never finishes', { [RUN_PATH]: { status: 201, body: { id: RUN_ID, status: 'RUNNING' } } }, 'timeout'],
    ['unavailable when datapoints errored', {
      [RUN_PATH]: { status: 201, body: { id: RUN_ID, status: 'FINISHED' } },
      [POINTS_PATH]: { status: 201, body: [point('dp1', [{ name: 'c', value: true }]), { id: 'dp2', error_code: 'TIMEOUT', check_values: [] }] },
    }, 'unavailable'],
    ['malformed when a check has no value', {
      [RUN_PATH]: { status: 201, body: { id: RUN_ID, status: 'FINISHED' } },
      [POINTS_PATH]: { status: 201, body: [{ id: 'dp1', check_values: [{ name: 'c', value: 'yes', check_id: CHECK_ID }] }] },
    }, 'malformed'],
    ['malformed on an empty run', {
      [RUN_PATH]: { status: 201, body: { id: RUN_ID, status: 'FINISHED' } },
      [POINTS_PATH]: { status: 201, body: [] },
    }, 'malformed'],
  ])('fails closed: %s', async (_label, routes, failure) => {
    const result = await source(routes, { timeoutMs: 30_000 }).s.run();
    expect(result).toMatchObject({ source: 'okareo', status: 'failed', failure });
  });

  it('reports not_configured without a key or a run id, and refuses a malformed run id or base URL', () => {
    expect(resolveOkareoConfig({}, { testRunId: RUN_ID })).toMatchObject({ status: 'not_configured', reason: expect.stringContaining('ENG-2151') });
    expect(resolveOkareoConfig(ENV, {})).toMatchObject({ status: 'not_configured' });
    expect(() => resolveOkareoConfig(ENV, { testRunId: 'latest' })).toThrow(OkareoError);
    expect(() => resolveOkareoConfig({ ...ENV, OKAREO_BASE_URL: 'http://api.okareo.com' }, { testRunId: RUN_ID })).toThrow('must be https');
  });

  it('turns a missing key into an unavailable verdict when the baseline expects Okareo metrics', async () => {
    const result = await runOfflineSuite({
      baseline: {
        schemaVersion: 1, baselineId: 'staging-okareo-v1', suiteVersion: 1, createdAt: '2026-09-25T00:00:00.000Z', target: 'staging', source: 'test',
        metrics: [{ metricId: 'okareo:c', graderId: 'okareo:c', graderVersion: CHECK_ID, kind: 'probabilistic', category: 'quality', n: 40, passes: 38, threshold: 0.05, minN: 32, placeholder: false }],
      },
      baselineFile: 'b.json',
      target: 'staging',
      sources: [okareoSource({ env: {}, testRunId: RUN_ID })],
      gate: { blockingFlag: false },
    });
    expect(result.verdict).toBe('unavailable');
    expect(result.unavailable.join('\n')).toContain('OKAREO_API_KEY is not set');
  });

  it('scores boolean, is_issue and numeric checks', () => {
    const tallies = tallyOkareoChecks([
      point('a', [{ name: 'bool', value: true }, { name: 'issue', value: true, is_issue: true }, { name: 'score', value: 4 }]),
      point('b', [{ name: 'bool', value: false }, { name: 'issue', value: false, is_issue: false }, { name: 'score', value: 3 }]),
    ], { score: 3 });
    expect([...tallies.entries()].map(([k, t]) => [k, t.passes, t.n])).toEqual([['bool', 1, 2], ['issue', 1, 2], ['score', 2, 2]]);
  });
});
