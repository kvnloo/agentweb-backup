import { emmaToolRegistry } from './registry';
import type { ToolContext } from './orgCaller';
import { getSmartleadPushService } from '../services/smartleadPushRuntime';
import * as gate from '../services/smartleadPushApprovalGate';
import {
  ID, STATS_LAG_NOTE, campaignArg, campaignStatsSummary, idArg, onlyKeys, previewSummary, pushArgs, pushBody, runIdArg, unwrap,
} from '../services/smartleadPushToolShared';

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

function userIdOf(context: ToolContext): string {
  const id = context?.userId || context?.agentUserId;
  if (typeof id !== 'string' || !id.trim()) throw new Error('Authentication required');
  return id;
}


const PUSH_PROPERTIES = {
  listId: { type: 'string', description: 'The CRM list to push (its id from get_lead_lists).' },
  campaignId: { type: 'number', description: "The id of one of the campaigns in the user's Smartlead account (from list_smartlead_campaigns)." },
  accountId: { type: 'string', description: "Which Smartlead connection to use, only when more than one is available (the error lists them); by default the user's own, else the one a teammate shared." },
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
    inputSchema: { type: 'object', properties: { accountId: PUSH_PROPERTIES.accountId }, additionalProperties: false },
  },
  execute: async (args: unknown, context?: ToolContext) => {
    const a = onlyKeys(args, ['accountId']);
    const { campaigns, connection } = unwrap(await getSmartleadPushService().campaigns(userIdOf(context), a.accountId === undefined ? undefined : idArg(a.accountId, 'accountId')));
    return { success: true, smartleadAccount: connection, campaigns };
  },
});


emmaToolRegistry.register({
  name: 'get_smartlead_campaign_stats',
  definition: {
    name: 'get_smartlead_campaign_stats',
    description: "How one of the user's Smartlead campaigns is doing, as Smartlead counts it: contacts emailed, emails sent (follow-ups included), replies, bounces and unsubscribes. Read only; nothing is changed. Use list_smartlead_campaigns to find the campaign id. Opens and clicks are not reported. " + STATS_LAG_NOTE + " Say so when the user has just pushed or sent.",
    inputSchema: { type: 'object', properties: { campaignId: PUSH_PROPERTIES.campaignId, accountId: PUSH_PROPERTIES.accountId }, required: ['campaignId'], additionalProperties: false },
  },
  execute: async (args: unknown, context?: ToolContext) => {
    const a = onlyKeys(args, ['campaignId', 'accountId']);
    const { stats, connection } = unwrap(await getSmartleadPushService().campaignStats(userIdOf(context), campaignArg(a.campaignId), a.accountId === undefined ? undefined : idArg(a.accountId, 'accountId')));
    return {
      success: true,
      smartleadAccount: connection,
      ...campaignStatsSummary(stats),
    };
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
        requiresActiveConfirmation: preview.requiresActiveConfirmation === true, requiresUnsubscribeAcknowledgement: preview.requiresUnsubscribeAcknowledgement === true, mapping: p.mapping, acknowledgedTags: p.acknowledgedTags,
        fingerprint: preview.fingerprint,
      }),
      question: kind => gate.buildPushQuestion({
        kind, listName, campaignName: preview.campaign.name, campaignStatus: String(preview.campaign.status ?? ''),
        cohort: preview.cohort.chosen, eligible: preview.list.eligible, listTotal: preview.list.total,
        requiresActiveConfirmation: preview.requiresActiveConfirmation === true, requiresUnsubscribeAcknowledgement: preview.requiresUnsubscribeAcknowledgement === true, smartleadFilledTags: p.acknowledgedTags, includeUnverified: p.includeUnverified, mapping: p.mapping, connection: { name: preview.connection.name, shared: preview.connection.shared },
      }),
    });
    if (halt) return halt;
    const started = unwrap(await svc.start(userId, {
      token: preview.token,
      acknowledgements: { lawfulBasis: true, ...(preview.requiresActiveConfirmation ? { activeConfirmed: true } : {}), ...(preview.requiresUnsubscribeAcknowledgement ? { noUnsubscribeAccepted: true } : {}) },
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
    // Sorted, so the contacts the card names are not the ones the model chose to list first.
    const distinct = [...new Set(ids as string[])].sort();
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
