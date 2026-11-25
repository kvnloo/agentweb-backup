/**
 * ENG-2840 (W2-5a): three lead reads that Emma has and the MCP server did not: `get_lead_details`, `get_lead_engagements` and
 * `get_lead_list_statuses`.
 *
 * `manage_leads get` returns the stored lead (including its pipeline status and deal value). Emma's `get_lead_details` returns a different
 * projection: the profile, drafts, opt-out state, enrichment sources, an engagement summary, the recent engagements and the LinkedIn
 * connection status (no pipeline status, no deal value, and none of website, domain, role, lifecycle, priority, heat score or expected close
 * date), and it searches the caller's other accessible lists (best effort, the first 200) when the lead is not in the list asked for, provided
 * that list exists and is accessible. `get_lead_engagements` (the history of one lead; no such search) and `get_lead_list_statuses` (the
 * pipeline stages, including the default a list that never stored its own uses) have no MCP twin at all.
 *
 * Same pattern as the other wave-2 tools: the handler checks the arguments by NAME (the MCP path validates nothing against the input
 * schema) and then calls the portal's own route through `mcpFetch`, as the key's own user. The route's guard (`canOrgMemberAccessList`: the
 * list owner, the organization's owner and listed CRM editors, and any member of the owner's organization while the organization shares its
 * CRM) is the only tenant check; nothing here replaces it, and no identity is ever read from an argument.
 *
 * One thing differs from the CRM routes: `/api/emma/*` answers a refusal as HTTP 200 with `{ success: false, message }` (Emma's own tools
 * read it that way). `mcpFetch` would pass that on as data, and an agent must never read "Access denied" as an answer, so `requireSuccess`
 * turns it into an error. The route's `error` field is not repeated: on an internal failure it holds the raw exception text. A 5xx from the
 * route itself (its catch-all answers with the exception's message) and a failure to reach it (the message names the internal route and
 * port) are replaced by a fixed text for the same reason; a 4xx (a 429 for an account over its monthly quota, a 400 for a missing id)
 * carries the route's own short words and passes through.
 *
 * Not offered, on purpose (W2-5a design, brain `eng-2840-w25a-lead-reads-design-2026-11-25.md`): `get_hot_leads`,
 * `get_leads_needing_followup`, `get_lead_conversation_statuses` (each reloads the whole email history of the account's domain per call),
 * `analyze_crm_data` and `ask_crm` (they spend the platform's model key), `log_contact_event` (it writes to a global table keyed by an email
 * taken from the argument, with no ownership check).
 *
 * Cost and side effects. `get_lead_list_statuses` only reads (it is `readOnly`). The two lead tools are not: a read of a lead's history
 * fetches the body of received or delivered emails that have none stored from the mail provider, with the platform's key, and stores it as a
 * cache. Emma and the portal fetch every missing body at once; through these tools a call fetches at most `LEAD_READ_MAX_CONTENT_FETCHES`
 * (the newest ones; the rest come back without a body until a later call), so one call costs a bounded number of provider requests that
 * a key's rate limit then multiplies, not an unbounded fan-out. `get_lead_details` can also check a connected LinkedIn account. A key that
 * holds only `tools:read` cannot call the two lead tools, the same as `manage_leads` and `search_leads`. The monthly token quota refuses an
 * account that is already over it; these reads spend no tokens, so it does not bound them.
 *
 * Known limit, inherited from the data layer (`crmDb.getLeadEngagements`, `getLeadEngagementCount`) and unchanged here: email events are
 * looked up through the account's legacy single `emailDomain` setting. An account whose sending domains are set up only in the multi-domain
 * setting (`emailDomains[]`), or that sends from a connected mailbox, gets no email events here (LinkedIn and hand-recorded events are always
 * included), so an empty history is not proof that a lead was never emailed. Also inherited: when counting fails the three counts read 0
 * beside the listed events. The descriptions say both.
 */
import { mcpToolRegistry } from './registry';
import { mcpFetch } from './httpClient';
import { ctx, jsonResult } from './toolHelpers';
import { exactArgs } from './memoryTools';

const EMMA_BASE = '/api/emma';
const MAX_ID_CHARS = 200;
const MAX_MESSAGE_CHARS = 200;
/** The most email bodies one call may fetch from the mail provider (the newest ones that have none stored). Emma and the portal have no such bound. */
export const LEAD_READ_MAX_CONTENT_FETCHES = 10;
/** Emma's own bounds (`getLeadEngagements`: `Math.min(Math.max(limit || 20, 1), 100)`); a value outside them is refused, not clamped. */
export const ENGAGEMENTS_DEFAULT_LIMIT = 20;
export const ENGAGEMENTS_MAX_LIMIT = 100;

function refuse(tool: string, message: string): never {
  throw new Error(`${tool}: ${message}`);
}

