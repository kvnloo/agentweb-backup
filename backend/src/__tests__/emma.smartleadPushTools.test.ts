// ENG-673: Emma's Smartlead push tools. Whatever the CRM dialog can do Emma can do, over the same service; the difference is that starting a push
// and releasing contacts run only after the person in the chat approved a card built from live values, and the model never holds the signed token.
type Tool = { name: string; definition: { description: string; inputSchema: { properties: Record<string, unknown> } }; execute: (args: unknown, context: unknown) => Promise<Record<string, any>> };
const handlers = new Map<string, Tool>();
jest.mock('../emma/registry', () => ({ emmaToolRegistry: { register: (tool: Tool) => handlers.set(tool.name, tool) } }));
jest.mock('../services/chatbotService', () => ({
  chatbotDb: { getChatSession: jest.fn(), claimMetaWriteManifestDigest: jest.fn() },
}));
const svc = {
  campaigns: jest.fn(), campaignStats: jest.fn(), preview: jest.fn(), start: jest.fn(), status: jest.fn(), history: jest.fn(),
  pause: jest.fn(), resume: jest.fn(), cancel: jest.fn(), release: jest.fn(), canUseList: jest.fn(), sampleLeads: jest.fn(),
};
jest.mock('../services/smartleadPushRuntime', () => ({ getSmartleadPushService: () => svc }));

import { chatbotDb } from '../services/chatbotService';
import { deckHalt, deckReply, type DeckMessage } from './helpers/approvalDeckHistory';
import '../emma/smartleadPushTools';
import { SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS } from '../services/agentMode/core/toolDispatch';
import { SMARTLEAD_APPROVAL_KIND_PREFIX, cardText, computePushDigest, computeReleaseDigest } from '../services/smartleadPushApprovalGate';

const TOOLS = [
  'list_smartlead_campaigns', 'get_smartlead_campaign_stats', 'preview_smartlead_push', 'start_smartlead_push', 'get_smartlead_push_status',
  'pause_smartlead_push', 'resume_smartlead_push', 'cancel_smartlead_push', 'release_leads_from_smartlead',
];
const run = (name: string, args: unknown = {}, context: unknown = { userId: 'owner' }) => handlers.get(name)!.execute(args, context);
const SESSION = 'sess-1';
const attended = (extra: Record<string, unknown> = {}) => ({ userId: 'owner', sessionId: SESSION, ...extra });
const RUN_ID = '01M6SMARTLEADRUN1';

// -- in-memory chat sessions: the history the approval gate reads and the single-use map it claims in
type FakeSession = { sessionType?: string; consumedMetaWriteManifestDigests: Record<string, string>; messages: DeckMessage[] };
let sessions: Map<string, FakeSession>;
let deckCounter: number;
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const sessionOf = (id: string) => { if (!sessions.has(id)) sessions.set(id, { sessionType: 'chat', consumedMetaWriteManifestDigests: {}, messages: [] }); return sessions.get(id)!; };
function installChatDb() {
  sessions = new Map();
  deckCounter = 0;
  (chatbotDb.getChatSession as jest.Mock).mockImplementation(async (id: string) => clone(sessionOf(id)));
  (chatbotDb.claimMetaWriteManifestDigest as jest.Mock).mockImplementation(async (id: string, key: string) => {
    const map = sessionOf(id).consumedMetaWriteManifestDigests;
    if (key in map) return false;
    map[key] = new Date().toISOString();
    return true;
  });
}
function recordHalt(result: any, sessionId = SESSION): string {
  const item = result.questionDeckPayload[0];
  const deckId = `deck-${++deckCounter}`;
  sessionOf(sessionId).messages.push(deckHalt(item.kind, deckId, item.question));
  return deckId;
}
function answerCard(deckId: string, verdict: string, sessionId = SESSION, extra: { answeredBy?: 'user' | 'delegation'; at?: string } = {}) {
  sessionOf(sessionId).messages.push(deckReply(deckId, verdict, extra.answeredBy ?? 'user', extra.at ?? new Date().toISOString()));
}
/** Calls the tool; when it halts with a card, has the user approve it and calls again. */
async function withApproval(name: string, args: unknown, ctx = attended()) {
  const first = await run(name, args, ctx);
  if (!first.awaitingUserConfirmation) return first;
  answerCard(recordHalt(first, ctx.sessionId as string), 'approve', ctx.sessionId as string);
  return run(name, args, ctx);
}

