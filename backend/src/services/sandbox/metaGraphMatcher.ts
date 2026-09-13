import { isSandboxToken, sandboxTokenUserId } from './sentinel';
import type { GraphMethod, SimRequest } from './types';

/**
 * Decides whether an outbound Graph API request belongs to a sandbox principal (ENG-1908).
 *
 * Contract for real users: the hostname is checked first and anything that is not Meta's
 * Graph host returns `passthrough` before the body is looked at; every failure while
 * parsing a request that has NOT shown a sandbox token is also `passthrough` (fail open).
 * Contract for sandbox traffic: once a sandbox token has been seen, any failure is
 * `reject` — a sentinel must never reach the network (fail closed). Never throws.
 */
export interface GraphRequestInput {
  url: string;
  method?: string;
  headers?: Record<string, string | undefined>;
  contentType?: string;
  body?: unknown;
}

export type GraphClassification =
  | { kind: 'passthrough' }
  | { kind: 'simulate'; request: SimRequest }
  | { kind: 'reject'; reason: string };

const GRAPH_HOSTS = new Set(['graph.facebook.com', 'graph-video.facebook.com']);
const VERSIONED_PATH = /^\/(v\d+\.\d+)(?:\/(.*))?$/;
const TOKEN_PARAMS = ['access_token', 'fb_exchange_token', 'input_token'] as const;

/** Cheap synchronous gate used by the interceptor's fast path — no parsing beyond the URL. */
export function isGraphHost(url: string): boolean {
  try { return GRAPH_HOSTS.has(new URL(url).hostname); } catch { return false; }
}

/** Blob parts of a global FormData body, hydrated asynchronously by the interceptor. */
const pendingFiles = new WeakMap<SimRequest, Array<{ index: number; blob: Blob }>>();

export function classifyGraphRequest(input: GraphRequestInput): GraphClassification {
  let sawSandbox = false;
  try {
    let url: URL;
    try { url = new URL(input.url); } catch { return { kind: 'passthrough' }; }
    if (!GRAPH_HOSTS.has(url.hostname)) return { kind: 'passthrough' };

    const versioned = VERSIONED_PATH.exec(url.pathname);
    const version = versioned ? versioned[1] : 'unversioned';
    const rawPath = versioned ? (versioned[2] || '') : url.pathname.replace(/^\/+/, '');
    const path = rawPath.replace(/\/+$/, '');

    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => { query[key] = value; });
    const headers = lowerKeys(input.headers);
    const contentType = (input.contentType || headers['content-type'] || '').toLowerCase();

    // A single request can legally carry more than one token param at once — Meta's own
    // debug_token call sends a real app access_token alongside the input_token being
    // inspected. Taking whichever carrier/param is merely PRESENT first (the original
    // shape here) can pick the real token and short-circuit to passthrough while a
    // sandbox token sits unexamined in another param — the sentinel then reaches
    // graph.facebook.com for real, exactly the leak the fail-closed contract above rules
    // out. So every carrier is scanned for a sandbox token specifically before any
    // passthrough decision — only when NONE of them is a sandbox token do we pass through.
    //
    // 1. Query, 2. Authorization header — available without touching the body, so a
    // sandbox token found here flips `sawSandbox` BEFORE the body is parsed. That order
    // matters: parsing an attacker- or bug-malformed body can throw, and once a sandbox
    // token has been seen anywhere, a thrown parse error must reject (fail closed), not
    // silently fall through to passthrough because the throw happened before the body's
    // own tokens could be checked.
    const headerToken = bearer(headers.authorization);
    let token = sandboxTokenIn(query, headerToken ? { access_token: headerToken } : undefined);
    if (token !== undefined) sawSandbox = true;

    // 3. Body — parsed regardless of whether a token was already found in query/header,
    // because a sandbox token can ALSO ride in the body of a request whose query/header
    // carries a different, real token (the form-body variant of the same leak).
    const parsed = parseBody(input.body, contentType);
    if (token === undefined) {
      token = sandboxTokenIn(parsed?.form, parsed?.multipart?.fields, parsed?.jsonRecord);
      if (token !== undefined) sawSandbox = true;
    }
    if (token === undefined) return { kind: 'passthrough' };

    const userId = sandboxTokenUserId(token);
    if (!userId) return { kind: 'reject', reason: 'malformed sandbox token' };

    const request: SimRequest = {
      userId, token, method: normalizeMethod(input.method), version, path,
      query: stripTokens(query),
    };
    if (parsed?.form) request.form = stripTokens(parsed.form);
    if (parsed?.multipart) request.multipart = { fields: stripTokens(parsed.multipart.fields), files: parsed.multipart.files };
    if (parsed?.json !== undefined) request.json = parsed.jsonRecord ? stripTokens(parsed.jsonRecord) : parsed.json;
    if (parsed?.pending?.length) pendingFiles.set(request, parsed.pending);
    return { kind: 'simulate', request };
  } catch (error) {
    if (sawSandbox) return { kind: 'reject', reason: error instanceof Error ? error.message : 'unparseable sandbox request' };
    return { kind: 'passthrough' };
  }
}

/** Reads the bytes of FormData file parts recorded during classification. */
export async function hydrateMultipartFiles(request: SimRequest): Promise<void> {
  const pending = pendingFiles.get(request);
  if (!pending || !request.multipart) return;
  for (const { index, blob } of pending) {
    request.multipart.files[index].bytes = Buffer.from(await blob.arrayBuffer());
  }
  pendingFiles.delete(request);
}

function lowerKeys(headers?: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) if (typeof value === 'string') out[key.toLowerCase()] = value;
  return out;
}

