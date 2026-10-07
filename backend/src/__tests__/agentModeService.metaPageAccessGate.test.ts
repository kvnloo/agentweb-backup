/**
 * ENG-2232 — deterministic Page-access preflight at CAMPAIGN CREATE.
 *
 * Production incident this closes: ad account 1209971551106961 reported
 * ads_capable:true (ads_read granted) while PAGE LIST returned 0 Facebook
 * Pages, both before and after the customer reconnected. Nothing blocked the
 * build — the agent built 4 campaigns and 4 ad sets, all approved through the
 * deck, before the first AD_CREATIVE CREATE finally failed with Meta's own
 * Page-permission error.
 *
 * The capability flag (list_connected_accounts / Settings) already surfaced
 * this, but surfacing it is advisory — a model can still choose to build
 * anyway, which is exactly what happened in the reported session. This test
 * file covers the hard stop: CAMPAIGN CREATE must refuse to even start a
 * build when Page access is confirmed missing, the same way the ENG-400
 * objective gate (tested separately) refuses an unconfirmed objective.
 *
 * Also covers the narrower AD_CREATIVE CREATE gate: the CAMPAIGN CREATE gate
 * above only catches a build that starts with a brand-new campaign — adding
 * a creative to an EXISTING campaign never goes through it. AD_CREATIVE
 * CREATE always carries a concrete page_id (Meta requires it), so that gate
 * checks the literal requested Page against the accessible set directly,
 * rather than the CAMPAIGN gate's historical-existing-ads heuristic.
 */

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({ isReady: jest.fn().mockReturnValue(true) })),
}));

jest.mock('../services/metaService', () => {
  const actual = jest.requireActual('../services/metaService');
  return {
    ...actual,
    metaService: {
      createCampaign: jest.fn(),
      createAdCreative: jest.fn(),
      createAd: jest.fn(),
    },
  };
});

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('secrets-manager-token'),
}));

const mockIsTokenValid = jest.fn().mockResolvedValue(true);
jest.mock('../services/connectedAccountsDb', () => {
  const actual = jest.requireActual('../services/connectedAccountsDb');
  return {
    ...actual,
    isTokenValid: (...args: any[]) => mockIsTokenValid(...args),
  };
});

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getMessagesFromMessagesTable: jest.fn().mockResolvedValue([]),
    getChatSession: jest.fn(),
    updateSessionObjectiveConfirmation: jest.fn().mockResolvedValue(undefined),
    createChatSession: jest.fn().mockResolvedValue({ sessionId: 'auto-created-session' }),
  },
}));

import { AgentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';
import { userDb } from '../services/db';
import { chatbotDb } from '../services/chatbotService';
import { META_ADS_NO_PAGES_MESSAGE, buildMetaAdsWrongPageMessage, buildMetaAdsPageNotAccessibleMessage } from '../utils/metaAdsScope';

const AD_ACCOUNT_ID = '1209971551106961';
const SESSION_ID = 'session-1';

/** Settles the ENG-400 objective gate so the test reaches the Page gate right after it. */
const OBJECTIVE_CORRELATOR = `${AD_ACCOUNT_ID}|test campaign|||NONE`;

const metaAccount = (config: Record<string, any>) => ({
  platform: 'meta',
  account_id: AD_ACCOUNT_ID,
  account_name: 'My Health Surveys',
  config: {
    account_type: 'ad_account',
    ad_account_id: AD_ACCOUNT_ID,
    access_token: 'EAA-token',
    token_expires_at: Date.now() + 86_400_000,
    granted_scopes: ['ads_read'],
    ...config,
  },
});

const callApi = (service: AgentModeService, params: any = {}) =>
  (service as any).callMetaMarketingApi(
    'user1', 'CAMPAIGN', 'CREATE', AD_ACCOUNT_ID, undefined, undefined, undefined,
    {
      name: 'Test Campaign',
      special_ad_categories: ['NONE'],
      confirm: true,
      objective: 'OUTCOME_LEADS',
      ...params,
    },
    SESSION_ID,
  );

describe('AgentModeService — Meta Page-access CAMPAIGN CREATE gate (ENG-2232)', () => {
  let service: AgentModeService;

  beforeEach(() => {
    service = new AgentModeService();
    jest.clearAllMocks();
    mockIsTokenValid.mockResolvedValue(true);
    (metaService.createCampaign as jest.Mock).mockResolvedValue({ id: 'camp_1', name: 'Test Campaign' });
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId: SESSION_ID,
      objectiveConfirmations: {
        [`meta_objective:${OBJECTIVE_CORRELATOR}`]: {
          objective: 'OUTCOME_LEADS',
          answeredBy: 'user',
          at: '2026-09-30T00:00:00.000Z',
        },
      },
    });
    jest.spyOn(service as any, 'claimMetaWriteManifestGrant').mockResolvedValue({ granted: true, digest: 'stub-digest' });
  });

  it('blocks CAMPAIGN CREATE with the no-Pages message when has_meta_pages is confirmed false', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      id: 'user1',
      connected_accounts: [metaAccount({ has_meta_pages: false })],
    });

    const result = await callApi(service);

    expect(result.success).toBe(false);
    expect(result.message).toBe(META_ADS_NO_PAGES_MESSAGE);
    expect(result.error).toContain('META_PAGE_ACCESS_MISSING');
    expect(metaService.createCampaign).not.toHaveBeenCalled();
  });

  it('names the specific Page in the message when the block is a wrong-Page mismatch', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      id: 'user1',
      connected_accounts: [
        metaAccount({ has_meta_pages: false, existing_ads_page_id: '1010991085424542' }),
      ],
    });

    const result = await callApi(service);

    expect(result.success).toBe(false);
    expect(result.message).toBe(buildMetaAdsWrongPageMessage('1010991085424542'));
    expect(result.message).toContain('1010991085424542');
    expect(metaService.createCampaign).not.toHaveBeenCalled();
  });

  it('allows CAMPAIGN CREATE through when has_meta_pages is confirmed true', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      id: 'user1',
      connected_accounts: [metaAccount({ has_meta_pages: true })],
    });

    const result = await callApi(service);

    expect(result.success).toBe(true);
    expect(metaService.createCampaign).toHaveBeenCalled();
  });

  it('allows CAMPAIGN CREATE through when Page access was never probed (unknown, not missing) — a legacy record must not be blocked', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      id: 'user1',
      connected_accounts: [metaAccount({})], // no has_meta_pages field at all
    });

    const result = await callApi(service);

    expect(result.success).toBe(true);
    expect(metaService.createCampaign).toHaveBeenCalled();
  });

  it('does not gate non-CAMPAIGN-CREATE Meta writes on Page access (narrow scope, matches the objective gate)', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      id: 'user1',
      connected_accounts: [metaAccount({ has_meta_pages: false })],
    });

    const result = await (service as any).callMetaMarketingApi(
      'user1', 'CAMPAIGN', 'UPDATE', AD_ACCOUNT_ID, 'camp_1', undefined, undefined,
      { confirm: true, status: 'PAUSED' },
      SESSION_ID,
    );

    // An UPDATE isn't gated by this preflight — it must reach dispatch (and fail
    // or succeed) for reasons unrelated to Page access, never this gate's message.
    expect(result.error).not.toContain('META_PAGE_ACCESS_MISSING');
  });
});