// -- a realistic preview, with a fresh token each time (the real one is single use)
let tokenCounter: number;
type PreviewOver = Partial<{ eligible: number; total: number; hash: string; status: string; chosen: number; canStart: boolean; active: boolean; blocks: any[]; tagsToMap: string[]; name: string; fingerprint: string; shared: boolean; noUnsub: boolean }>;
let previewOver: PreviewOver;
const previewResult = () => {
  const o = previewOver;
  const eligible = o.eligible ?? 50;
  return {
    ok: true,
    preview: {
      campaign: { id: 77, name: o.name ?? 'Mindd outreach', status: o.status ?? 'DRAFTED' },
      sequence: { stepCount: 2, tags: ['first_name'], hash: o.hash ?? 'hash-1' },
      preflight: { blocks: o.blocks ?? [], warnings: [{ code: 'no_unsubscribe', message: 'No unsubscribe link.' }], tagsToMap: o.tagsToMap ?? [] },
      list: { total: o.total ?? 60, eligible, alreadyPushed: 0, skipped: { no_email: 10 } },
      samples: [{ email: 'a@example.com', sends: {} }],
      cohort: { chosen: o.chosen ?? Math.min(50, eligible), suggested: 50, max: eligible },
      canStart: o.canStart ?? true,
      requiresActiveConfirmation: o.active ?? false,
      requiresUnsubscribeAcknowledgement: o.noUnsub ?? false,
      fingerprint: o.fingerprint ?? 'fp-1',
      connection: { accountId: 'smartlead-owner', name: 'Mindd Smartlead', shared: o.shared ?? false },
      token: `signed-token-${++tokenCounter}`,
      expiresAt: '2026-10-28T14:00:00Z',
    },
  };
};
const runView = (over: Record<string, unknown> = {}) => ({ runId: RUN_ID, status: 'running', campaignName: 'Mindd outreach', counts: { added: 0 }, approved: 50, warnings: [], ...over });

beforeEach(() => {
  jest.clearAllMocks();
  installChatDb();
  tokenCounter = 0;
  previewOver = {};
  svc.canUseList.mockResolvedValue({ ok: true, listName: 'Mindd leads' });
  svc.sampleLeads.mockResolvedValue({ ok: true, emails: ['ann@example.com', 'bob@example.com', 'cy@example.com'] });
  svc.preview.mockImplementation(async () => previewResult());
  svc.start.mockImplementation(async () => ({ ok: true, started: true, run: runView() }));
  svc.release.mockResolvedValue({ ok: true, released: 3, skipped: { notFound: 0, nothingToRelease: 1, doNotContact: 0 } });
  for (const k of ['pause', 'resume', 'cancel', 'status']) (svc as any)[k].mockResolvedValue({ ok: true, run: runView() });
  svc.history.mockResolvedValue({ ok: true, runs: [] });
  svc.campaigns.mockResolvedValue({ ok: true, connection: { accountId: 'smartlead-owner', name: 'Mindd Smartlead', shared: false }, campaigns: [{ id: 77, name: 'Mindd outreach', status: 'DRAFTED', pushable: true, needsConfirmation: false }] });
});

const PUSH = { listId: 'list-1', campaignId: 77 };

describe('registration', () => {
  it('registers every tool, keeps them away from share-link visitors, and exposes no way to pass the signed token or the acknowledgements', () => {
    for (const name of TOOLS) {
      expect(handlers.has(name)).toBe(true);
      expect(SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS.has(name)).toBe(true);
    }
    for (const name of ['preview_smartlead_push', 'start_smartlead_push']) {
      const props = Object.keys(handlers.get(name)!.definition.inputSchema.properties);
      expect(props).not.toContain('token');
      expect(props).not.toContain('acknowledgements');
      expect(props).not.toContain('lawfulBasis');
    }
  });
});

