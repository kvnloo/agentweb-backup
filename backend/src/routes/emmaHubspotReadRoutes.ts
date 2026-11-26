/**
 * ENG-2840 (W2-9): `POST /api/emma/hubspot-read`, the route behind the MCP tool `call_hubspot_api` (the read-only subset of Emma's tool).
 *
 * Mounted on the /api/emma router (authenticated, metered). Any portal token can reach it directly, so it does not trust its caller: the
 * body is checked again with the same allow-list and value rules as the tool (utils/hubspotReadArgs.ts), a refusal is a 400 with a short
 * message, and Emma's handler is given ONLY the checked fields, as `req.user.userId`. No identity ever comes from the body: the handler
 * resolves the caller's own HubSpot account, a token on one of the caller's own lead lists, or an account a teammate shared with the
 * caller's organization (exactly as Emma does).
 *
 * Answers:
 *  - `{ success: true, account, entity_type, action, result }`: `account` says which connection answered (`own`, `org_shared` or
 *    `lead_list_token`); `result` is the handler's answer without `success`.
 *  - `{ success: false, message }` (HTTP 200) when the handler refused or HubSpot answered an error: a fixed text chosen here from the
 *    HubSpot status, or (no status: Emma's own account, sign-in and timeout errors) from the kind of error; the handler's raw `err.message`
 *    is never passed on. The one free text kept is HubSpot's own `message` on a 400 (redacted by the handler, cleaned again and cut here).
 *  - HTTP 403 with a fixed text (the one the LinkedIn read routes use) when the caller is an evaluation sandbox whose denied tool classes cover this tool: Emma refuses
 *    that through her registry, and this route calls her implementation directly, so it applies the check itself.
 *  - HTTP 500 with a fixed text on anything unexpected.
 */
