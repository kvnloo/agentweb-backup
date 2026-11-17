import axios from 'axios';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { classifyMetaReadFailure, META_RECONNECT_MESSAGE, META_PERMISSION_MESSAGE } from '../utils/metaReadErrorClass';
import { META_ADS_NO_PAGES_MESSAGE } from '../utils/metaAdsScope';
import { metaPageAccessFixSteps } from './metaPageAccessRefusal';

/**
 * ENG-2921 slice 1: read-only account diagnostics. `ads_account_get_activity_logs` reads the
 * selected account's `activities` edge; `ads_get_errors` explains a Meta Marketing API error
 * code from a static table (no Graph call). Help articles and usage-header backoff are later
 * slices.
 */
export const ACTIVITY_FIELDS = 'event_time,event_type,translated_event_type,actor_id,actor_name,object_id,object_name,object_type,extra_data,date_time_in_timezone';

const names = ['ads_account_get_activity_logs', 'ads_get_errors'] as const;

export function isDiagnosticsRead(name: string): boolean { return (names as readonly string[]).includes(name); }

/** Common Marketing API error codes (developers.facebook.com/docs/marketing-api/error-reference). */
export const META_ERROR_EXPLANATIONS: Record<string, { meaning: string; action: string }> = {
  '1': { meaning: 'Unknown or transient API error.', action: 'Retry after a short wait; if it persists, simplify the request.' },
  '2': { meaning: 'Temporary service error at Meta.', action: 'Retry with backoff.' },
  '4': { meaning: 'Application-level request limit reached.', action: 'Back off and retry later; reduce request volume.' },
  '10': { meaning: 'Permission denied for this action.', action: 'Reconnect Meta with the required permissions (ads_management/ads_read).' },
  '17': { meaning: 'User-level request limit reached.', action: 'Back off and retry later.' },
  '100': { meaning: 'Invalid parameter.', action: 'Check the field names and values in the request; error_subcode narrows which one.' },
  '190': { meaning: 'Access token expired or invalid.', action: 'Reconnect the Meta account.' },
  '200': { meaning: 'Missing permission for this object or action.', action: 'Confirm the connected user has the right role on the ad account, page, or business.' },
  '272': { meaning: 'Ad account is not authorized for this action (e.g. business verification or policy).', action: 'Check account status and business verification in Business Manager.' },
  '294': { meaning: 'Managing ads requires an approved app or a verified account.', action: 'Check app review / ads_management access.' },
  '368': { meaning: 'Action blocked as potentially abusive or policy-violating.', action: 'Review Meta policy notices for the account; retry later.' },
  '613': { meaning: 'Rate limit exceeded for this call type.', action: 'Back off; spread requests over time.' },
  '1487390': { meaning: 'Ad creative or targeting is invalid for the chosen placement/objective.', action: 'Adjust creative or targeting per the error message.' },
  '2635': { meaning: 'Deprecated API version.', action: 'The integration must call a supported Graph API version.' },
  '80004': { meaning: 'Ads Management rate limit (business use case) reached for this ad account.', action: 'Back off until the reported estimated_time_to_regain_access.' },
};

export const DIAGNOSTICS_READ_DEFINITIONS = names.map((name) => ({
  name,
  description: ({
    ads_account_get_activity_logs: 'Read the change/activity history of the selected Meta ad account (who changed what, when). Read-only; returns one page and paging cursors.',
    ads_get_errors: 'Explain a Meta Marketing API error code: what it means and what to do. No Meta call is made.',
  })[name],
  inputSchema: name === 'ads_account_get_activity_logs'
    ? {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Connected Meta ad account; optional when exactly one is connected.' },
        since: { type: 'string', description: 'ISO date or unix seconds; earliest event.' },
        until: { type: 'string', description: 'ISO date or unix seconds; latest event.' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        after: { type: 'string' },
      },
      additionalProperties: false,
    }
    : {
      type: 'object',
      properties: {
        code: { type: 'string', pattern: '^[0-9]+$', description: 'Meta error code (error.code or error_subcode).' },
        message: { type: 'string', description: 'Optional: Meta\'s error.message, so a permission code can be told apart (e.g. a Facebook Page refusal).' },
      },
      required: ['code'],
      additionalProperties: false,
    },
}));

/**
 * ENG-3129: Page-permission refusals. 283 is Graph's "Requires extended permission" for Page
 * permissions (pages_*). The generic permission codes 10 / 200–299 are Page refusals only when
 * Meta's message says so (a Page, page_id, or a pages_* permission) — otherwise they keep the
 * generic ad-account hint.
 */
const PAGE_PERMISSION_CODES = new Set(['283']);
const PAGE_ERROR_TEXT = /\bpages?\b|page_id|pages_[a-z_]+/i;

