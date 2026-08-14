/**
 * ENG-941 — the Meta launch gate as wired into agentModeService.
 *
 * Mirrors googleAdsLaunchGate.test.ts. Everything external is mocked: no network,
 * no Graph API, no DynamoDB.
 */
const mockPreflight = jest.fn();
jest.mock('../services/metaTrackingPreflight', () => ({
  preflightMetaTrackingGate: (...a: any[]) => mockPreflight(...a),
  META_TRACKING_MECHANISMS: ['Meta pixel base code (fbq init)'],
}));

const mockListPixels = jest.fn();
const mockListAds = jest.fn();
jest.mock('../services/metaService', () => ({
  __esModule: true,
  metaService: {
    listPixels: (...a: any[]) => mockListPixels(...a),
    listAdsForUtmAudit: (...a: any[]) => mockListAds(...a),
  },
}));

const mockRecord = jest.fn();
jest.mock('../services/chatbotService', () => ({
  __esModule: true,
  chatbotDb: { recordMetaMeasurementCheck: (...a: any[]) => mockRecord(...a) },
}));

import { _runMetaTrackingGateForTest } from '../services/metaLaunchGate';

const ACCOUNT = '409853340719899';
const CAMPAIGN = '120200000000000';
const PIXEL = '1012387921717047';

const creds = { accountId: ACCOUNT, accessToken: 'tok' };

