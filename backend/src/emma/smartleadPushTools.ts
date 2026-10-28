import { emmaToolRegistry } from './registry';
import type { ToolContext } from './orgCaller';
import { getSmartleadPushService } from '../services/smartleadPushRuntime';
import * as gate from '../services/smartleadPushApprovalGate';

/**
 * Emma's Smartlead push tools (ENG-673). Whatever the CRM dialog can do, Emma can do, over the SAME service and with the same safeguards:
 * the user's own Smartlead connection only, the whole list previewed and the push limited to what was previewed, the kill switch, the
 * opt-out and own-sender rules. Two things differ because a model is calling rather than a person clicking:
 *
 *  - Starting a push and releasing contacts run only after the person in the chat clicked "approve" on a card whose wording the product built
 *    from live values (smartleadPushApprovalGate.ts). The approval stands in for the portal's lawful-basis tick and its "already sending"
 *    confirmation. The model never sees or supplies the signed preview token; the tool previews itself, on both calls, and an approval is
 *    bound to exactly what the card showed, so anything that changed in between (the list, the campaign's emails, its status) asks again.
 *  - They refuse unattended and scheduled runs and anyone acting on a customer's behalf.
 *
 * Pausing and cancelling make no one receive more email, so they need no approval and work in any run. Resuming continues an already approved
 * push, as in the dialog, and needs an attended chat.
 */

const BAD_ARGS = 'Invalid Smartlead push arguments';

function onlyKeys(args: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error(BAD_ARGS);
  // Models often send null for omitted optionals; treat null as "not provided".
  const entries = Object.entries(args).filter(([, v]) => v !== null);
  if (entries.some(([k]) => !allowed.includes(k))) throw new Error(BAD_ARGS);
  return Object.fromEntries(entries);
}

function userIdOf(context: ToolContext): string {
  const id = context?.userId || context?.agentUserId;
  if (typeof id !== 'string' || !id.trim()) throw new Error('Authentication required');
  return id;
}

const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const RUN_ID = /^[A-Za-z0-9]{10,40}$/;