function bearer(header?: string): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : undefined;
}

/**
 * Scans every candidate carrier — in the order the caller passes them — for a token param
 * that IS specifically a sandbox sentinel, returning the first one found. A carrier can
 * legally hold more than one token param (Meta's own `debug_token` call sends a real
 * `access_token` alongside the `input_token` under test); checking every param on every
 * carrier for sandbox-ness, rather than stopping at whichever param is merely present
 * first, is what keeps a sentinel sharing a request with a real token from slipping past
 * as passthrough (see the call site's comment).
 */
function sandboxTokenIn(...records: Array<Record<string, unknown> | undefined>): string | undefined {
  for (const record of records) {
    if (!record) continue;
    for (const key of TOKEN_PARAMS) {
      const value = record[key];
      if (typeof value === 'string' && value && isSandboxToken(value)) return value;
    }
  }
  return undefined;
}

function stripTokens<T extends Record<string, unknown>>(record: T): T {
  const copy: Record<string, unknown> = { ...record };
  for (const key of TOKEN_PARAMS) delete copy[key];
  return copy as T;
}

function normalizeMethod(method?: string): GraphMethod {
  const upper = (method || 'GET').toUpperCase();
  if (upper === 'POST' || upper === 'PUT' || upper === 'PATCH') return 'POST';
  if (upper === 'DELETE') return 'DELETE';
  return 'GET';
}

interface ParsedBody {
  form?: Record<string, string>;
  multipart?: { fields: Record<string, string>; files: Array<{ field: string; filename?: string; contentType?: string; bytes: Buffer }> };
  json?: unknown;
  jsonRecord?: Record<string, unknown>;
  pending?: Array<{ index: number; blob: Blob }>;
}

function parseBody(body: unknown, contentType: string): ParsedBody | undefined {
  if (body === undefined || body === null) return undefined;
  if (body instanceof URLSearchParams) return { form: paramsToRecord(body) };
  if (typeof FormData !== 'undefined' && body instanceof FormData) return parseFormData(body);
  if (isFormDataPackage(body)) return parseMultipart(body.getBuffer(), body.getBoundary());
  if (contentType.startsWith('multipart/form-data')) {
    const boundary = /boundary=("?)([^";]+)\1/i.exec(contentType)?.[2];
    if (!boundary) return undefined;
    return parseMultipart(toBuffer(body), boundary);
  }
  if (contentType.startsWith('application/x-www-form-urlencoded')) return { form: paramsToRecord(new URLSearchParams(toBuffer(body).toString('utf8'))) };
  if (contentType.startsWith('application/json') || (typeof body === 'object' && !Buffer.isBuffer(body))) {
    const json = typeof body === 'string' || Buffer.isBuffer(body) ? JSON.parse(toBuffer(body).toString('utf8')) : body;
    const jsonRecord = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
    return { json, jsonRecord };
  }
  if (typeof body === 'string' && body.includes('=') && !body.trim().startsWith('{')) return { form: paramsToRecord(new URLSearchParams(body)) };
  return undefined;
}

function paramsToRecord(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  params.forEach((value, key) => { out[key] = value; });
  return out;
}

function toBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new Error(`unsupported body type ${typeof body}`);
}

function isFormDataPackage(body: unknown): body is { getBuffer(): Buffer; getBoundary(): string } {
  return !!body && typeof body === 'object' && typeof (body as any).getBuffer === 'function' && typeof (body as any).getBoundary === 'function';
}

function parseFormData(fd: FormData): ParsedBody {
  const fields: Record<string, string> = {};
  const files: NonNullable<ParsedBody['multipart']>['files'] = [];
  const pending: Array<{ index: number; blob: Blob }> = [];
  fd.forEach((value, key) => {
    if (typeof value === 'string') { fields[key] = value; return; }
    const blob = value as Blob & { name?: string };
    pending.push({ index: files.length, blob });
    files.push({ field: key, filename: blob.name, contentType: blob.type || undefined, bytes: Buffer.alloc(0) });
  });
  return { multipart: { fields, files }, pending };
}

function parseMultipart(buffer: Buffer, boundary: string): ParsedBody {
  const fields: Record<string, string> = {};
  const files: Array<{ field: string; filename?: string; contentType?: string; bytes: Buffer }> = [];
  const delimiter = Buffer.from(`--${boundary}`);
  let cursor = buffer.indexOf(delimiter);
  while (cursor !== -1) {
    cursor += delimiter.length;
    if (buffer.slice(cursor, cursor + 2).toString() === '--') break;
    if (buffer.slice(cursor, cursor + 2).toString() === '\r\n') cursor += 2;
    const headerEnd = buffer.indexOf('\r\n\r\n', cursor);
    if (headerEnd === -1) break;
    const rawHeaders = buffer.slice(cursor, headerEnd).toString('utf8');
    const next = buffer.indexOf(delimiter, headerEnd + 4);
    const contentEnd = next === -1 ? buffer.length : next - 2; // strip the CRLF before the next delimiter
    const content = buffer.slice(headerEnd + 4, Math.max(headerEnd + 4, contentEnd));
    const disposition = /name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(rawHeaders);
    const field = disposition?.[1] ?? '';
    const filename = disposition?.[2];
    const partType = /content-type:\s*([^\r\n]+)/i.exec(rawHeaders)?.[1]?.trim();
    if (filename !== undefined || partType) files.push({ field, filename, contentType: partType, bytes: content });
    else fields[field] = content.toString('utf8');
    cursor = next;
  }
  return { multipart: { fields, files } };
}
