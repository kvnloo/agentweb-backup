/**
 * Credential-free evidence provenance projection for AgentWeb -> z0 context packing.
 *
 * AgentWeb owns retrieval, raw connector identity, URLs, credentials, and source
 * metadata. The wire format contains only pseudonymous identities, retrieval
 * time, content digest, bounded content, source kind, and declared need IDs.
 */
import { createHash } from 'crypto';

export type Z0EvidenceSourceKind =
  | 'public-knowledge-base'
  | 'private-knowledge-base'
  | 'google-drive'
  | 'clickup'
  | 'clickup-tasks'
  | 'unknown';

export interface Z0EvidenceSourceInput {
  rawSourceId: string;
  rawLocator?: string;
  sourceKind: Z0EvidenceSourceKind;
  retrievedAt: string;
  content: string;
  needIds: readonly string[];
  metadata?: unknown;
}

export interface Z0ProjectedEvidenceSource {
  source_id: string;
  source_version: string;
  locator: string;
  content: string;
  need_ids: string[];
  source_kind: Z0EvidenceSourceKind;
  retrieved_at: string;
  content_sha256: string;
}

export interface Z0ContextNeed {
  id: string;
  description: string;
  required?: boolean;
}

export interface Z0EvidenceContextPackInput {
  traceId: string;
  parentAgent: string;
  taskId: string;
  needs: readonly Z0ContextNeed[];
  evidence: readonly Z0EvidenceSourceInput[];
  scanIncomplete?: boolean;
  maxPacketBytes?: number;
}

export interface Z0EvidenceContextPackRequest {
  harness: 'agentweb';
  trace_id: string;
  parent_agent: string;
  task_id: string;
  needs: Array<{ id: string; description: string; required: boolean }>;
  evidence: Z0ProjectedEvidenceSource[];
  scan_incomplete: boolean;
  max_packet_bytes?: number;
}

export type Z0EvidenceFetchLike = typeof fetch;
export type Z0EvidenceExportMode = 'off' | 'shadow';

const SOURCE_KINDS = new Set<Z0EvidenceSourceKind>([
  'public-knowledge-base',
  'private-knowledge-base',
  'google-drive',
  'clickup',
  'clickup-tasks',
  'unknown',
]);
const PARENT_RE = /^agentweb:[a-f0-9]{24}$/;
const MAX_CONTENT_CHARS = 5000;
const MAX_EVIDENCE = 20;
const MAX_METADATA_DEPTH = 12;
const MAX_METADATA_NODES = 4096;
const DEFAULT_TIMEOUT_MS = 1500;

const FORBIDDEN_METADATA_KEYS = new Set([
  'userid',
  'accountid',
  'sessionid',
  'apikey',
  'oauthtoken',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'bearertoken',
  'authorization',
  'cookie',
  'password',
  'clientsecret',
  'privatekey',
  'secretkey',
  'credential',
  'credentials',
]);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseInstant(value: string, name: string): number {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw new Error(`${name} must be a bounded ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a valid ISO timestamp`);
  if (!/[zZ]|[+-]\d\d:\d\d$/.test(value)) {
    throw new Error(`${name} must be timezone-aware`);
  }
  return parsed;
}

export function validateLocalEvidenceMetadata(metadata: unknown): string[] {
  if (metadata === undefined) return [];

  const errors: string[] = [];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let stopped = false;

  const visit = (value: unknown, path: string, depth: number): void => {
    if (stopped) return;

    nodes += 1;
    if (nodes > MAX_METADATA_NODES) {
      errors.push(`metadata exceeds max node count ${MAX_METADATA_NODES}`);
      stopped = true;
      return;
    }
    if (depth > MAX_METADATA_DEPTH) {
      errors.push(`metadata exceeds max depth ${MAX_METADATA_DEPTH}`);
      stopped = true;
      return;
    }
    if (!value || typeof value !== 'object') return;

    const objectValue = value as object;
    if (seen.has(objectValue)) {
      errors.push('metadata must be acyclic');
      stopped = true;
      return;
    }
    seen.add(objectValue);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
      return;
    }

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_METADATA_KEYS.has(normalizeKey(key))) {
        errors.push(`forbidden local metadata field at ${path}.${key}: ${key}`);
      }
      visit(entry, `${path}.${key}`, depth + 1);
      if (stopped) return;
    }
  };

  visit(metadata, 'metadata', 0);
  return errors;
}

