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

import { _runMetaTrackingGateForTest, computeMetaWriteManifestDigest } from '../services/metaLaunchGate';

const ACCOUNT = '409853340719899';
const CAMPAIGN = '120200000000000';
const PIXEL = '1012387921717047';

const creds = { accountId: ACCOUNT, accessToken: 'tok' };

describe('Meta launch gate (ENG-941)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListPixels.mockResolvedValue({ pixels: [{ id: PIXEL, name: 'Test Pixel' }], truncated: false, pagesFetched: 1 });
    mockListAds.mockResolvedValue({ items: [{ adId: 'a1', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/lp'] }], truncated: false, pagesFetched: 1 });
    mockPreflight.mockResolvedValue({ ok: true, results: [], blockedUrls: [], message: '' });
  });

  /*
   * ENG-1476 follow-up. metaService's list reads report `truncated` when a page/wall-clock
   * bound stops them short. This gate decides from that ad list what a launch would send
   * traffic to, so a partial list means some ads in scope were never checked. It used to
   * discard the flag entirely and judge the launch on whatever it happened to receive.
   */
  describe('a truncated ad read is not a clean read', () => {
    it('blocks a campaign-level activation when the ad list stopped at its bound', async () => {
      mockListAds.mockResolvedValue({ items: [], truncated: true, pagesFetched: 25 });

      const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', false, 'sess-t');

      // An empty destination list from a truncated read is "we did not fetch them", not
      // "there are none" — the old code returned proceed:true here.
      expect(out.proceed).toBe(false);
      expect(out.blockResult.error).toMatch(/could not be read completely/i);
      expect(mockRecord).toHaveBeenCalledWith('sess-t', expect.objectContaining({ outcome: 'blocked' }));
    });

    it('blocks even when some destinations were found, because the rest were never read', async () => {
      mockListAds.mockResolvedValue({
        items: [{ adId: 'a1', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/lp'] }],
        truncated: true,
        pagesFetched: 25,
      });
      mockPreflight.mockResolvedValue({ ok: true, results: [], blockedUrls: [], message: '' });

      const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', false, 'sess-t');

      expect(out.proceed).toBe(false);
      expect(out.blockResult.error).toMatch(/never checked/i);
    });

    it('still honours an explicit override, recorded as overridden rather than passed', async () => {
      mockListAds.mockResolvedValue({ items: [], truncated: true, pagesFetched: 25 });

      const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', true, 'sess-t');

      expect(out.proceed).toBe(true);
      expect(mockRecord).toHaveBeenCalledWith('sess-t', expect.objectContaining({ outcome: 'overridden' }));
    });

    it('does not block a complete read that legitimately has nothing to measure', async () => {
      mockListAds.mockResolvedValue({ items: [], truncated: false, pagesFetched: 1 });

      const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', false, 'sess-t');

      // Guards the opposite error: a campaign with no ads yet must still pass.
      expect(out.proceed).toBe(true);
    });

    it('does not block an AD-level activation, which is judged on that ad alone', async () => {
      mockListAds.mockResolvedValue({
        items: [{ adId: 'a1', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/lp'] }],
        truncated: true,
        pagesFetched: 25,
      });
      mockPreflight.mockResolvedValue({ ok: true, results: [], blockedUrls: [], message: '' });

      const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', false, 'sess-t', {}, 'a1');

      expect(out.proceed).toBe(true);
    });

    it('says the search was incomplete — not that the ad is elsewhere — when a named ad is missed', async () => {
      mockListAds.mockResolvedValue({ items: [], truncated: true, pagesFetched: 25 });

      const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', false, 'sess-t', {}, 'a-missing');

      expect(out.proceed).toBe(false);
      // ENG-1636's lesson: a pre-flight that names the wrong remedy sends the reader to fix
      // a cause that is not theirs.
      expect(out.blockResult.error).toMatch(/not necessarily absent|not have been reached/i);
      /*
       * Same guard the accountWideTruncated branch below already carries, applied to the branch
       * beside it: this module has NO ad-set concept — zero references, and
       * `metaService.listAdsForUtmAudit` takes a campaign id and nothing else — so narrowing to
       * an ad set cannot make the gate's read smaller or change the outcome. The reasoning was
       * written for one branch and not applied to its sibling.
       */
      expect(out.blockResult.error).not.toMatch(/narrow the request to the ad set/i);
      // Supplying the destination IS honoured for an AD entity, so it stays.
      expect(out.blockResult.error).toMatch(/supply the destination on the request/i);
      expect(out.blockResult.error).not.toMatch(/may belong to a different campaign/i);
    });

    /*
     * The two truncation flags answer different questions, and collapsing them
     * (`adsTruncated || accountWideTruncated`) made the message describe a read that had not
     * stopped at all.
     *
     * The account-wide fallback only runs when the CAMPAIGN-scoped read already came back
     * without the ad. So when that campaign read was complete and only the fallback truncated,
     * "the ad list for campaign X was too large to read completely" was false — and it told the
     * user to narrow to the ad set containing an ad that is not in the campaign, while
     * suppressing the one accurate sentence: that the ad may belong to a different campaign.
     */
    it('names the account-wide read, not the campaign read, when only the fallback truncated', async () => {
      mockListAds.mockImplementation((_accountId: string, _token: string, campaignId?: string) =>
        Promise.resolve(
          campaignId
            // Campaign-scoped read: COMPLETE, and the ad is genuinely not in it.
            ? { items: [], truncated: false, pagesFetched: 1 }
            // Account-wide fallback: stopped at its bound, so where the ad lives is unknown.
            : { items: [], truncated: true, pagesFetched: 25 },
        ),
      );

      const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', false, 'sess-t', {}, 'a-missing');

      expect(out.proceed).toBe(false);
      // The campaign read finished — saying it did not is describing the wrong read.
      expect(out.blockResult.error).not.toMatch(/ad list for campaign [^.]*was too large/i);
      // ...and pointing at an ad set inside that campaign is a remedy that cannot work.
      expect(out.blockResult.error).not.toMatch(/narrow the request to the ad set/i);
      // The accurate diagnosis must survive rather than be suppressed by the wrong one.
      expect(out.blockResult.error).toMatch(/may belong to a different campaign/i);
      // And the read that actually stopped short is named.
      expect(out.blockResult.error).toMatch(/account-wide search/i);
    });

    it('keeps the plain not-found message when neither read stopped short', async () => {
      // Guards the opposite error: both reads complete and the ad is simply elsewhere.
      mockListAds.mockResolvedValue({ items: [], truncated: false, pagesFetched: 1 });

      const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', false, 'sess-t', {}, 'a-missing');

      expect(out.proceed).toBe(false);
      expect(out.blockResult.error).toMatch(/may belong to a different campaign/i);
      expect(out.blockResult.error).not.toMatch(/could not be read completely/i);
      expect(out.blockResult.error).not.toMatch(/account-wide search/i);
    });
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
    mockListPixels.mockResolvedValue({ pixels: [{ id: PIXEL }, { id: '999' }], truncated: false, pagesFetched: 1 });
    await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', false, 'sess-1');
    /*
     * Four args now: the pre-flight shares the gate's wall-clock budget, so a launch pointing at
     * many distinct destinations cannot spend unbounded time on top of the ad reads. Asserting
     * the deadline is a real number rather than ignoring it — passing `undefined` would silently
     * restore the unbounded behaviour and this test would not notice.
     */
    expect(mockPreflight).toHaveBeenCalledWith(['https://site.example/lp'], [PIXEL, '999'], {}, expect.any(Number));
  });

  it('gathers destinations across every ad in the campaign', async () => {
    mockListAds.mockResolvedValue({ items: [
      { adId: 'a1', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/one'] },
      { adId: 'a2', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/two', 'https://site.example/one'] },
    ], truncated: false, pagesFetched: 1 });
    await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'UPDATE', false, 'sess-1');
    const urls = mockPreflight.mock.calls[0][0];
    expect(urls).toEqual(expect.arrayContaining(['https://site.example/one', 'https://site.example/two']));
  });

  it('proceeds when the campaign has no serving destinations yet — nothing to gate', async () => {
    mockListAds.mockResolvedValue({ items: [], truncated: false, pagesFetched: 1 });
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

describe('meta write manifest digest (ENG-1642)', () => {
  const call = {
    entity_type: 'AD',
    action: 'UPDATE',
    account_id: ACCOUNT,
    campaign_id: CAMPAIGN,
    ad_set_id: 'adset-1',
    ad_id: 'ad-1',
    params: { status: 'ACTIVE', name: 'Launch ad' },
  };

  it('is stable when gate-only confirmation fields differ', () => {
    const preview = computeMetaWriteManifestDigest('manifest-secret', call);
    const confirmed = computeMetaWriteManifestDigest('manifest-secret', {
      ...call,
      params: { ...call.params, confirm: true, tracking_override_token: 'not-part-of-the-write' },
    });
    expect(confirmed).toBe(preview);
  });

  it.each([
    ['target', { ...call, ad_id: 'another-ad' }],
    ['action', { ...call, action: 'CREATE' }],
    ['params', { ...call, params: { ...call.params, name: 'Different creative' } }],
  ])('changes when the %s changes', (_field, changed) => {
    expect(computeMetaWriteManifestDigest('manifest-secret', changed)).not.toBe(
      computeMetaWriteManifestDigest('manifest-secret', call),
    );
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
    mockListAds.mockResolvedValue({ items: [
      { adId: 'ad-good', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/good'] },
      { adId: 'ad-bad', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/bad'] },
    ], truncated: false, pagesFetched: 1 });
    await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'AD_UPDATE', false, 'sess-1', {}, 'ad-good');
    expect(mockPreflight).toHaveBeenCalledWith(['https://site.example/good'], [PIXEL], {}, expect.any(Number));
  });

  it('checks the whole campaign when no single ad is named', async () => {
    mockListAds.mockResolvedValue({ items: [
      { adId: 'ad-good', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/good'] },
      { adId: 'ad-bad', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/bad'] },
    ], truncated: false, pagesFetched: 1 });
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
    mockListAds.mockResolvedValue({ items: [
      { adId: 'existing', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/already-fine'] },
    ], truncated: false, pagesFetched: 1 });
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
    mockListAds.mockResolvedValue({ items: [
      { adId: 'ad-42', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/old'] },
    ], truncated: false, pagesFetched: 1 });
    await _runMetaTrackingGateForTest(
      creds, CAMPAIGN, 'AD_UPDATE', false, 'sess-1',
      { resolveCreativeDestinations: jest.fn().mockResolvedValue(['https://site.example/new']) },
      'ad-42', [], ['120299'],
    );
    expect(mockPreflight.mock.calls[0][0]).toEqual(['https://site.example/new']);
  });

  /*
   * `adId` is supplied only for an AD-entity write, so it is undefined for every CREATE. Gating
   * the truncation block on `!adId` alone therefore blocked creates whose destination was fully
   * checkable, telling them to "activate a single ad instead" — impossible for an entity that
   * does not exist yet. The ad list's completeness only matters when the ad list is what the
   * decision rests on.
   */
  describe('a truncated ad list and a CREATE that carries its own destination', () => {
    it('does not block a CREATE whose destination came from the request', async () => {
      mockListAds.mockResolvedValue({ items: [], truncated: true, pagesFetched: 25 });
      mockPreflight.mockResolvedValue({ ok: true, results: [], blockedUrls: [], message: '' });

      const out = await _runMetaTrackingGateForTest(
        creds, CAMPAIGN, 'AD_CREATE', false, 'sess-c',
        {}, undefined, ['https://site.example/new-lp'], [],
      );

      expect(out.proceed).toBe(true);
      // The supplied destination is what gets checked — the unread siblings are irrelevant to it.
      expect(mockPreflight.mock.calls[0][0]).toContain('https://site.example/new-lp');
    });

    it('still blocks when the truncated ad list IS what the decision rests on', async () => {
      mockListAds.mockResolvedValue({ items: [], truncated: true, pagesFetched: 25 });

      const out = await _runMetaTrackingGateForTest(
        creds, CAMPAIGN, 'UPDATE', false, 'sess-c', {}, undefined, [], [],
      );

      expect(out.proceed).toBe(false);
      expect(out.blockResult.error).toMatch(/could not be read completely/i);
    });

    it('offers a remedy a CREATE can actually follow', async () => {
      mockListAds.mockResolvedValue({ items: [], truncated: true, pagesFetched: 25 });

      const out = await _runMetaTrackingGateForTest(
        creds, CAMPAIGN, 'UPDATE', false, 'sess-c', {}, undefined, [], [],
      );

      /*
       * This branch fires only for CAMPAIGN_UPDATE / AD_SET_UPDATE / AD_CREATE, and
       * `collectPendingDestinations` returns [] unconditionally for the two UPDATEs (campaigns
       * carry no destination; an ad set carries one only on CREATE). So "supply the destination
       * on the request" — which this test used to REQUIRE — is a remedy the caller can follow
       * exactly and get the identical block back. Same defect class the sibling branch is already
       * guarded against at the ad-set assertion above.
       */
      /*
       * The destination remedy may be MENTIONED, but only qualified. It works for an AD CREATE
       * and not for the campaign/ad-set UPDATEs that also reach this branch, where
       * `collectPendingDestinations` returns [] unconditionally. The defect was stating it
       * flatly, as if the caller could add link_url and retry.
       */
      expect(out.blockResult.error).toMatch(/for an AD CREATE/i);
      expect(out.blockResult.error).not.toMatch(/narrow the launch to a single ad/i);
      /*
       * And the extended launch budget must be named, so "just wait longer" is visibly already
       * tried. This branch is now the genuinely-enormous case, not the 45-second case: reading
       * the campaign gets four minutes because refusing a launch is far more expensive to the
       * user than a slow one.
       */
      expect(out.blockResult.error).toMatch(/extended launch read budget/i);
      expect(out.blockResult.error).toMatch(/tracking-check override/i);
    });
  });

  /*
   * The `!destinationCameFromRequest` escape above does not reach the launches that create an
   * EMPTY container, because they carry no destination to supply: `executeAudienceCampaignLaunch`
   * calls this gate with no `pendingDestinations` argument at all, and a plain AD_SET CREATE with
   * no link_url has none either.
   *
   * Those launches put ZERO pre-existing ads live — the new ad set contains no ads and can send
   * traffic nowhere — so the campaign's unread ads cannot be "some ads in this launch that were
   * never checked". And "Narrow the launch to a single ad" is not a remedy anyone can follow for
   * an entity that does not exist.
   */
  describe('a truncated ad list and a launch that activates no existing ad', () => {
    it('does not block the audience-launch path, which creates an ad set and no ads', async () => {
      mockListAds.mockResolvedValue({ items: [], truncated: true, pagesFetched: 25 });

      const out = await _runMetaTrackingGateForTest(
        creds, CAMPAIGN, 'TARGETED_AUDIENCE_LAUNCH', false, 'sess-c',
      );

      expect(out.proceed).toBe(true);
    });

    it('does not block the retargeting-launch path either', async () => {
      mockListAds.mockResolvedValue({ items: [], truncated: true, pagesFetched: 25 });

      const out = await _runMetaTrackingGateForTest(
        creds, CAMPAIGN, 'RETARGETING_LAUNCH', false, 'sess-c',
      );

      expect(out.proceed).toBe(true);
    });

    it('does not block a plain AD_SET CREATE that carries no link_url', async () => {
      mockListAds.mockResolvedValue({ items: [], truncated: true, pagesFetched: 25 });

      const out = await _runMetaTrackingGateForTest(
        creds, CAMPAIGN, 'AD_SET_CREATE', false, 'sess-c', {}, undefined, [], [],
      );

      expect(out.proceed).toBe(true);
    });

    it('still blocks an AD_CREATE with no destination — that one really does start serving', async () => {
      // The boundary: an AD CREATE makes something that serves, and with no destination on the
      // request the campaign's (unread) ad list is what the check would have to fall back on.
      mockListAds.mockResolvedValue({ items: [], truncated: true, pagesFetched: 25 });

      const out = await _runMetaTrackingGateForTest(
        creds, CAMPAIGN, 'AD_CREATE', false, 'sess-c', {}, undefined, [], [],
      );

      expect(out.proceed).toBe(false);
      expect(out.blockResult.error).toMatch(/could not be read completely/i);
    });

    it('still checks the campaign destinations it CAN read for an empty-container launch', async () => {
      // Lifting the truncation block is not lifting the gate: a readable, untracked destination
      // still blocks these launches exactly as before.
      mockListAds.mockResolvedValue({
        items: [{ adId: 'a1', campaignId: CAMPAIGN, destinationUrls: ['https://dark.example/lp'] }],
        truncated: true,
        pagesFetched: 25,
      });
      // ...Once, not a new default: the describes below this one have no beforeEach of their
      // own and inherit whatever mock state the previous test left behind.
      mockPreflight.mockResolvedValueOnce({
        ok: false, results: [{ url: 'https://dark.example/lp', status: 'missing', mechanisms: [] }],
        blockedUrls: ['https://dark.example/lp'], message: 'no tracking found',
      });

      const out = await _runMetaTrackingGateForTest(
        creds, CAMPAIGN, 'TARGETED_AUDIENCE_LAUNCH', false, 'sess-c',
      );

      expect(out.proceed).toBe(false);
      expect(out.blockResult.error).toMatch(/no tracking found/i);
    });
  });

  it('resolves a referenced creative to its destination and checks it', async () => {
    mockListAds.mockResolvedValue({ items: [], truncated: false, pagesFetched: 1 });
    const resolveCreativeDestinations = jest.fn().mockResolvedValue(['https://site.example/referenced']);
    await _runMetaTrackingGateForTest(
      creds, CAMPAIGN, 'AD_CREATE', false, 'sess-1',
      { resolveCreativeDestinations }, undefined, [], ['120299'],
    );
    expect(resolveCreativeDestinations).toHaveBeenCalledWith('120299', 'tok');
    expect(mockPreflight.mock.calls[0][0]).toContain('https://site.example/referenced');
  });

  it('blocks when a referenced creative cannot be resolved — an unreadable destination is not a measured one', async () => {
    mockListAds.mockResolvedValue({ items: [], truncated: false, pagesFetched: 1 });
    const resolveCreativeDestinations = jest.fn().mockRejectedValue(new Error('Graph 400'));
    const out = await _runMetaTrackingGateForTest(
      creds, CAMPAIGN, 'AD_CREATE', false, 'sess-1',
      { resolveCreativeDestinations }, undefined, [], ['120299'],
    );
    expect(out.proceed).toBe(false);
    /*
     * Same rule as the ad-level blocks in this function: the id comes out of the text the user
     * reads and goes onto the ledger row instead. This assertion used to REQUIRE the id in the
     * message — the last place in this module still doing it.
     */
    expect(out.blockResult.error).toContain('could not verify where the requested ad creative sends people');
    expect(out.blockResult.error).not.toContain('120299');
    expect(mockPreflight).not.toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      outcome: 'blocked',
      creativeId: '120299',
    }));
  });

  it('blocks when a referenced creative resolves to no destination at all — the shape was not understood', async () => {
    mockListAds.mockResolvedValue({ items: [], truncated: false, pagesFetched: 1 });
    const out = await _runMetaTrackingGateForTest(
      creds, CAMPAIGN, 'AD_CREATE', false, 'sess-1',
      { resolveCreativeDestinations: jest.fn().mockResolvedValue([]) }, undefined, [], ['120299'],
    );
    expect(out.proceed).toBe(false);
    // Id on the ledger, not in the user-facing text — see the sibling test above.
    expect(out.blockResult.error).not.toContain('120299');
    expect(out.blockResult.error).toContain('reported no destination URL');
    expect(mockRecord).toHaveBeenCalledWith('sess-1', expect.objectContaining({ creativeId: '120299' }));
  });

  it('still honours an explicit override when a creative cannot be resolved', async () => {
    mockListAds.mockResolvedValue({ items: [], truncated: false, pagesFetched: 1 });
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
    mockListAds.mockResolvedValue({ items: [
      { adId: 'ad-42', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/old'] },
    ], truncated: false, pagesFetched: 1 });
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

  /*
   * This test used to assert the opposite — that CREATE/UPDATE never read these aliases —
   * which was my own wrong premise from a too-narrow grep, not a fact about the code. See
   * 'destination aliases on AD writes' below: CREATIVE_CONTENT_KEYS includes both.
   */
  it('collects the same aliases on the other AD write paths', () => {
    expect(collectPendingDestinations('AD', 'CREATE', { destination: 'https://a/2' })).toEqual(['https://a/2']);
    expect(collectPendingDestinations('AD', 'UPDATE', { url: 'https://a/3' })).toEqual(['https://a/3']);
  });
});

/*
 * Greptile P1, round 9 ("Creative-swap aliases evade preflight"). I rejected this in round 6
 * after grepping metaService.ts and finding the aliases unused. That was the wrong file:
 * AgentModeService.CREATIVE_CONTENT_KEYS is ['link_url', 'destination', 'url', ...], so
 * either alias BOTH triggers the creative swap (agentModeService.ts:17255) and becomes the
 * new link (17324). They are destination inputs on every AD write, not dead params.
 */
describe('destination aliases on AD writes (ENG-941)', () => {
  const { collectPendingDestinations } = require('../services/metaLaunchGate');

  it('collects params.destination and params.url on an AD UPDATE', () => {
    expect(collectPendingDestinations('AD', 'UPDATE', { destination: 'https://a/1' })).toEqual(['https://a/1']);
    expect(collectPendingDestinations('AD', 'UPDATE', { url: 'https://a/2' })).toEqual(['https://a/2']);
  });

  it('collects them on an AD CREATE too, so the collector cannot drift from the key list', () => {
    expect(collectPendingDestinations('AD', 'CREATE', { destination: 'https://a/1' })).toEqual(['https://a/1']);
  });

  it('does not collect them for entities that carry no creative', () => {
    expect(collectPendingDestinations('AD_SET', 'CREATE', { destination: 'https://a/1' })).toEqual([]);
    expect(collectPendingDestinations('CAMPAIGN', 'CREATE', { url: 'https://a/1' })).toEqual([]);
  });
});

/*
 * Greptile P1, round 11 ("Copied ads use wrong campaign scope"). When the gate is scoped to
 * ONE named ad, that ad is looked up in the campaign-filtered list — so a stale or wrong
 * campaign id (a COPY_AD into an ad set in another campaign, most obviously) leaves the
 * scoped list empty. That was read as "nothing serving yet" and passed, when the truth is
 * the destination was never found: an inability to verify, not an absence of risk.
 */
describe('named-ad scoping must not silently pass (ENG-941)', () => {
  it('blocks when the named ad is not in the campaign being checked', async () => {
    mockListAds.mockResolvedValue({ items: [
      { adId: 'someone-else', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/other'] },
    ], truncated: false, pagesFetched: 1 });
    const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'AD_COPY_AD', false, 'sess-1', {}, 'ad-42');
    expect(out.proceed).toBe(false);
    /*
     * The block must say WHICH failure this is, without printing a raw Meta id.
     *
     * These assertions used to pin `ad-42` in the model/user-visible text. Product rule: ids are
     * not shown to the user, and this string is relayed to them. The ad is the one the caller
     * just named in this request, so the sentence is unambiguous without it — and the id is
     * still recorded on the ledger entry for debugging.
     */
    expect(out.blockResult.error).toContain('the requested ad was not found in this campaign');
    expect(out.blockResult.error).not.toContain('ad-42');
    expect(mockPreflight).not.toHaveBeenCalled();
    /*
     * The id has to survive SOMEWHERE, and the ledger is the only place left.
     *
     * Taking it out of the block text is right — that text reaches the user. But it was the only
     * record of which ad was refused: `blockResult` carries no ids, the gate logs none, and the
     * ledger row was `{accountId, campaignId, action, outcome}`, identical for every ad in the
     * campaign AND for the campaign-wide truncation block. "Emma refused to activate my ad" had
     * no answer. Removing the id from prose and adding it here are one change, not two.
     */
    expect(mockRecord).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      outcome: 'blocked',
      adId: 'ad-42',
    }));
  });

  it('proceeds when the copy carries its own destination, which is what will serve', async () => {
    mockListAds.mockResolvedValue({ items: [], truncated: false, pagesFetched: 1 });
    await _runMetaTrackingGateForTest(
      creds, CAMPAIGN, 'AD_COPY_AD', false, 'sess-1', {}, 'ad-42', ['https://site.example/new'],
    );
    expect(mockPreflight.mock.calls[0][0]).toEqual(['https://site.example/new']);
  });

  it('still lets a campaign with nothing serving through when no single ad was named', async () => {
    mockListAds.mockResolvedValue({ items: [], truncated: false, pagesFetched: 1 });
    const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'CAMPAIGN_UPDATE', false, 'sess-1');
    expect(out.proceed).toBe(true);
  });

  it('honours an explicit override when the named ad cannot be found', async () => {
    mockListAds.mockResolvedValue({ items: [], truncated: false, pagesFetched: 1 });
    const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'AD_COPY_AD', true, 'sess-1', {}, 'ad-42');
    expect(out.proceed).toBe(true);
    expect(mockRecord).toHaveBeenCalledWith('sess-1', expect.objectContaining({ outcome: 'overridden' }));
  });
});

/*
 * Greptile P1, round 12 — the previous round's fix over-corrected. A COPY_AD's SOURCE ad
 * legitimately lives in another campaign (that is what copying between campaigns means), and
 * its destination is readable account-wide. Blocking there refuses a valid launch over a page
 * we could have checked. The rule that has to hold is narrower: block only when the ad cannot
 * be found AT ALL.
 */
describe('named-ad lookup falls back to the account before blocking (ENG-941)', () => {
  it('verifies a copy whose source ad lives in a different campaign', async () => {
    mockListAds
      .mockResolvedValueOnce({ items: [], truncated: false, pagesFetched: 1 }) // campaign-scoped: source ad is not in this campaign
      .mockResolvedValueOnce({ items: [   // account-wide: it is right here
        { adId: 'ad-42', campaignId: 'other-campaign', destinationUrls: ['https://site.example/source'] },
      ], truncated: false, pagesFetched: 1 });
    const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'AD_COPY_AD', false, 'sess-1', {}, 'ad-42');
    expect(out.proceed).toBe(true);
    expect(mockPreflight.mock.calls[0][0]).toEqual(['https://site.example/source']);
  });

  it('still blocks when the ad cannot be found anywhere on the account', async () => {
    mockListAds.mockResolvedValue({ items: [], truncated: false, pagesFetched: 1 });
    const out = await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'AD_COPY_AD', false, 'sess-1', {}, 'ad-42');
    expect(out.proceed).toBe(false);
    expect(out.blockResult.error).toContain('the requested ad was not found in this campaign');
    expect(out.blockResult.error).not.toContain('ad-42');
  });

  it('does not pay for the account-wide lookup when the campaign scope already found the ad', async () => {
    mockListAds.mockResolvedValue({ items: [
      { adId: 'ad-42', campaignId: CAMPAIGN, destinationUrls: ['https://site.example/lp'] },
    ], truncated: false, pagesFetched: 1 });
    await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'AD_COPY_AD', false, 'sess-1', {}, 'ad-42');
    expect(mockListAds).toHaveBeenCalledTimes(1);
  });
});

/**
 * ENG-1909: `runMetaTrackingGate` used to call `preflightMetaTrackingGate` with a hardcoded
 * `{}` third argument, so a caller had no way to override the destination fetch — the field
 * did not exist on `MetaGateDeps` at all. A sandbox account needs exactly that override (see
 * services/sandboxTrackingPreflight.ts), so the field was added and threaded through. This
 * proves the threading itself: not passing `fetchHtml` is byte-for-byte the old hardcoded
 * `{}` (real accounts unaffected), and passing one reaches the preflight call unchanged.
 */
describe('fetchHtml threading (ENG-1909)', () => {
  it('omitting deps.fetchHtml passes {} through — the exact call a real account always made', async () => {
    await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'CAMPAIGN_UPDATE', false, 'sess-1');
    expect(mockPreflight).toHaveBeenCalledTimes(1);
    expect(mockPreflight.mock.calls[0][2]).toEqual({ fetchHtml: undefined });
  });

  it('a caller-supplied fetchHtml reaches preflightMetaTrackingGate unchanged', async () => {
    const fetchHtml = jest.fn(async () => '<html></html>');
    await _runMetaTrackingGateForTest(creds, CAMPAIGN, 'CAMPAIGN_UPDATE', false, 'sess-1', { fetchHtml });
    expect(mockPreflight).toHaveBeenCalledTimes(1);
    expect(mockPreflight.mock.calls[0][2]).toEqual({ fetchHtml });
  });
});