describe('read-only tools', () => {
  it('lists campaigns for the caller, and says which Smartlead account they are in', async () => {
    const r = await run('list_smartlead_campaigns', {}, { userId: 'owner' });
    expect(svc.campaigns).toHaveBeenCalledWith('owner', undefined);
    expect(r.campaigns[0]).toMatchObject({ id: 77, pushable: true });
    expect(r.smartleadAccount).toEqual({ accountId: 'smartlead-owner', name: 'Mindd Smartlead', shared: false });
    await run('list_smartlead_campaigns', { accountId: 'smartlead-other' }, { userId: 'owner' });
    expect(svc.campaigns).toHaveBeenLastCalledWith('owner', 'smartlead-other');
  });

  it('gives a campaign\'s counters, says they can lag, and leaves out opens and clicks', async () => {
    svc.campaignStats.mockResolvedValue({
      ok: true, connection: { accountId: 'smartlead-owner', name: 'Mindd Smartlead', shared: false },
      stats: { campaignId: 77, name: 'Mindd outreach', status: 'ACTIVE', leadsInCampaign: 60, contactsEmailed: 50, emailsSent: 90, replies: 4, bounces: 2, unsubscribes: 1 },
    });
    const r = await run('get_smartlead_campaign_stats', { campaignId: 77 }, { userId: 'owner' });
    expect(svc.campaignStats).toHaveBeenCalledWith('owner', 77, undefined);
    expect(r).toEqual({
      success: true,
      smartleadAccount: { accountId: 'smartlead-owner', name: 'Mindd Smartlead', shared: false },
      campaign: { id: 77, name: 'Mindd outreach', status: 'ACTIVE' },
      stats: { leadsInCampaign: 60, contactsEmailed: 50, emailsSent: 90, replies: 4, bounces: 2, unsubscribes: 1 },
      note: "Smartlead's counts can lag a few minutes behind a recent push or send.",
    });
    const def = handlers.get('get_smartlead_campaign_stats')!.definition;
    expect(def.description).toMatch(/lag a few minutes/);
    expect(Object.keys(def.inputSchema.properties).sort()).toEqual(['accountId', 'campaignId']);
    await run('get_smartlead_campaign_stats', { campaignId: '77', accountId: 'smartlead-other' }, { userId: 'owner' });
    expect(svc.campaignStats).toHaveBeenLastCalledWith('owner', 77, 'smartlead-other');
  });

  it('refuses a bad campaign id or an unknown argument, surfaces the service message, and needs a signed-in caller', async () => {
    await expect(run('get_smartlead_campaign_stats', {}, { userId: 'owner' })).rejects.toThrow(/campaignId/);
    await expect(run('get_smartlead_campaign_stats', { campaignId: 77, listId: 'x' }, { userId: 'owner' })).rejects.toThrow(/Invalid Smartlead push arguments/);
    svc.campaignStats.mockResolvedValue({ ok: false, status: 404, code: 'campaign_not_found', message: 'That campaign was not found in the connected Smartlead account.' });
    await expect(run('get_smartlead_campaign_stats', { campaignId: 77 }, { userId: 'owner' })).rejects.toThrow(/not found in the connected Smartlead account/);
    await expect(run('get_smartlead_campaign_stats', { campaignId: 77 }, {})).rejects.toThrow(/Authentication required/);
  });

  it('passes a chosen Smartlead connection through to the preview and start, and tells the model which account was used', async () => {
    const r = await run('preview_smartlead_push', { ...PUSH, accountId: 'smartlead-other' });
    expect(svc.preview).toHaveBeenCalledWith('owner', expect.objectContaining({ accountId: 'smartlead-other' }));
    expect(r.preview.smartleadAccount).toEqual({ accountId: 'smartlead-owner', name: 'Mindd Smartlead', shared: false });
    await withApproval('start_smartlead_push', { ...PUSH, accountId: 'smartlead-other' });
    expect(svc.preview.mock.calls.every(([, body]) => body.accountId === 'smartlead-other')).toBe(true);
    await expect(run('preview_smartlead_push', { ...PUSH, accountId: '' })).rejects.toThrow('accountId is required');
    await run('preview_smartlead_push', PUSH);
    expect(svc.preview.mock.calls[svc.preview.mock.calls.length - 1][1]).not.toHaveProperty('accountId');
  });

  it('preview tells the model the numbers and findings but never the signed token', async () => {
    const r = await run('preview_smartlead_push', PUSH);
    expect(svc.preview).toHaveBeenCalledWith('owner', expect.objectContaining({ listId: 'list-1', campaignId: 77, includeUnverified: false }));
    expect(r.preview).toMatchObject({ list: { eligible: 50, total: 60 }, cohort: { chosen: 50 }, canStart: true, campaignAlreadySending: false, emailStepsInCampaignSequence: 2 });
    expect(JSON.stringify(r)).not.toContain('signed-token');
  });

  it('status by run and by list', async () => {
    await run('get_smartlead_push_status', { runId: RUN_ID });
    expect(svc.status).toHaveBeenCalledWith('owner', RUN_ID);
    await run('get_smartlead_push_status', { listId: 'list-1' });
    expect(svc.history).toHaveBeenCalledWith('owner', 'list-1');
    await expect(run('get_smartlead_push_status', {})).rejects.toThrow('runId or a listId');
  });

  it("a service refusal becomes the tool's error, in the service's own words", async () => {
    svc.preview.mockResolvedValue({ ok: false, status: 403, code: 'forbidden', message: 'You need edit access to this list to push it to Smartlead.' });
    await expect(run('preview_smartlead_push', PUSH)).rejects.toThrow('You need edit access');
  });
});

