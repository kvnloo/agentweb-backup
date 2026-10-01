import {
  acquireZ0BridgeAdmission,
  clearZ0BridgeBackpressureStateForTests,
  getZ0BridgeBackpressureStateForTests,
  noteZ0BridgeTransportFailure,
  observeZ0BridgeResponse,
  parseZ0RetryAfterMs,
  releaseZ0BridgeAdmission,
  type Z0BridgeAdmissionToken,
} from '../emma/z0BridgeBackpressure';
import type {
  Z0BridgeCapabilitiesV1,
  Z0CapabilitiesFetchLike,
} from '../emma/z0BridgeCapabilities';

const capabilities: Z0BridgeCapabilitiesV1 = {
  schema: 'agentweb.z0.bridge.capabilities.v1',
  bridge_protocol_versions: ['agentweb.z0.bridge.v1'],
  transport: {
    max_request_bytes: 40000,
    max_active: 2,
    socket_backlog: 8,
    overload_status: 503,
    retry_after_seconds: 1,
    queue_policy: 'reject_excess',
    overload_execution: 'not_started',
    overload_execution_header: 'X-Z0-Execution',
  },
  active_dispatch_supported: true,
  receipt_schemas: ['z0int.decision_receipt.v1'],
  endpoints: [
    {
      path: '/v1/intelligence',
      kind: 'dispatch',
      modes: ['active'],
      capability_source: 'payload.function',
      physical_execution: true,
      free_only: 'caller_explicit',
    },
    {
      path: '/v1/plan',
      kind: 'plan',
      modes: ['shadow'],
      capability_source: 'payload.function',
      physical_execution: false,
      free_only: 'caller_explicit',
    },
  ],
};

function capabilityFetch(
  value: Z0BridgeCapabilitiesV1 = capabilities,
): Z0CapabilitiesFetchLike {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => value,
  })) as unknown as Z0CapabilitiesFetchLike;
}

function headers(values: Record<string, string>) {
  const normalized = new Map(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    get(name: string) {
      return normalized.get(name.toLowerCase()) ?? null;
    },
  };
}

async function admit(
  fetchImpl: Z0CapabilitiesFetchLike,
  now: () => number = () => 1_000,
) {
  return acquireZ0BridgeAdmission({
    baseUrl: 'http://z0.test',
    mode: 'active',
    kind: 'dispatch',
    capability: 'summarization',
    freeOnly: true,
    requestBytes: 1000,
    fetchImpl,
    now,
  });
}

