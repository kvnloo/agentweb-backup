/** Human contract: one exact paused brief approval, no activation or drift, all requested ads. */
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(), claimMetaWriteManifestDigest: jest.fn(),
    updateSessionApprovalDeck: jest.fn(), updateSessionWorkflowRun: jest.fn(),
    updateSessionMetaWriteFailureStreaks: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));
jest.mock('../services/metaService', () => ({
  ...jest.requireActual('../services/metaService'),
  metaService: { getCampaign: jest.fn(), getAdSet: jest.fn(), getAd: jest.fn(), getAdCreative: jest.fn(), listCampaigns: jest.fn(), listAdSets: jest.fn() },
}));

import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { metaService } from '../services/metaService';

const ACCOUNT = '111';
const SESSION = 'bundle-session';
const brief = () => ({
  requested_ad_count: 3,
  campaign: { name: 'Launch', objective: 'OUTCOME_TRAFFIC', special_ad_categories: ['NONE'], status: 'PAUSED' },
  ad_set: { name: 'US', daily_budget: 50, optimization_goal: 'LINK_CLICKS', billing_event: 'IMPRESSIONS',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP', destination_type: 'WEBSITE', status: 'PAUSED',
    targeting: { geo_locations: { countries: ['US'] }, targeting_automation: { advantage_audience: 0 } } },
  ads: [1, 2, 3].map(n => ({ name: `Ad ${n}`, creative_id: `creative-${n}`, status: 'PAUSED' })),
});
let service: AgentModeService;
let session: any;
let writes: any[];
let nodes: Map<string, any>;
let objectiveGate: jest.SpyInstance;
let messages: any[];
let creatives: Map<string, any>;

beforeEach(() => {
  jest.clearAllMocks();
  service = new AgentModeService();
  session = { sessionId: SESSION, userId: 'user-1' };
  writes = [];
  nodes = new Map();
  messages = [{ role: 'user', content: 'Create a paused campaign with three ads.' }];
  creatives = new Map([1, 2, 3].map(n => [`creative-${n}`, {
    id: `creative-${n}`, account_id: ACCOUNT, name: `Launch creative ${n}`,
    object_story_spec: { page_id: 'page-1', link_data: { message: 'Meet your next customer.', name: 'Grow your business', link: 'https://agentweb.pro' } },
  }]));
  (chatbotDb.getMessagesFromMessagesTable as jest.Mock).mockImplementation(async () => structuredClone(messages));
  (metaService.getAdCreative as jest.Mock).mockImplementation(async (_token, id) => structuredClone(creatives.get(id)));
  (chatbotDb.getChatSession as jest.Mock).mockImplementation(async () => structuredClone(session));
  (chatbotDb.updateSessionApprovalDeck as jest.Mock).mockImplementation(async (_id, deck, opts) => {
    if (opts?.requireStillAwaiting && session.pendingApprovalDeck?.status !== 'awaiting') return null;
    session.pendingApprovalDeck = structuredClone(deck);
    return structuredClone(session);
  });
  (chatbotDb.claimMetaWriteManifestDigest as jest.Mock).mockImplementation(async (_id, digest) => {
    session.consumedMetaWriteManifestDigests ??= {};
    if (session.consumedMetaWriteManifestDigests[digest]) return false;
    session.consumedMetaWriteManifestDigests[digest] = 'claimed';
    return true;
  });
  (chatbotDb.updateSessionWorkflowRun as jest.Mock).mockImplementation(async (_id, run, opts) => {
    if (opts?.requireVersion !== undefined && session.workflowRun?.version !== opts.requireVersion) return null;
    session.workflowRun = structuredClone(run);
    return structuredClone(session);
  });
  jest.spyOn(service as any, 'getMetaCredentials').mockResolvedValue({ accountId: ACCOUNT, accessToken: 'mock' });
  objectiveGate = jest.spyOn(service as any, 'resolveCampaignObjectiveGate').mockResolvedValue({ allowed: false, response: { success: false, message: 'Separate objective question' } });
  jest.spyOn(service as any, 'normalizeMetaMoneyParams').mockImplementation(async (...args: any[]) => {
    const params = { ...args[2] };
    for (const field of ['daily_budget', 'lifetime_budget', 'spend_cap']) if (params[field] !== undefined) params[field] *= 100;
    return { params, currency: 'USD', confirmation: 'USD' };
  });
  for (const [method, entity, key] of [
    ['manageMetaAdsCampaigns', 'CAMPAIGN', 'campaign'],
    ['manageMetaAdsAdSets', 'AD_SET', 'adSet'],
    ['manageMetaAdsAds', 'AD', 'ad'],
  ]) {
    jest.spyOn(service as any, method).mockImplementation(async (...args: any[]) => {
      const params = structuredClone(args[entity === 'CAMPAIGN' ? 4 : 5]);
      const id = `${entity}-${writes.length + 1}`;
      writes.push({ entity, action: args[1], account: args[2], params });
      const node = { ...params, id, ...(entity === 'CAMPAIGN' ? { special_ad_categories: params.special_ad_categories.filter((v: string) => v !== 'NONE') } : {}),
        ...(entity === 'AD_SET' ? { campaign_id: args[3], daily_budget: '5000' } : {}),
        ...(entity === 'AD' ? { adset_id: args[3], creative: { id: params.creative_id } } : {}) };
      nodes.set(id, node);
      return { success: true, [key]: { id } };
    });
  }
  (metaService.getCampaign as jest.Mock).mockImplementation(async (_a, _t, id) => nodes.get(id));
  (metaService.getAdSet as jest.Mock).mockImplementation(async (_t, id) => nodes.get(id));
  (metaService.getAd as jest.Mock).mockImplementation(async (_t, id) => nodes.get(id));
  (metaService.listCampaigns as jest.Mock).mockImplementation(async (_a, _t, opts) => ({ campaigns: [nodes.get(opts.campaignId)] }));
  (metaService.listAdSets as jest.Mock).mockImplementation(async (_a, _t, _c, opts) => ({ adSets: [nodes.get(opts.adSetId)] }));
});