describe('start_smartlead_push: who may be asked', () => {
  const refused = async (ctx: Record<string, unknown>, text: RegExp) => {
    await expect(run('start_smartlead_push', PUSH, ctx)).rejects.toThrow(text);
    expect(svc.preview).not.toHaveBeenCalled();
    expect(svc.start).not.toHaveBeenCalled();
  };
  it('refuses an unattended run', () => refused(attended({ isUnattendedRun: true }), /interactive chat/));
  it('refuses someone acting on the customer\'s behalf', async () => {
    await refused(attended({ isDelegatedAccess: true }), /customer in their own chat/);
    await refused(attended({ isDelegatedAdmin: true }), /customer in their own chat/);
  });
  it('refuses a call with no chat session, an unreadable session and a scheduled session', async () => {
    await refused({ userId: 'owner' }, /attended chat session/);
    (chatbotDb.getChatSession as jest.Mock).mockRejectedValueOnce(new Error('boom'));
    await refused(attended(), /could not be read/);
    sessionOf('sched').sessionType = 'scheduled';
    await refused(attended({ sessionId: 'sched' }), /not a scheduled run/);
  });
  it('refuses when the caller is not signed in', () => expect(run('start_smartlead_push', PUSH, {})).rejects.toThrow('Authentication required'));
});

describe('start_smartlead_push: the approval card', () => {
  it('stops with a card and adds nothing; the card is built from live values and Decline comes first', async () => {
    const r = await run('start_smartlead_push', PUSH, attended());
    expect(r).toMatchObject({ awaitingUserConfirmation: true, type: 'ask_user_question' });
    expect(svc.start).not.toHaveBeenCalled();
    const card = r.questionDeckPayload[0];
    expect(card.kind.startsWith(SMARTLEAD_APPROVAL_KIND_PREFIX + 'push:')).toBe(true);
    expect(card.immutable).toBe(true);
    expect(card.allowEmmaDecide).toBe(false);
    expect(card.options.map((o: any) => o.id)).toEqual(['decline', 'approve']);
    expect(card.options[0].recommended).toBe(true);
    expect(card.question).toContain('Add 50 contacts from "Mindd leads" to the campaign "Mindd outreach" in your Smartlead account "Mindd Smartlead"');
    expect(card.question).toContain('50 of 60 contacts in the list can be added');
    expect(card.question).toContain('lawful basis');
    expect(card.question).toContain('opt out are stopped in Smartlead for good');
    expect(card.question).not.toContain('ALREADY SENDING');
  });

  it("names a teammate's shared Smartlead account on the card, since the emails go out from THAT account's mailboxes", async () => {
    previewOver = { shared: true };
    const r = await run('start_smartlead_push', PUSH, attended());
    expect(r.questionDeckPayload[0].question).toContain("in a teammate's shared Smartlead account \"Mindd Smartlead\"");
    expect(r.questionDeckPayload[0].question).toContain("from that account's own mailboxes");
  });

  it('says so on the card when the campaign is already sending, and when contacts without a verified email are included', async () => {
    previewOver = { status: 'ACTIVE', active: true };
    const r = await run('start_smartlead_push', { ...PUSH, includeUnverified: true }, attended());
    expect(r.questionDeckPayload[0].question).toContain('ALREADY SENDING (active)');
    expect(r.questionDeckPayload[0].question).toContain('not verified');
  });

  it('says plainly on the card that a sending campaign has no unsubscribe link, and a draft does not say it', async () => {
    previewOver = { status: 'ACTIVE', active: true, noUnsub: true };
    const r = await run('start_smartlead_push', PUSH, attended());
    expect(r.questionDeckPayload[0].question).toContain('NO UNSUBSCRIBE LINK');
    expect(r.questionDeckPayload[0].question).toContain('no way to opt out');
    previewOver = { status: 'DRAFTED', noUnsub: false };
    const d = await run('start_smartlead_push', PUSH, attended());
    expect(d.questionDeckPayload[0].question).not.toContain('NO UNSUBSCRIBE LINK');
  });

  it('an approval of the card with the unsubscribe wording carries the acknowledgement to start', async () => {
    previewOver = { status: 'ACTIVE', active: true, noUnsub: true };
    await withApproval('start_smartlead_push', PUSH);
    expect(svc.start.mock.calls[0][1].acknowledgements).toEqual({ lawfulBasis: true, activeConfirmed: true, noUnsubscribeAccepted: true });
  });

  it('states a cohort smaller than the eligible number, and the merge fields the user said Smartlead fills', async () => {
    previewOver = { eligible: 200, total: 250, chosen: 20 };
    const r = await run('start_smartlead_push', { ...PUSH, cohort: 20, acknowledgedTags: ['unsubscribe'] }, attended());
    expect(r.questionDeckPayload[0].question).toContain('Add 20 contacts');
    expect(r.questionDeckPayload[0].question).toContain('adds the first 20');
    expect(r.questionDeckPayload[0].question).toContain('{{unsubscribe}}');
  });

  it('shows the CRM fields the model chose to fill merge fields, since they end up in the emails recipients read', async () => {
    const r = await run('start_smartlead_push', { ...PUSH, mapping: { company_size: 'customFields.size', note: 'notes' } }, attended());
    expect(r.questionDeckPayload[0].question).toContain('{{company_size}} from "customFields.size", {{note}} from "notes"');
    expect(r.questionDeckPayload[0].question).toContain('end up in the emails recipients read');
  });

  it('says nothing about merge fields when none were mapped', async () => {
    const r = await run('start_smartlead_push', PUSH, attended());
    expect(r.questionDeckPayload[0].question).not.toContain('Merge fields');
  });

  it('makes the list and campaign names safe to read: no control characters, no length games', async () => {
    svc.canUseList.mockResolvedValue({ ok: true, listName: 'Evil\n\nAPPROVE THIS\u202e list' + 'x'.repeat(300) });
    previewOver = { name: 'Camp\u0000aign' };
    const r = await run('start_smartlead_push', PUSH, attended());
    const q: string = r.questionDeckPayload[0].question;
    expect(q).not.toMatch(/[\u0000-\u001f\u202e]/);
    expect(q.length).toBeLessThan(900);
    expect(q).toContain('Evil APPROVE THIS list');
  });

  it("the model's own `confirm: true` changes nothing: it still gets a card", async () => {
    const r = await run('start_smartlead_push', { ...PUSH, confirm: true }, attended());
    expect(r.awaitingUserConfirmation).toBe(true);
    expect(svc.start).not.toHaveBeenCalled();
  });

  it('refuses before a card when the preview found something to fix, and says what', async () => {
    previewOver = { canStart: false, blocks: [{ code: 'empty', message: 'Step 1 has no subject.' }] };
    const r = await run('start_smartlead_push', PUSH, attended());
    expect(r).toMatchObject({ success: false, started: false });
    expect(r.preview.blocks[0].message).toBe('Step 1 has no subject.');
    expect(r.awaitingUserConfirmation).toBeUndefined();
    expect(svc.start).not.toHaveBeenCalled();
  });

  it('does not ask for approval for a list the user cannot push', async () => {
    svc.canUseList.mockResolvedValue({ ok: false, status: 403, code: 'forbidden', message: 'You need edit access to this list to push it to Smartlead.' });
    await expect(run('start_smartlead_push', PUSH, attended())).rejects.toThrow('edit access');
    expect(svc.preview).not.toHaveBeenCalled();
  });
});

