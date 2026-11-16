import { publicBaseUrl, removeEventWebhooks, type RemoveOutcome, type WebhookApi } from "./smartleadEventRegistration";
import { getAccountByIdConsistentOrThrow } from "./connectedAccountsDb";
import { resolveSmartlead } from "./smartleadConnection";
import { listCampaigns } from "./smartleadService";
import { realWebhookApi } from "./smartleadPushRuntime";

/**
 * When a customer removes their Smartlead connection, AgentWeb takes its event webhook off their campaigns (ENG-673, slice 3), so nothing of ours
 * is left behind in their account. Best effort by design: the connection is removed whatever happens here (a revoked key cannot delete
 * anything, and a leftover webhook is harmless: it only posts to an address that still ignores contacts it does not know).
 *
 * Smartlead allows about one call a second, and we keep no list of the campaigns we registered on, so this reads the account's campaigns (one
 * call) and looks at each one's webhooks: slow for an account with many campaigns. So it is done in TWO parts: the key is found first (fast,
 * and it must be found before the connection is deleted), and the long part carries on in the background after the connection is gone, with
 * its own larger budget. The caller awaits only the first part and hands the returned promise to the shutdown tracker.
 */
const MAX_CAMPAIGNS = 300;
const BUDGET_MS = 5 * 60 * 1000;

export interface CleanupDeps {
  resolveKey: (userId: string, accountId: string) => Promise<{ ok: true; apiKey: string } | { ok: false }>;
  listCampaignIds: (apiKey: string) => Promise<number[]>;
  api: WebhookApi;
  log: (line: string) => void;
  /** This deployment's public address (only webhooks pointing at it are ours); null → nothing can be recognised. */
  baseUrl: () => string | null;
  /** Has the connection been added again? Then stop: the new connection's webhooks must not be removed. */
  reconnected: (userId: string, accountId: string) => Promise<boolean>;
  /** The background part's time budget (tests shorten it). */
  budgetMs?: number;
}

const realDeps: CleanupDeps = {
  resolveKey: async (userId, accountId) => {
    const r = await resolveSmartlead(userId, accountId);
    return r.ok ? { ok: true, apiKey: r.apiKey } : { ok: false };
  },
  listCampaignIds: async apiKey => (await listCampaigns(apiKey, { maxRetries: 1 })).map(c => c.id),
  api: realWebhookApi,
  baseUrl: () => publicBaseUrl(),
  reconnected: async (userId, accountId) => (await getAccountByIdConsistentOrThrow(accountId, userId, "smartlead")) !== null,
  log: line => console.log(line),
};

/**
 * Finds the key while the connection still exists, and returns the job to run once it is gone. The caller runs it AFTER deleting the connection:
 * started earlier, the job could see the connection still there, read that as "added again", and stop. The job never rejects; it resolves to null
 * when there is nothing to do or it could not be done.
 */
export async function prepareSmartleadEventCleanup(userId: string, accountId: string, deps: CleanupDeps = realDeps): Promise<{ run: () => Promise<RemoveOutcome | null> }> {
  const nothing = { run: () => Promise.resolve(null) };
  let apiKey: string;
  try {
    const key = await deps.resolveKey(userId, accountId);
    if (!key.ok) return nothing; // no usable key (already revoked, or not theirs to use): nothing can be deleted
    apiKey = key.apiKey;
  } catch (e) {
    deps.log(`[SmartleadEvents] disconnect cleanup could not start: ${e instanceof Error ? e.message : String(e)}`);
    return nothing;
  }
  const baseUrl = deps.baseUrl();
  if (!baseUrl) return nothing;
  return {
    run: () => {
      let stop = false;
      const timer = setTimeout(() => { stop = true; }, deps.budgetMs ?? BUDGET_MS);
      return (async () => {
        const all = await deps.listCampaignIds(apiKey);
        if (all.length > MAX_CAMPAIGNS) deps.log(`[SmartleadEvents] disconnect cleanup: ${all.length} campaigns, only the first ${MAX_CAMPAIGNS} are checked`);
        const ids = all.slice(0, MAX_CAMPAIGNS);
        // Campaign by campaign, so the time budget can stop the work between campaigns (a promise race alone would leave it running).
        const total: RemoveOutcome = { campaigns: 0, removed: 0, failed: 0 };
        for (const id of ids) {
          if (stop) { deps.log(`[SmartleadEvents] disconnect cleanup stopped at its time budget after ${total.campaigns} campaign(s)`); break; }
          // A failed read throws and ends the job: not knowing means stop, because a leftover webhook is harmless and removing a new connection's is not.
          if (await deps.reconnected(userId, accountId)) { deps.log("[SmartleadEvents] disconnect cleanup stopped: the connection was added again"); break; }
          const one = await removeEventWebhooks(deps.api, { apiKey, accountId, baseUrl, campaignIds: [id] }, deps.log);
          total.campaigns += one.campaigns; total.removed += one.removed; total.failed += one.failed;
        }
        deps.log(`[SmartleadEvents] disconnect: looked at ${total.campaigns} campaign(s), removed ${total.removed} webhook(s), ${total.failed} failed`);
        return total;
      })().catch(e => {
        deps.log(`[SmartleadEvents] disconnect cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }).finally(() => clearTimeout(timer));
    },
  };
}
