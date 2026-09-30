import crypto from 'crypto';
import { pseudonymousAgentWebParent, readZ0AgentWebConfig, type Z0FetchLike } from '../emma/z0Adapter';

export type Z0ContextPacketMode = 'off' | 'shadow';

export interface AgentWebKnowledgeSearchResult {
  success: boolean;
  query?: string;
  results?: Array<{
    content?: unknown;
    source?: unknown;
    fileName?: unknown;
  }>;
  returnedResults?: number;
  hasMore?: boolean;
  scanIncomplete?: boolean;
}

export interface Z0ContextPacketOptions {
  scopeId: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: Z0FetchLike;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function readZ0ContextPacketMode(
  env: NodeJS.ProcessEnv = process.env,
): Z0ContextPacketMode {
  return (env.Z0_CONTEXT_PACKET_SHADOW ?? '').trim().toLowerCase() === 'shadow'
    ? 'shadow'
    : 'off';
}

function sourceKind(source: string): string {
  if (source === 'public-knowledge-base') return 'public-knowledge-base';
  if (source === 'private-knowledge-base') return 'private-knowledge-base';
  if (source.startsWith('google-drive/')) return 'google-drive';
  if (source.startsWith('clickup-tasks/')) return 'clickup-tasks';
  if (source.startsWith('clickup/')) return 'clickup';
  return 'unknown';
}

function maxPacketBytes(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(env.Z0INT_CONTEXT_PACKET_MAX_BYTES ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 4096 && parsed <= 12000
    ? parsed
    : 6000;
}

export function buildZ0ContextPacketRequest(
  query: string,
  search: AgentWebKnowledgeSearchResult,
  scopeId: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!query.trim()) throw new Error('query is required');
  const parentAgent = pseudonymousAgentWebParent(scopeId);
  const rows = Array.isArray(search.results) ? search.results : [];
  const evidence = rows
    .filter(row => typeof row.content === 'string' && row.content.trim().length > 0)
    .slice(0, 20)
    .map(row => {
      const content = String(row.content).slice(0, 5000);
      const source = typeof row.source === 'string' ? row.source : 'unknown';
      const fileName = typeof row.fileName === 'string' ? row.fileName : '';
      const sourceDigest = sha256(`${source}\0${fileName}`);
      const contentDigest = sha256(content);
      return {
        source_id: `agentweb-kb:${sourceDigest}`,
        source_version: `sha256:${contentDigest}`,
        locator: `agentweb-kb://${sourceDigest}`,
        content,
        need_ids: ['q0'],
        source_kind: sourceKind(source),
      };
    });

  const traceId = sha256(
    `${parentAgent}\0context-pack\0${sha256(query)}\0` +
    evidence.map(row => row.source_version).join('|'),
  );
  return {
    harness: 'agentweb',
    trace_id: traceId,
    parent_agent: parentAgent,
    task_id: `agentweb-kb-${sha256(query).slice(0, 24)}`,
    needs: [
      {
        id: 'q0',
        description: query.slice(0, 1000),
        required: true,
      },
    ],
    evidence,
    scan_incomplete: search.scanIncomplete === true || search.hasMore === true,
    max_packet_bytes: maxPacketBytes(env),
  };
}

export async function runZ0ContextPacketShadow(
  query: string,
  search: AgentWebKnowledgeSearchResult,
  options: Z0ContextPacketOptions,
): Promise<any> {
  const env = options.env ?? process.env;
  if (readZ0ContextPacketMode(env) === 'off') {
    return { ok: false, skipped: true, applied: false, reason: 'disabled' };
  }
  if (env.Z0INT_CONTEXT_PACKET_ALLOW !== '1') {
    return {
      ok: false,
      skipped: true,
      applied: false,
      reason: 'context_boundary_not_authorized',
    };
  }
  if (!search?.success) {
    return {
      ok: false,
      skipped: true,
      applied: false,
      reason: 'search_failed',
    };
  }

  let request: ReturnType<typeof buildZ0ContextPacketRequest>;
  try {
    request = buildZ0ContextPacketRequest(query, search, options.scopeId, env);
  } catch (error) {
    return {
      ok: false,
      skipped: true,
      applied: false,
      reason: 'validation_error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const config = readZ0AgentWebConfig(env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, 3000));
  try {
    const response = await fetchImpl(`${config.baseUrl}/v1/context/pack`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        skipped: true,
        applied: false,
        reason: `http_${response.status}`,
      };
    }
    const payload = await response.json() as any;
    if (!payload || payload.ok !== true || !payload.packet) {
      return {
        ok: false,
        skipped: true,
        applied: false,
        reason: 'invalid_response',
      };
    }
    return {
      ...payload,
      applied: false,
      trace_id: request.trace_id,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: true,
      applied: false,
      reason: error instanceof Error && error.name === 'AbortError'
        ? 'timeout'
        : 'transport_error',
    };
  } finally {
    clearTimeout(timer);
  }
}

export function logZ0ContextPacketShadow(result: any): void {
  if (!result?.ok || !result?.packet) {
    console.log(JSON.stringify({
      event: 'z0_context_packet_shadow',
      ok: false,
      reason: result?.reason ?? 'unknown',
    }));
    return;
  }
  const packet = result.packet;
  const measurements = packet.measurements ?? {};
  console.log(JSON.stringify({
    event: 'z0_context_packet_shadow',
    ok: true,
    traceId: result.trace_id ?? null,
    applied: result.applied === true,
    schema: packet.schema ?? null,
    evidenceCount: Array.isArray(packet.evidence) ? packet.evidence.length : null,
    unresolvedGapCount: Array.isArray(packet.unresolved_gaps)
      ? packet.unresolved_gaps.length
      : null,
    inputContentBytes: measurements.input_content_bytes ?? null,
    packetBytes: measurements.packet_bytes ?? null,
    compressionRatio: measurements.compression_ratio ?? null,
    truncatedExcerpts: measurements.truncated_excerpts ?? null,
    scanIncomplete: measurements.scan_incomplete === true,
    networkModelCalls: measurements.network_model_calls ?? null,
    privateTextPersisted: measurements.private_text_persisted ?? null,
  }));
}

export function observeZ0ContextPacketShadow(
  query: string,
  search: AgentWebKnowledgeSearchResult,
  scopeId: string,
): void {
  if (readZ0ContextPacketMode() === 'off') return;
  void runZ0ContextPacketShadow(query, search, { scopeId }).then(
    logZ0ContextPacketShadow,
    () => logZ0ContextPacketShadow({ ok: false, reason: 'shadow_exception' }),
  );
}
