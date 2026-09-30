import { buildReliabilityEvent } from '../services/reliabilityEvent';
import {
  exportReliabilityEventToZ0Safe,
  getZ0ReliabilityExporterInFlightForTests,
  type Z0ReliabilityFetchLike,
} from '../services/z0ReliabilityExporter';

function response(payload: unknown, status = 200): Z0ReliabilityFetchLike {
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })) as unknown as Z0ReliabilityFetchLike;
}

describe('z0 reliability exporter', () => {
  it('is off by default and performs no network call', async () => {
    const fetchImpl = jest.fn() as unknown as Z0ReliabilityFetchLike;
    const result = await exportReliabilityEventToZ0Safe(
      buildReliabilityEvent({ tool: 'ask_crm', outcome: 'success', latencyMs: 4 }),
      { env: {} as NodeJS.ProcessEnv, fetchImpl },
    );
    expect(result).toEqual({ exported: false, reason: 'disabled' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('exports only the privacy-minimized projection', async () => {
    const fetchImpl = response({
      ok: true,
      receipt_id: 'agentweb-observe-' + 'a'.repeat(64),
      replayed: false,
    });
    const event = buildReliabilityEvent({
      tool: 'ask_crm',
      outcome: 'error',
      latencyMs: 12,
      sessionId: 'raw-session-secret',
      userId: 'raw-user-secret',
      errorSummary: 'sensitive downstream error',
      platform: 'emma_live',
    });

    const result = await exportReliabilityEventToZ0Safe(event, {
      env: {
        Z0INT_AGENTWEB_OBSERVE: 'shadow',
        Z0INT_SERVICE_URL: 'http://z0.test',
      } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    expect(result).toMatchObject({ exported: true, reason: 'stored', replayed: false });
    const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0];
    expect(url).toBe('http://z0.test/v1/observe/reliability');
    const serialized = init.body as string;
    expect(serialized).not.toContain('raw-session-secret');
    expect(serialized).not.toContain('raw-user-secret');
    expect(serialized).not.toContain('sensitive downstream error');
    const body = JSON.parse(serialized);
    expect(body.session_id).toMatch(/^agentweb:[a-f0-9]{24}$/);
    expect(body.measurement_state).toBe('partial');
    expect(body.execution).toBe('log_only');
    expect(body.outcome.verified_success).toBeUndefined();
    expect(getZ0ReliabilityExporterInFlightForTests()).toBe(0);
  });

  it('fails open on transport errors', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('offline');
    }) as unknown as Z0ReliabilityFetchLike;
    const result = await exportReliabilityEventToZ0Safe(
      buildReliabilityEvent({ tool: 'search', outcome: 'success', latencyMs: 1 }),
      {
        env: { Z0INT_AGENTWEB_OBSERVE: 'shadow' } as NodeJS.ProcessEnv,
        fetchImpl,
      },
    );
    expect(result).toEqual({ exported: false, reason: 'transport_error' });
    expect(getZ0ReliabilityExporterInFlightForTests()).toBe(0);
  });
});
