/**
 * ENG-2840 (W2-5a): three lead reads that Emma has and the MCP server did not: `get_lead_details`, `get_lead_engagements` and
 * `get_lead_list_statuses`.
 *
 * `manage_leads get` returns the stored lead (including its pipeline status and deal value). Emma's `get_lead_details` returns a different
 * projection: the profile, drafts, opt-out state, enrichment sources, an engagement summary, the recent engagements and the LinkedIn
 * connection status (no pipeline status, no deal value), and it finds the lead when the list id is stale but the list itself exists and is
 * accessible. `get_lead_engagements` (the history of one lead; no stale-list recovery) and `get_lead_list_statuses` (the pipeline stages,
 * including the default a list that never stored its own uses) have no MCP twin at all.
 *
 * Same pattern as the other wave-2 tools: the handler checks the arguments by NAME (the MCP path validates nothing against the input
 * schema) and then calls the portal's own route through `mcpFetch`, as the key's own user. The route's guard (`canOrgMemberAccessList`: the
 * list owner, or a member of the owner's organization while the organization shares its CRM) is the only tenant check; nothing here
 * replaces it, and no identity is ever read from an argument.
 *
 * One thing differs from the CRM routes: `/api/emma/*` answers a refusal as HTTP 200 with `{ success: false, message }` (Emma's own tools
 * read it that way). `mcpFetch` would pass that on as data, and an agent must never read "Access denied" as an answer, so `requireSuccess`
 * turns it into an error. The route's `error` field is not repeated: on an internal failure it holds the raw exception text. A 5xx from the
 * route itself (its catch-all answers with the exception's message) is replaced by a fixed text for the same reason; a 4xx (a 429 for an
 * account over its monthly quota, a 400 for a missing id) carries the route's own short words and passes through.
 *
 * Not offered, on purpose (W2-5a design, brain `eng-2840-w25a-lead-reads-design-2026-11-25.md`): `get_hot_leads`,
 * `get_leads_needing_followup`, `get_lead_conversation_statuses` (each reloads the whole email history of the account's domain per call),
 * `analyze_crm_data` and `ask_crm` (they spend the platform's model key), `log_contact_event` (it writes to a global table keyed by an email
 * taken from the argument, with no ownership check).
 *
 * "Read" is meant as: nothing in the lead or the list changes. The first read of a lead's history fetches, for every email event of that lead
 * that has no content stored yet, the content from the mail provider (all at once, with the platform's key) and stores it as a cache, and
 * `get_lead_details` can check a connected LinkedIn account. Those costs are Emma's and the portal's own, now reachable by a key; the key's
 * rate limit and the monthly token quota are the only bounds. That is why these tools are not flagged `readOnly`: a key that holds only
 * `tools:read` cannot call them, the same as `manage_leads` and `search_leads`.
 *
 * Known limit, inherited from the data layer (`crmDb.getLeadEngagements`, `getLeadEngagementCount`): email events are looked up through the
 * account's single legacy `emailDomain` setting. An account whose sending domain is stored only in `emailDomains[]`, or that sends from a
 * connected mailbox, gets no email events here (LinkedIn and hand-recorded events are always included), so an empty history is not proof that a
 * lead was never emailed. The descriptions say so.
 */
import { mcpToolRegistry } from './registry';
import { mcpFetch } from './httpClient';
import { ctx, jsonResult } from './toolHelpers';
import { exactArgs } from './memoryTools';

const EMMA_BASE = '/api/emma';
const MAX_ID_CHARS = 200;
const MAX_MESSAGE_CHARS = 200;
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
    body: { list_id: idArg('get_lead_details', 'list_id', a.list_id), lead_id: idArg('get_lead_details', 'lead_id', a.lead_id) },
  };
}

export function leadEngagementsRequest(args: unknown): LeadReadRequest {
  const tool = 'get_lead_engagements';
  const a = exactArgs(tool, args, ENGAGEMENTS_INPUTS);
  const body: Record<string, unknown> = { list_id: idArg(tool, 'list_id', a.list_id), lead_id: idArg(tool, 'lead_id', a.lead_id) };
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
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) refuse(tool, 'the CRM gave no answer. Nothing was changed.');
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
    // the route's catch-all answers a 5xx with the exception's own message; the agent gets a fixed text instead
    const status = /^API error \((5\d\d)\)/.exec(String(err?.message ?? ''))?.[1];
    if (status) refuse(tool, `the CRM could not answer (HTTP ${status}). Try again later; nothing was changed.`);
    throw err;
  }
  return jsonResult(requireSuccess(tool, answer));
}

mcpToolRegistry.register({
  name: 'get_lead_details',
  requiresUserAccount: true,
  definition: {
    name: 'get_lead_details',
    description: 'One lead\'s profile and engagement picture: name, email, phone, company, title, LinkedIn, notes, custom fields, ICP match, attribution, opt-out state, email and message drafts, enrichment sources, its LinkedIn connection status, engagement counts and its 10 most recent engagements. '
      + 'It does NOT return the pipeline status or the deal value: read those with manage_leads get. '
      + 'list_id and lead_id come from manage_leads list or search_leads. If the lead is not in list_id but is in another list you can access, it is returned with a note naming the right list (list_id itself must exist and be one you can access). '
      + 'engagementSummary.total and last7Days count messages SENT; totalAllMessages counts every event. '
      + "Email events are found through the account's sending-domain setting: an account that sends from a connected mailbox, or has no sending domain set that way, shows no email events here, so an empty history does not prove a lead was never emailed. "
      + "Reading never changes the lead; a first read of a lead's history fetches the content of every email event that has none stored yet from the mail provider, all at once, and stores it, and a LinkedIn lead can trigger a check of the connected account. "
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
      + `limit is a whole number from 1 to ${ENGAGEMENTS_MAX_LIMIT} (default ${ENGAGEMENTS_DEFAULT_LIMIT}). `
      + 'Each event has eventType, createdAt, eventData and, for an email, a preview of its first 200 characters. '
      + 'To tell whether the page is the whole history, read message (it says "Showing the first N of M" when the page was cut) or engagementSummary.totalAllMessages; engagementSummary.total and last7Days count messages SENT only. '
      + "Email events are found through the account's sending-domain setting: an account that sends from a connected mailbox, or has no sending domain set that way, shows no email events here, so an empty history does not prove a lead was never emailed. "
      + 'list_id and lead_id come from manage_leads list or search_leads; a list_id that does not contain the lead is refused here (get_lead_details finds a lead in another of your lists). '
      + "Reading never changes the lead; a first read of a lead's history fetches the content of every email event that has none stored yet from the mail provider, all at once, and stores it, and a LinkedIn lead can trigger a check of the connected account. "
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
  requiresUserAccount: true,
  definition: {
    name: 'get_lead_list_statuses',
    description: 'The pipeline stages a lead list is set up with, and the list name. A list that never stored its own stages answers with the default for its type, which create_lead_list get does not show. '
      + 'list_id comes from list_lead_lists. ' + 'Any other argument is refused by name (userId, sessionId and llmModel are ignored by the server).',
    inputSchema: {
      type: 'object',
      properties: { list_id: { type: 'string', description: 'The lead list id' } },
      required: ['list_id'],
    },
  },
  execute: async (args: any, context: any) => run('get_lead_list_statuses', leadListStatusesRequest(args), context),
});