import type { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { HubspotReadArgsError, HUBSPOT_DEAL_CONTACTS_MAX, validateHubspotReadArgs } from '../utils/hubspotReadArgs';
import { EvaluationDenied, enforceEvaluationTool } from '../services/evaluationPolicy';

const MAX_MESSAGE_CHARS = 300;
const FAILED_TEXT = 'The HubSpot read failed. Try again later.';
const SANDBOX_TEXT = 'This tool is not available in this sandbox workspace';
const RECONNECT = 'Reconnect HubSpot in Settings → Connected Accounts.';

/**
 * Fixed texts for a refusal without an HTTP status (Emma's own errors: no account, several accounts, an account id not found, a sign-in
 * that needs reconnecting, Marketing Hub missing, a timeout). Matched on the kind of error; the error's own words are never passed on.
 */
const NO_STATUS_TEXTS: Array<[RegExp, string]> = [
  [/multiple hubspot accounts/i, 'Several HubSpot accounts are connected: pass account_id (from list_connected_accounts).'],
  [/hubspot account ".*" not found/i, 'That account_id is not one of your HubSpot accounts or one shared with your organization. Use an id from list_connected_accounts.'],
  [/no hubspot account connected|hubspot account not connected/i, `No HubSpot account is connected. Connect HubSpot in Settings → Connected Accounts.`],
  [/needs to be reconnected|no refresh token|reconnect your hubspot/i, `The HubSpot sign-in needs to be renewed. ${RECONNECT}`],
  [/does not have Marketing Hub/i, 'This HubSpot portal does not have Marketing Hub, so it cannot read this object. Reconnecting will not change that.'],
  [/authorised for CRM access only/i, `This HubSpot connection was granted CRM access only, so it cannot read this Marketing Hub object. ${RECONNECT} Choose the marketing option.`],
  [/no deal stage matches/i, 'No deal stage matches deal_stage. Use DEALS LIST_PIPELINES to see the stage ids and labels.'],
  [/timeout|timed out|ECONNABORTED|ETIMEDOUT/i, 'HubSpot did not answer in time. Try again later.'],
];

export type HubspotAccountSource = 'own' | 'org_shared' | 'lead_list_token';

/** Which connection served the call: its account id and whose it is. Pure; exported for tests. */
export function describeServingAccount(svc: { accountId?: string; ownerUserId?: string } | null | undefined, callerId: string): { account_id: string | null; source: HubspotAccountSource } | null {
  if (!svc) return null;
  const accountId = typeof svc.accountId === 'string' && svc.accountId !== '' ? svc.accountId : null;
  // No account id: the pasted private-app token path, which only ever reads the caller's OWN lead lists.
  if (!accountId) return { account_id: null, source: 'lead_list_token' };
  return { account_id: accountId, source: svc.ownerUserId === callerId ? 'own' : 'org_shared' };
}

/** A short, single-line text without anything token-shaped (the same shapes Emma's HubSpot redaction removes). */
export function cleanHubspotText(text: unknown): string {
  if (typeof text !== 'string') return '';
  const out = text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\(\s*[A-Za-z0-9_-]{20,}\s*\)/g, '(<redacted>)')
    .replace(/\b(?:pat-[a-z0-9-]+|na1-[A-Za-z0-9-]{8,}|[A-Za-z0-9_-]{40,})\b/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > MAX_MESSAGE_CHARS ? `${out.slice(0, MAX_MESSAGE_CHARS - 1)}…` : out;
}

/** The short message for a `{ success: false }` answer of the handler. Exported for tests. */
export function refusalMessage(result: Record<string, any>): string {
  const status = typeof result.status === 'number' && Number.isInteger(result.status) ? result.status : null;
  const said = cleanHubspotText(result.error);
  if (status === 403) return said || 'HubSpot denied access. Check the connection\'s permissions and the portal\'s HubSpot plan.';
  if (status === 401) return `HubSpot did not accept the connection's sign-in (HTTP 401). ${RECONNECT}`;
  if (status === 404) return 'HubSpot found nothing at that id (HTTP 404). Check the id: use one HubSpot returned in a LIST.';
  if (status === 429) return 'HubSpot\'s rate limit for this portal was reached (HTTP 429); it is shared by everyone using the portal. Try again in a minute.';
  if (status !== null && status >= 500) return `HubSpot could not answer (HTTP ${status}). Try again later.`;
  if (status !== null) {
    const hubspot = cleanHubspotText(result.hubspotError && typeof result.hubspotError === 'object' ? (result.hubspotError as any).message : undefined);
    return `HubSpot refused the request (HTTP ${status})${hubspot ? `: ${hubspot}` : '.'}`;
  }
  const raw = typeof result.error === 'string' ? result.error : '';
  return NO_STATUS_TEXTS.find(([re]) => re.test(raw))?.[1] ?? FAILED_TEXT;
}

export function registerHubspotReadRoutes(router: Router): void {
  router.post('/hubspot-read', async (req: Request, res: Response) => {
    const callerId = (req as AuthenticatedRequest).user?.userId;
    if (typeof callerId !== 'string' || callerId === '') return res.status(401).json({ message: 'Authentication required' });

    let args: ReturnType<typeof validateHubspotReadArgs>;
    try {
      args = validateHubspotReadArgs(req.body);
    } catch (err: any) {
      if (err instanceof HubspotReadArgsError) return res.status(400).json({ message: err.message });
      return res.status(500).json({ message: FAILED_TEXT });
    }

    try {
      await enforceEvaluationTool(callerId, 'call_hubspot_api');
      const { handleHubspotApi } = await import('../emma/impl/adsCrmApis');
      let served: ReturnType<typeof describeServingAccount> = null;
      const result = await handleHubspotApi(callerId, args, {
        onResolved: (svc) => { served = describeServingAccount(svc, callerId); },
        maxDealContacts: HUBSPOT_DEAL_CONTACTS_MAX,
      });
      if (!result || typeof result !== 'object' || Array.isArray(result)) return res.status(500).json({ message: FAILED_TEXT });
      if (result.success !== true) return res.json({ success: false, message: refusalMessage(result) });
      const { success: _success, ...rest } = result;
      void _success;
      return res.json({ success: true, account: served, entity_type: args.entity_type, action: args.action, result: rest });
    } catch (err: any) {
      if (err instanceof EvaluationDenied) return res.status(403).json({ message: SANDBOX_TEXT });
      console.error('[emma hubspot-read] failed:', cleanHubspotText(err?.message));
      return res.status(500).json({ message: FAILED_TEXT });
    }
  });
}