function isPagePermissionError(code: string, message: string): boolean {
  if (PAGE_PERMISSION_CODES.has(code)) return true;
  const n = Number(code);
  return (n === 10 || (n >= 200 && n <= 299)) && PAGE_ERROR_TEXT.test(message);
}

const TIME = /^(\d{1,10}|\d{4}-\d{2}-\d{2}(T[0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?)$/;

/** Pure: no credentials, no network. */
export function explainMetaError(args: any) {
  const extra = Object.keys(args ?? {}).filter((k) => k !== 'code' && k !== 'account_id' && k !== 'message');
  if (extra.length) throw new MetaToolkitRefusal(`Unsupported error-explainer argument: ${extra[0]}`);
  const code = String(args?.code ?? '').trim();
  if (!/^\d+$/.test(code)) throw new MetaToolkitRefusal('code must be a numeric Meta error code.');
  if (args?.message !== undefined && typeof args.message !== 'string') throw new MetaToolkitRefusal('message must be a string.');
  if (isPagePermissionError(code, args?.message ?? '')) {
    return {
      code,
      known: true,
      page_access: 'missing',
      meaning: META_ADS_NO_PAGES_MESSAGE,
      action: metaPageAccessFixSteps().map((step, i) => `${i + 1}. ${step}`).join('\n'),
    };
  }
  const known = META_ERROR_EXPLANATIONS[code];
  return known
    ? { code, known: true, ...known }
    : { code, known: false, meaning: 'Not in the built-in table.', action: 'Read error.message and error_user_msg from the original response; see Meta\'s Marketing API error reference.' };
}

/** Uses server-resolved, account-bound credentials; never caller supplied. */
export async function executeActivityLogRead(
  args: any, credentials: { accountId: string; accessToken: string },
  graph: Pick<typeof axios, 'get'> = axios,
) {
  const props = DIAGNOSTICS_READ_DEFINITIONS[0].inputSchema.properties;
  args = Object.fromEntries(Object.entries(args ?? {}).filter(([, v]) => !(typeof v === 'string' && v.trim() === '')));
  for (const key of Object.keys(args)) {
    if (!(key in props)) throw new MetaToolkitRefusal(`Unsupported activity-log argument: ${key}`);
  }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) throw new MetaToolkitRefusal('limit must be an integer from 1 to 100.');
  for (const k of ['since', 'until', 'after']) {
    if (args[k] !== undefined && typeof args[k] !== 'string') throw new MetaToolkitRefusal(`${k} must be a string.`);
  }
  for (const k of ['since', 'until']) {
    if (args[k] !== undefined && !TIME.test(args[k])) throw new MetaToolkitRefusal(`${k} must be an ISO date or unix seconds.`);
  }
  const base = `https://graph.facebook.com/${process.env.META_API_VERSION || 'v25.0'}`;
  const accountId = String(credentials.accountId ?? '').replace(/^act_/, '');
  if (!/^\d+$/.test(accountId)) throw new MetaToolkitRefusal('The selected Meta ad account id is not valid.');
  const account = `act_${accountId}`;
  const params: Record<string, unknown> = { fields: ACTIVITY_FIELDS, limit: args.limit ?? 50 };
  for (const k of ['since', 'until', 'after']) if (args[k] !== undefined) params[k] = args[k];
  try {
    const data = (await graph.get(`${base}/${account}/activities`, { params: { ...params, access_token: credentials.accessToken }, timeout: 15_000 })).data;
    // Graph paging.next/previous URLs embed access_token; return cursors and has-more flags only.
    if (data?.paging) {
      const { next, previous, ...rest } = data.paging;
      return { ...data, paging: { ...rest, has_next: Boolean(next), has_previous: Boolean(previous) } };
    }
    return data;
  } catch (error: any) {
    return metaReadFailureResult(error);
  }
}

/**
 * Turn a Meta refusal (Graph error or credential resolution failure) into a readable tool result
 * instead of letting the gateway's generic handler return a bare "Meta Toolkit call failed."
 * Mirrors the campaign-list read (emma/impl/adsApis.ts): reconnect message on an invalid token,
 * permission message on other credential refusals.
 */
export function metaReadFailureResult(error: any) {
  const failure = classifyMetaReadFailure(error);
  const graphMessage = error?.response?.data?.error?.message;
  const base = graphMessage || error?.message || 'Meta refused the activity-log read';
  const message = failure.kind === 'credential'
    ? `${base}. ${failure.tokenInvalid || error?.isMetaAuthError ? META_RECONNECT_MESSAGE : META_PERMISSION_MESSAGE}`
    : failure.kind === 'transient'
      ? `${base}. Meta is temporarily unavailable or throttling; try again shortly.`
      : base;
  return {
    success: false,
    message,
    errorClass: failure.errorClass,
    errorType: failure.kind === 'credential' ? 'configuration' : failure.kind,
  };
}
