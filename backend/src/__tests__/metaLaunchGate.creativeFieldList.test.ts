/**
 * ENG-1742 — regression pin for the launch gate's REAL creative-destination Graph read.
 *
 * Every existing metaLaunchGate.test.ts creative-resolution test injects a hand-built
 * `resolveCreativeDestinations` mock via `MetaGateDeps` — which is exactly why this bug
 * shipped and stayed live: the default implementation's actual field list, the thing that
 * was wrong, was never exercised by any test. This file deliberately does NOT inject that
 * override, so the gate falls through to `defaultResolveCreativeDestinations` and its real
 * `axios.get` call — mocking only axios itself, the actual network boundary.
 *
 * Confirmed live on 2026-09-04 (env1) against a real production creative/ad account: before
 * the fix, Meta returned `(#100) Tried accessing nonexisting field (effective_object_story_spec)`
 * and the gate blocked every AD_CREATE referencing an existing creative_id as "could not verify
 * where the requested ad creative sends people". After the fix, the same creative's destination
 * resolves correctly and the gate proceeds to the real tracking check.
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

const mockAxiosGet = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: (...a: any[]) => mockAxiosGet(...a) },
}));

import { _runMetaTrackingGateForTest } from '../services/metaLaunchGate';

const ACCOUNT = '409853340719899';
const CAMPAIGN = '120200000000000';
const PIXEL = '1012387921717047';
const CREATIVE_ID = '1534525205026417';
const creds = { accountId: ACCOUNT, accessToken: 'tok' };

describe('Meta launch gate — real creative-destination Graph read (ENG-1742)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListPixels.mockResolvedValue({ pixels: [{ id: PIXEL, name: 'Test Pixel' }], truncated: false, pagesFetched: 1 });
    mockListAds.mockResolvedValue({ items: [], truncated: false, pagesFetched: 1 });
    mockPreflight.mockResolvedValue({ ok: true, results: [], blockedUrls: [], message: '' });
  });

  it('never requests effective_object_story_spec or template_url — both are invalid on an AdCreative node', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { link_url: 'https://site.example/lp', object_story_spec: {}, asset_feed_spec: {}, url_tags: '' },
    });

    await _runMetaTrackingGateForTest(
      creds, CAMPAIGN, 'AD_CREATE', false, 'sess-1',
      {}, undefined, [], [CREATIVE_ID],
    );

    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    const requestedUrl = mockAxiosGet.mock.calls[0][0] as string;
    expect(requestedUrl).not.toContain('effective_object_story_spec');
    expect(requestedUrl).not.toContain('template_url');
    expect(requestedUrl).toContain('link_url');
    expect(requestedUrl).toContain('object_story_spec');
  });

  it('resolves a real page-post creative response and proceeds to the tracking check, instead of blocking as unverifiable', async () => {
    // Shape Meta actually returns for a plain page-post/SHARE creative with the fixed field list.
    mockAxiosGet.mockResolvedValue({
      data: {
        link_url: 'https://site.example/lp',
        object_story_spec: { link_data: { link: 'https://site.example/lp' } },
      },
    });

    const out = await _runMetaTrackingGateForTest(
      creds, CAMPAIGN, 'AD_CREATE', false, 'sess-1',
      {}, undefined, [], [CREATIVE_ID],
    );

    // The old bug never reached this point at all — the axios call itself threw. Getting to a
    // clean preflight call with the resolved destination IS the regression this pins.
    expect(mockPreflight).toHaveBeenCalledTimes(1);
    expect(mockPreflight.mock.calls[0][0]).toContain('https://site.example/lp');
    expect(out.proceed).toBe(true);
  });

  it('follows object_story_id back to the referenced page post when the creative carries no inline destination', async () => {
    // Creative built purely by referencing an existing page post — no link_url, no
    // object_story_spec.link_data.link, nothing inline. Only object_story_id points anywhere.
    //
    // `link` was requested here in an earlier version of this fix and always failed live —
    // Meta rejects it outright with "(#12) deprecate_post_aggregated_fields_for_attachement"
    // on every post read, confirmed 2026-09-04 against a real page post. The real destination
    // comes back on the `attachments` edge instead, wrapped in an l.facebook.com redirect —
    // this mock mirrors that actual shape, not the field this fix no longer requests.
    mockAxiosGet.mockImplementation((url: string) => {
      if (url.includes(CREATIVE_ID)) {
        return Promise.resolve({ data: { object_story_id: '123456_987654' } });
      }
      if (url.includes('123456_987654')) {
        expect(url).not.toContain('fields=link&');
        // Pins the URL-encoding too: unencoded {url} is silently mangled by Graph into a flat
        // "attachmentsurl" field and rejected — confirmed live 2026-09-04. A regression back to
        // raw braces must fail this test, not just "toContain('attachments')".
        expect(url).toContain('fields=attachments%7Burl%7D');
        expect(url).not.toContain('attachments{url}');
        return Promise.resolve({
          data: {
            attachments: {
              data: [{ url: 'https://l.facebook.com/l.php?u=https%3A%2F%2Fsite.example%2Freferenced-post' }],
            },
          },
        });
      }
      throw new Error(`unexpected axios.get call: ${url}`);
    });

    const out = await _runMetaTrackingGateForTest(
      creds, CAMPAIGN, 'AD_CREATE', false, 'sess-1',
      {}, undefined, [], [CREATIVE_ID],
    );

    expect(mockAxiosGet).toHaveBeenCalledTimes(2);
    const postCallUrl = mockAxiosGet.mock.calls[1][0] as string;
    expect(postCallUrl).toContain('123456_987654');
    expect(mockPreflight).toHaveBeenCalledTimes(1);
    expect(mockPreflight.mock.calls[0][0]).toContain('https://l.facebook.com/l.php?u=https%3A%2F%2Fsite.example%2Freferenced-post');
    expect(out.proceed).toBe(true);
  });

  it('still blocks (as unverifiable, not silently) when Meta genuinely refuses the request', async () => {
    // Confirms the fix didn't just swallow the failure mode — a real Graph error on this
    // specific call still surfaces as a block, same as before.
    const graphError: any = new Error('Request failed with status code 400');
    graphError.response = {
      status: 400,
      data: { error: { message: 'Some other real failure', type: 'OAuthException', code: 100 } },
    };
    mockAxiosGet.mockRejectedValue(graphError);

    const out = await _runMetaTrackingGateForTest(
      creds, CAMPAIGN, 'AD_CREATE', false, 'sess-1',
      {}, undefined, [], [CREATIVE_ID],
    );

    expect(out.proceed).toBe(false);
    expect(out.blockResult.error).toMatch(/could not verify where the requested ad creative sends people/i);
    expect(out.blockResult.error).toContain('Some other real failure');
  });
});
