/**
 * ENG-1972 — rendering through Placid's REST API.
 *
 * The URL API answers 403 for this project on every render, so no ad image could
 * be created and production recorded zero Placid renders. These tests pin the
 * replacement's contract: authenticate with the private token, honour a queued
 * render instead of treating it as a failure, and never hang a user's request on
 * a stuck queue.
 */

const mockPost = jest.fn();
const mockGet = jest.fn();
const mockRecordVendorUsage = jest.fn();
jest.mock('../services/usageRecorderService', () => ({
  recordVendorUsage: (...a: any[]) => mockRecordVendorUsage(...a),
}));
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (...a: any[]) => mockPost(...a),
    get: (...a: any[]) => mockGet(...a),
  },
}));

import {
  renderPlacidImage,
  PlacidRenderError,
  PLACID_POLL_ATTEMPTS,
} from '../services/placidRenderService';

const noSleep = () => Promise.resolve();
const BILLING = { userId: 'caller-1', billingUserId: 'owner-1' };

describe('renderPlacidImage (ENG-1972)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates the image with the private token and returns the finished URL', async () => {
    mockPost.mockResolvedValue({
      data: { id: 1, status: 'finished', image_url: 'https://cdn.placid.test/a.png' },
    });

    const result = await renderPlacidImage({
      token: 'tok-123',
      templateUuid: 'tpl-1',
      layers: { img: { image: 'https://src.test/in.png' }, text: { text: 'hi' } },
      billing: BILLING,
      base: 'https://api.placid.test/api/rest',
      sleep: noSleep,
    });

    expect(result).toEqual({ imageUrl: 'https://cdn.placid.test/a.png' });
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, body, config] = mockPost.mock.calls[0];
    expect(url).toBe('https://api.placid.test/api/rest/images');
    // Layers pass through with their own types — no query-string stringification.
    expect(body).toEqual({
      template_uuid: 'tpl-1',
      layers: { img: { image: 'https://src.test/in.png' }, text: { text: 'hi' } },
      create_now: true,
    });
    // This is the whole point of the change: the REST API takes the token that
    // already works for this project, rather than an unsigned public URL.
    expect(config.headers.Authorization).toBe('Bearer tok-123');
    expect(mockGet).not.toHaveBeenCalled();

    // ENG-698: metered here, beside the spend, so the two cannot drift.
    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordVendorUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'caller-1',
        billingUserId: 'owner-1',
        provider: 'placid',
        operation: 'image_render',
        unit: 'render',
        quantity: 1,
        rateKey: 'image_render',
      }),
    );
  });

  it('meters a queued render once, when it finishes', async () => {
    mockPost.mockResolvedValue({ data: { id: 6, status: 'queued', polling_url: 'https://p.test/6' } });
    mockGet
      .mockResolvedValueOnce({ data: { status: 'queued' } })
      .mockResolvedValueOnce({ data: { status: 'finished', image_url: 'https://cdn.placid.test/d.png' } });

    await renderPlacidImage({
      token: 'tok', templateUuid: 'tpl', layers: {}, billing: BILLING, sleep: noSleep,
    });

    // Polling is not billing: one image, one charge.
    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
  });

  it('carries onBehalfOf and sessionId through to the ledger', async () => {
    mockPost.mockResolvedValue({ data: { status: 'finished', image_url: 'https://cdn.placid.test/e.png' } });

    await renderPlacidImage({
      token: 'tok',
      templateUuid: 'tpl',
      layers: {},
      billing: { userId: 'admin-1', billingUserId: 'customer-1', onBehalfOf: 'admin-1', sessionId: 'sess-1' },
      sleep: noSleep,
    });

    const ctx = mockRecordVendorUsage.mock.calls[0][0];
    expect(ctx.billingUserId).toBe('customer-1');
    expect(ctx.onBehalfOf).toBe('admin-1');
    expect(ctx.sessionId).toBe('sess-1');
  });

  it('never books a render that produced no image', async () => {
    mockPost.mockResolvedValue({ data: { id: 7, status: 'error' } });
    await expect(
      renderPlacidImage({ token: 'tok', templateUuid: 'tpl', layers: {}, billing: BILLING, sleep: noSleep }),
    ).rejects.toBeInstanceOf(PlacidRenderError);

    mockPost.mockRejectedValue(new Error('Request failed with status code 403'));
    await expect(
      renderPlacidImage({ token: 'tok', templateUuid: 'tpl', layers: {}, billing: BILLING, sleep: noSleep }),
    ).rejects.toThrow(/403/);

    expect(mockRecordVendorUsage).not.toHaveBeenCalled();
  });

  it('still returns the image when metering throws (ENG-698 AC6)', async () => {
    mockPost.mockResolvedValue({ data: { status: 'finished', image_url: 'https://cdn.placid.test/f.png' } });
    mockRecordVendorUsage.mockImplementation(() => {
      throw new Error('recorder exploded');
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await renderPlacidImage({
      token: 'tok', templateUuid: 'tpl', layers: {}, billing: BILLING, sleep: noSleep,
    });

    expect(result.imageUrl).toBe('https://cdn.placid.test/f.png');
  });

  it('polls a queued render until it finishes', async () => {
    mockPost.mockResolvedValue({
      data: { id: 2, status: 'queued', polling_url: 'https://api.placid.test/api/rest/images/2' },
    });
    mockGet
      .mockResolvedValueOnce({ data: { status: 'queued' } })
      .mockResolvedValueOnce({
        data: { status: 'finished', image_url: 'https://cdn.placid.test/b.png' },
      });

    const result = await renderPlacidImage({
      token: 'tok', templateUuid: 'tpl', layers: {}, billing: BILLING, base: 'https://api.placid.test/api/rest', sleep: noSleep,
    });

    expect(result.imageUrl).toBe('https://cdn.placid.test/b.png');
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet.mock.calls[0][0]).toBe('https://api.placid.test/api/rest/images/2');
    expect(mockGet.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('falls back to the id-derived polling URL when none is returned', async () => {
    mockPost.mockResolvedValue({ data: { id: 9, status: 'queued' } });
    mockGet.mockResolvedValue({ data: { status: 'finished', image_url: 'https://cdn.placid.test/c.png' } });

    await renderPlacidImage({
      token: 'tok', templateUuid: 'tpl', layers: {}, billing: BILLING, base: 'https://api.placid.test/api/rest', sleep: noSleep,
    });

    expect(mockGet.mock.calls[0][0]).toBe('https://api.placid.test/api/rest/images/9');
  });

  it('throws when Placid reports an error on create', async () => {
    mockPost.mockResolvedValue({ data: { id: 3, status: 'error' } });

    await expect(
      renderPlacidImage({ token: 'tok', templateUuid: 'tpl', layers: {}, billing: BILLING, sleep: noSleep }),
    ).rejects.toBeInstanceOf(PlacidRenderError);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('throws when Placid reports an error while polling', async () => {
    mockPost.mockResolvedValue({ data: { id: 4, status: 'queued', polling_url: 'https://p.test/4' } });
    mockGet.mockResolvedValue({ data: { status: 'error' } });

    await expect(
      renderPlacidImage({ token: 'tok', templateUuid: 'tpl', layers: {}, billing: BILLING, sleep: noSleep }),
    ).rejects.toThrow(/error rendering/i);
  });

  it('gives up at the polling ceiling rather than hanging the request', async () => {
    mockPost.mockResolvedValue({ data: { id: 5, status: 'queued', polling_url: 'https://p.test/5' } });
    mockGet.mockResolvedValue({ data: { status: 'queued' } });

    await expect(
      renderPlacidImage({ token: 'tok', templateUuid: 'tpl', layers: {}, billing: BILLING, sleep: noSleep }),
    ).rejects.toThrow(/still queued/i);
    expect(mockGet).toHaveBeenCalledTimes(PLACID_POLL_ATTEMPTS);
  });

  it('throws when there is neither an image nor a way to poll for one', async () => {
    mockPost.mockResolvedValue({ data: { status: 'queued' } });

    await expect(
      renderPlacidImage({ token: 'tok', templateUuid: 'tpl', layers: {}, billing: BILLING, sleep: noSleep }),
    ).rejects.toThrow(/no polling URL/i);
  });

  // An HTTP failure is not swallowed into a PlacidRenderError: the caller needs
  // to tell a refused request (the 403 this ticket is about) from a slow one.
  it('propagates an HTTP failure as-is', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('Request failed with status code 403'), {
      response: { status: 403 },
    }));

    await expect(
      renderPlacidImage({ token: 'tok', templateUuid: 'tpl', layers: {}, billing: BILLING, sleep: noSleep }),
    ).rejects.toThrow(/403/);
  });
});
