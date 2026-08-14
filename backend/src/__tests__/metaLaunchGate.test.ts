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