function idArg(value: unknown, what: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${what} is required`);
  return value;
}

function campaignArg(value: unknown): number {
  const n = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw new Error('campaignId must be a positive whole number (from list_smartlead_campaigns)');
  return n;
}

function runIdArg(value: unknown): string {
  if (typeof value !== 'string' || !RUN_ID.test(value)) throw new Error('runId is required (from get_smartlead_push_status)');
  return value;
}

/** The service's refusals carry a status and a message written for the user: surface them as the tool's error. */
function unwrap<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (result.ok) return result as Extract<T, { ok: true }>;
  const fail = result as unknown as { message?: string; code?: string };
  throw new Error(fail.message || fail.code || 'The Smartlead push request failed');
}

interface PushArgs {
  listId: string;
  campaignId: number;
  includeUnverified: boolean;
  mapping: Record<string, string>;
  acknowledgedTags: string[];
  cohort?: number;
}

const PUSH_KEYS = ['listId', 'campaignId', 'includeUnverified', 'mapping', 'acknowledgedTags', 'cohort', 'confirm'] as const;

function pushArgs(args: unknown): PushArgs {
  const a = onlyKeys(args, PUSH_KEYS);
  const mappingRaw = a.mapping ?? {};
  if (typeof mappingRaw !== 'object' || Array.isArray(mappingRaw) || Object.keys(mappingRaw).length > 50) throw new Error(BAD_ARGS);
  const mapping: Record<string, string> = {};
  for (const [tag, path] of Object.entries(mappingRaw as Record<string, unknown>)) {
    if (typeof path !== 'string' || !tag || tag.length > 100 || !path || path.length > 100) throw new Error(BAD_ARGS);
    mapping[tag] = path;
  }
  const tagsRaw = a.acknowledgedTags ?? [];
  if (!Array.isArray(tagsRaw) || tagsRaw.length > 50 || tagsRaw.some(t => typeof t !== 'string' || !t || t.length > 100)) throw new Error(BAD_ARGS);
  if (a.includeUnverified !== undefined && typeof a.includeUnverified !== 'boolean') throw new Error(BAD_ARGS);
  if (a.cohort !== undefined && (typeof a.cohort !== 'number' || !Number.isSafeInteger(a.cohort) || a.cohort < 1)) throw new Error('cohort must be a positive whole number');
  return {
    listId: idArg(a.listId, 'listId'),
    campaignId: campaignArg(a.campaignId),
    includeUnverified: a.includeUnverified === true,
    mapping,
    acknowledgedTags: tagsRaw as string[],
    ...(a.cohort !== undefined ? { cohort: a.cohort as number } : {}),
  };
}

const pushBody = (p: PushArgs) => ({
  listId: p.listId,
  campaignId: p.campaignId,
  includeUnverified: p.includeUnverified,
  mapping: p.mapping,
  acknowledgedTags: p.acknowledgedTags,
  ...(p.cohort !== undefined ? { cohort: p.cohort } : {}),
});

/** What the model is told about a preview: numbers and findings, never the signed token. */
function previewSummary(p: any) {
  return {
    campaign: p.campaign,
    emailStepsInCampaignSequence: p.sequence.stepCount,
    list: p.list,
    cohort: p.cohort,
    blocks: p.preflight.blocks,
    warnings: p.preflight.warnings,
    fieldsToDecide: p.preflight.tagsToMap,
    campaignAlreadySending: p.requiresActiveConfirmation === true,
    canStart: p.canStart === true,
  };
}

const PUSH_PROPERTIES = {
  listId: { type: 'string', description: 'The CRM list to push (its id from get_lead_lists).' },
  campaignId: { type: 'number', description: "The id of one of the user's own Smartlead campaigns (from list_smartlead_campaigns)." },
  includeUnverified: { type: 'boolean', description: 'Also push contacts whose email is not verified. Default false; do not turn this on unless the user asks.' },
  mapping: { type: 'object', additionalProperties: { type: 'string' }, description: 'For a merge field the campaign uses that is not a standard one: its name mapped to the CRM field that fills it, from fieldsToDecide in the preview.' },
  acknowledgedTags: { type: 'array', items: { type: 'string' }, description: 'Merge fields the user said Smartlead fills in itself. Only what the user said.' },
  cohort: { type: 'number', description: 'How many contacts to add now (default: the preview\'s suggestion, 50 for a first push).' },
} as const;

async function attendedSession(context: ToolContext) {
  const sessionId = typeof context?.sessionId === 'string' ? context.sessionId : undefined;
  const { chatbotDb } = await import('../services/chatbotService');
  const session = sessionId ? await chatbotDb.getChatSession(sessionId, true).catch(() => null) : null;
  const attended = gate.checkAttended({
    unattended: context?.isUnattendedRun === true,
    delegated: context?.isDelegatedAccess === true || context?.isDelegatedAdmin === true,
    sessionId,
    session,
  });
  if (!attended.allowed) throw new Error(attended.reason);
  return { attended, chatbotDb };
}

/**
 * Returns the approval card (a halt) unless the user already approved this exact action in this chat; in that case the approval is claimed
 * (single use) and the caller may act. A claim that is lost, or a crash after it, costs the approval and never allows a second action.
 */
async function requireApproval(p: {
  context: ToolContext;
  action: gate.SmartleadApprovalAction;
  digestFor: (sessionId: string) => string;
  question: (kind: string) => ReturnType<typeof gate.buildPushQuestion>;
}): Promise<Record<string, unknown> | undefined> {
  const { attended, chatbotDb } = await attendedSession(p.context);
  const { sessionId, session } = attended;
  const digest = p.digestFor(sessionId);
  const consumedKinds = new Set(Object.keys(session.consumedMetaWriteManifestDigests ?? {})
    .filter(k => k.startsWith(gate.SMARTLEAD_CONSUMED_KEY_PREFIX)).map(k => k.slice(gate.SMARTLEAD_CONSUMED_KEY_PREFIX.length)));
  const found = gate.findApproval(session.messages, gate.approvalKindPrefix(p.action, digest), Date.now(), consumedKinds);
  if (found.status === 'none') {
    const question = p.question(gate.newApprovalKind(p.action, digest));
    return {
      success: true,
      awaitingUserConfirmation: true,
      type: 'ask_user_question',
      sessionId,
      questionDeckPayload: [question],
      confirmationPrompt: question.question,
      summary: question.question,
      message: 'Nothing was done yet. The run stops here until the user answers the card. After they approve, call this tool again with the same arguments; do not ask them in text.',
    };
  }
  if (!(await chatbotDb.claimMetaWriteManifestDigest(sessionId, gate.consumedKeyOf(found.kind)))) {
    throw new Error('This approval was already used. Nothing was done; ask again to get a new approval card.');
  }
  return undefined;
}

emmaToolRegistry.register({
  name: 'list_smartlead_campaigns',
  definition: {
    name: 'list_smartlead_campaigns',
    description: "List the campaigns in the user's own connected Smartlead account, with their status and whether leads can be added to them. Smartlead sends the emails; the user makes and starts campaigns in Smartlead. Use this to let the user pick a campaign before push preview.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  execute: async (args: unknown, context?: ToolContext) => {
    onlyKeys(args, []);
    const { campaigns } = unwrap(await getSmartleadPushService().campaigns(userIdOf(context)));
    return { success: true, campaigns };
  },
});

emmaToolRegistry.register({
  name: 'preview_smartlead_push',
  definition: {
    name: 'preview_smartlead_push',
    description: "Check what pushing a CRM list into one of the user's Smartlead campaigns would do, without changing anything: how many contacts can be added, why others are skipped (no email, unverified, do not contact, already pushed, a field the campaign uses is empty), the campaign's own warnings, and which merge fields in the campaign need a decision. Always do this before start_smartlead_push, and tell the user the numbers.",
    inputSchema: { type: 'object', properties: PUSH_PROPERTIES, required: ['listId', 'campaignId'], additionalProperties: false },
  },
  execute: async (args: unknown, context?: ToolContext) => {
    const p = pushArgs(args);
    const { preview } = unwrap(await getSmartleadPushService().preview(userIdOf(context), pushBody(p)));
    return { success: true, preview: previewSummary(preview) };
  },
});

emmaToolRegistry.register({
  name: 'start_smartlead_push',
  definition: {
    name: 'start_smartlead_push',
    description: "Add contacts from a CRM list to one of the user's Smartlead campaigns. Smartlead then sends the emails; this only adds the contacts. This leads to real people being emailed, so the user approves on a card built from the live numbers: this tool first stops and shows that card, and adds nothing until the user clicks approve. Then call it again with the same arguments (it previews again; if anything changed since the card, a new card is shown). Run preview_smartlead_push first and resolve any blocks or fieldsToDecide with the user. The push runs in the background; use get_smartlead_push_status for progress.",
    inputSchema: {
      type: 'object',
      properties: { ...PUSH_PROPERTIES, confirm: { type: 'boolean', description: 'Ignored. The user approves on the approval card, not through this argument.' } },
      required: ['listId', 'campaignId'],
      additionalProperties: false,
    },
  },
  execute: async (args: unknown, context?: ToolContext) => {
    const p = pushArgs(args);
    const userId = userIdOf(context);
    const svc = getSmartleadPushService();
    // Refuse before anything is previewed or asked when nobody can approve.
    await attendedSession(context);
    const { listName } = unwrap(await svc.canUseList(userId, p.listId));
    const { preview } = unwrap(await svc.preview(userId, pushBody(p)));
    if (!preview.canStart) {
      return { success: false, started: false, message: 'Nothing was added: the preview found something to fix first.', preview: previewSummary(preview) };
    }
    const halt = await requireApproval({
      context,
      action: 'push',
      digestFor: sessionId => gate.computePushDigest({
        userId, sessionId, listId: p.listId, campaignId: p.campaignId, campaignStatus: String(preview.campaign.status ?? ''),
        sequenceHash: preview.sequence.hash, cohort: preview.cohort.chosen, eligible: preview.list.eligible, includeUnverified: p.includeUnverified,
        requiresActiveConfirmation: preview.requiresActiveConfirmation === true, mapping: p.mapping, acknowledgedTags: p.acknowledgedTags,
        fingerprint: preview.fingerprint,
      }),
      question: kind => gate.buildPushQuestion({
        kind, listName, campaignName: preview.campaign.name, campaignStatus: String(preview.campaign.status ?? ''),
        cohort: preview.cohort.chosen, eligible: preview.list.eligible, listTotal: preview.list.total,
        requiresActiveConfirmation: preview.requiresActiveConfirmation === true, smartleadFilledTags: p.acknowledgedTags, includeUnverified: p.includeUnverified, mapping: p.mapping,
      }),
    });
    if (halt) return halt;
    const started = unwrap(await svc.start(userId, {
      token: preview.token,
      acknowledgements: { lawfulBasis: true, ...(preview.requiresActiveConfirmation ? { activeConfirmed: true } : {}) },
    }, { channel: 'agent' }));
    return {
      success: true,
      started: started.started,
      campaign: { ...preview.campaign, emailStepsInCampaignSequence: preview.sequence.stepCount },
      run: started.run,
      message: started.started ? 'The push is running in the background. Use get_smartlead_push_status for progress.' : 'A push to this campaign for this list was already running; it was not started twice.',
    };
  },
});

emmaToolRegistry.register({
  name: 'get_smartlead_push_status',
  definition: {
    name: 'get_smartlead_push_status',
    description: 'Progress of a Smartlead push (how many contacts were added, whether it is running, paused or finished, and why it paused), or the recent pushes for a CRM list. Give runId for one push, or listId for the list\'s recent pushes.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' }, listId: { type: 'string' } }, additionalProperties: false },
  },
  execute: async (args: unknown, context?: ToolContext) => {
    const a = onlyKeys(args, ['runId', 'listId']);
    const svc = getSmartleadPushService();
    const userId = userIdOf(context);
    if (a.runId !== undefined) return { success: true, ...unwrap(await svc.status(userId, runIdArg(a.runId))) };
    if (a.listId !== undefined) return { success: true, ...unwrap(await svc.history(userId, idArg(a.listId, 'listId'))) };
    throw new Error('Give a runId or a listId');
  },
});

for (const action of ['pause', 'resume', 'cancel'] as const) {
  emmaToolRegistry.register({
    name: `${action}_smartlead_push`,
    definition: {
      name: `${action}_smartlead_push`,
      description: action === 'pause'
        ? 'Pause a running Smartlead push; contacts already added stay in Smartlead. It can be resumed.'
        : action === 'resume'
          ? 'Resume a paused Smartlead push; it carries on with the contacts that were approved, no more.'
          : 'Cancel a Smartlead push for good; contacts already added stay in Smartlead (they can be removed there).',
      inputSchema: { type: 'object', properties: { runId: { type: 'string', description: 'The push (from get_smartlead_push_status).' } }, required: ['runId'], additionalProperties: false },
    },
    execute: async (args: unknown, context?: ToolContext) => {
      const { runId } = onlyKeys(args, ['runId']);
      const userId = userIdOf(context);
      // Pausing and cancelling make no one receive more email, so any run may do them; resuming carries on sending and needs a person present.
      if (action === 'resume') await attendedSession(context);
      const svc = getSmartleadPushService();
      const id = runIdArg(runId);
      const result = action === 'pause' ? await svc.pause(userId, id) : action === 'resume' ? await svc.resume(userId, id) : await svc.cancel(userId, id);
      return { success: true, ...unwrap(result) };
    },
  });
}

emmaToolRegistry.register({
  name: 'release_leads_from_smartlead',
  definition: {
    name: 'release_leads_from_smartlead',
    description: "Give contacts that were pushed to a Smartlead campaign back to AgentWeb's own senders, so AgentWeb may email them again. It changes nothing in Smartlead and the campaign may keep emailing them, so they could get email from two places; contacts who opted out stay blocked. The user approves on a card: this tool first stops and shows it, and releases nothing until the user clicks approve; then call it again with the same arguments. Only use the contact ids the user chose.",
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string' },
        leadIds: { type: 'array', items: { type: 'string' }, description: 'The ids of the contacts the user chose (at most 500).' },
        campaignId: { type: 'number', description: 'Limit the release to one Smartlead campaign (optional).' },
        confirm: { type: 'boolean', description: 'Ignored. The user approves on the approval card, not through this argument.' },
      },
      required: ['listId', 'leadIds'],
      additionalProperties: false,
    },
  },
  execute: async (args: unknown, context?: ToolContext) => {
    const a = onlyKeys(args, ['listId', 'leadIds', 'campaignId', 'confirm']);
    const listId = idArg(a.listId, 'listId');
    const ids = a.leadIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || ids.some(i => typeof i !== 'string' || !ID.test(i))) throw new Error('Give between 1 and 500 contact ids');
    const campaignId = a.campaignId === undefined ? null : campaignArg(a.campaignId);
    const userId = userIdOf(context);
    const svc = getSmartleadPushService();
    await attendedSession(context);
    const { listName } = unwrap(await svc.canUseList(userId, listId));
    const distinct = [...new Set(ids as string[])];
    const { emails: sample } = unwrap(await svc.sampleLeads(userId, listId, distinct));
    const halt = await requireApproval({
      context,
      action: 'release',
      digestFor: sessionId => gate.computeReleaseDigest({ userId, sessionId, listId, campaignId, leadIds: distinct }),
      question: kind => gate.buildReleaseQuestion({ kind, listName, count: distinct.length, campaignId, sample }),
    });
    if (halt) return halt;
    const released = unwrap(await svc.release(userId, { listId, leadIds: distinct, ...(campaignId ? { campaignId } : {}) }));
    return { success: true, released: released.released, skipped: released.skipped };
  },
});