describe('start_smartlead_push: after the user approves', () => {
  it('starts the push once, with the fresh signed token, both acknowledgements the card stood for, and the agent channel', async () => {
    const r = await withApproval('start_smartlead_push', PUSH);
    expect(r).toMatchObject({ success: true, started: true, campaign: { name: 'Mindd outreach', status: 'DRAFTED', emailStepsInCampaignSequence: 2 } });
    expect(svc.start).toHaveBeenCalledTimes(1);
    expect(svc.start).toHaveBeenCalledWith('owner', { token: 'signed-token-2', acknowledgements: { lawfulBasis: true } }, { channel: 'agent' });
    expect(svc.preview).toHaveBeenCalledTimes(2); // once for the card, once to act on what is true now
  });

  it('adds the already-sending confirmation only for a campaign that is already sending', async () => {
    previewOver = { status: 'ACTIVE', active: true };
    await withApproval('start_smartlead_push', PUSH);
    expect(svc.start.mock.calls[0][1].acknowledgements).toEqual({ lawfulBasis: true, activeConfirmed: true });
  });

  it('an approval is used once: a second call asks again', async () => {
    await withApproval('start_smartlead_push', PUSH);
    const again = await run('start_smartlead_push', PUSH, attended());
    expect(again.awaitingUserConfirmation).toBe(true);
    expect(svc.start).toHaveBeenCalledTimes(1);
  });

  it('a lost claim (another call used the approval first) adds nothing', async () => {
    const first = await run('start_smartlead_push', PUSH, attended());
    answerCard(recordHalt(first), 'approve');
    (chatbotDb.claimMetaWriteManifestDigest as jest.Mock).mockResolvedValueOnce(false);
    await expect(run('start_smartlead_push', PUSH, attended())).rejects.toThrow('already used');
    expect(svc.start).not.toHaveBeenCalled();
  });

  it('reports a push that was already running instead of claiming it started', async () => {
    svc.start.mockResolvedValue({ ok: true, started: false, run: runView() });
    const r = await withApproval('start_smartlead_push', PUSH);
    expect(r).toMatchObject({ success: true, started: false });
    expect(r.message).toMatch(/already running/);
  });

  it("surfaces the service's refusal after approval (for example the kill switch)", async () => {
    svc.start.mockResolvedValue({ ok: false, status: 503, code: 'disabled', message: 'Pushing to Smartlead is switched off at the moment.' });
    await expect(withApproval('start_smartlead_push', PUSH)).rejects.toThrow('switched off');
  });
});