/**
 * A list or lead id. Ids travel in the request body, not in a path, so nothing here can reach another route; but real ids come from an
 * import or an email key as well as from AgentWeb (`lead_<time>_<random>`), so no stricter shape is required. Text, not empty, no padding,
 * no control characters, at most 200 characters.
 */
function idArg(tool: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') refuse(tool, `${field} is required and must be text.`);
  const id = value as string;
  if (id.length > MAX_ID_CHARS || id !== id.trim() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(id)) {
    refuse(tool, `${field} is not a valid id. Use an id returned by manage_leads, search_leads or list_lead_lists.`);
  }
  return id;
}

/** The request a lead read makes, or the refusal. Pure: nothing is called here. */
export interface LeadReadRequest {
  path: string;
  body: Record<string, unknown>;
}

const DETAILS_INPUTS = ['list_id', 'lead_id'] as const;
const ENGAGEMENTS_INPUTS = ['list_id', 'lead_id', 'limit'] as const;
const STATUSES_INPUTS = ['list_id'] as const;

export function leadDetailsRequest(args: unknown): LeadReadRequest {
  const a = exactArgs('get_lead_details', args, DETAILS_INPUTS);
  return {
    path: `${EMMA_BASE}/lead-details`,
    body: {
      list_id: idArg('get_lead_details', 'list_id', a.list_id),
      lead_id: idArg('get_lead_details', 'lead_id', a.lead_id),
      max_content_fetches: LEAD_READ_MAX_CONTENT_FETCHES,
    },
  };
}

export function leadEngagementsRequest(args: unknown): LeadReadRequest {
  const tool = 'get_lead_engagements';
  const a = exactArgs(tool, args, ENGAGEMENTS_INPUTS);
  const body: Record<string, unknown> = {
    list_id: idArg(tool, 'list_id', a.list_id),
    lead_id: idArg(tool, 'lead_id', a.lead_id),
    max_content_fetches: LEAD_READ_MAX_CONTENT_FETCHES,
  };
  if (a.limit !== undefined && a.limit !== null) {
    if (typeof a.limit !== 'number' || !Number.isInteger(a.limit) || a.limit < 1 || a.limit > ENGAGEMENTS_MAX_LIMIT) {
      refuse(tool, `limit must be a whole number from 1 to ${ENGAGEMENTS_MAX_LIMIT} (default ${ENGAGEMENTS_DEFAULT_LIMIT}).`);
    }
    body.limit = a.limit;
  }
  return { path: `${EMMA_BASE}/lead-engagements`, body };
}

export function leadListStatusesRequest(args: unknown): LeadReadRequest {
  const a = exactArgs('get_lead_list_statuses', args, STATUSES_INPUTS);
  return { path: `${EMMA_BASE}/lead-list-statuses`, body: { list_id: idArg('get_lead_list_statuses', 'list_id', a.list_id) } };
}

/**
 * The route's answer, or an error. Anything that is not `{ success: true, ... }` is a refusal or a failure: only the route's `message`
 * (short, written by the route) is passed on; its `error` field can hold a raw exception text and is dropped.
 */
export function requireSuccess(tool: string, answer: unknown): Record<string, unknown> {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) refuse(tool, 'the CRM gave no answer. No lead or list was changed.');
  const result = answer as Record<string, unknown>;
  if (result.success !== true) {
    const message = typeof result.message === 'string' && result.message.trim() !== '' ? result.message.trim().slice(0, MAX_MESSAGE_CHARS) : 'the request was refused';
    refuse(tool, `${message}.`);
  }
  return result;
}

async function run(tool: string, request: LeadReadRequest, context: any): Promise<unknown> {
  let answer: unknown;
  try {
    answer = await mcpFetch({ method: 'POST', path: request.path, context: ctx(context), body: request.body });
  } catch (err: any) {
    // A 4xx carries the route's own short words (a 429 for an account over its quota, a 400 for a missing id) and passes through. Anything
    // else gets a fixed text: the route's catch-all answers a 5xx with the exception's own message, and a failure to reach the route names
    // the internal route and port.
    const message = String(err?.message ?? '');
    const status = /^API error \((\d{3})\)/.exec(message)?.[1];
    if (status && status.startsWith('4')) throw err;
    refuse(tool, status
      ? `the CRM could not answer (HTTP ${status}). Try again later. No lead or list was changed.`
      : 'the CRM could not be reached. Try again later. No lead or list was changed.');
  }
  return jsonResult(requireSuccess(tool, answer));
}