function validateNeedIds(needIds: readonly string[]): string[] {
  if (!Array.isArray(needIds) || needIds.length < 1 || needIds.length > 16) {
    throw new Error('needIds must contain 1..16 ids');
  }
  const normalized = needIds.map(id => {
    if (typeof id !== 'string' || id.trim().length === 0 || id.length > 120) {
      throw new Error('needIds must contain bounded nonempty strings');
    }
    return id;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('needIds must be unique');
  }
  return [...normalized];
}

export function projectEvidenceSourceToZ0(
  input: Z0EvidenceSourceInput,
): Z0ProjectedEvidenceSource {
  if (
    typeof input.rawSourceId !== 'string' ||
    input.rawSourceId.trim().length === 0 ||
    input.rawSourceId.length > 4000
  ) {
    throw new Error('rawSourceId is invalid');
  }
  if (
    input.rawLocator !== undefined &&
    (
      typeof input.rawLocator !== 'string' ||
      input.rawLocator.trim().length === 0 ||
      input.rawLocator.length > 8000
    )
  ) {
    throw new Error('rawLocator is invalid');
  }
  if (!SOURCE_KINDS.has(input.sourceKind)) {
    throw new Error('sourceKind is invalid');
  }
  parseInstant(input.retrievedAt, 'retrievedAt');
  if (
    typeof input.content !== 'string' ||
    input.content.trim().length === 0 ||
    input.content.length > MAX_CONTENT_CHARS
  ) {
    throw new Error(`content must be 1..${MAX_CONTENT_CHARS} chars`);
  }

  const metadataErrors = validateLocalEvidenceMetadata(input.metadata);
  if (metadataErrors.length) {
    throw new Error(`evidence metadata isolation failed: ${metadataErrors.join('; ')}`);
  }

  const needIds = validateNeedIds(input.needIds);
  const contentDigest = sha256(input.content);
  const sourceDigest = sha256(
    JSON.stringify({
      source_kind: input.sourceKind,
      raw_source_id: input.rawSourceId,
    }),
  );
  const locatorDigest = sha256(
    JSON.stringify({
      source_kind: input.sourceKind,
      raw_locator: input.rawLocator ?? input.rawSourceId,
    }),
  );

  return {
    source_id: `agentweb-kb:${sourceDigest}`,
    source_version: `sha256:${contentDigest}`,
    locator: `agentweb-kb://${locatorDigest}`,
    content: input.content,
    need_ids: needIds,
    source_kind: input.sourceKind,
    retrieved_at: input.retrievedAt,
    content_sha256: contentDigest,
  };
}

export function projectEvidenceContextPackToZ0(
  input: Z0EvidenceContextPackInput,
): Z0EvidenceContextPackRequest {
  if (
    typeof input.traceId !== 'string' ||
    input.traceId.trim().length === 0 ||
    input.traceId.length > 200
  ) {
    throw new Error('traceId is invalid');
  }
  if (!PARENT_RE.test(input.parentAgent)) {
    throw new Error('parentAgent must already be pseudonymous');
  }
  if (
    typeof input.taskId !== 'string' ||
    input.taskId.trim().length === 0 ||
    input.taskId.length > 200
  ) {
    throw new Error('taskId is invalid');
  }
  if (!Array.isArray(input.needs) || input.needs.length < 1 || input.needs.length > 16) {
    throw new Error('needs must contain 1..16 items');
  }

  const needs = input.needs.map(need => {
    if (
      typeof need.id !== 'string' ||
      need.id.trim().length === 0 ||
      need.id.length > 120
    ) {
      throw new Error('need.id is invalid');
    }
    if (
      typeof need.description !== 'string' ||
      need.description.trim().length === 0 ||
      need.description.length > 1000
    ) {
      throw new Error('need.description is invalid');
    }
    if (need.required !== undefined && typeof need.required !== 'boolean') {
      throw new Error('need.required must be boolean');
    }
    return {
      id: need.id,
      description: need.description,
      required: need.required ?? true,
    };
  });
  if (new Set(needs.map(need => need.id)).size !== needs.length) {
    throw new Error('need ids must be unique');
  }

  if (
    !Array.isArray(input.evidence) ||
    input.evidence.length > MAX_EVIDENCE
  ) {
    throw new Error(`evidence must contain at most ${MAX_EVIDENCE} items`);
  }

  const evidence = input.evidence.map(projectEvidenceSourceToZ0);
  const needSet = new Set(needs.map(need => need.id));
  for (const source of evidence) {
    if (source.need_ids.some(id => !needSet.has(id))) {
      throw new Error('evidence needIds must reference declared needs');
    }
  }

  if (
    input.maxPacketBytes !== undefined &&
    (
      !Number.isInteger(input.maxPacketBytes) ||
      input.maxPacketBytes < 4096 ||
      input.maxPacketBytes > 12000
    )
  ) {
    throw new Error('maxPacketBytes must be an integer from 4096 to 12000');
  }

  return {
    harness: 'agentweb',
    trace_id: input.traceId,
    parent_agent: input.parentAgent,
    task_id: input.taskId,
    needs,
    evidence,
    scan_incomplete: input.scanIncomplete ?? false,
    ...(input.maxPacketBytes !== undefined
      ? { max_packet_bytes: input.maxPacketBytes }
      : {}),
  };
}

export function readZ0EvidenceExportMode(
  env: NodeJS.ProcessEnv = process.env,
): Z0EvidenceExportMode {
  return (env.Z0INT_AGENTWEB_CONTEXT_PACK ?? '').trim().toLowerCase() === 'shadow'
    ? 'shadow'
    : 'off';
}

export async function exportEvidenceContextPackToZ0Safe(
  input: Z0EvidenceContextPackInput,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: Z0EvidenceFetchLike;
  } = {},
): Promise<{
  exported: boolean;
  reason: string;
  packet?: unknown;
}> {
  const env = options.env ?? process.env;
  if (readZ0EvidenceExportMode(env) === 'off') {
    return { exported: false, reason: 'disabled' };
  }

  let request: Z0EvidenceContextPackRequest;
  try {
    request = projectEvidenceContextPackToZ0(input);
  } catch (error) {
    return {
      exported: false,
      reason: error instanceof Error
        ? `validation_error:${error.message}`
        : 'validation_error',
    };
  }

  const baseUrl = (env.Z0INT_SERVICE_URL ?? 'http://127.0.0.1:11501').replace(/\/+$/, '');
  const timeoutRaw = Number.parseInt(env.Z0INT_AGENTWEB_CONTEXT_TIMEOUT_MS ?? '', 10);
  const timeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0 && timeoutRaw <= 5000
      ? timeoutRaw
      : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${baseUrl}/v1/context/pack`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      return { exported: false, reason: `http_${response.status}` };
    }
    const payload = (await response.json()) as any;
    if (
      !payload ||
      payload.ok !== true ||
      payload.mode !== 'shadow' ||
      payload.applied !== false ||
      !payload.packet
    ) {
      return { exported: false, reason: 'invalid_response' };
    }
    return {
      exported: true,
      reason: 'packed',
      packet: payload.packet,
    };
  } catch (error) {
    return {
      exported: false,
      reason: error instanceof Error && error.name === 'AbortError'
        ? 'timeout'
        : 'transport_error',
    };
  } finally {
    clearTimeout(timer);
  }
}