const preview = (params = brief(), account = ACCOUNT) => service.callMetaMarketingApi(
  'user-1', 'CAMPAIGN', 'CREATE_PAUSED_BUNDLE', account, undefined, undefined, undefined, params, SESSION,
) as Promise<any>;
async function stage() {
  const result = await preview();
  expect(result.awaitingUserConfirmation).toBe(true);
  const minimized = (service as any).extractMinimalToolResult(result, 'call_meta_marketing_api');
  const deck = (service as any).buildMetaWriteApprovalDeckFromHalts([minimized]);
  await chatbotDb.updateSessionApprovalDeck(SESSION, deck);
  return deck;
}
async function approve() {
  const deck = await stage();
  return service.submitApprovalDeckAnswers(SESSION, deck.deckId, [{ itemId: deck.items[0].itemId, verdict: 'approve' }], 'user');
}

it('persists one exact brief including objective and all three ads, without an objective repeat or writes', async () => {
  const deck = await stage();
  expect(deck.items).toHaveLength(1);
  expect(session.pendingApprovalDeck.items[0].metaWriteDispatch.params).toMatchObject({ ...brief(), currency: 'USD' });
  expect(deck.items[0].question).toContain('OUTCOME_TRAFFIC');
  expect(deck.items[0].question).toContain('creative-3');
  expect(objectiveGate).not.toHaveBeenCalled();
  expect(writes).toHaveLength(0);
});

it('one explicit approval creates exactly the campaign, ad set and 3 ads, all PAUSED', async () => {
  const result = await approve();
  expect(result.outcome).toBe('submitted');
  if (result.outcome !== 'submitted') throw new Error('not submitted');
  expect(result.summary?.status).toBe('fully_applied');
  expect(writes.map(w => w.entity)).toEqual(['CAMPAIGN', 'AD_SET', 'AD', 'AD', 'AD']);
  expect(writes.every(w => w.action === 'CREATE' && w.params.status === 'PAUSED')).toBe(true);
  expect(objectiveGate).not.toHaveBeenCalled();
  expect(chatbotDb.claimMetaWriteManifestDigest).toHaveBeenCalledTimes(1);
});