describe('Meta launch gate (ENG-941)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListPixels.mockResolvedValue([{ id: PIXEL, name: 'Test Pixel' }]);
    mockListAds.mockResolvedValue([{ adId: 'a1', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/lp'] }]);
    mockPreflight.mockResolvedValue({ ok: true, results: [], blockedUrls: [], message: '' });
  });

  it('proceeds and records a pass when every destination is measured', async () => {
    const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', false, 'sess-1');
    expect(out.proceed).toBe(true);
    expect(mockRecord).toHaveBeenCalledWith('sess-1', expect.objectContaining({ outcome: 'passed', accountId: ACCOUNT }));
  });

  it('blocks an unmeasured launch and returns the gate message', async () => {
    mockPreflight.mockResolvedValue({
      ok: false,
      results: [{ url: 'https://site.example/lp', status: 'unmeasured', mechanisms: [], checkedFor: [] }],
      blockedUrls: [{ url: 'https://site.example/lp', status: 'unmeasured', mechanisms: [], checkedFor: [] }],
      message: 'Launch blocked: ...',
    });
    const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', false, 'sess-1');
    expect(out.proceed).toBe(false);
    expect(out.blockResult).toEqual(
      expect.objectContaining({ success: false, blocked: true, reason: 'tracking_preflight' }),
    );
    expect(out.blockResult.error).toContain('Launch blocked');
    expect(mockRecord).toHaveBeenCalledWith('sess-1', expect.objectContaining({ outcome: 'blocked' }));
  });

  it('proceeds on an explicit override and persists it as overridden, not passed', async () => {
    mockPreflight.mockResolvedValue({ ok: false, results: [], blockedUrls: [{}], message: 'blocked' });
    const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', true, 'sess-1');
    expect(out.proceed).toBe(true);
    expect(mockRecord).toHaveBeenCalledWith('sess-1', expect.objectContaining({ outcome: 'overridden' }));
  });

  it('passes the ad account\'s own pixel ids into the check', async () => {
    mockListPixels.mockResolvedValue([{ id: PIXEL }, { id: '999' }]);
    await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', false, 'sess-1');
    expect(mockPreflight).toHaveBeenCalledWith(['https://site.example/lp'], [PIXEL, '999']);
  });

  it('gathers destinations across every ad in the campaign', async () => {
    mockListAds.mockResolvedValue([
      { adId: 'a1', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/one'] },
      { adId: 'a2', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/two', 'https://site.example/one'] },
    ]);
    await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', false, 'sess-1');
    const urls = mockPreflight.mock.calls[0][0];
    expect(urls).toEqual(expect.arrayContaining(['https://site.example/one', 'https://site.example/two']));
  });

  it('proceeds when the campaign has no serving destinations yet — nothing to gate', async () => {
    mockListAds.mockResolvedValue([]);
    const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'CREATE', false, 'sess-1');
    expect(out.proceed).toBe(true);
    expect(mockPreflight).not.toHaveBeenCalled();
  });

  /*
   * AC4: an API failure is "could not verify", which follows the blocked path. The
   * dangerous version of this bug is the opposite — treating an error as a pass and
   * letting spend start against tracking nobody actually checked.
   */
  it('blocks when the ad list cannot be read, rather than assuming measured', async () => {
    mockListAds.mockRejectedValue(new Error('Graph API 500'));
    const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', false, 'sess-1');
    expect(out.proceed).toBe(false);
    expect(out.blockResult.error).toContain('could not verify');
    expect(mockRecord).toHaveBeenCalledWith('sess-1', expect.objectContaining({ outcome: 'blocked' }));
  });

  it('blocks when the pixel list cannot be read', async () => {
    mockListPixels.mockRejectedValue(new Error('Graph API 401'));
    const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', false, 'sess-1');
    expect(out.proceed).toBe(false);
    expect(out.blockResult.error).toContain('could not verify');
  });

  it('lets an explicit override through even when verification itself failed', async () => {
    mockListAds.mockRejectedValue(new Error('Graph API 500'));
    const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', true, 'sess-1');
    expect(out.proceed).toBe(true);
    expect(mockRecord).toHaveBeenCalledWith('sess-1', expect.objectContaining({ outcome: 'overridden' }));
  });

  it('never lets a persistence failure break the launch flow', async () => {
    mockRecord.mockRejectedValue(new Error('dynamo down'));
    const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', false, 'sess-1');
    expect(out.proceed).toBe(true);
  });
});

describe('isMetaSpendStartingWrite (ENG-941)', () => {
  // Requiring all three terms is what keeps the gate off the ~40 other Meta writes
  // Emma makes. Getting this predicate wrong in either direction is the whole risk:
  // too narrow and spend starts ungated, too broad and every read-ish write blocks.
  const { isMetaSpendStartingWrite } = require('../services/metaLaunchGate');

  it.each([
    ['CAMPAIGN', 'UPDATE', 'ACTIVE', true],
    ['CAMPAIGN', 'CREATE', 'ACTIVE', true],
    ['AD_SET', 'UPDATE', 'ACTIVE', true],
    ['AD', 'UPDATE', 'ACTIVE', true],
    ['CAMPAIGN', 'UPDATE', 'PAUSED', false],
    ['CAMPAIGN', 'DELETE', 'ACTIVE', false],
    ['CAMPAIGN', 'GET', 'ACTIVE', false],
    ['AD_CREATIVE', 'CREATE', 'ACTIVE', false],
    ['CUSTOM_AUDIENCE', 'CREATE', 'ACTIVE', false],
    ['CAMPAIGN', 'UPDATE', undefined, false],
  ])('%s / %s / status=%s -> %s', (entity, action, status, expected) => {
    expect(isMetaSpendStartingWrite(entity as any, action as any, status ? { status } : {})).toBe(expected);
  });

  it('is case-insensitive on status, since callers pass it through verbatim', () => {
    expect(isMetaSpendStartingWrite('CAMPAIGN', 'UPDATE', { status: 'active' })).toBe(true);
  });

  it('treats a null or missing params object as not spend-starting', () => {
    expect(isMetaSpendStartingWrite('CAMPAIGN', 'UPDATE', null as any)).toBe(false);
    expect(isMetaSpendStartingWrite('CAMPAIGN', 'UPDATE', undefined as any)).toBe(false);
  });
});

/**
 * ENG-941: /stats explains a block, it never lifts one. The distinction matters —
 * /stats is account-pixel-level, so treating activity as a pass would wave through a
 * customer with one instrumented page and one dark lander, i.e. RankAI's incident.
 */
describe('server-side activity hint (ENG-941)', () => {
  beforeEach(() => {
    mockPreflight.mockResolvedValue({
      ok: false,
      results: [{ url: 'https://site.example/lp', status: 'unmeasured', mechanisms: [], checkedFor: [] }],
      blockedUrls: [{ url: 'https://site.example/lp', status: 'unmeasured', mechanisms: [], checkedFor: [] }],
      message: 'Launch blocked: no pixel.',
    });
  });

  it('still blocks when the account pixel is active, and says so in the message', async () => {
    const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', false, 'sess-1', {
      pixelHasRecentActivity: async () => true,
    });
    expect(out.proceed).toBe(false);
    expect(out.blockResult.error).toContain('IS receiving events server-side');
    expect(out.blockResult.error).toContain(PIXEL);
    expect(out.blockResult.error).toContain('override');
  });

  it('adds no hint when the account pixel shows no recent activity', async () => {
    const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', false, 'sess-1', {
      pixelHasRecentActivity: async () => false,
    });
    expect(out.proceed).toBe(false);
    expect(out.blockResult.error).not.toContain('IS receiving events server-side');
  });

  it('ignores a stats lookup failure rather than breaking or passing the launch', async () => {
    const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', false, 'sess-1', {
      pixelHasRecentActivity: async () => {
        throw new Error('stats 500');
      },
    });
    expect(out.proceed).toBe(false);
    expect(out.blockResult.error).toContain('Launch blocked');
  });

  it('never consults stats when the gate passes', async () => {
    mockPreflight.mockResolvedValue({ ok: true, results: [], blockedUrls: [], message: '' });
    const probe = jest.fn();
    const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', false, 'sess-1', {
      pixelHasRecentActivity: probe as any,
    });
    expect(out.proceed).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('scoping and bypass fixes (ENG-941)', () => {
  beforeEach(() => {
    mockPreflight.mockResolvedValue({ ok: true, results: [], blockedUrls: [], message: '' });
  });

  /*
   * createAdSet is the odd one out: createCampaign and createAd both apply
   * `params.status || PAUSED`, but createAdSet only sets status when given, so an omitted
   * status falls through to Meta's default of ACTIVE. Without this, an ad set created with
   * no status starts delivering and never meets the gate.
   */
  it('treats an AD_SET CREATE with no status as spend-starting', () => {
    const { isMetaSpendStartingWrite } = require('../services/metaLaunchGate');
    expect(isMetaSpendStartingWrite('AD_SET', 'CREATE', {})).toBe(true);
    expect(isMetaSpendStartingWrite('AD_SET', 'CREATE', { name: 'x' })).toBe(true);
  });

  it('does not gate entities that genuinely default to paused, or updates with no status', () => {
    const { isMetaSpendStartingWrite } = require('../services/metaLaunchGate');
    expect(isMetaSpendStartingWrite('CAMPAIGN', 'CREATE', {})).toBe(false);
    expect(isMetaSpendStartingWrite('AD', 'CREATE', {})).toBe(false);
    expect(isMetaSpendStartingWrite('AD_SET', 'UPDATE', {})).toBe(false);
    expect(isMetaSpendStartingWrite('AD_SET', 'CREATE', { status: 'PAUSED' })).toBe(false);
  });

  it('blocks rather than scanning the whole account when no campaign is identified', async () => {
    const out = await _runMetaTrackingGateForTest(creds, undefined, 'AD_SET_UPDATE', false, 'sess-1');
    expect(out.proceed).toBe(false);
    expect(out.blockResult.error).toContain('no campaign was identified');
    expect(mockListAds).not.toHaveBeenCalled();
  });

  it('still honours an override when no campaign is identified', async () => {
    const out = await _runMetaTrackingGateForTest(creds, undefined, 'AD_SET_UPDATE', true, 'sess-1');
    expect(out.proceed).toBe(true);
    expect(mockRecord).toHaveBeenCalledWith('sess-1', expect.objectContaining({ outcome: 'overridden' }));
  });

  it('judges a single ad on its own destination, not its siblings', async () => {
    mockListAds.mockResolvedValue([
      { adId: 'ad-good', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/good'] },
      { adId: 'ad-bad', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/bad'] },
    ]);
    await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'AD_UPDATE', false, 'sess-1', {}, 'ad-good');
    expect(mockPreflight).toHaveBeenCalledWith(['https://site.example/good'], [PIXEL]);
  });

  it('checks the whole campaign when no single ad is named', async () => {
    mockListAds.mockResolvedValue([
      { adId: 'ad-good', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/good'] },
      { adId: 'ad-bad', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/bad'] },
    ]);
    await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'AD_SET_UPDATE', false, 'sess-1');
    const urls = mockPreflight.mock.calls[0][0];
    expect(urls).toEqual(['https://site.example/good', 'https://site.example/bad']);
  });
});

/**
 * Greptile findings on PR #2406, all three real:
 *  - an ad created ACTIVE was checked against its siblings, shipping its own destination unchecked
 *  - inert pixel text (comments, docs snippets) counted as an install
 *  - the override was trusted but never disclosed in the confirmation the user approves
 */
describe('Greptile findings (ENG-941)', () => {
  const { collectPendingDestinations } = require('../services/metaLaunchGate');

  it('collects the destination of an ad being created, from any of the shapes Meta accepts', () => {
    expect(collectPendingDestinations('AD', 'CREATE', { link_url: 'https://a/1' })).toEqual(['https://a/1']);
    expect(collectPendingDestinations('AD', 'CREATE', {
      creative: { object_story_spec: { link_data: { link: 'https://a/2' } } },
    })).toEqual(['https://a/2']);
    expect(collectPendingDestinations('AD', 'CREATE', {
      creative: { asset_feed_spec: { link_urls: [{ website_url: 'https://a/3' }, { link: 'https://a/4' }] } },
    })).toEqual(['https://a/3', 'https://a/4']);
  });

  /*
   * This originally asserted AD UPDATE collects nothing, which encoded the round-5 bug:
   * an update carrying creative content swaps in a NEW creative, so its inline destination
   * is exactly what must be checked. See 'inline creative swap on AD UPDATE' below.
   */
  it('collects nothing for unrelated entities or empty params', () => {
    expect(collectPendingDestinations('CAMPAIGN', 'CREATE', { link_url: 'https://a/1' })).toEqual([]);
    expect(collectPendingDestinations('AD', 'CREATE', null)).toEqual([]);
    expect(collectPendingDestinations('AD', 'DELETE', { link_url: 'https://a/1' })).toEqual([]);
  });

  it('checks a newly created ad\'s own destination, not just the existing campaign ads', async () => {
    mockListAds.mockResolvedValue([
      { adId: 'existing', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/already-fine'] },
    ]);
    await _runMetaTrackingGateForTest(
      creds, CAMPAIGN, 'AD_CREATE', false, 'sess-1', {}, undefined, ['https://site.example/brand-new'],
    );
    const urls = mockPreflight.mock.calls[0][0];
    expect(urls).toContain('https://site.example/brand-new');
  });
});

/*
 * Greptile P1, round 3 ("Referenced destination remains unchecked"). `collectPendingDestinations`
 * reads INLINE creative shapes, but Meta's documented ad-create path references an existing
 * creative by id — the destination then lives only on that creative, and the new ad has no
 * entry in the ad list to fall back on. The gate checked siblings (or nothing) and let an
 * ACTIVE ad launch at a destination it never looked at.
 */
describe('referenced creative destinations (ENG-941)', () => {
  const { collectPendingCreativeIds } = require('../services/metaLaunchGate');

  it('collects a referenced creative id from either shape Meta accepts', () => {
    expect(collectPendingCreativeIds('AD', 'CREATE', { creative_id: '120299' })).toEqual(['120299']);
    expect(collectPendingCreativeIds('AD', 'CREATE', { creative: { creative_id: '120299' } })).toEqual(['120299']);
    expect(collectPendingCreativeIds('AD', 'CREATE', { creative: { id: '120299' } })).toEqual(['120299']);
  });

  it('collects nothing when the creative is inlined or absent', () => {
    expect(collectPendingCreativeIds('AD', 'CREATE', { creative: { link_url: 'https://a/1' } })).toEqual([]);
    expect(collectPendingCreativeIds('AD', 'CREATE', null)).toEqual([]);
    expect(collectPendingCreativeIds('CAMPAIGN', 'CREATE', { creative_id: '120299' })).toEqual([]);
  });

  /*
   * The creative-SWAP path (AD UPDATE with params.creative_id) is documented in the tool
   * itself. It has the same hole in a different place: the ad exists, so the gate reads its
   * destination from the ad list — which is the OLD creative's destination, not the one this
   * write is about to make serve.
   */
  it('collects a swapped-in creative id on an AD UPDATE', () => {
    expect(collectPendingCreativeIds('AD', 'UPDATE', { creative_id: '120299' })).toEqual(['120299']);
  });

  it('uses the swapped-in destination instead of the ad\'s current one', async () => {
    mockListAds.mockResolvedValue([
      { adId: 'ad-42', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/old'] },
    ]);
    await _runMetaTrackingGateForTest(
      creds, CAMPAIGN, 'AD_UPDATE', false, 'sess-1',
      { resolveCreativeDestinations: jest.fn().mockResolvedValue(['https://site.example/new']) },
      'ad-42', [], ['120299'],
    );
    expect(mockPreflight.mock.calls[0][0]).toEqual(['https://site.example/new']);
  });

  it('resolves a referenced creative to its destination and checks it', async () => {
    mockListAds.mockResolvedValue([]);
    const resolveCreativeDestinations = jest.fn().mockResolvedValue(['https://site.example/referenced']);
    await _runMetaTrackingGateForTest(
      creds, CAMPAIGN, 'AD_CREATE', false, 'sess-1',
      { resolveCreativeDestinations }, undefined, [], ['120299'],
    );
    expect(resolveCreativeDestinations).toHaveBeenCalledWith('120299', 'tok');
    expect(mockPreflight.mock.calls[0][0]).toContain('https://site.example/referenced');
  });

  it('blocks when a referenced creative cannot be resolved — an unreadable destination is not a measured one', async () => {
    mockListAds.mockResolvedValue([]);
    const resolveCreativeDestinations = jest.fn().mockRejectedValue(new Error('Graph 400'));
    const out = await _runMetaTrackingGateForTest(
      creds, CAMPAIGN, 'AD_CREATE', false, 'sess-1',
      { resolveCreativeDestinations }, undefined, [], ['120299'],
    );
    expect(out.proceed).toBe(false);
    expect(out.blockResult.error).toContain('120299');
    expect(mockPreflight).not.toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledWith('sess-1', expect.objectContaining({ outcome: 'blocked' }));
  });

  it('blocks when a referenced creative resolves to no destination at all — the shape was not understood', async () => {
    mockListAds.mockResolvedValue([]);
    const out = await _runMetaTrackingGateForTest(
      creds, CAMPAIGN, 'AD_CREATE', false, 'sess-1',
      { resolveCreativeDestinations: jest.fn().mockResolvedValue([]) }, undefined, [], ['120299'],
    );
    expect(out.proceed).toBe(false);
    expect(out.blockResult.error).toContain('120299');
  });

  it('still honours an explicit override when a creative cannot be resolved', async () => {
    mockListAds.mockResolvedValue([]);
    const out = await _runMetaTrackingGateForTest(
      creds, CAMPAIGN, 'AD_CREATE', true, 'sess-1',
      { resolveCreativeDestinations: jest.fn().mockRejectedValue(new Error('Graph 400')) }, undefined, [], ['120299'],
    );
    expect(out.proceed).toBe(true);
    expect(mockRecord).toHaveBeenCalledWith('sess-1', expect.objectContaining({ outcome: 'overridden' }));
  });
});

/*
 * The inline collector previously enumerated a fixed list of creative shapes. Meta keeps
 * adding them (video CTA, asset feed, call-to-action link specs), and a shape nobody
 * enumerated yields no destination — a silent fail-open. Collecting by KEY across the
 * creative object instead means a new shape is covered the day Meta ships it.
 */
describe('inline creative destination extraction (ENG-941)', () => {
  const { collectPendingDestinations } = require('../services/metaLaunchGate');

  it('finds a destination nested in a shape the old fixed list did not enumerate', () => {
    expect(collectPendingDestinations('AD', 'CREATE', {
      creative: { object_story_spec: { template_data: { call_to_action: { value: { link: 'https://a/deep' } } } } },
    })).toEqual(['https://a/deep']);
  });

  it('does not mistake creative assets for destinations', () => {
    expect(collectPendingDestinations('AD', 'CREATE', {
      creative: { image_url: 'https://cdn/x.png', thumbnail_url: 'https://cdn/t.png', video_id: '123' },
    })).toEqual([]);
  });
});

/*
 * Greptile P1, round 5 ("Creative swap checks old destination"). AD UPDATE can carry the
 * new destination inline (link_url / a creative object), not only as a creative_id — and
 * the collector only ran for CREATE, so the gate checked the ad list's OLD URL while the
 * update was about to build and activate a replacement creative pointing somewhere else.
 */
describe('inline creative swap on AD UPDATE (ENG-941)', () => {
  const { collectPendingDestinations } = require('../services/metaLaunchGate');

  it('collects an inline destination supplied on an AD UPDATE', () => {
    expect(collectPendingDestinations('AD', 'UPDATE', { link_url: 'https://a/new' })).toEqual(['https://a/new']);
    expect(collectPendingDestinations('AD', 'UPDATE', {
      creative: { object_story_spec: { link_data: { link: 'https://a/new2' } } },
    })).toEqual(['https://a/new2']);
  });

  it('still collects nothing for entities that carry no creative', () => {
    expect(collectPendingDestinations('CAMPAIGN', 'UPDATE', { link_url: 'https://a/1' })).toEqual([]);
    expect(collectPendingDestinations('AD_SET', 'UPDATE', { link_url: 'https://a/1' })).toEqual([]);
  });

  it('checks the inline new destination rather than the ad\'s current one', async () => {
    mockListAds.mockResolvedValue([
      { adId: 'ad-42', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/old'] },
    ]);
    await _runMetaTrackingGateForTest(
      creds, CAMPAIGN, 'AD_UPDATE', false, 'sess-1', {}, 'ad-42', ['https://site.example/new'],
    );
    expect(mockPreflight.mock.calls[0][0]).toEqual(['https://site.example/new']);
  });
});

/*
 * Greptile P1, round 8 ("Active copied ads bypass preflight"). COPY_AD is a third way to
 * create an ad, and `copyMetaAdsAd` ends in `status: params.status || 'PAUSED'` — so a copy
 * requested as ACTIVE starts delivering. SPEND_ACTIONS covered only CREATE and UPDATE, so
 * the gate never ran for it.
 *
 * It also carries its own destination override: `copyMetaAdsAd` reads
 * `params.link_url || params.destination || params.url` (agentModeService.ts:16191), so all
 * three aliases have to be collected HERE or the copy is checked against the source ad's
 * old page while serving a new one.
 */
describe('COPY_AD (ENG-941)', () => {
  const { isMetaSpendStartingWrite, collectPendingDestinations } = require('../services/metaLaunchGate');

  it('treats a copy requested as ACTIVE as spend-starting', () => {
    expect(isMetaSpendStartingWrite('AD', 'COPY_AD', { status: 'ACTIVE' })).toBe(true);
  });

  it('leaves an ordinary copy alone — copies default to PAUSED', () => {
    expect(isMetaSpendStartingWrite('AD', 'COPY_AD', {})).toBe(false);
    expect(isMetaSpendStartingWrite('AD', 'COPY_AD', { status: 'PAUSED' })).toBe(false);
  });

  it('collects the copy\'s destination override under any alias the copy path reads', () => {
    expect(collectPendingDestinations('AD', 'COPY_AD', { link_url: 'https://a/1' })).toEqual(['https://a/1']);
    expect(collectPendingDestinations('AD', 'COPY_AD', { destination: 'https://a/2' })).toEqual(['https://a/2']);
    expect(collectPendingDestinations('AD', 'COPY_AD', { url: 'https://a/3' })).toEqual(['https://a/3']);
  });

  it('collects nothing when the copy keeps the source destination', () => {
    // Nothing inline: the source ad is what serves, and the gate checks it via the ad list.
    expect(collectPendingDestinations('AD', 'COPY_AD', { name: 'Copy of X' })).toEqual([]);
  });

  it('does not collect those aliases on paths that never read them', () => {
    expect(collectPendingDestinations('AD', 'CREATE', { destination: 'https://a/2' })).toEqual([]);
    expect(collectPendingDestinations('AD', 'UPDATE', { url: 'https://a/3' })).toEqual([]);
  });
});
