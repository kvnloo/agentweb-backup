/** One bounded, non-redirecting transport for both authenticated vendor surfaces. */
import { Agent } from 'undici';
import { isIP } from 'net';
import { resolvePinnedPublicAddress } from '../../utils/ssrfGuard';
import { AgenticFabriqApiError, AgenticFabriqAuthenticationError, AgenticFabriqError, AgenticFabriqResponseTooLargeError, AgenticFabriqTimeoutError } from './errors';

export function httpsUrl(value: unknown): URL {
  try {
    if (typeof value !== 'string' || value.length > 4096 || /[\s\\]/.test(value)) throw new Error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || value.includes('#') || url.port ||
        isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.') ||
        /(^|\.)(localhost|local|internal)$/.test(url.hostname) || url.hostname.endsWith('.')) throw new Error();
    return url;
  } catch { throw new AgenticFabriqAuthenticationError('Invalid vendor destination'); }
}

export function httpsOrigin(value: unknown): string {
  const url = httpsUrl(value);
  if (url.pathname !== '/' || url.search) throw new AgenticFabriqAuthenticationError('Invalid vendor origin');
  return url.origin;
}

export async function boundedJsonRequest(fetchImpl: typeof fetch, url: string, init: RequestInit,
  timeoutMs: number, maxBytes: number, operation: 'rest' | 'mcp'): Promise<unknown> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_000_000) {
    throw new AgenticFabriqError('Invalid transport bounds');
  }
  httpsUrl(url);
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let dispatcher: Agent | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      controller.abort();
      void reader?.cancel().catch(() => undefined);
      reject(new AgenticFabriqTimeoutError(operation));
    }, timeoutMs);
  });
  const run = async () => {
    const pinned = await resolvePinnedPublicAddress(url);
    if (expired) throw new AgenticFabriqTimeoutError(operation);
    dispatcher = new Agent({ connect: { lookup: (_hostname, options, callback) => {
      if ((options as {all?: boolean}).all) (callback as any)(null, [{address:pinned.address, family:pinned.family}]);
      else (callback as any)(null, pinned.address, pinned.family);
    } } });
    const res = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal, dispatcher } as RequestInit);
    if (expired) { void res.body?.cancel().catch(() => undefined); throw new AgenticFabriqTimeoutError(operation); }
    if (res.redirected || res.status >= 300 && res.status < 400) {
      void res.body?.cancel().catch(() => undefined);
      throw new AgenticFabriqAuthenticationError('Vendor redirect refused');
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      throw new AgenticFabriqApiError(res.status, operation);
    }
    const declared = res.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
      void res.body?.cancel().catch(() => undefined);
      throw new AgenticFabriqResponseTooLargeError(operation);
    }
    if (res.status === 204) return undefined;
    if (!res.body) throw new AgenticFabriqError('Invalid vendor JSON');
    reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (expired) throw new AgenticFabriqTimeoutError(operation);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new AgenticFabriqResponseTooLargeError(operation);
      }
      chunks.push(chunk.value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks, bytes))); }
    catch { throw new AgenticFabriqError('Invalid vendor JSON'); }
  };
  try { return await Promise.race([run(), deadline]); }
  catch (error) {
    controller.abort();
    void reader?.cancel().catch(() => undefined);
    if (expired) throw new AgenticFabriqTimeoutError(operation);
    if (error instanceof AgenticFabriqError) throw error;
    throw new AgenticFabriqError('Vendor transport failed');
  } finally {
    clearTimeout(timer!);
    void dispatcher?.destroy().catch(() => undefined);
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function boundedString(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
export function invalidShape(): never { throw new AgenticFabriqError('Invalid vendor response'); }
