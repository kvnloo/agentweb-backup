import {
  exportVerifiedEventBatchToZ0Safe,
  projectVerifiedEventBatchToZ0,
  type Z0VerifiedExternalEventInput,
} from '../services/z0VerifiedEventBatch';
import type { Z0OutcomeFetchLike } from '../services/z0OutcomeObservation';

const base: Z0VerifiedExternalEventInput = {
  provider: 'example-provider',
  externalEventId: 'evt-provider-secret-123',
  eventType: 'analytics.updated',
  eventTime: '2026-09-02T12:00:00Z',
  receivedAt: '2026-09-02T12:00:01Z',
  subjectId: 'raw-customer-verified-event',
  verification: {
    verified: true,
    scheme: 'hmac-sha256',
    verifiedAt: '2026-09-02T12:00:01Z',
  },
  payload: {
    customer: {
      id: 'raw-customer-verified-event',
      authorization: 'Bearer SECRET-RAW-TOKEN',
    },
    metrics: { conversion_rate: 0.16 },
  },
  outcomes: [
    {
      decisionTraceId: 'a'.repeat(64),
      decisionTime: '2026-09-01T12:00:00Z',
      executionTime: '2026-09-01T12:00:05Z',
      observationTime: '2026-09-01T13:00:00Z',
      window: '1h',
      subjectId: 'raw-customer-verified-event',
      metric: {
        source: 'agentweb.analytics',
        name: 'conversion_rate',
        value: 0.12,
        unit: 'ratio',
        direction: 'higher_better',
      },
    },
    {
      decisionTraceId: 'a'.repeat(64),
      decisionTime: '2026-09-01T12:00:00Z',
      executionTime: '2026-09-01T12:00:05Z',
      observationTime: '2026-09-02T12:00:00Z',
      window: '24h',
      subjectId: 'raw-customer-verified-event',
      metric: {
        source: 'agentweb.analytics',
        name: 'conversion_rate',
        value: 0.16,
        unit: 'ratio',
        direction: 'higher_better',
      },
    },
  ],
};

function response(payload: unknown, status = 200): Z0OutcomeFetchLike {
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })) as unknown as Z0OutcomeFetchLike;
}

describe('z0 verified external event batching', () => {
  it('hashes raw event identity and payload locally', () => {
    const projected = projectVerifiedEventBatchToZ0(base);
    const serialized = JSON.stringify(projected);

    expect(projected.event_id).toMatch(/^agentweb-event-[a-f0-9]{64}$/);
    expect(projected.payload_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(projected.subject_ref).toMatch(/^agentweb-subject:[a-f0-9]{24}$/);
    expect(projected.projections).toHaveLength(2);
    expect(projected.quality_authoritative).toBe(false);

    expect(serialized).not.toContain('evt-provider-secret-123');
    expect(serialized).not.toContain('Bearer SECRET-RAW-TOKEN');
    expect(serialized).not.toContain('raw-customer-verified-event');
  });

  it('canonicalizes payload key order before hashing', () => {
    const first = projectVerifiedEventBatchToZ0({
      ...base,
      payload: { alpha: 1, nested: { x: true, y: false } },
    });
    const second = projectVerifiedEventBatchToZ0({
      ...base,
      payload: { nested: { y: false, x: true }, alpha: 1 },
    });
    expect(second.event_id).toBe(first.event_id);
    expect(second.payload_sha256).toBe(first.payload_sha256);
  });

  it('preserves event identity while changed payload changes the batch digest', () => {
    const first = projectVerifiedEventBatchToZ0(base);
    const changed = projectVerifiedEventBatchToZ0({
      ...base,
      payload: {
        ...(base.payload as Record<string, unknown>),
        changed: true,
      },
    });
    expect(changed.event_id).toBe(first.event_id);
    expect(changed.payload_sha256).not.toBe(first.payload_sha256);
  });

  it('rejects unverified events before transport', async () => {
    const fetchImpl = jest.fn() as unknown as Z0OutcomeFetchLike;
    const result = await exportVerifiedEventBatchToZ0Safe({
      ...base,
      verification: {
        ...base.verification,
        verified: false,
      },
    }, {
      env: { Z0INT_AGENTWEB_EVENT_FORWARD: 'shadow' } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    expect(result.exported).toBe(false);
    expect(result.reason).toMatch(/^validation_error:/);
    expect(result.reason).toMatch(/already be signature-verified/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is default-off', async () => {
    const fetchImpl = jest.fn() as unknown as Z0OutcomeFetchLike;
    expect(await exportVerifiedEventBatchToZ0Safe(base, {
      env: {} as NodeJS.ProcessEnv,
      fetchImpl,
    })).toEqual({ exported: false, reason: 'disabled' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('exports replay metadata without raw provider material', async () => {
    const projected = projectVerifiedEventBatchToZ0(base);
    const fetchImpl = response({
      ok: true,
      event_id: projected.event_id,
      replayed: true,
      fanout_count: 2,
      projection_results: [],
    });

    const result = await exportVerifiedEventBatchToZ0Safe(base, {
      env: {
        Z0INT_AGENTWEB_EVENT_FORWARD: 'shadow',
        Z0INT_SERVICE_URL: 'http://z0.test/',
      } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    expect(result).toEqual({
      exported: true,
      reason: 'replayed',
      event_id: projected.event_id,
      replayed: true,
      fanout_count: 2,
    });

    const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0];
    expect(url).toBe('http://z0.test/v1/observe/event-batch');
    const body = String(init.body);
    expect(body).not.toContain('evt-provider-secret-123');
    expect(body).not.toContain('Bearer SECRET-RAW-TOKEN');
    expect(body).not.toContain('raw-customer-verified-event');
  });

  it('rejects cyclic raw payloads locally', () => {
    const payload: Record<string, unknown> = {};
    payload.self = payload;
    expect(() => projectVerifiedEventBatchToZ0({
      ...base,
      payload,
    })).toThrow(/acyclic/);
  });
});