describe('z0 bridge backpressure and circuit breaker', () => {
  beforeEach(() => clearZ0BridgeBackpressureStateForTests());

  it('enforces advertised max_active with no local queue', async () => {
    const fetchImpl = capabilityFetch();
    const first = await admit(fetchImpl);
    const second = await admit(fetchImpl);
    const third = await admit(fetchImpl);

    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(true);
    expect(third).toMatchObject({
      admitted: false,
      reason: 'local_backpressure',
      retryAfterMs: 1000,
    });
    expect((fetchImpl as unknown as jest.Mock)).toHaveBeenCalledTimes(1);

    releaseZ0BridgeAdmission(first.admitted ? first.token : null);
    const fourth = await admit(fetchImpl);
    expect(fourth.admitted).toBe(true);

    releaseZ0BridgeAdmission(second.admitted ? second.token : null);
    releaseZ0BridgeAdmission(fourth.admitted ? fourth.token : null);
    expect(getZ0BridgeBackpressureStateForTests('http://z0.test').inFlight).toBe(0);
  });

  it('opens immediately on proven pre-execution overload and honors Retry-After', async () => {
    let nowMs = 10_000;
    const fetchImpl = capabilityFetch();
    const first = await admit(fetchImpl, () => nowMs);
    expect(first.admitted).toBe(true);
    if (!first.admitted) throw new Error('expected admission');

    expect(observeZ0BridgeResponse(first.token, {
      ok: false,
      status: 503,
      headers: headers({
        'Retry-After': '2',
        'X-Z0-Execution': 'not_started',
      }),
    }, () => nowMs)).toEqual({
      kind: 'pre_execution_overload',
      retryAfterMs: 2000,
    });
    releaseZ0BridgeAdmission(first.token);

    nowMs += 100;
    const blocked = await admit(fetchImpl, () => nowMs);
    expect(blocked).toMatchObject({
      admitted: false,
      reason: 'circuit_open',
      retryAfterMs: 1900,
    });

    nowMs += 2000;
    const recovered = await admit(fetchImpl, () => nowMs);
    expect(recovered.admitted).toBe(true);
    releaseZ0BridgeAdmission(recovered.admitted ? recovered.token : null);
  });

  it('does not trust an unproven 503 as pre-execution', async () => {
    const fetchImpl = capabilityFetch();
    const first = await admit(fetchImpl);
    expect(first.admitted).toBe(true);
    if (!first.admitted) throw new Error('expected admission');

    expect(observeZ0BridgeResponse(first.token, {
      ok: false,
      status: 503,
      headers: headers({ 'Retry-After': '1' }),
    })).toMatchObject({
      kind: 'ambiguous_failure',
      circuitOpened: false,
    });
    releaseZ0BridgeAdmission(first.token);
  });

  it('opens after repeated ambiguous transport failures without retrying them itself', async () => {
    const fetchImpl = capabilityFetch();

    for (let index = 0; index < 3; index += 1) {
      const admitted = await admit(fetchImpl);
      expect(admitted.admitted).toBe(true);
      if (!admitted.admitted) throw new Error('expected admission');

      const result = noteZ0BridgeTransportFailure(admitted.token, () => 1000);
      releaseZ0BridgeAdmission(admitted.token);
      expect(result.circuitOpened).toBe(index === 2);
    }

    const blocked = await admit(fetchImpl, () => 1001);
    expect(blocked).toMatchObject({
      admitted: false,
      reason: 'circuit_open',
    });
  });

  it('opens a short circuit when capability discovery fails to prevent discovery storms', async () => {
    let nowMs = 5000;
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })) as unknown as Z0CapabilitiesFetchLike;

    const first = await admit(fetchImpl, () => nowMs);
    expect(first).toMatchObject({
      admitted: false,
      reason: 'capability_unavailable',
      retryAfterMs: 1000,
    });

    nowMs += 10;
    const second = await admit(fetchImpl, () => nowMs);
    expect(second).toMatchObject({
      admitted: false,
      reason: 'circuit_open',
    });
    expect((fetchImpl as unknown as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it('rejects requests above advertised max_request_bytes before route transport', async () => {
    const fetchImpl = capabilityFetch();
    const result = await acquireZ0BridgeAdmission({
      baseUrl: 'http://z0.test',
      mode: 'active',
      kind: 'dispatch',
      capability: 'summarization',
      freeOnly: true,
      requestBytes: 40001,
      fetchImpl,
      now: () => 1000,
    });
    expect(result).toMatchObject({
      admitted: false,
      reason: 'request_too_large',
    });
  });

  it('parses Retry-After seconds and dates with a bounded maximum', () => {
    expect(parseZ0RetryAfterMs('2', 1000, 1000)).toBe(2000);
    expect(parseZ0RetryAfterMs(
      new Date(6000).toUTCString(),
      1000,
      1000,
    )).toBe(5000);
    expect(parseZ0RetryAfterMs('999999', 1000, 1000)).toBe(30000);
    expect(parseZ0RetryAfterMs('invalid', 1000, 750)).toBe(750);
  });

  it('release is idempotent', async () => {
    const fetchImpl = capabilityFetch();
    const result = await admit(fetchImpl);
    expect(result.admitted).toBe(true);
    if (!result.admitted) throw new Error('expected admission');
    const token: Z0BridgeAdmissionToken = result.token;

    releaseZ0BridgeAdmission(token);
    releaseZ0BridgeAdmission(token);
    expect(getZ0BridgeBackpressureStateForTests('http://z0.test').inFlight).toBe(0);
  });
});