describe('start_smartlead_push: an approval covers exactly what the card showed', () => {
  const approveThenChange = async (change: () => void, args: Record<string, unknown> = PUSH, args2: Record<string, unknown> = args) => {
    const first = await run('start_smartlead_push', args, attended());
    answerCard(recordHalt(first), 'approve');
    change();
    return run('start_smartlead_push', args2, attended());
  };
  const asksAgain = (r: Record<string, any>) => {
    expect(r.awaitingUserConfirmation).toBe(true);
    expect(svc.start).not.toHaveBeenCalled();
  };
  it('the list grew', async () => asksAgain(await approveThenChange(() => { previewOver = { eligible: 70, total: 80, chosen: 50 }; })));
  it("the customer edited the campaign's emails", async () => asksAgain(await approveThenChange(() => { previewOver = { hash: 'hash-2' }; })));
  it('the campaign was started', async () => asksAgain(await approveThenChange(() => { previewOver = { status: 'ACTIVE', active: true }; })));
  it('another campaign', async () => asksAgain(await approveThenChange(() => undefined, PUSH, { ...PUSH, campaignId: 78 })));
  it('the same number of contacts, but different ones or another Smartlead connection (the preview fingerprint)', async () => asksAgain(await approveThenChange(() => { previewOver = { fingerprint: 'fp-2' }; })));
  it('another list', async () => asksAgain(await approveThenChange(() => undefined, PUSH, { ...PUSH, listId: 'list-2' })));
  it('unverified contacts switched on', async () => asksAgain(await approveThenChange(() => undefined, PUSH, { ...PUSH, includeUnverified: true })));
  it('a different field mapping', async () => asksAgain(await approveThenChange(() => undefined, PUSH, { ...PUSH, mapping: { company_size: 'customFields.size' } })));
  it('a different set of fields Smartlead is said to fill', async () => asksAgain(await approveThenChange(() => undefined, PUSH, { ...PUSH, acknowledgedTags: ['unsubscribe'] })));
  it('a smaller cohort', async () => asksAgain(await approveThenChange(() => { previewOver = { chosen: 10 }; }, PUSH, { ...PUSH, cohort: 10 })));

  it('mapping and tag order do not matter', async () => {
    const a = { ...PUSH, mapping: { b: 'y', a: 'x' }, acknowledgedTags: ['t2', 't1'] };
    const b = { ...PUSH, mapping: { a: 'x', b: 'y' }, acknowledgedTags: ['t1', 't2'] };
    const r = await approveThenChange(() => undefined, a, b);
    expect(r.started).toBe(true);
  });

  it("an approval given in another chat does not count", async () => {
    const first = await run('start_smartlead_push', PUSH, attended());
    answerCard(recordHalt(first), 'approve');
    const other = await run('start_smartlead_push', PUSH, attended({ sessionId: 'sess-2' }));
    expect(other.awaitingUserConfirmation).toBe(true);
    expect(svc.start).not.toHaveBeenCalled();
  });
});

describe('start_smartlead_push: only a person, and only an approve', () => {
  const answered = async (verdict: string, extra: { answeredBy?: 'user' | 'delegation'; at?: string } = {}) => {
    const first = await run('start_smartlead_push', PUSH, attended());
    answerCard(recordHalt(first), verdict, SESSION, extra);
    return run('start_smartlead_push', PUSH, attended());
  };
  it('a decline adds nothing and asks again', async () => { expect((await answered('decline')).awaitingUserConfirmation).toBe(true); expect(svc.start).not.toHaveBeenCalled(); });
  it("a delegated or Emma-decided answer adds nothing", async () => { expect((await answered('approve', { answeredBy: 'delegation' })).awaitingUserConfirmation).toBe(true); expect(svc.start).not.toHaveBeenCalled(); });
  it('an approval older than 15 minutes adds nothing', async () => { expect((await answered('approve', { at: new Date(Date.now() - 16 * 60_000).toISOString() })).awaitingUserConfirmation).toBe(true); expect(svc.start).not.toHaveBeenCalled(); });
  it('an unanswered card adds nothing', async () => {
    const first = await run('start_smartlead_push', PUSH, attended());
    recordHalt(first);
    expect((await run('start_smartlead_push', PUSH, attended())).awaitingUserConfirmation).toBe(true);
    expect(svc.start).not.toHaveBeenCalled();
  });
});