it('cannot report complete when the third of three requested ads fails', async () => {
  const original = (service as any).manageMetaAdsAds.getMockImplementation();
  (service as any).manageMetaAdsAds.mockImplementation(async (...args: any[]) => args[5].name === 'Ad 3'
    ? { success: false, message: 'Third ad rejected' } : original(...args));
  const result = await approve();
  if (result.outcome !== 'submitted') throw new Error('not submitted');
  expect(result.summary?.status).not.toBe('fully_applied');
  expect(JSON.stringify(result.summary)).toContain('2/3');
});

it.each(['campaign', 'ad_set', 'ad'])('rejects ACTIVE in the %s before any writes', async target => {
  const params = brief();
  (target === 'ad' ? params.ads[0] : (params as any)[target]).status = 'ACTIVE';
  const result = await preview(params);
  expect(result.success).toBe(false);
  expect(writes).toHaveLength(0);
});

it('rejects a manifest listing only two of three requested ads', async () => {
  const params = brief(); params.ads.pop();
  expect((await preview(params)).success).toBe(false);
  expect(writes).toHaveLength(0);
});

it.each(['targeting', 'creative', 'objective', 'count'])('refuses %s drift after approval', async change => {
  const deck = await stage();
  session.pendingApprovalDeck.status = 'answered';
  session.pendingApprovalDeck.answers = [{ itemId: deck.items[0].itemId, verdict: 'approve', answeredBy: 'user', at: new Date().toISOString() }];
  const changed = brief();
  if (change === 'targeting') changed.ad_set.targeting.geo_locations.countries = ['CA'];
  if (change === 'creative') changed.ads[0].creative_id = 'different';
  if (change === 'objective') changed.campaign.objective = 'OUTCOME_LEADS';
  if (change === 'count') { changed.requested_ad_count = 2; changed.ads.pop(); }
  const result = await preview(changed);
  expect(result.awaitingUserConfirmation === true || result.success === false).toBe(true);
  expect(writes).toHaveLength(0);
});

it('fails read-back objective drift before creating children', async () => {
  (metaService.getCampaign as jest.Mock).mockImplementation(async (_a, _t, id) => ({ ...nodes.get(id), objective: 'OUTCOME_LEADS' }));
  (metaService.listCampaigns as jest.Mock).mockImplementation(async (_a, _t, opts) => ({ campaigns: [{ ...nodes.get(opts.campaignId), objective: 'OUTCOME_LEADS' }] }));
  const result = await approve();
  if (result.outcome !== 'submitted') throw new Error('not submitted');
  expect(result.summary?.status).not.toBe('fully_applied');
  expect(writes).toHaveLength(1);
});

it('rejecting the brief creates nothing', async () => {
  const deck = await stage();
  await service.submitApprovalDeckAnswers(SESSION, deck.deckId, [{ itemId: deck.items[0].itemId, verdict: 'reject' }], 'user');
  expect(writes).toHaveLength(0);
});

it('legacy confirm=true alone remains unable to authorize activation', async () => {
  const result: any = await service.callMetaMarketingApi('user-1', 'AD', 'UPDATE', ACCOUNT, undefined, undefined, 'ad-1', { status: 'ACTIVE', confirm: true }, SESSION);
  expect(result.awaitingUserConfirmation).toBe(true);
  expect(writes).toHaveLength(0);
});

it('a repeated exact call after approval neither creates duplicates nor asks again', async () => {
  await approve();
  const result = await preview();
  expect(result.awaitingUserConfirmation).toBeUndefined();
  expect(writes).toHaveLength(5);
});

