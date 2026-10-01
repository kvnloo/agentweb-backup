import {
  clearZ0SidecarStartupCacheForTests,
  ensureZ0SidecarReady,
  getZ0SidecarStartupCacheSizeForTests,
  normalizeZ0SidecarBaseUrl,
  parseZ0DeploymentMode,
  validateZ0SidecarProfileV1,
} from '../emma/z0SidecarDeployment';
import type { Z0CapabilitiesFetchLike } from '../emma/z0BridgeCapabilities';

const profile = {
  schema: 'agentweb.z0.sidecar_profile.v1',
  deployment_mode: 'local_sidecar',
  transport: 'http',
  default_bind: '127.0.0.1',
  default_port: 11501,
  loopback_hosts: ['127.0.0.1', 'localhost', '::1'],
  public_wildcard_supported: false,
  tls_mode: 'none_loopback',
  mtls_gateway_supported: false,
  graceful_drain_supported: true,
  paths: {
    health: '/healthz',
    ready: '/readyz',
    capabilities: '/v1/bridge/capabilities',
    deployment_profile: '/v1/bridge/deployment-profile',
  },
  process: {
    entrypoint: 'python -m z0int.intelligence_service',
    default_args: ['--bind', '127.0.0.1', '--port', '11501'],
  },
  limits: {
    max_active: 4,
    socket_backlog: 8,
    overload_status: 503,
    overload_execution: 'not_started',
    overload_execution_header: 'X-Z0-Execution',
  },
  credentials_required: false,
};

const capabilities = {
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
  endpoints: [{
    path: '/v1/plan',
    kind: 'plan',
    modes: ['shadow'],
    capability_source: 'payload.function',
    physical_execution: false,
    free_only: 'caller_explicit',
  }],
};

const ready = {
  ok: true,
  authority_protocol_version: 2,
  scope: 'dispatch ready; model availability checked on call',
  max_active: 4,
  socket_backlog: 8,
  queue_policy: 'reject_excess',
  overload_execution: 'not_started',
  overload_execution_header: 'X-Z0-Execution',
};

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fixtureFetch(overrides: Partial<{
  profile: unknown;
  health: unknown;
  healthStatus: number;
  ready: unknown;
  readyStatus: number;
  capabilities: unknown;
}> = {}): Z0CapabilitiesFetchLike {
  return jest.fn(async (url: string | URL | Request) => {
    const text = String(url);
    if (text.endsWith('/v1/bridge/deployment-profile')) {
      return response(overrides.profile ?? profile);
    }
    if (text.endsWith('/healthz')) {
      return response(overrides.health ?? { ok: true }, overrides.healthStatus ?? 200);
    }
    if (text.endsWith('/readyz')) {
      return response(overrides.ready ?? ready, overrides.readyStatus ?? 200);
    }
    if (text.endsWith('/v1/bridge/capabilities')) {
      return response(overrides.capabilities ?? capabilities);
    }
    return response({ error: 'not_found' }, 404);
  }) as unknown as Z0CapabilitiesFetchLike;
}

describe('z0 sidecar deployment handshake', () => {
  beforeEach(() => clearZ0SidecarStartupCacheForTests());

  it.each([
    'http://127.0.0.1:11501',
    'http://localhost:11501/',
    'http://[::1]:11501',
  ])('accepts loopback URL %s', value => {
    expect(normalizeZ0SidecarBaseUrl(value)).toMatch(/^http:/);
  });

  it.each([
    'https://127.0.0.1:11501',
    'http://10.0.0.8:11501',
    'http://0.0.0.0:11501',
    'http://example.com:11501',
    'http://user:pass@127.0.0.1:11501',
    'http://127.0.0.1:11501/path',
  ])('rejects non-sidecar URL %s', value => {
    expect(() => normalizeZ0SidecarBaseUrl(value)).toThrow();
  });

  it('parses deployment mode conservatively', () => {
    expect(parseZ0DeploymentMode('sidecar')).toBe('sidecar');
    expect(parseZ0DeploymentMode('SIDECAR')).toBe('sidecar');
    expect(parseZ0DeploymentMode('remote')).toBe('off');
    expect(parseZ0DeploymentMode(undefined)).toBe('off');
  });

  it('validates the current static profile', () => {
    expect(validateZ0SidecarProfileV1(profile)).toEqual([]);
  });

  it('performs one successful handshake and caches it', async () => {
    const fetchImpl = fixtureFetch() as unknown as jest.Mock;
    const first = await ensureZ0SidecarReady({
      baseUrl: 'http://127.0.0.1:11501',
      fetchImpl: fetchImpl as unknown as Z0CapabilitiesFetchLike,
    });
    const second = await ensureZ0SidecarReady({
      baseUrl: 'http://127.0.0.1:11501/',
      fetchImpl: fetchImpl as unknown as Z0CapabilitiesFetchLike,
    });

    expect(first.ok).toBe(true);
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(getZ0SidecarStartupCacheSizeForTests()).toBe(1);
  });

  it('rejects non-loopback before transport', async () => {
    const fetchImpl = fixtureFetch() as unknown as jest.Mock;
    await expect(ensureZ0SidecarReady({
      baseUrl: 'http://10.0.0.8:11501',
      fetchImpl: fetchImpl as unknown as Z0CapabilitiesFetchLike,
    })).rejects.toThrow(/loopback/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects draining readiness and does not cache failure', async () => {
    const fetchImpl = fixtureFetch({
      ready: { ok: false, draining: true },
      readyStatus: 503,
    });
    await expect(ensureZ0SidecarReady({
      baseUrl: 'http://127.0.0.1:11501',
      fetchImpl,
    })).rejects.toThrow(/draining/);
    expect(getZ0SidecarStartupCacheSizeForTests()).toBe(0);
  });

  it('rejects limit mismatch across profile and capabilities', async () => {
    const fetchImpl = fixtureFetch({
      capabilities: {
        ...capabilities,
        transport: {
          ...capabilities.transport,
          max_active: 3,
        },
      },
    });
    await expect(ensureZ0SidecarReady({
      baseUrl: 'http://127.0.0.1:11501',
      fetchImpl,
    })).rejects.toThrow(/max_active mismatch/);
  });
});