mcpToolRegistry.register({
  name: 'get_lead_details',
  requiresUserAccount: true,
  definition: {
    name: 'get_lead_details',
    description: "One lead's profile and engagement picture: name, email, phone, company, title, LinkedIn URL, notes, custom fields, ICP match, attribution, opt-out state, a message draft and a 200-character preview of the email draft, enrichment sources, its LinkedIn connection status, engagement counts and its 10 most recent engagements. "
      + 'It does NOT return the pipeline status, the deal value, or fields such as website, domain, role, lifecycle, priority, heat score or expected close date: read the stored lead with manage_leads get for those. '
      + 'list_id and lead_id come from manage_leads list or search_leads. If the lead is not in list_id, a best-effort search of your other accessible lists (the first 200) may find it and return it with a note naming the right list; a capped or failed search reads as Lead not found, so that is not proof the lead does not exist. list_id itself must exist and be one you can access. '
      + 'engagementSummary.total and last7Days count messages SENT; totalAllMessages counts every event; counts that are all 0 beside listed events mean the count failed. '
      + 'Email events are included only for accounts with the legacy single sending-domain setting; an account whose sending domains are set up in the multi-domain setting, or that sends from a connected mailbox, gets LinkedIn and hand-recorded events only, so an empty history does not prove a lead was never emailed. '
      + 'Reading never changes the lead or the list; a read stores, as a cache, the content it fetches from the mail provider for the newest received or delivered emails of the lead that have none stored (at most ' + LEAD_READ_MAX_CONTENT_FETCHES + ' per call; older ones appear without content until a later call), and can check a connected LinkedIn account. '
      + 'Fields named like sessionId, debug, userAgent or ipAddress are removed from answers. '
      + 'Any other argument is refused by name (userId, sessionId and llmModel are ignored by the server).',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The lead list the lead is in' },
        lead_id: { type: 'string', description: 'The lead id' },
      },
      required: ['list_id', 'lead_id'],
    },
  },
  execute: async (args: any, context: any) => run('get_lead_details', leadDetailsRequest(args), context),
});

mcpToolRegistry.register({
  name: 'get_lead_engagements',
  requiresUserAccount: true,
  definition: {
    name: 'get_lead_engagements',
    description: 'The engagement history of one lead, newest first: emails sent and received, LinkedIn messages, and the calls, meetings and notes recorded by hand. '
      + 'limit is a whole number from 1 to ' + ENGAGEMENTS_MAX_LIMIT + ' (default ' + ENGAGEMENTS_DEFAULT_LIMIT + '). '
      + 'Each event has eventType, createdAt, eventData and, for an email whose content is stored, a preview of its first 200 characters (a sent email may have none). '
      + 'To tell whether the page is the whole history, read message (it says "Showing the first N of M" when the page was cut). engagementSummary.total and last7Days count messages SENT; totalAllMessages counts every event; counts that are all 0 beside listed events mean the count failed. '
      + 'Email events are included only for accounts with the legacy single sending-domain setting; an account whose sending domains are set up in the multi-domain setting, or that sends from a connected mailbox, gets LinkedIn and hand-recorded events only, so an empty history does not prove a lead was never emailed. '
      + 'list_id and lead_id come from manage_leads list or search_leads; a list_id that does not contain the lead is refused here (get_lead_details searches your other lists). '
      + 'Reading never changes the lead or the list; a read stores, as a cache, the content it fetches from the mail provider for the newest received or delivered emails of the lead that have none stored (at most ' + LEAD_READ_MAX_CONTENT_FETCHES + ' per call; older ones appear without content until a later call). '
      + 'Fields named like sessionId, debug, userAgent or ipAddress are removed from answers. '
      + 'Any other argument is refused by name (userId, sessionId and llmModel are ignored by the server).',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The lead list the lead is in' },
        lead_id: { type: 'string', description: 'The lead id' },
        limit: { type: 'integer', minimum: 1, maximum: ENGAGEMENTS_MAX_LIMIT, description: `Most events to return (default ${ENGAGEMENTS_DEFAULT_LIMIT})` },
      },
      required: ['list_id', 'lead_id'],
    },
  },
  execute: async (args: any, context: any) => run('get_lead_engagements', leadEngagementsRequest(args), context),
});

mcpToolRegistry.register({
  name: 'get_lead_list_statuses',
  readOnly: true,
  requiresUserAccount: true,
  definition: {
    name: 'get_lead_list_statuses',
    description: 'The pipeline stages a lead list is set up with, and the list name. A list that never stored its own stages answers with the default for its type, which create_lead_list get does not show. '
      + 'list_id comes from list_lead_lists. Reading changes nothing. Any other argument is refused by name (userId, sessionId and llmModel are ignored by the server).',
    inputSchema: {
      type: 'object',
      properties: { list_id: { type: 'string', description: 'The lead list id' } },
      required: ['list_id'],
    },
  },
  execute: async (args: any, context: any) => run('get_lead_list_statuses', leadListStatusesRequest(args), context),
});