it('stores all verified IDs and the exact requested/verified ad counts in the checkpoint', async () => {
  const result = await approve();
  if (result.outcome !== 'submitted') throw new Error('not submitted');
  expect(result.summary?.items[0].bundle).toMatchObject({ requested_ad_count: 3, verified_ad_count: 3 });
  expect(result.summary?.items[0].bundle?.ledger).toHaveLength(5);
  expect(session.workflowRun.checkpoints[0].verifiedFields.ledger).toHaveLength(5);
});

it('denies activation after approving a draft bundle', async () => {
  await approve();
  const result: any = await service.callMetaMarketingApi('user-1', 'CAMPAIGN', 'UPDATE', ACCOUNT, 'CAMPAIGN-1', undefined, undefined, { status: 'ACTIVE', confirm: true }, SESSION);
  expect(result.awaitingUserConfirmation).toBe(true);
  expect(writes).toHaveLength(5);
});

it('does not accept a delegated bundle approval', async () => {
  const deck = await stage();
  const result = await service.submitApprovalDeckAnswers(SESSION, deck.deckId, [{ itemId: deck.items[0].itemId, verdict: 'approve' }], 'delegation');
  expect(result.outcome).toBe('invalid');
  expect(writes).toHaveLength(0);
});

it('rejects another user’s session before producing a brief', async () => {
  session.userId = 'another-user';
  expect((await preview()).success).toBe(false);
  expect(writes).toHaveLength(0);
});

it('blocks persisted payload tampering before dispatch', async () => {
  const deck = await stage();
  session.pendingApprovalDeck.items[0].metaWriteDispatch.params.ads[0].creative_id = 'unapproved';
  const result = await service.submitApprovalDeckAnswers(SESSION, deck.deckId, [{ itemId: deck.items[0].itemId, verdict: 'approve' }], 'user');
  if (result.outcome !== 'submitted') throw new Error('not submitted');
  expect(result.summary?.status).not.toBe('fully_applied');
  expect(writes).toHaveLength(0);
});

it('does not let the unsigned resolvedAccountId move the approved writes', async () => {
  const deck = await stage();
  session.pendingApprovalDeck.items[0].metaWriteDispatch.resolvedAccountId = 'another-account';
  await service.submitApprovalDeckAnswers(SESSION, deck.deckId, [{ itemId: deck.items[0].itemId, verdict: 'approve' }], 'user');
  expect(writes).toHaveLength(5);
  expect(writes.every(w => w.account === ACCOUNT)).toBe(true);
});

it('blocks account-resolution drift between preview and approval', async () => {
  const deck = await stage();
  (service as any).getMetaCredentials.mockResolvedValue({ accountId: '222', accessToken: 'mock' });
  await service.submitApprovalDeckAnswers(SESSION, deck.deckId, [{ itemId: deck.items[0].itemId, verdict: 'approve' }], 'user');
  expect(writes).toHaveLength(0);
});

it('blocks currency drift between preview and approval', async () => {
  const deck = await stage();
  (service as any).normalizeMetaMoneyParams.mockImplementation(async (_a: any, _t: any, params: any) => ({ params, currency: 'JPY' }));
  await service.submitApprovalDeckAnswers(SESSION, deck.deckId, [{ itemId: deck.items[0].itemId, verdict: 'approve' }], 'user');
  expect(writes).toHaveLength(0);
});

it.each([null, 'bad', [], 42])('malformed ad read-back %p cannot count as completion', async malformed => {
  (metaService.getAd as jest.Mock).mockResolvedValue(malformed);
  const result = await approve();
  if (result.outcome !== 'submitted') throw new Error('not submitted');
  expect(result.summary?.status).not.toBe('fully_applied');
  expect(JSON.stringify(result.summary)).toContain('0/3');
  expect(writes).toHaveLength(3);
});

it.each(['status', 'targeting', 'daily_budget', 'campaign_id'])('ad-set read-back %s drift stops all ads', async field => {
  (metaService.listAdSets as jest.Mock).mockImplementation(async (_a, _t, _c, opts) => ({ adSets: [{ ...nodes.get(opts.adSetId), [field]: 'wrong' }] }));
  const result = await approve();
  if (result.outcome !== 'submitted') throw new Error('not submitted');
  expect(result.summary?.status).not.toBe('fully_applied');
  expect(writes).toHaveLength(2);
});

