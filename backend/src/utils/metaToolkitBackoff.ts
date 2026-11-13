import { AsyncLocalStorage } from 'async_hooks';
import axios from 'axios';
import { parseBusinessUseCaseUsage } from './metaBusinessUsage';

export const META_TOOLKIT_BUC_THRESHOLD_PCT = 90;
export const META_TOOLKIT_MAX_BACKOFF_MS = 30_000;
const context = new AsyncLocalStorage<{
  write: boolean; writeSent?: boolean; retried: boolean; limited?: ReturnType<typeof limitedResult>;
  sleep: (ms: number) => Promise<void>;
}>();
function limitedResult(minutes: number) {
  return { success: false, rate_limited: true, estimated_time_to_regain_access: minutes,
    retryAfterSeconds: Math.ceil(minutes * 60),
    message: `Meta rate limited this call. Estimated time to regain access: ${minutes} minute(s). Retry later.` };
}
function signal(headers: any, data: any, status?: number) {
  const usage = parseBusinessUseCaseUsage({ headers: { get: (name) => headers?.get?.(name) ?? headers?.[name] ?? null } });
  const code = Number(data?.error?.code);
  if (!(usage && Math.max(usage.callCountPct, usage.totalCpuTimePct, usage.totalTimePct) >= META_TOOLKIT_BUC_THRESHOLD_PCT)
      && ![4, 17, 32, 613].includes(code) && !(code >= 80000 && code <= 80014) && status !== 429) return;
  const estimate = usage?.estimatedMinutesToRegainAccess;
  return limitedResult(typeof estimate === 'number' && Number.isFinite(estimate) && estimate >= 0 ? estimate : 1);
}
async function retryAllowed(headers: any, data: any, status?: number, method = 'get'): Promise<boolean> {
  const state = context.getStore();
  if (!state) return false;
  const limited = signal(headers, data, status);
  if (!limited) return false;
  const nonGet = method.toUpperCase() !== 'GET';
  const write = state.write || nonGet;
  // Warn only when a mutating request actually reached Meta; a throttled preview read changed nothing.
  state.limited = state.writeSent || nonGet
    ? { ...limited, message: `${limited.message} This write was not retried and may have executed; verify its state before trying again.` }
    : limited;
  if (write || state.retried) throw new Error(limited.message);
  state.retried = true;
  await state.sleep(Math.min(META_TOOLKIT_MAX_BACKOFF_MS, limited.retryAfterSeconds * 1000));
  state.limited = undefined;
  return true;
}
function graph(url?: string) { try { return new URL(url ?? '').hostname === 'graph.facebook.com'; } catch { return false; } }
/** Attach toolkit backoff to an axios instance; requests outside toolkit context are untouched. */
export function attachMetaToolkitBackoff<T extends typeof axios | ReturnType<typeof axios.create>>(client: T): T {
  client.interceptors.request.use(config => {
    const state = context.getStore();
    if (state?.limited && graph(config.url)) throw new Error(state.limited.message);
    if (state && graph(config.url) && (config.method ?? 'get').toUpperCase() !== 'GET') state.writeSent = true;
    return config;
  });
  client.interceptors.response.use(async response => {
    if (graph(response.config.url) && await retryAllowed(response.headers, response.data, response.status, response.config.method)) return client.request(response.config);
    return response;
  }, async error => {
    const response = error?.response;
    if (graph(error?.config?.url) && await retryAllowed(response?.headers, response?.data, response?.status, error.config.method)) return client.request(error.config);
    throw error;
  });
  return client;
}
// Installed once on the default client.
attachMetaToolkitBackoff(axios);

/** Toolkit fetch path bypasses the legacy helper's independent retry budget. */
export async function toolkitMetaFetch(url: string): Promise<Response> {
  const limited = context.getStore()?.limited;
  if (limited && graph(url)) throw new Error(limited.message);
  const response = await fetch(url);
  if (!context.getStore() || !graph(url)) return response;
  let data: any;
  try { data = await response.clone().json(); } catch { /* Header/status still usable. */ }
  if (await retryAllowed(response.headers, data, response.status)) return toolkitMetaFetch(url);
  return response;
}
export function inMetaToolkitBackoffContext() { return !!context.getStore(); }
export async function withMetaToolkitBackoff<T>(write: boolean, sleep: ((ms: number) => Promise<void>) | undefined, run: () => Promise<T>) {
  const state = { write, retried: false, sleep: sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))), limited: undefined as ReturnType<typeof limitedResult> | undefined };
  return context.run(state, async () => {
    try { const result = await run(); return state.limited ?? result; }
    catch (error) { if (state.limited) return state.limited; throw error; }
  });
}