describe('argument checks', () => {
  it('rejects unknown keys (no way to smuggle in a token or acknowledgements), bad ids and a zero cohort', async () => {
    for (const args of [
      { ...PUSH, token: 'x' }, { ...PUSH, acknowledgements: { lawfulBasis: true } }, { listId: '', campaignId: 77 }, { listId: 'l', campaignId: 0 },
      { listId: 'l', campaignId: 'abc' }, { ...PUSH, cohort: 0 }, { ...PUSH, cohort: 1.5 }, { ...PUSH, mapping: [] }, { ...PUSH, acknowledgedTags: [1] },
    ]) {
      await expect(run('start_smartlead_push', args, attended())).rejects.toThrow();
    }
    expect(svc.start).not.toHaveBeenCalled();
    expect(svc.preview).not.toHaveBeenCalled();
  });

  it('treats null optionals as not provided and accepts a numeric campaign id given as text', async () => {
    const r = await run('preview_smartlead_push', { ...PUSH, campaignId: '77', includeUnverified: null, mapping: null, cohort: null });
    expect(r.success).toBe(true);
    expect(svc.preview).toHaveBeenCalledWith('owner', expect.objectContaining({ campaignId: 77 }));
  });
});

describe('pause, resume and cancel', () => {
  it('pause and cancel work in an unattended run (they stop email, never start it)', async () => {
    await run('pause_smartlead_push', { runId: RUN_ID }, { userId: 'owner', isUnattendedRun: true });
    await run('cancel_smartlead_push', { runId: RUN_ID }, { userId: 'owner', isUnattendedRun: true });
    expect(svc.pause).toHaveBeenCalledWith('owner', RUN_ID);
    expect(svc.cancel).toHaveBeenCalledWith('owner', RUN_ID);
  });

  it('resume needs an attended chat, and then goes to the service', async () => {
    await expect(run('resume_smartlead_push', { runId: RUN_ID }, { userId: 'owner', isUnattendedRun: true })).rejects.toThrow(/interactive chat/);
    expect(svc.resume).not.toHaveBeenCalled();
    await run('resume_smartlead_push', { runId: RUN_ID }, attended());
    expect(svc.resume).toHaveBeenCalledWith('owner', RUN_ID);
  });

  it('a bad run id is refused before the service', async () => {
    await expect(run('cancel_smartlead_push', { runId: 'x' }, attended())).rejects.toThrow('runId is required');
    expect(svc.cancel).not.toHaveBeenCalled();
  });
});

describe('release_leads_from_smartlead', () => {
  const REL = { listId: 'list-1', leadIds: ['b', 'a', 'a', 'c'] };

  it('stops with a card, releases nothing, and the card names the count and the risks', async () => {
    const r = await run('release_leads_from_smartlead', REL, attended());
    expect(r.awaitingUserConfirmation).toBe(true);
    expect(svc.release).not.toHaveBeenCalled();
    const card = r.questionDeckPayload[0];
    expect(card.kind.startsWith(SMARTLEAD_APPROVAL_KIND_PREFIX + 'release:')).toBe(true);
    expect(card.question).toContain('Release 3 contacts in "Mindd leads" from Smartlead');
    expect(card.question).toContain('They include ann@example.com, bob@example.com, cy@example.com.');
    expect(card.question).toMatch(/two places/);
    expect(card.question).toMatch(/cannot be undone/);
    expect(card.options.map((o: any) => o.id)).toEqual(['decline', 'approve']);
  });

  it('names the contacts and counts the rest when there are more than a few', async () => {
    const r = await run('release_leads_from_smartlead', { listId: 'list-1', leadIds: ['a', 'b', 'c', 'd', 'e', 'f'] }, attended());
    expect(r.questionDeckPayload[0].question).toContain('They include ann@example.com, bob@example.com, cy@example.com and 3 others.');
    expect(svc.sampleLeads).toHaveBeenCalledWith('owner', 'list-1', ['a', 'b', 'c', 'd', 'e', 'f']);
    await run('release_leads_from_smartlead', { listId: 'list-1', leadIds: ['f', 'e', 'd', 'c', 'b', 'a'] }, attended());
    expect(svc.sampleLeads).toHaveBeenLastCalledWith('owner', 'list-1', ['a', 'b', 'c', 'd', 'e', 'f']); // the same contacts are named whatever order the model lists them in
  });

  it('after approval releases exactly the distinct ids the card was for', async () => {
    const r = await withApproval('release_leads_from_smartlead', { ...REL, campaignId: 77 });
    expect(r).toMatchObject({ success: true, released: 3 });
    expect(svc.release).toHaveBeenCalledTimes(1);
    expect(svc.release).toHaveBeenCalledWith('owner', { listId: 'list-1', leadIds: ['a', 'b', 'c'], campaignId: 77 });
  });

  it('an approval does not carry over to other contacts, another list or another campaign, and is used once', async () => {
    const first = await run('release_leads_from_smartlead', REL, attended());
    answerCard(recordHalt(first), 'approve');
    for (const args of [{ ...REL, leadIds: ['a', 'b'] }, { ...REL, leadIds: ['a', 'b', 'd'] }, { ...REL, listId: 'list-2' }, { ...REL, campaignId: 77 }]) {
      expect((await run('release_leads_from_smartlead', args, attended())).awaitingUserConfirmation).toBe(true);
    }
    expect(svc.release).not.toHaveBeenCalled();
    expect((await run('release_leads_from_smartlead', REL, attended())).success).toBe(true);
    expect((await run('release_leads_from_smartlead', REL, attended())).awaitingUserConfirmation).toBe(true);
    expect(svc.release).toHaveBeenCalledTimes(1);
  });

  it('refuses unattended, an unusable list, and a bad id list, all before any card', async () => {
    await expect(run('release_leads_from_smartlead', REL, attended({ isUnattendedRun: true }))).rejects.toThrow(/interactive chat/);
    svc.canUseList.mockResolvedValueOnce({ ok: false, status: 403, code: 'forbidden', message: 'You need edit access.' });
    await expect(run('release_leads_from_smartlead', REL, attended())).rejects.toThrow('edit access');
    for (const leadIds of [[], Array.from({ length: 501 }, (_, i) => `l${i}`), [1], ['a b']]) {
      await expect(run('release_leads_from_smartlead', { listId: 'list-1', leadIds }, attended())).rejects.toThrow('between 1 and 500');
    }
    expect(svc.release).not.toHaveBeenCalled();
  });
});