it('a reused ad ID cannot inflate the verified count', async () => {
  const original = (service as any).manageMetaAdsAds.getMockImplementation();
  (service as any).manageMetaAdsAds.mockImplementation(async (...args: any[]) => args[5].name === 'Ad 3'
    ? { success: true, ad: { id: 'AD-4' } } : original(...args));
  const result = await approve();
  if (result.outcome !== 'submitted') throw new Error('not submitted');
  expect(result.summary?.status).not.toBe('fully_applied');
  expect(JSON.stringify(result.summary)).toContain('2/3');
});

it.each([null, 'ad', 7, [], { name: 'bad', creative_id: {} }])('rejects malformed per-ad input %p', async ad => {
  const input = brief(); input.ads[1] = ad as any;
  expect((await preview(input)).success).toBe(false);
  expect(writes).toHaveLength(0);
});

it.each(['confirm', 'override_tracking_check', 'adset_id', 'account_id'])('rejects an ad-level %s override', async field => {
  const input = brief(); (input.ads[0] as any)[field] = true;
  expect((await preview(input)).success).toBe(false);
  expect(writes).toHaveLength(0);
});

it('preflights every creative before the single approval and rechecks all before the first write', async () => {
  const deck = await stage();
  expect(deck.items[0].question).toContain('Meet your next customer.');
  const reads = metaService.getAdCreative as jest.Mock;
  expect(reads.mock.calls.map(call => call[1])).toEqual(['creative-1', 'creative-2', 'creative-3']);
  const original = (service as any).manageMetaAdsCampaigns.getMockImplementation();
  (service as any).manageMetaAdsCampaigns.mockImplementation(async (...args: any[]) => {
    expect(reads.mock.calls.map(call => call[1])).toEqual([
      'creative-1', 'creative-2', 'creative-3', 'creative-1', 'creative-2', 'creative-3',
    ]);
    return original(...args);
  });
  messages.push({ role: 'user', content: 'Approved', metadata: { approvalDeckAnswer: { deckId: deck.deckId } } });
  const result = await service.submitApprovalDeckAnswers(SESSION, deck.deckId, [{ itemId: deck.items[0].itemId, verdict: 'approve' }], 'user');
  if (result.outcome !== 'submitted') throw new Error('not submitted');
  expect(result.summary?.status).toBe('fully_applied');
  expect(writes).toHaveLength(5);
});

it('blocks material creative copy drift between preview and execution', async () => {
  const deck = await stage();
  creatives.get('creative-3').object_story_spec.link_data.message = 'A different, valid offer.';
  const result = await service.submitApprovalDeckAnswers(SESSION, deck.deckId, [{ itemId: deck.items[0].itemId, verdict: 'approve' }], 'user');
  if (result.outcome !== 'submitted') throw new Error('not submitted');
  expect(result.summary?.status).not.toBe('fully_applied');
  expect(writes).toHaveLength(0);
});

it.each([undefined, null, 'bad', [], 42, { id: 'wrong', account_id: ACCOUNT },
  { id: 'creative-3', account_id: '222' }, { id: 'creative-3' },
  { id: 'creative-3', account_id: [ACCOUNT] },
])('refuses an unavailable, malformed or foreign third creative before approval: %p', async value => {
  creatives.set('creative-3', value);
  const result = await preview();
  expect(result.success).toBe(false);
  expect(result.awaitingUserConfirmation).not.toBe(true);
  expect(writes).toHaveLength(0);
  expect(chatbotDb.claimMetaWriteManifestDigest).not.toHaveBeenCalled();
});

