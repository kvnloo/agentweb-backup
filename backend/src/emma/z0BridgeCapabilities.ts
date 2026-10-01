import { Z0_BRIDGE_SCHEMA_V1, type Z0BridgeKind, type Z0BridgeMode } from './z0BridgeProtocol';

export const Z0_BRIDGE_CAPABILITIES_SCHEMA_V1 =
  'agentweb.z0.bridge.capabilities.v1' as const;

export interface Z0BridgeCapabilityEndpointV1 {
  path: string;
  kind: Z0BridgeKind;
  modes: Z0BridgeMode[];
  capability_source?: 'payload.function';
  capabilities?: string[];
  physical_execution: boolean;
  free_only: boolean | 'caller_explicit';
  experimental?: boolean;
}

export interface Z0BridgeCapabilitiesV1 {
  schema: typeof Z0_BRIDGE_CAPABILITIES_SCHEMA_V1;
  bridge_protocol_versions: string[];
  transport: {
    max_request_bytes: number;
    max_active: number;
    socket_backlog: number;
    overload_status: number;
    retry_after_seconds: number;
  };
  active_dispatch_supported: boolean;
  receipt_schemas: string[];
  endpoints: Z0BridgeCapabilityEndpointV1[];
}

export type Z0CapabilitiesFetchLike = typeof fetch;

export interface Z0BridgeCapabilitiesOptions {
  baseUrl: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  fetchImpl?: Z0CapabilitiesFetchLike;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 1000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const cache = new Map<string, { expiresAt: number; value: Z0BridgeCapabilitiesV1 }>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateZ0BridgeCapabilitiesV1(value: unknown): string[] {
  if (!isRecord(value)) return ['capabilities must be an object'];
  const errors: string[] = [];

  if (value.schema !== Z0_BRIDGE_CAPABILITIES_SCHEMA_V1) {
    errors.push(`schema must be ${Z0_BRIDGE_CAPABILITIES_SCHEMA_V1}`);
  }

  if (
    !Array.isArray(value.bridge_protocol_versions) ||
    !value.bridge_protocol_versions.includes(Z0_BRIDGE_SCHEMA_V1)
  ) {
    errors.push(`bridge_protocol_versions must include ${Z0_BRIDGE_SCHEMA_V1}`);
  }

  if (!isRecord(value.transport)) {
    errors.push('transport must be an object');
  } else {
    for (const field of [
      'max_request_bytes',
      'max_active',
      'socket_backlog',
      'overload_status',
      'retry_after_seconds',
    ] as const) {
      const v = value.transport[field];
      if (!Number.isInteger(v) || (v as number) < 0) {
        errors.push(`transport.${field} must be a non-negative integer`);
      }
    }
    if (
      Number.isInteger(value.transport.max_request_bytes) &&
      (value.transport.max_request_bytes as number) < 1024
    ) {
      errors.push('transport.max_request_bytes is implausibly small');
    }
  }

  if (typeof value.active_dispatch_supported !== 'boolean') {
    errors.push('active_dispatch_supported must be boolean');
  }

  if (
    !Array.isArray(value.receipt_schemas) ||
    !value.receipt_schemas.every(v => typeof v === 'string')
  ) {
    errors.push('receipt_schemas must be a string array');
  }

  if (!Array.isArray(value.endpoints) || value.endpoints.length === 0) {
    errors.push('endpoints must be a non-empty array');
  } else {
    value.endpoints.forEach((row, index) => {
      if (!isRecord(row)) {
        errors.push(`endpoints[${index}] must be an object`);
        return;
      }
      if (typeof row.path !== 'string' || !row.path.startsWith('/v1/')) {
        errors.push(`endpoints[${index}].path is invalid`);
      }
      if (!['plan', 'decide', 'dispatch', 'observe'].includes(String(row.kind))) {
        errors.push(`endpoints[${index}].kind is invalid`);
      }
      if (
        !Array.isArray(row.modes) ||
        row.modes.length === 0 ||
        !row.modes.every(v => v === 'shadow' || v === 'active')
      ) {
        errors.push(`endpoints[${index}].modes is invalid`);
      }
      if (typeof row.physical_execution !== 'boolean') {
        errors.push(`endpoints[${index}].physical_execution must be boolean`);
      }
      if (
        row.free_only !== true &&
        row.free_only !== false &&
        row.free_only !== 'caller_explicit'
      ) {
        errors.push(`endpoints[${index}].free_only is invalid`);
      }
      if (
        row.capabilities !== undefined &&
        (!Array.isArray(row.capabilities) ||
          !row.capabilities.every(v => typeof v === 'string' && v.length > 0))
      ) {
        errors.push(`endpoints[${index}].capabilities is invalid`);
      }
      if (
        row.capability_source !== undefined &&
        row.capability_source !== 'payload.function'
      ) {
        errors.push(`endpoints[${index}].capability_source is invalid`);
      }
    });
  }

  return errors;
}

export function z0BridgeCapabilitySupported(
  capabilities: Z0BridgeCapabilitiesV1,
  request: {
    kind: Z0BridgeKind;
    mode: Z0BridgeMode;
    capability: string;
    freeOnly: boolean;
  },
): boolean {
  if (!capabilities.bridge_protocol_versions.includes(Z0_BRIDGE_SCHEMA_V1)) return false;
  if (request.kind === 'dispatch' && request.mode === 'active' && !capabilities.active_dispatch_supported) {
    return false;
  }

  return capabilities.endpoints.some(endpoint => {
    if (endpoint.kind !== request.kind || !endpoint.modes.includes(request.mode)) return false;
    if (endpoint.free_only === true && request.freeOnly !== true) return false;
    if (endpoint.free_only === false && request.freeOnly !== false) return false;

    if (endpoint.capabilities) {
      return endpoint.capabilities.includes(request.capability);
    }
    return endpoint.capability_source === 'payload.function' && request.capability.length > 0;
  });
}

export async function getZ0BridgeCapabilities(
  options: Z0BridgeCapabilitiesOptions,
): Promise<Z0BridgeCapabilitiesV1> {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('baseUrl is required');

  const now = options.now ?? Date.now;
  const cached = cache.get(baseUrl);
  const currentTime = now();
  if (cached && cached.expiresAt > currentTime) return cached.value;

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) throw new Error('cacheTtlMs must be non-negative');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${baseUrl}/v1/bridge/capabilities`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`z0 bridge capability negotiation returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    const errors = validateZ0BridgeCapabilitiesV1(payload);
    if (errors.length) {
      throw new Error(`invalid z0 bridge capabilities: ${errors.join('; ')}`);
    }

    const value = payload as Z0BridgeCapabilitiesV1;
    cache.set(baseUrl, { expiresAt: currentTime + cacheTtlMs, value });
    return value;
  } finally {
    clearTimeout(timer);
  }
}

export function clearZ0BridgeCapabilitiesCacheForTests(): void {
  cache.clear();
}
