import {
  clearZ0BridgeCapabilitiesCacheForTests,
  getZ0BridgeCapabilities,
  type Z0BridgeCapabilitiesV1,
  type Z0CapabilitiesFetchLike,
} from './z0BridgeCapabilities';

export type Z0DeploymentMode = 'off' | 'sidecar';

export interface Z0SidecarProfileV1 {
  schema: 'agentweb.z0.sidecar_profile.v1';
  deployment_mode: 'local_sidecar';
  transport: 'http';
  default_bind: '127.0.0.1';
  default_port: number;
  loopback_hosts: string[];
  public_wildcard_supported: false;
  tls_mode: 'none_loopback';
  mtls_gateway_supported: false;
  graceful_drain_supported: true;
  paths: {
    health: '/healthz';
    ready: '/readyz';
    capabilities: '/v1/bridge/capabilities';
    deployment_profile: '/v1/bridge/deployment-profile';
  };
  process: {
    entrypoint: string;
    default_args: string[];
  };
  limits: {
    max_active: number;
    socket_backlog: number;
    overload_status: number;
    overload_execution: 'not_started';
    overload_execution_header: 'X-Z0-Execution';
  };
  credentials_required: false;
}

export interface Z0SidecarReadyV1 {
  ok: true;
  authority_protocol_version: number;
  scope: string;
  max_active: number;
  socket_backlog: number;
  queue_policy: 'reject_excess';
  overload_execution: 'not_started';
  overload_execution_header: 'X-Z0-Execution';
}

export interface Z0SidecarHandshakeResult {
  ok: true;
  baseUrl: string;
  profile: Z0SidecarProfileV1;
  capabilities: Z0BridgeCapabilitiesV1;
  ready: Z0SidecarReadyV1;
}

const startupCache = new Map<string, Promise<Z0SidecarHandshakeResult>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHost(hostname: string): string {
  const lower = hostname.trim().toLowerCase();
  return lower.startsWith('[') && lower.endsWith(']')
    ? lower.slice(1, -1)
    : lower;
}

export function parseZ0DeploymentMode(
  raw: string | undefined,
): Z0DeploymentMode {
  return (raw ?? '').trim().toLowerCase() === 'sidecar' ? 'sidecar' : 'off';
}

export function normalizeZ0SidecarBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('sidecar base URL is invalid');
  }

  if (parsed.protocol !== 'http:') {
    throw new Error('sidecar mode requires plain HTTP on loopback');
  }
  if (parsed.username || parsed.password) {
    throw new Error('sidecar URL must not contain credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('sidecar URL must not contain query or fragment');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('sidecar URL must be an origin without a path');
  }

  const host = normalizeHost(parsed.hostname);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('sidecar mode requires loopback host');
  }

  return parsed.origin.replace(/\/+$/, '');
}

export function validateZ0SidecarProfileV1(value: unknown): string[] {
  if (!isRecord(value)) return ['sidecar profile must be an object'];
  const errors: string[] = [];

  if (value.schema !== 'agentweb.z0.sidecar_profile.v1') {
    errors.push('invalid sidecar profile schema');
  }
  if (value.deployment_mode !== 'local_sidecar') {
    errors.push('deployment_mode must be local_sidecar');
  }
  if (value.transport !== 'http') {
    errors.push('transport must be http');
  }
  if (value.default_bind !== '127.0.0.1') {
    errors.push('default_bind must be 127.0.0.1');
  }
  if (!Number.isInteger(value.default_port) || Number(value.default_port) < 1 || Number(value.default_port) > 65535) {
    errors.push('default_port is invalid');
  }
  const loopbackHosts = value.loopback_hosts;
  if (
    !Array.isArray(loopbackHosts) ||
    !['127.0.0.1', 'localhost', '::1'].every(host => loopbackHosts.includes(host))
  ) {
    errors.push('loopback_hosts must include 127.0.0.1, localhost, and ::1');
  }
  if (value.public_wildcard_supported !== false) {
    errors.push('public_wildcard_supported must be false');
  }
  if (value.tls_mode !== 'none_loopback') {
    errors.push('tls_mode must be none_loopback');
  }
  if (value.mtls_gateway_supported !== false) {
    errors.push('mtls_gateway_supported must be false in v1');
  }
  if (value.graceful_drain_supported !== true) {
    errors.push('graceful_drain_supported must be true');
  }
  if (value.credentials_required !== false) {
    errors.push('credentials_required must be false');
  }

  if (!isRecord(value.paths)) {
    errors.push('paths must be an object');
  } else {
    const expected = {
      health: '/healthz',
      ready: '/readyz',
      capabilities: '/v1/bridge/capabilities',
      deployment_profile: '/v1/bridge/deployment-profile',
    } as const;
    for (const [key, path] of Object.entries(expected)) {
      if (value.paths[key] !== path) errors.push(`paths.${key} must be ${path}`);
    }
  }

  if (!isRecord(value.process)) {
    errors.push('process must be an object');
  } else {
    if (value.process.entrypoint !== 'python -m z0int.intelligence_service') {
      errors.push('process.entrypoint is invalid');
    }
    if (
      !Array.isArray(value.process.default_args) ||
      !value.process.default_args.every(arg => typeof arg === 'string')
    ) {
      errors.push('process.default_args must be a string array');
    }
  }

  if (!isRecord(value.limits)) {
    errors.push('limits must be an object');
  } else {
    for (const field of ['max_active', 'socket_backlog', 'overload_status'] as const) {
      if (!Number.isInteger(value.limits[field]) || Number(value.limits[field]) < 1) {
        errors.push(`limits.${field} is invalid`);
      }
    }
    if (value.limits.overload_execution !== 'not_started') {
      errors.push('limits.overload_execution must be not_started');
    }
    if (value.limits.overload_execution_header !== 'X-Z0-Execution') {
      errors.push('limits.overload_execution_header must be X-Z0-Execution');
    }
  }

  return errors;
}

