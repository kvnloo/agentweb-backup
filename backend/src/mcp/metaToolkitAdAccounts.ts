/**
 * ENG-3040 — Zoma read-only `ads_get_ad_accounts` for external agents.
 *
 * Meta's own tool lists "the ad accounts the user has access to (name, status, currency,
 * timezone)". `zoma_status` already names the connected accounts but carries no status or
 * timezone, so this tool adds one Graph read per connected account for those fields.
 *
 * It lists ONLY the Meta ad accounts connected to the caller's Zoma login (their own and
 * those shared with their organization): the gateway passes that list in, and this module
 * never asks Meta which other accounts the Meta user can reach. Each read is the account's
 * own `act_<id>` node with that connection's token. Reads only: no write, no storage.
 */
import { ACCOUNT_STATUS } from './metaToolkitHealth';
import { MetaToolkitRefusal } from './metaToolkitErrors';

export const AD_ACCOUNTS_TOOL_NAME = 'ads_get_ad_accounts';

export const AD_ACCOUNTS_TOOL_DEFINITION = {
  name: AD_ACCOUNTS_TOOL_NAME,
  description:
    'Read-only list of the Meta ad accounts connected to this Zoma login (your own and any shared with your organization): ' +
    'account_id, name, status (ACTIVE, DISABLED, UNSETTLED and so on), currency and timezone. ' +
    'Works when several accounts are connected: use an account_id from this list on other tools. ' +
    'Ad accounts you can reach on Meta but have not connected to Zoma are not listed; zoma_status gives the connect link.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export const AD_ACCOUNT_LIST_FIELDS = 'id,name,account_status,currency,timezone_name';
export const MAX_AD_ACCOUNTS = 25;

/** A usable Meta connection of the caller, as resolved by the gateway. */
export interface ConnectedAdAccount {
  accountId: string;
  name?: string;
  currency?: string;
}

export interface MetaAdAccountsDeps {
  /** Read-only Graph GET of the account's own `act_<id>` node with that connection's token. */
  readAccount: (userId: string, accountId: string, fields: string) => Promise<any>;
}

const defaultDeps: MetaAdAccountsDeps = {
  readAccount: async (userId, accountId, fields) => {
    const { agentModeService } = await import('../services/agentModeService');
    return agentModeService.readToolkitMetaPagesGraph(userId, accountId, `act_${accountId}`, { fields });
  },
};

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);

export async function runMetaAdAccountsTool(
  userId: string,
  connected: ConnectedAdAccount[],
  args: any,
  deps: MetaAdAccountsDeps = defaultDeps,
) {
  const unknownArgs = Object.keys(args ?? {});
  if (unknownArgs.length) throw new MetaToolkitRefusal(`${AD_ACCOUNTS_TOOL_NAME} takes no arguments (got ${unknownArgs.join(', ')}).`);

  const seen = new Set<string>();
  const unique = connected.filter((a) => /^\d+$/.test(a.accountId) && !seen.has(a.accountId) && !!seen.add(a.accountId));
  if (unique.length === 0) {
    return { accounts: [], count: 0, note: 'No usable Meta ad account is connected. Call zoma_status for the connect link.' };
  }

  const listed = unique.slice(0, MAX_AD_ACCOUNTS);
  let firstError = '';
  const accounts = await Promise.all(listed.map(async (a) => {
    try {
      const raw = await deps.readAccount(userId, a.accountId, AD_ACCOUNT_LIST_FIELDS);
      const code = Number(raw?.account_status);
      return {
        account_id: a.accountId,
        name: text(raw?.name) ?? a.name,
        status: ACCOUNT_STATUS[code] ?? `UNKNOWN_${raw?.account_status}`,
        currency: text(raw?.currency) ?? a.currency,
        timezone: text(raw?.timezone_name),
      };
    } catch (error: any) {
      const message = String(error?.metaError?.message || error?.message || 'Meta request failed');
      firstError ||= message;
      // Still list the connection (from what Zoma stored) so the caller can see it exists.
      return { account_id: a.accountId, name: a.name, status: 'UNREADABLE', currency: a.currency, read_error: message };
    }
  }));

  if (accounts.every((a) => a.status === 'UNREADABLE')) {
    throw new MetaToolkitRefusal(`Could not read from Meta: ${firstError}.`);
  }
  return {
    accounts,
    count: accounts.length,
    ...(unique.length > listed.length ? { truncated: true, note: `Only the first ${MAX_AD_ACCOUNTS} of ${unique.length} connected accounts were read.` } : {}),
  };
}
