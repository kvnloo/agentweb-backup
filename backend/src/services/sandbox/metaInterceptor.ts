import http from 'http';
import https from 'https';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import axios, { AxiosError } from 'axios';
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { classifyGraphRequest, hydrateMultipartFiles, isGraphHost, type GraphClassification } from './metaGraphMatcher';
import type { SimRequest, SimResponse } from './types';

/**
 * The one process-level seam for sandbox Meta traffic (ENG-1908).
 *
 * Every Graph call the backend makes leaves through one of three clients: Node's global
 * fetch (metaApiFetch and the raw fetch sites), the shared axios instance (the Meta SDK has
 * no nested axios, so its calls ride the default adapter), or raw http/https. The first two
 * are the primary hooks; the third is a fail-closed backstop that still answers but audits,
 * because a covered client should never reach it.
 *
 * Real users: the hostname is checked synchronously before anything else; non-Graph traffic
 * is handed to the original client untouched. Sandbox traffic: a sentinel token never
 * reaches the network, the simulator is bounded by a timeout, and every failure becomes a
 * Graph-shaped error instead of a hang.
 */
export interface MetaInterceptorOptions {
  handle: (request: SimRequest) => Promise<SimResponse>;
  /** Upper bound for one simulated answer; a stall becomes a Graph-shaped 500. */
  timeoutMs?: number;
}

export interface InterceptorAudit {
  simulated: number;
  rejected: number;
  backstopHits: number;
  simulatorErrors: number;
  lastBackstop?: { method: string; path: string; at: string };
}

const DEFAULT_TIMEOUT_MS = 15000;
const audit: InterceptorAudit = { simulated: 0, rejected: 0, backstopHits: 0, simulatorErrors: 0 };

interface Installed {
  options: Required<MetaInterceptorOptions>;
  originalFetch: typeof globalThis.fetch;
  originalAdapter: AxiosAdapter;
  originalAdapterSetting: unknown;
  originalHttpRequest: typeof http.request;
  originalHttpsRequest: typeof https.request;
}
let installed: Installed | null = null;

export function getInterceptorAudit(): InterceptorAudit { return { ...audit, ...(audit.lastBackstop ? { lastBackstop: { ...audit.lastBackstop } } : {}) }; }
export function resetInterceptorAuditForTests(): void { audit.simulated = 0; audit.rejected = 0; audit.backstopHits = 0; audit.simulatorErrors = 0; delete audit.lastBackstop; }

export function installMetaSandboxInterceptor(options: MetaInterceptorOptions): void {
  if (installed) return;
  const state: Installed = {
    options: { handle: options.handle, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    originalFetch: globalThis.fetch,
    originalAdapter: axios.getAdapter(axios.defaults.adapter),
    originalAdapterSetting: axios.defaults.adapter,
    originalHttpRequest: http.request,
    originalHttpsRequest: https.request,
  };
  installed = state;
  globalThis.fetch = wrapFetch(state);
  axios.defaults.adapter = wrapAdapter(state);
  http.request = wrapRequest(state, 'http:', state.originalHttpRequest) as typeof http.request;
  https.request = wrapRequest(state, 'https:', state.originalHttpsRequest) as typeof https.request;
}

export function uninstallMetaSandboxInterceptor(): void {
  if (!installed) return;
  globalThis.fetch = installed.originalFetch;
  axios.defaults.adapter = installed.originalAdapterSetting as AxiosAdapter;
  http.request = installed.originalHttpRequest;
  https.request = installed.originalHttpsRequest;
  installed = null;
}

// ---------------------------------------------------------------------------------------
// Answering

const graphError = (status: number, message: string, code: number, type: string): SimResponse => ({
  status, headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ error: { message, type, code, fbtrace_id: 'sandbox' } }),
});

