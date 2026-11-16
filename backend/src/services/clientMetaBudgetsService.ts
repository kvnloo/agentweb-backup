/**
 * ENG-3069: admin-only read of one managed customer's Meta budgets and spend for an exact
 * since/until window. Read-only: no Meta write, nothing stored.
 *
 * Client lookup and the account/token pair come from findClientMatches and
 * resolveClientMetaAccount (clientHealthService, shared with assess_client_health and
 * read_client_meta_activity / ENG-3070), with the same refusals as read_client_meta_activity.
 */
import { userDb } from './db';
import { getAccountsByUserId } from './connectedAccountsDb';
import { findClientMatches, resolveClientMetaAccount, hasUsableAdToken } from './clientHealthService';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(d: unknown): d is string {
  if (typeof d !== 'string' || !DATE_RE.test(d)) return false;
  const parsed = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d;
}

function refuse(reason: string, message: string, extra: Record<string, unknown> = {}) {
  return { success: false as const, reason, message, ...extra };
}

class MetaReadError extends Error {}

/** One Graph read. A Graph error body, a truncated page set, or a non-array body is a failure. */
async function readRows(url: string, what: string): Promise<any[]> {
  const { fetchWithRetryAndPaging } = await import('../utils/metaApiFetch');
  let body: any;
  try {
    body = await fetchWithRetryAndPaging(url);
  } catch (err) {
    throw new MetaReadError(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!body || typeof body !== 'object') throw new MetaReadError(`${what}: empty response`);
  if (body.error) throw new MetaReadError(`${what}: ${body.error.message || 'Graph API error'}`);
  if (body.pagingTruncated) throw new MetaReadError(`${what}: paging stopped before the last page`);
  if (!Array.isArray(body.data)) throw new MetaReadError(`${what}: response had no data array`);
  return body.data;
}

const windowSpend = (row: any): string => row?.insights?.data?.[0]?.spend ?? '0';
const budget = (v: unknown): string | null => (typeof v === 'string' && v !== '' && v !== '0' ? v : null);

export async function readClientMetaBudgets(
  callerUserId: string,
  clientNameOrEmail: string,
  since: string,
  until: string,
  callerIsAdmin?: boolean,
): Promise<any> {
  const isAdmin = callerIsAdmin !== undefined
    ? callerIsAdmin
    : (await userDb.getUserById(callerUserId))?.isAdmin === true;
  if (!isAdmin) {
    return { ...refuse('not_admin', 'Access denied. Only admin users can read a client\'s Meta budgets.'), error: 'Admin access required' };
  }
  if (!validDate(since) || !validDate(until) || since > until) {
    return refuse('invalid_window', 'since and until must be real dates in YYYY-MM-DD form, with since on or before until. Nothing was read.');
  }

  const matches = await findClientMatches(clientNameOrEmail);
  if (matches.length === 0) {
    return { ...refuse('client_not_found', `Client "${clientNameOrEmail}" not found.`), error: 'Client not found' };
  }
  if (matches.length > 1) {
    return refuse('ambiguous_client',
      `"${clientNameOrEmail}" matches ${matches.length} clients. Nothing was read; ask again with the client's exact email.`,
      { matches: matches.slice(0, 10).map((u: any) => ({ email: u.email, displayName: u.displayName })) });
  }
  const client = matches[0];
  const clientRef = { userId: client.userId, email: client.email, displayName: client.displayName };

  const metaAdAccounts = (await getAccountsByUserId(client.userId)).filter(
    (acc: any) => acc.platform === 'meta' && acc.config?.account_type === 'ad_account'
  );
  const nowMs = Date.now();
  const { connectedMetaAccount, useConnectedAccount, resolvedAdAccountId } =
    resolveClientMetaAccount(client, metaAdAccounts, nowMs);

  if (!resolvedAdAccountId) {
    return (connectedMetaAccount?.config as any)?.ad_account_id
      ? refuse('credential_pair_mismatch', 'The client\'s connected Meta ad account has no access token of its own, and the shared token is not used for a client-connected account. Nothing was read; the client needs to reconnect Meta.', { client: clientRef })
      : refuse('no_meta_connection', 'This client has no Meta ad account connected. Nothing was read.', { client: clientRef });
  }
  if (useConnectedAccount && !hasUsableAdToken(connectedMetaAccount, nowMs)) {
    return refuse('no_meta_connection', 'This client\'s Meta connection has expired and cannot refresh. Nothing was read; the client needs to reconnect Meta.', { client: clientRef, ad_account_id: resolvedAdAccountId });
  }

  let token: string;
  if (useConnectedAccount) {
    const { ensureFreshMetaAdAccountToken } = await import('./metaTokenRefresh');
    await ensureFreshMetaAdAccountToken(connectedMetaAccount, client.userId);
    token = connectedMetaAccount.config.access_token;
  } else {
    const { getMetaAccessToken } = await import('../utils/secretsManager');
    token = await getMetaAccessToken();
  }
  const adAccountId = resolvedAdAccountId as string;
  const apiVersion = process.env.META_API_VERSION || 'v25.0';
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
  const base = `https://graph.facebook.com/${apiVersion}/act_${adAccountId}`;
  const insightsField = `insights.time_range(${timeRange})%7Bspend%7D`;

  try {
    const [accountRows, campaignRows, adSetRows] = await Promise.all([
      readRows(`${base}/insights?fields=spend,account_currency&time_range=${timeRange}&access_token=${token}`, 'account insights'),
      readRows(`${base}/campaigns?fields=id,name,status,effective_status,daily_budget,lifetime_budget,${insightsField}&limit=200&access_token=${token}`, 'campaigns'),
      readRows(`${base}/adsets?fields=id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,${insightsField}&limit=200&access_token=${token}`, 'ad sets'),
    ]);
    return {
      success: true,
      client: clientRef,
      ad_account_id: adAccountId,
      credential_source: useConnectedAccount ? 'client_connection' : 'legacy_shared_token',
      since,
      until,
      account_spend: accountRows[0]?.spend ?? '0',
      currency: accountRows[0]?.account_currency ?? null,
      budget_units: 'minor currency units (cents), as Meta returns them',
      campaigns: campaignRows.map((c: any) => ({
        id: c.id, name: c.name, status: c.status, effective_status: c.effective_status ?? null,
        daily_budget: budget(c.daily_budget), lifetime_budget: budget(c.lifetime_budget), spend: windowSpend(c),
      })),
      ad_sets: adSetRows.map((s: any) => ({
        id: s.id, name: s.name, campaign_id: s.campaign_id, status: s.status, effective_status: s.effective_status ?? null,
        daily_budget: budget(s.daily_budget), lifetime_budget: budget(s.lifetime_budget), spend: windowSpend(s),
      })),
    };
  } catch (err) {
    if (!(err instanceof MetaReadError)) throw err;
    return refuse('meta_read_failed', `Meta read failed for act_${adAccountId}: ${err.message}. No numbers are reported.`, {
      ad_account_id: adAccountId,
    });
  }
}
