/**
 * ENG-2922 — Graph I/O for the Zoma toolkit's ARCHIVE / DELETE / COPY of Meta campaigns,
 * ad sets and ads (mcp/metaToolkitLifecycle.ts holds the guard). Kept out of the
 * agentMode monolith; every function takes the HTTP client and credentials explicitly.
 *
 * Ownership: a node id addresses a Graph object globally, so every read compares the
 * node's own account_id with the selected ad account and treats a foreign node as absent.
 */
import { describeMetaError } from '../../utils/metaErrorDetail';

export type LifecycleEntity = 'CAMPAIGN' | 'AD_SET' | 'AD';

export interface MetaGraphHttp {
  get: (url: string, config: { params: Record<string, unknown> }) => Promise<{ data: any }>;
  post: (url: string, body: unknown, config: { params: Record<string, unknown> }) => Promise<{ data: any }>;
}

export interface MetaGraphContext {
  http: MetaGraphHttp;
  accountId: string;
  accessToken: string;
  apiVersion?: string;
}

export interface MetaNodeState {
  id: string;
  name?: string;
  status?: string;
  effective_status?: string;
}

const base = (ctx: MetaGraphContext) => `https://graph.facebook.com/${ctx.apiVersion || process.env.META_API_VERSION || 'v25.0'}`;
const bare = (id: unknown) => String(id ?? '').trim().replace(/^act_/, '');

/** Meta's "object does not exist / no permission to read it" family (code 100, subcode 33). */
function isMissingNodeError(error: any): boolean {
  const e = error?.response?.data?.error ?? error?.error ?? error;
  return Number(e?.code) === 100 && (Number(e?.error_subcode) === 33 || /does not exist/i.test(String(e?.message ?? '')));
}

/** Read one node, scoped to the selected ad account. Null = missing or not in this account. */
export async function readOwnedMetaNode(ctx: MetaGraphContext, id: string): Promise<MetaNodeState | null> {
  if (!/^\d+$/.test(String(id))) return null;
  try {
    const { data } = await ctx.http.get(`${base(ctx)}/${encodeURIComponent(id)}`, {
      params: { fields: 'id,name,status,effective_status,account_id', access_token: ctx.accessToken },
    });
    if (!data?.id || bare(data.account_id) !== bare(ctx.accountId)) return null;
    return { id: String(data.id), name: data.name, status: data.status, effective_status: data.effective_status };
  } catch (error) {
    if (isMissingNodeError(error)) return null;
    throw error;
  }
}

/**
 * Spend of one node over at least the last 24 hours, in major units of the account currency.
 * Insights are day-grained in the AD ACCOUNT's timezone, which can be up to 14 h ahead of or
 * 12 h behind UTC, so the window is UTC day(now - 48 h) … day(now + 24 h): whatever the account
 * timezone, it covers the account's local today and yesterday. A future `until` that Meta
 * rejects fails closed (the caller treats unknown spend as recent spend).
 */
export function recentSpendWindow(now: number): { since: string; until: string } {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { since: day(now - 48 * 60 * 60 * 1000), until: day(now + 24 * 60 * 60 * 1000) };
}

export async function readMetaRecentSpend(ctx: MetaGraphContext, id: string, now: number): Promise<number> {
  const { data } = await ctx.http.get(`${base(ctx)}/${encodeURIComponent(id)}/insights`, {
    params: {
      fields: 'spend',
      time_range: JSON.stringify(recentSpendWindow(now)),
      access_token: ctx.accessToken,
    },
  });
  if (!Array.isArray(data?.data)) throw new Error('Meta returned no insights payload.');
  const total = data.data.reduce((sum: number, row: any) => sum + Number(row?.spend ?? 0), 0);
  if (!Number.isFinite(total)) throw new Error('Meta returned a non-numeric spend.');
  return total;
}

export interface MetaCopyOptions {
  deep_copy?: boolean;
  /** AD_SET copy: destination campaign. */
  campaign_id?: string;
  /** AD copy: destination ad set. */
  adset_id?: string;
}

/** POST /{id}/copies with status_option=PAUSED. Returns the new top-level id (+ child ids). */
export async function copyMetaNode(ctx: MetaGraphContext, entity: LifecycleEntity, id: string, opts: MetaCopyOptions) {
  const params: Record<string, unknown> = { status_option: 'PAUSED', access_token: ctx.accessToken };
  if (entity !== 'AD' && opts.deep_copy) params.deep_copy = true;
  if (entity === 'AD_SET' && opts.campaign_id) params.campaign_id = opts.campaign_id;
  if (entity === 'AD' && opts.adset_id) params.adset_id = opts.adset_id;
  let data: any;
  try {
    ({ data } = await ctx.http.post(`${base(ctx)}/${encodeURIComponent(id)}/copies`, null, { params }));
  } catch (error: any) {
    // axios's own message is "Request failed with status code 400" — the reason Meta gave
    // (error_user_title / error_user_msg / subcode / fbtrace_id) is only in the response body.
    // Re-thrown with that detail; `response` keeps status + Meta's body (never the request
    // config, which carries the access token) so the caller still knows Meta answered.
    const wrapped: any = new Error(describeMetaError(error, 'Meta refused the copy.'));
    if (error?.response) wrapped.response = { status: error.response.status, data: error.response.data };
    throw wrapped;
  }
  const copiedId = data?.copied_campaign_id ?? data?.copied_adset_id ?? data?.copied_ad_id;
  const childIds: string[] = [];
  for (const group of Array.isArray(data?.ad_object_ids) ? data.ad_object_ids : []) {
    for (const child of Array.isArray(group?.copied_ids) ? group.copied_ids : [group?.copied_id]) if (child) childIds.push(String(child));
  }
  return { copiedId: copiedId ? String(copiedId) : undefined, childIds };
}