async function answer(state: Installed, classification: Exclude<GraphClassification, { kind: 'passthrough' }>): Promise<SimResponse> {
  if (classification.kind === 'reject') {
    audit.rejected++;
    return graphError(400, 'Invalid OAuth access token.', 190, 'OAuthException');
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await hydrateMultipartFiles(classification.request);
    const response = await Promise.race([
      state.options.handle(classification.request),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`sandbox simulator exceeded ${state.options.timeoutMs}ms`)), state.options.timeoutMs); }),
    ]);
    if (!response || typeof response.status !== 'number' || typeof response.body !== 'string') throw new Error('sandbox simulator returned no response');
    audit.simulated++;
    return { status: response.status, headers: { 'content-type': 'application/json', ...response.headers }, body: response.body };
  } catch (error) {
    audit.simulatorErrors++;
    console.error('[metaInterceptor] simulator failed:', error instanceof Error ? error.message : String(error));
    return graphError(500, error instanceof Error ? error.message : 'sandbox simulator error', 1, 'SandboxSimulatorError');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------
// Hook 1: global fetch

function wrapFetch(state: Installed): typeof globalThis.fetch {
  const real = state.originalFetch;
  const wrapped = async function sandboxAwareFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let url: string;
    try {
      url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    } catch { return real(input, init); }
    if (!isGraphHost(url)) return real(input, init);

    let classification: GraphClassification;
    try {
      const request = typeof input === 'object' && !(input instanceof URL) ? (input as Request) : undefined;
      const method = init?.method ?? request?.method;
      const headers = headersToRecord(init?.headers ?? request?.headers);
      let body: unknown = init?.body;
      if (body === undefined && request && request.body && !request.bodyUsed) {
        const type = (headers['content-type'] || '').toLowerCase();
        const clone = request.clone();
        if (type.startsWith('multipart/form-data')) body = await clone.formData();
        else if (type.startsWith('application/x-www-form-urlencoded') || type.startsWith('application/json') || type === '') body = await clone.text();
      } else if (body instanceof Blob && !(typeof FormData !== 'undefined' && body instanceof FormData)) {
        body = Buffer.from(await body.arrayBuffer());
      } else if (body && typeof (body as ReadableStream).getReader === 'function') {
        body = undefined; // a stream body cannot be inspected without consuming it; query/header tokens still classify
      }
      classification = classifyGraphRequest({ url, method, headers, body });
    } catch {
      classification = { kind: 'passthrough' };
    }
    if (classification.kind === 'passthrough') return real(input, init);
    const sim = await answer(state, classification);
    return new Response(sim.body, { status: sim.status, headers: sim.headers });
  };
  return wrapped as typeof globalThis.fetch;
}

function headersToRecord(headers: HeadersInit | Headers | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) { headers.forEach((value, key) => { out[key.toLowerCase()] = value; }); return out; }
  if (Array.isArray(headers)) { for (const [key, value] of headers) out[String(key).toLowerCase()] = String(value); return out; }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) if (value !== undefined) out[key.toLowerCase()] = String(value);
  return out;
}

// ---------------------------------------------------------------------------------------
// Hook 2: axios default adapter (covers the Meta SDK — same module instance)

function wrapAdapter(state: Installed): AxiosAdapter {
  const original = state.originalAdapter;
  return async function sandboxAwareAdapter(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
    let url: string;
    try { url = axios.getUri(config); } catch { return original(config); }
    if (!isGraphHost(url)) return original(config);

    let classification: GraphClassification;
    try {
      const headers = axiosHeadersToRecord(config.headers);
      classification = classifyGraphRequest({ url, method: config.method, headers, body: config.data });
    } catch {
      classification = { kind: 'passthrough' };
    }
    if (classification.kind === 'passthrough') return original(config);
    const sim = await answer(state, classification);
    const response: AxiosResponse = {
      data: config.responseType === 'json' || config.responseType === 'text' || !config.responseType ? sim.body : sim.body,
      status: sim.status,
      statusText: sim.status === 200 ? 'OK' : sim.status === 400 ? 'Bad Request' : sim.status === 500 ? 'Internal Server Error' : String(sim.status),
      headers: sim.headers,
      config,
      request: {},
    };
    // Same contract as the http adapter: axios' transformResponse parses the string body and
    // non-2xx statuses reject with an AxiosError carrying the response.
    const validate = config.validateStatus;
    if (!validate || validate(response.status)) return response;
    const parsed = { ...response, data: safeJson(sim.body) };
    throw new AxiosError(`Request failed with status code ${response.status}`,
      response.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST, config, response.request, parsed);
  };
}

