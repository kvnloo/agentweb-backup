/**
 * Smartlead tools for outside agents over MCP (the Hermes agents: Yugo, Hue, Remy), on the user's OWN Smartlead connection.
 *
 * Same names and same checks as Emma's tools (emma/smartleadPushTools.ts, helpers in services/smartleadPushToolShared.ts), over the same
 * REST routes the portal uses (routes/smartleadPush.ts), so the per-user rate limits, the kill switch and every push rule apply unchanged.
 *
 * What an agent may do here:
 *  - read (`smartlead:read`): list campaigns, a campaign's numbers, preview a push, follow a push;
 *  - stop (`smartlead:control`): pause or cancel a push. Both make nobody receive more email.
 *
 * What it may not: start, resume or release a push. Those send email to real people (or let AgentWeb's own senders email them again), and
 * the person who owns the account approves them in the portal's Push to Smartlead dialog (lawful basis, a campaign already sending, a
 * campaign with no unsubscribe link). In Emma's chat a product-built approval card does that job; an MCP agent has no card, so the preview
 * returns a link to the list and the steps instead, and never the signed preview token that /start accepts.
 *
 * Only `aw_` keys that explicitly hold the scope may call these (`apiKeyOnly`): a signed-in OAuth client, marketplace clients included,
 * is refused, and default keys do not hold the scopes.
 */
import { mcpToolRegistry } from './registry';
import { mcpFetch } from './httpClient';
import { ctx, jsonResult } from './toolHelpers';
import { API_KEY_SCOPE_SMARTLEAD_CONTROL, API_KEY_SCOPE_SMARTLEAD_READ } from './apiKeyScopes';
import {
  campaignArg, campaignStatsSummary, idArg, onlyKeys, previewSummary, pushArgs, pushBody, runIdArg,
} from '../../services/smartleadPushToolShared';

const BASE = '/api/crm/smartlead-push';

/** The tools an outside agent never gets: each sends email or lets AgentWeb's senders email contacts again. */
export const SMARTLEAD_TOOLS_NOT_ON_MCP = ['start_smartlead_push', 'resume_smartlead_push', 'release_leads_from_smartlead'] as const;

function portalBase(): string {
  return (process.env.CUSTOMER_FRONTEND_URL || 'https://app.agentweb.pro').replace(/\/$/, '');
}

/** Where a person approves a push: the list in the CRM, then its settings menu. */
export function listPushLink(listId: string): string {
  return `${portalBase()}/crm?listId=${encodeURIComponent(listId)}`;
}

const ACCOUNT_ID = {
  type: 'string',
  description: "Which Smartlead connection to use, only when more than one is available (the error lists them); by default the user's own, else the one a teammate shared.",
};
const CAMPAIGN_ID = { type: 'number', description: "The id of one of the user's Smartlead campaigns (from list_smartlead_campaigns)." };
const RUN_ID_PROP = { type: 'string', description: 'The push (from get_smartlead_push_status with a listId).' };

type Gate = typeof API_KEY_SCOPE_SMARTLEAD_READ | typeof API_KEY_SCOPE_SMARTLEAD_CONTROL;

function register(p: {
  name: string;
  scope: Gate;
  readOnly: boolean;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: unknown, context: any) => Promise<unknown>;
}) {
  mcpToolRegistry.register({
    name: p.name,
    readOnly: p.readOnly,
    requiredScope: p.scope,
    apiKeyOnly: true,
    requiresUserAccount: true,
    definition: { name: p.name, description: p.description, inputSchema: p.inputSchema },
    execute: async (args: any, context: any) => {
      const audit = (outcome: 'ok' | 'error', error?: string) =>
        console.info(JSON.stringify({
          event: 'mcp_smartlead',
          tool: p.name,
          userId: context?.userId,
          apiKeyId: context?.apiKeyId,
          external: context?.externalMcp === true,
          outcome,
          ...(error ? { error } : {}),
        }));
      try {
        const result = await p.run(args, context);
        audit('ok');
        return jsonResult(result);
      } catch (err: any) {
        audit('error', String(err?.message ?? err).slice(0, 300));
        throw err;
      }
    },
  });
}

register({
  name: 'list_smartlead_campaigns',
  scope: API_KEY_SCOPE_SMARTLEAD_READ,
  readOnly: true,
  description:
    "List the campaigns in the user's own connected Smartlead account, with their status and whether leads can be added to them. " +
    'Read only. Smartlead does the sending; AgentWeb never sends these emails.',
  inputSchema: { type: 'object', properties: { accountId: ACCOUNT_ID }, additionalProperties: false },
  run: async (args, context) => {
    const a = onlyKeys(args, ['accountId']);
    const accountId = a.accountId === undefined ? undefined : idArg(a.accountId, 'accountId');
    const data = await mcpFetch({ method: 'GET', path: `${BASE}/campaigns`, context: ctx(context), ...(accountId ? { queryParams: { accountId } } : {}) });
    return { smartleadAccount: data?.connection, campaigns: data?.campaigns ?? [] };
  },
});