it.each([
  { body: 'Lorem ipsum dolor sit amet' },
  { title: 'TBD' },
  { object_story_spec: { link_data: { message: 'Welcome to {{company_name}}' } } },
  { object_story_spec: { video_data: { title: '[INSERT HEADLINE HERE]' } } },
  { object_story_spec: { link_data: { child_attachments: [{ description: 'YOUR_TEXT_HERE' }] } } },
  { asset_feed_spec: { bodies: [{ text: '[Your company name]' }] } },
  { asset_feed_spec: { titles: [null] } },
  { object_story_spec: { link_data: { message: 42 } } },
])('refuses placeholder copy or malformed creative text before approval: %p', async content => {
  creatives.set('creative-3', { ...creatives.get('creative-3'), ...content });
  const result = await preview();
  expect(result.success).toBe(false);
  expect(result.awaitingUserConfirmation).not.toBe(true);
  expect(writes).toHaveLength(0);
});

it.each(['missing', 'foreign', 'placeholder', 'read-error'])('rechecks the third creative (%s) before creating any parent', async failure => {
  const deck = await stage();
  if (failure === 'missing') creatives.delete('creative-3');
  if (failure === 'foreign') creatives.get('creative-3').account_id = '222';
  if (failure === 'placeholder') creatives.get('creative-3').body = 'INSERT COPY HERE';
  if (failure === 'read-error') (metaService.getAdCreative as jest.Mock).mockRejectedValue(new Error('Meta unavailable'));
  const result = await service.submitApprovalDeckAnswers(SESSION, deck.deckId, [{ itemId: deck.items[0].itemId, verdict: 'approve' }], 'user');
  if (result.outcome !== 'submitted') throw new Error('not submitted');
  expect(result.summary?.status).not.toBe('fully_applied');
  expect(writes).toHaveLength(0);
});

it.each(['three ads', '3 ads', 'three ad variants'])('blocks a self-consistent two-ad model proposal when the user requested %s', async request => {
  messages = [{ role: 'user', content: `Build one campaign with ${request}.` },
    { role: 'assistant', content: 'I will create two ads.' }, { role: 'user', content: 'Proceed.' }];
  const params = brief(); params.requested_ad_count = 2; params.ads.pop();
  const result = await preview(params);
  expect(result.success).toBe(false);
  expect(result.message).toMatch(/3/);
  expect(result.awaitingUserConfirmation).not.toBe(true);
  expect(writes).toHaveLength(0);
});

it('requires a user-sourced count instead of trusting a model-only count', async () => {
  messages = [{ role: 'assistant', content: 'Create three ads.' }];
  expect((await preview()).success).toBe(false);
  expect(writes).toHaveLength(0);
});

it('rechecks user count before writes if the brief changed after preview', async () => {
  const deck = await stage();
  messages.push({ role: 'user', content: 'Actually, create four ads.' });
  const result = await service.submitApprovalDeckAnswers(SESSION, deck.deckId, [{ itemId: deck.items[0].itemId, verdict: 'approve' }], 'user');
  if (result.outcome !== 'submitted') throw new Error('not submitted');
  expect(result.summary?.status).not.toBe('fully_applied');
  expect(writes).toHaveLength(0);
});

it.each([
  { age_min: 25 },
  { excluded_geo_locations: { countries: ['CA'] } },
  { flexible_spec: [{ interests: [{ id: 'interest-1' }] }] },
])('rejects extra material targeting in Meta read-back: %p', async extra => {
  (metaService.listAdSets as jest.Mock).mockImplementation(async (_a, _t, _c, opts) => {
    const node = nodes.get(opts.adSetId);
    return { adSets: [{ ...node, targeting: { ...node.targeting, ...extra } }] };
  });
  const result = await approve();
  if (result.outcome !== 'submitted') throw new Error('not submitted');
  expect(result.summary?.status).not.toBe('fully_applied');
  expect(writes).toHaveLength(2);
});