describe('review hardening', () => {
  it("an approval given to one user in a chat does not work for another user who calls with the same session id", async () => {
    const first = await run('start_smartlead_push', PUSH, attended());
    answerCard(recordHalt(first), 'approve');
    const other = await run('start_smartlead_push', PUSH, { userId: 'someone-else', sessionId: SESSION });
    expect(other.awaitingUserConfirmation).toBe(true);
    expect(svc.start).not.toHaveBeenCalled();
  });

  it('release and resume refuse delegated access, a missing session and a scheduled session, like start', async () => {
    sessionOf('sched').sessionType = 'scheduled';
    const calls: Array<[string, Record<string, unknown>]> = [['release_leads_from_smartlead', { listId: 'list-1', leadIds: ['a'] }], ['resume_smartlead_push', { runId: RUN_ID }]];
    for (const [name, args] of calls) {
      await expect(run(name, args, attended({ isDelegatedAccess: true }))).rejects.toThrow(/customer in their own chat/);
      await expect(run(name, args, { userId: 'owner' })).rejects.toThrow(/attended chat session/);
      await expect(run(name, args, attended({ sessionId: 'sched' }))).rejects.toThrow(/not a scheduled run/);
    }
    expect(svc.release).not.toHaveBeenCalled();
    expect(svc.resume).not.toHaveBeenCalled();
  });

  it('a start that fails after approval spends that approval: the user is asked again, and nothing was added', async () => {
    svc.start.mockResolvedValueOnce({ ok: false, status: 409, code: 'sequence_changed', message: "The campaign's sequence changed after you previewed. Preview again." });
    await expect(withApproval('start_smartlead_push', PUSH)).rejects.toThrow('sequence changed');
    const again = await run('start_smartlead_push', PUSH, attended());
    expect(again.awaitingUserConfirmation).toBe(true);
    expect(svc.start).toHaveBeenCalledTimes(1);
  });
});

describe('the approval gate', () => {
  const base = { userId: 'u', sessionId: 's', listId: 'l', campaignId: 1, campaignStatus: 'DRAFTED', sequenceHash: 'h', cohort: 5, eligible: 5, includeUnverified: false, requiresActiveConfirmation: false, requiresUnsubscribeAcknowledgement: false, mapping: {}, acknowledgedTags: [] as string[], fingerprint: 'f' };
  it('every thing the card showed changes the digest, and nothing else does', () => {
    const d = computePushDigest(base);
    expect(computePushDigest({ ...base })).toBe(d);
    for (const change of [{ userId: 'v' }, { sessionId: 't' }, { listId: 'm' }, { campaignId: 2 }, { campaignStatus: 'ACTIVE' }, { sequenceHash: 'g' }, { cohort: 4 }, { eligible: 6 }, { requiresUnsubscribeAcknowledgement: true }, { includeUnverified: true }, { requiresActiveConfirmation: true }, { mapping: { a: 'b' } }, { acknowledgedTags: ['x'] }, { fingerprint: 'g' }]) {
      expect(computePushDigest({ ...base, ...change })).not.toBe(d);
    }
  });

  it('a push digest and a release digest never collide', () => {
    expect(computeReleaseDigest({ userId: 'u', sessionId: 's', listId: 'l', campaignId: 1, leadIds: ['a'] })).not.toBe(computePushDigest(base));
  });

  it('cardText strips control and direction characters, collapses space and shortens', () => {
    expect(cardText('a\u0000b\u202ec\u2028d\n e')).toBe('a b c d e');
    expect(cardText('x'.repeat(200), 10)).toBe('xxxxxxxxx…');
    expect(cardText(undefined)).toBe('');
  });
});