function validateReady(value: unknown): asserts value is Z0SidecarReadyV1 {
  if (!isRecord(value) || value.ok !== true) {
    throw new Error('z0 sidecar is not ready');
  }
  if (value.draining === true) {
    throw new Error('z0 sidecar is draining');
  }
  if (!Number.isInteger(value.max_active) || !Number.isInteger(value.socket_backlog)) {
    throw new Error('z0 readyz is missing capacity fields');
  }
  if (value.queue_policy !== 'reject_excess') {
    throw new Error('z0 readyz queue policy mismatch');
  }
  if (value.overload_execution !== 'not_started') {
    throw new Error('z0 readyz overload execution mismatch');
  }
  if (value.overload_execution_header !== 'X-Z0-Execution') {
    throw new Error('z0 readyz overload proof header mismatch');
  }
}

/** Do not let a checked loopback origin redirect a handshake or execution. */
export function withZ0SidecarRedirectGuard(
  fetchImpl: Z0CapabilitiesFetchLike,
): Z0CapabilitiesFetchLike {
  return (input, init) => fetchImpl(input, { ...init, redirect: 'error' });
}

async function fetchJson(
  fetchImpl: Z0CapabilitiesFetchLike,
  url: string,
  timeoutMs: number,
): Promise<{ status: number; ok: boolean; value: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    let value: unknown = null;
    try {
      value = await response.json();
    } catch {
      value = null;
    }
    return { status: response.status, ok: response.ok, value };
  } finally {
    clearTimeout(timer);
  }
}

async function performHandshake(options: {
  baseUrl: string;
  fetchImpl?: Z0CapabilitiesFetchLike;
  timeoutMs?: number;
}): Promise<Z0SidecarHandshakeResult> {
  const baseUrl = normalizeZ0SidecarBaseUrl(options.baseUrl);
  const fetchImpl = withZ0SidecarRedirectGuard(options.fetchImpl ?? fetch);
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 1000, 100), 5000);

  const [profileResponse, healthResponse, readyResponse, capabilities] = await Promise.all([
    fetchJson(fetchImpl, `${baseUrl}/v1/bridge/deployment-profile`, timeoutMs),
    fetchJson(fetchImpl, `${baseUrl}/healthz`, timeoutMs),
    fetchJson(fetchImpl, `${baseUrl}/readyz`, timeoutMs),
    getZ0BridgeCapabilities({
      baseUrl,
      fetchImpl,
      timeoutMs,
      cacheTtlMs: 60_000,
    }),
  ]);

  if (!profileResponse.ok) {
    throw new Error(`z0 sidecar deployment profile returned HTTP ${profileResponse.status}`);
  }
  const profileErrors = validateZ0SidecarProfileV1(profileResponse.value);
  if (profileErrors.length) {
    throw new Error(`invalid z0 sidecar profile: ${profileErrors.join('; ')}`);
  }
  const profile = profileResponse.value as Z0SidecarProfileV1;

  if (!healthResponse.ok || !isRecord(healthResponse.value) || healthResponse.value.ok !== true) {
    throw new Error('z0 sidecar health check failed');
  }

  if (!readyResponse.ok) {
    if (isRecord(readyResponse.value) && readyResponse.value.draining === true) {
      throw new Error('z0 sidecar is draining');
    }
    throw new Error(`z0 sidecar readiness returned HTTP ${readyResponse.status}`);
  }
  validateReady(readyResponse.value);
  const ready = readyResponse.value as Z0SidecarReadyV1;

  if (
    profile.limits.max_active !== capabilities.transport.max_active ||
    profile.limits.max_active !== ready.max_active
  ) {
    throw new Error('sidecar max_active mismatch across profile/capabilities/readyz');
  }
  if (
    profile.limits.socket_backlog !== capabilities.transport.socket_backlog ||
    profile.limits.socket_backlog !== ready.socket_backlog
  ) {
    throw new Error('sidecar socket_backlog mismatch across profile/capabilities/readyz');
  }
  if (profile.limits.overload_status !== capabilities.transport.overload_status) {
    throw new Error('sidecar overload_status mismatch');
  }
  if (
    profile.limits.overload_execution !== capabilities.transport.overload_execution ||
    profile.limits.overload_execution !== ready.overload_execution
  ) {
    throw new Error('sidecar overload execution mismatch');
  }
  if (
    profile.limits.overload_execution_header !== capabilities.transport.overload_execution_header ||
    profile.limits.overload_execution_header !== ready.overload_execution_header
  ) {
    throw new Error('sidecar overload proof header mismatch');
  }

  return {
    ok: true,
    baseUrl,
    profile,
    capabilities,
    ready,
  };
}

export async function ensureZ0SidecarReady(options: {
  baseUrl: string;
  fetchImpl?: Z0CapabilitiesFetchLike;
  timeoutMs?: number;
}): Promise<Z0SidecarHandshakeResult> {
  const key = normalizeZ0SidecarBaseUrl(options.baseUrl);
  const existing = startupCache.get(key);
  if (existing) return existing;

  const pending = performHandshake({
    ...options,
    baseUrl: key,
  }).catch(error => {
    startupCache.delete(key);
    throw error;
  });
  startupCache.set(key, pending);
  return pending;
}

export function clearZ0SidecarStartupCacheForTests(): void {
  startupCache.clear();
  clearZ0BridgeCapabilitiesCacheForTests();
}

export function getZ0SidecarStartupCacheSizeForTests(): number {
  return startupCache.size;
}