it('reads and rejects an unapproved campaign budget before creating children', async () => {
  (metaService.listCampaigns as jest.Mock).mockImplementation(async (_a, _t, opts) => ({
    campaigns: [{ ...nodes.get(opts.campaignId), ...(opts.fields.includes('daily_budget') ? { daily_budget: '10000' } : {}) }],
  }));
  const result = await approve();
  if (result.outcome !== 'submitted') throw new Error('not submitted');
  expect(result.summary?.status).not.toBe('fully_applied');
  expect(writes).toHaveLength(1);
});

it.each(['CAMPAIGN', 'AD_SET', 'AD'])('bundle approval never authorizes %s activation', async entity => {
  await approve();
  const result: any = await service.callMetaMarketingApi('user-1', entity as any, 'UPDATE', ACCOUNT,
    entity === 'CAMPAIGN' ? 'CAMPAIGN-1' : undefined, entity === 'AD_SET' ? 'AD_SET-2' : undefined,
    entity === 'AD' ? 'AD-3' : undefined, { status: 'ACTIVE', confirm: true }, SESSION);
  expect(result.awaitingUserConfirmation).toBe(true);
  expect(writes).toHaveLength(5);
});

it('distinguishes one ad set from three ads in the human brief', async () => {
  messages = [{ role: 'user', content: 'Create one campaign, one ad set, and three ads.' }];
  expect((await preview()).awaitingUserConfirmation).toBe(true);
});

it('preserves approved Meta URL-tag macros and null optional creative fields', async () => {
  for (const creative of creatives.values()) {
    creative.url_tags = 'utm_campaign={{campaign.id}}&utm_content={{ad.id}}';
    creative.object_story_spec.link_data.caption = null;
  }
  const result = await approve();
  if (result.outcome !== 'submitted') throw new Error('not submitted');
  expect(result.summary?.status).toBe('fully_applied');
});

it('blocks a changed top-level creative image before writes', async () => {
  creatives.get('creative-3').image_url = 'https://agentweb.pro/original.png';
  const deck = await stage();
  creatives.get('creative-3').image_url = 'https://agentweb.pro/different.png';
  await service.submitApprovalDeckAnswers(SESSION, deck.deckId, [{ itemId: deck.items[0].itemId, verdict: 'approve' }], 'user');
  expect(writes).toHaveLength(0);
});

it('does not let duplicate targeting IDs hide an extra audience', async () => {
  const input = brief();
  (input.ad_set.targeting as any).custom_audiences = [{ id: 'audience-1' }, { id: 'audience-1' }];
  const result = await preview(input);
  const deck = (service as any).buildMetaWriteApprovalDeckFromHalts([result]);
  await chatbotDb.updateSessionApprovalDeck(SESSION, deck);
  (metaService.listAdSets as jest.Mock).mockImplementation(async (_a, _t, _c, opts) => {
    const node = nodes.get(opts.adSetId);
    return { adSets: [{ ...node, targeting: { ...node.targeting, custom_audiences: [{ id: 'audience-1' }, { id: 'audience-2' }] } }] };
  });
  await service.submitApprovalDeckAnswers(SESSION, deck.deckId, [{ itemId: deck.items[0].itemId, verdict: 'approve' }], 'user');
  expect(writes).toHaveLength(2);
});

it.each([{ object_story_spec: {} }, { body: '' }, { asset_feed_spec: { bodies: [{}] } }])('refuses creative content that cannot be inspected: %p', async content => {
  creatives.set('creative-3', { id: 'creative-3', account_id: ACCOUNT, ...content });
  expect((await preview()).success).toBe(false);
  expect(writes).toHaveLength(0);
});

it('blocks a material carousel ordering change after approval', async () => {
  creatives.get('creative-3').object_story_spec.link_data.child_attachments = [
    { name: 'First offer', link: 'https://agentweb.pro/first' },
    { name: 'Second offer', link: 'https://agentweb.pro/second' },
  ];
  const deck = await stage();
  creatives.get('creative-3').object_story_spec.link_data.child_attachments.reverse();
  await service.submitApprovalDeckAnswers(SESSION, deck.deckId, [{ itemId: deck.items[0].itemId, verdict: 'approve' }], 'user');
  expect(writes).toHaveLength(0);
});
