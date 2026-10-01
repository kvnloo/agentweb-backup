import {
  clearZ0BridgeCapabilitiesCacheForTests,
  getZ0BridgeCapabilities,
  validateZ0BridgeCapabilitiesV1,
  z0BridgeCapabilitySupported,
  type Z0BridgeCapabilitiesV1,
  type Z0CapabilitiesFetchLike,
} from '../emma/z0BridgeCapabilities';

const capabilities: Z0BridgeCapabilitiesV1 = {
  schema: 'agentweb.z0.bridge.capabilities.v1',
  bridge_protocol_versions: ['agentweb.z0.bridge.v1'],
  transport: {
    max_request_bytes: 40000,
    max_active: 4,
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
      path: '/v1/plan',
      kind: 'plan',
      modes: ['shadow'],
      capability_source: 'payload.function',
      physical_execution: false,
      free_only: 'caller_explicit',
    },
    {
      path: '/v1/intelligence',
      kind: 'dispatch',
      modes: ['active'],
      capability_source: 'payload.function',
      physical_execution: true,
      free_only: 'caller_explicit',
    },
    {
      path: '/v1/experimental/choice',
      kind: 'decide',
      modes: ['shadow'],
      capabilities: ['experiment.report_type_v1'],
      physical_execution: true,
      free_only: false,
      experimental: true,
    },
  ],
};

function response(payload: unknown, status = 200): Z0CapabilitiesFetchLike {
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })) as unknown as Z0CapabilitiesFetchLike;
}

describe('z0 bridge capability negotiation', () => {
  beforeEach(() => clearZ0BridgeCapabilitiesCacheForTests());

  it('validates the current capability document', () => {
    expect(validateZ0BridgeCapabilitiesV1(capabilities)).toEqual([]);
  });

  it('rejects a server that does not advertise bridge v1', () => {
    expect(validateZ0BridgeCapabilitiesV1({
      ...capabilities,
      bridge_protocol_versions: ['agentweb.z0.bridge.v2'],
    })).toContain(
      'bridge_protocol_versions must include agentweb.z0.bridge.v1',
    );
  });

  it('matches generic plan/dispatch and exact experimental capabilities', () => {
    expect(z0BridgeCapabilitySupported(capabilities, {
      kind: 'plan',
      mode: 'shadow',
      capability: 'summarization',
      freeOnly: true,
    })).toBe(true);

    expect(z0BridgeCapabilitySupported(capabilities, {
      kind: 'dispatch',
      mode: 'active',
      capability: 'research',
      freeOnly: true,
    })).toBe(true);

    expect(z0BridgeCapabilitySupported(capabilities, {
      kind: 'decide',
      mode: 'shadow',
      capability: 'experiment.report_type_v1',
      freeOnly: false,
    })).toBe(true);
  });

  it('does not silently route a paid decision through free-only policy', () => {
    expect(z0BridgeCapabilitySupported(capabilities, {
      kind: 'decide',
      mode: 'shadow',
      capability: 'experiment.report_type_v1',
      freeOnly: true,
    })).toBe(false);
  });

  it('caches a valid discovery response instead of preflighting every turn', async () => {
    let now = 1_000;
    const fetchImpl = response(capabilities) as unknown as jest.Mock;

    const first = await getZ0BridgeCapabilities({
      baseUrl: 'http://z0.test/',
      fetchImpl: fetchImpl as unknown as Z0CapabilitiesFetchLike,
      cacheTtlMs: 60_000,
      now: () => now,
    });
    now += 10_000;
    const second = await getZ0BridgeCapabilities({
      baseUrl: 'http://z0.test',
      fetchImpl: fetchImpl as unknown as Z0CapabilitiesFetchLike,
      cacheTtlMs: 60_000,
      now: () => now,
    });

    expect(first).toEqual(capabilities);
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://z0.test/v1/bridge/capabilities');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET' });
  });

  it('refreshes after the cache TTL', async () => {
    let now = 1_000;
    const fetchImpl = response(capabilities) as unknown as jest.Mock;

    await getZ0BridgeCapabilities({
      baseUrl: 'http://z0.test',
      fetchImpl: fetchImpl as unknown as Z0CapabilitiesFetchLike,
      cacheTtlMs: 100,
      now: () => now,
    });
    now += 101;
    await getZ0BridgeCapabilities({
      baseUrl: 'http://z0.test',
      fetchImpl: fetchImpl as unknown as Z0CapabilitiesFetchLike,
      cacheTtlMs: 100,
      now: () => now,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