function axiosHeadersToRecord(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const json = typeof (headers as any).toJSON === 'function' ? (headers as any).toJSON() : headers;
  for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function safeJson(body: string): unknown {
  try { return JSON.parse(body); } catch { return body; }
}

// ---------------------------------------------------------------------------------------
// Hook 3: http/https backstop

type RequestFn = typeof http.request;

function wrapRequest(state: Installed, protocol: 'http:' | 'https:', original: RequestFn): RequestFn {
  const wrapped = function sandboxAwareRequest(this: unknown, ...args: any[]): http.ClientRequest {
    let url: string | undefined;
    let options: http.RequestOptions | undefined;
    let callback: ((res: http.IncomingMessage) => void) | undefined;
    try {
      const [first, second, third] = args;
      if (typeof first === 'string' || first instanceof URL) {
        url = String(first);
        options = second && typeof second === 'object' ? second : undefined;
        callback = typeof second === 'function' ? second : typeof third === 'function' ? third : undefined;
      } else if (first && typeof first === 'object') {
        options = first;
        callback = typeof second === 'function' ? second : undefined;
        const host = options.hostname || options.host || '';
        const proto = options.protocol || protocol;
        const port = options.port ? `:${options.port}` : '';
        url = `${proto}//${host}${port}${options.path || '/'}`;
      }
    } catch { url = undefined; }
    if (!url || !isGraphHost(url)) return original.apply(this, args as any);

    let classification: GraphClassification;
    try {
      const method = options?.method || 'GET';
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(options?.headers || {})) if (value !== undefined) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
      classification = classifyGraphRequest({ url, method, headers });
    } catch {
      classification = { kind: 'passthrough' };
    }
    if (classification.kind === 'passthrough') return original.apply(this, args as any);

    // A covered client should have been caught by the fetch or axios hook. Answer anyway
    // (fail closed) and make the miss visible.
    audit.backstopHits++;
    const path = classification.kind === 'simulate' ? classification.request.path : new URL(url).pathname;
    const method = (options?.method || 'GET').toUpperCase();
    audit.lastBackstop = { method, path, at: new Date().toISOString() };
    console.error(`[metaInterceptor] backstop answered a sandbox request that bypassed the fetch/axios hooks: ${method} ${path}`);
    const req = fakeClientRequest(state, classification, method);
    if (callback) req.once('response', callback);
    return req;
  };
  return wrapped as unknown as RequestFn;
}

function fakeClientRequest(state: Installed, classification: Exclude<GraphClassification, { kind: 'passthrough' }>, method: string): http.ClientRequest {
  const req = new EventEmitter() as http.ClientRequest & { socket: any };
  const chunks: Buffer[] = [];
  const socket = Object.assign(new EventEmitter(), {
    setKeepAlive: () => socket, setTimeout: () => socket, setNoDelay: () => socket, destroy: () => socket, ref: () => socket, unref: () => socket,
    remoteAddress: '127.0.0.1', encrypted: true,
  });
  req.socket = socket;
  Object.assign(req, {
    method,
    write: (chunk: any) => { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; },
    setTimeout: () => req, setHeader: () => req, getHeader: () => undefined, removeHeader: () => req, flushHeaders: () => undefined,
    setNoDelay: () => undefined, setSocketKeepAlive: () => undefined, destroy: () => req, abort: () => undefined, cork: () => undefined, uncork: () => undefined,
    end: (chunk?: any) => {
      if (chunk && typeof chunk !== 'function') chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      void (async () => {
        const sim = await answer(state, classification);
        const res = new PassThrough() as PassThrough & Record<string, unknown>;
        Object.assign(res, {
          statusCode: sim.status, statusMessage: sim.status === 200 ? 'OK' : String(sim.status), headers: sim.headers,
          rawHeaders: Object.entries(sim.headers).flat(), httpVersion: '1.1', socket, complete: true, aborted: false,
          setTimeout: () => res, destroy: () => res,
        });
        process.nextTick(() => { req.emit('socket', socket); req.emit('response', res); res.end(sim.body); });
      })();
      return req;
    },
  });
  return req;
}