describe('AgentModeService — Meta AD_CREATIVE CREATE page_id gate (ENG-2232)', () => {
  let service: AgentModeService;

  const validCreativeParams = (extra: any = {}) => ({
    name: 'Test Creative',
    page_id: '1010991085424542',
    body: 'Body copy',
    title: 'Title',
    link_url: 'https://example.com',
    image_hash: 'abc123',
    confirm: true,
    ...extra,
  });

  const callCreativeApi = (params: any = {}) =>
    (service as any).callMetaMarketingApi(
      'user1', 'AD_CREATIVE', 'CREATE', AD_ACCOUNT_ID, undefined, undefined, undefined,
      validCreativeParams(params),
      SESSION_ID,
    );

  beforeEach(() => {
    service = new AgentModeService();
    jest.clearAllMocks();
    mockIsTokenValid.mockResolvedValue(true);
    (metaService.createAdCreative as jest.Mock).mockResolvedValue({ id: 'creative_1' });
  });

  it('blocks AD_CREATIVE CREATE when the requested page_id is not in the accessible set', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      id: 'user1',
      connected_accounts: [metaAccount({ accessible_page_ids: ['some_other_page'] })],
    });

    const result = await callCreativeApi({ page_id: '1010991085424542' });

    expect(result.success).toBe(false);
    expect(result.message).toBe(buildMetaAdsPageNotAccessibleMessage('1010991085424542'));
    expect(result.error).toContain('META_PAGE_ACCESS_MISSING');
    expect(metaService.createAdCreative).not.toHaveBeenCalled();
  });

  it('blocks AD_CREATIVE CREATE when the accessible set is confirmed empty', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      id: 'user1',
      connected_accounts: [metaAccount({ accessible_page_ids: [] })],
    });

    const result = await callCreativeApi({ page_id: '1010991085424542' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('META_PAGE_ACCESS_MISSING');
    expect(metaService.createAdCreative).not.toHaveBeenCalled();
  });

  it('allows AD_CREATIVE CREATE through when the requested page_id IS in the accessible set', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      id: 'user1',
      connected_accounts: [metaAccount({ accessible_page_ids: ['1010991085424542', 'other_page'] })],
    });

    const result = await callCreativeApi({ page_id: '1010991085424542' });

    // Downstream of the gate (getCustomerUtmDefault etc.) isn't mocked here — the
    // only thing this test asserts is that the gate itself did not block.
    expect(result.error ?? '').not.toContain('META_PAGE_ACCESS_MISSING');
  });

  it('allows AD_CREATIVE CREATE through when accessible_page_ids was never probed (unknown, not missing)', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      id: 'user1',
      connected_accounts: [metaAccount({})], // no accessible_page_ids field at all
    });

    const result = await callCreativeApi({ page_id: '1010991085424542' });

    expect(result.error ?? '').not.toContain('META_PAGE_ACCESS_MISSING');
  });

  it('is independent of the historical existing_ads_page_id signal — checks the literal requested page_id', async () => {
    // existing ads use a DIFFERENT page than the one this call requests, but the
    // requested page IS in the accessible set — must not be blocked on history.
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      id: 'user1',
      connected_accounts: [
        metaAccount({
          has_meta_pages: false,
          existing_ads_page_id: 'some_legacy_page',
          accessible_page_ids: ['1010991085424542'],
        }),
      ],
    });

    const result = await callCreativeApi({ page_id: '1010991085424542' });

    expect(result.error ?? '').not.toContain('META_PAGE_ACCESS_MISSING');
  });
});

describe('AgentModeService — Meta AD write Page-access gate (ENG-2274)', () => {
  let service: AgentModeService;

  beforeEach(() => {
    service = new AgentModeService();
    jest.clearAllMocks();
    mockIsTokenValid.mockResolvedValue(true);
    (metaService.createAd as jest.Mock).mockResolvedValue({ id: 'ad_1', name: 'Test Ad' });
    jest.spyOn(service as any, 'claimMetaWriteManifestGrant').mockResolvedValue({ granted: true, digest: 'stub-digest' });
  });

  it('blocks direct AD CREATE when the connection has confirmed zero accessible Pages', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      id: 'user1',
      connected_accounts: [metaAccount({ has_meta_pages: false })],
    });

    const result = await (service as any).callMetaMarketingApi(
      'user1', 'AD', 'CREATE', AD_ACCOUNT_ID, 'camp_1', 'adset_1', undefined,
      { name: 'Test Ad', creative_id: 'creative_1', status: 'PAUSED', confirm: true },
      SESSION_ID,
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe(META_ADS_NO_PAGES_MESSAGE);
    expect(result.error).toContain('META_PAGE_ACCESS_MISSING');
    expect(metaService.createAd).not.toHaveBeenCalled();
  });

  it('does not block direct AD CREATE when Page access is unknown on a legacy record', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      id: 'user1',
      connected_accounts: [metaAccount({})],
    });

    const result = await (service as any).callMetaMarketingApi(
      'user1', 'AD', 'CREATE', AD_ACCOUNT_ID, 'camp_1', 'adset_1', undefined,
      { name: 'Test Ad', creative_id: 'creative_1', status: 'PAUSED', confirm: true },
      SESSION_ID,
    );

    expect(result.error ?? '').not.toContain('META_PAGE_ACCESS_MISSING');
  });
});