register({
  name: 'get_smartlead_campaign_stats',
  scope: API_KEY_SCOPE_SMARTLEAD_READ,
  readOnly: true,
  description:
    "How one of the user's Smartlead campaigns is doing, as Smartlead counts it: contacts emailed, emails sent (follow-ups included), " +
    'replies, bounces and unsubscribes. Read only. Opens and clicks are not reported, and the counts can lag a few minutes behind a recent push or send.',
  inputSchema: { type: 'object', properties: { campaignId: CAMPAIGN_ID, accountId: ACCOUNT_ID }, required: ['campaignId'], additionalProperties: false },
  run: async (args, context) => {
    const a = onlyKeys(args, ['campaignId', 'accountId']);
    const campaignId = campaignArg(a.campaignId);
    const accountId = a.accountId === undefined ? undefined : idArg(a.accountId, 'accountId');
    const data = await mcpFetch({
      method: 'GET', path: `${BASE}/campaigns/${campaignId}/stats`, context: ctx(context), ...(accountId ? { queryParams: { accountId } } : {}),
    });
    return { smartleadAccount: data?.connection, ...campaignStatsSummary(data.stats) };
  },
});

register({
  name: 'preview_smartlead_push',
  scope: API_KEY_SCOPE_SMARTLEAD_READ,
  readOnly: true,
  description:
    "Check what pushing a CRM list into one of the user's Smartlead campaigns would do, without changing anything: how many contacts " +
    'can be added, why others are skipped, what blocks the push and what needs a decision. Read only. An agent cannot start the push: ' +
    'the result has a link where the person who owns the account reviews and approves it in AgentWeb.',
  inputSchema: {
    type: 'object',
    properties: {
      listId: { type: 'string', description: 'The CRM list to push (its id from list_lead_lists).' },
      campaignId: CAMPAIGN_ID,
      accountId: ACCOUNT_ID,
      includeUnverified: { type: 'boolean', description: 'Also count contacts whose email is not verified. Default false; only when the user asks.' },
      mapping: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'For a merge field the campaign uses that is not a standard one: its name mapped to the CRM field that fills it, only as the user said.',
      },
      acknowledgedTags: { type: 'array', items: { type: 'string' }, description: 'Merge fields the user said Smartlead fills in itself. Only what the user said.' },
      cohort: { type: 'number', description: "How many contacts to add (default: the preview's suggestion, 50 for a first push)." },
    },
    required: ['listId', 'campaignId'],
    additionalProperties: false,
  },
  run: async (args, context) => {
    const p = pushArgs(args);
    const data = await mcpFetch({ method: 'POST', path: `${BASE}/preview`, context: ctx(context), body: pushBody(p) });
    // An allowlist of numbers and findings: the signed token and fingerprint that /start accepts never leave this function.
    const preview = previewSummary(data.preview);
    const link = listPushLink(p.listId);
    return {
      preview,
      approveIn: link,
      nextStep: preview.canStart
        ? `Nothing was pushed. To push, the person who owns the account opens ${link}, opens the list's settings menu, chooses "Push to Smartlead", picks this campaign and approves there.`
        : `Nothing was pushed, and this push cannot start yet: see blocks and fieldsToDecide. Once they are resolved, the person who owns the account approves it at ${link} (the list's settings menu, "Push to Smartlead").`,
    };
  },
});

register({
  name: 'get_smartlead_push_status',
  scope: API_KEY_SCOPE_SMARTLEAD_READ,
  readOnly: true,
  description:
    "Progress of a Smartlead push (how many contacts were added, whether it is running, paused or finished, and why it paused), or a CRM list's " +
    'recent pushes. Give runId for one push, or listId for the list. Read only.',
  inputSchema: {
    type: 'object',
    properties: { runId: { type: 'string', description: 'One push.' }, listId: { type: 'string', description: "A CRM list (from list_lead_lists): its recent pushes." } },
    additionalProperties: false,
  },
  run: async (args, context) => {
    const a = onlyKeys(args, ['runId', 'listId']);
    if (a.runId !== undefined) {
      return mcpFetch({ method: 'GET', path: `${BASE}/runs/${encodeURIComponent(runIdArg(a.runId))}`, context: ctx(context) });
    }
    if (a.listId !== undefined) {
      return mcpFetch({ method: 'GET', path: `${BASE}/lists/${encodeURIComponent(idArg(a.listId, 'listId'))}/runs`, context: ctx(context) });
    }
    throw new Error('Give a runId or a listId');
  },
});

for (const action of ['pause', 'cancel'] as const) {
  register({
    name: `${action}_smartlead_push`,
    scope: API_KEY_SCOPE_SMARTLEAD_CONTROL,
    readOnly: false,
    description: action === 'pause'
      ? 'Pause a running Smartlead push; contacts already added stay in Smartlead. Only the person who owns the account can resume it, in AgentWeb.'
      : 'Cancel a Smartlead push for good; contacts already added stay in Smartlead (they can be removed there).',
    inputSchema: { type: 'object', properties: { runId: RUN_ID_PROP }, required: ['runId'], additionalProperties: false },
    run: async (args, context) => {
      const { runId } = onlyKeys(args, ['runId']);
      return mcpFetch({ method: 'POST', path: `${BASE}/runs/${encodeURIComponent(runIdArg(runId))}/${action}`, context: ctx(context) });
    },
  });
}
