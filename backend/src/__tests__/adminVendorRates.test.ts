import request from 'supertest';
import express, { NextFunction, Request, Response } from 'express';

const mockGet = jest.fn();
const mockIfMatches = jest.fn();
const mockIfAbsent = jest.fn();
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: (...a: unknown[]) => mockGet(...a),
    setSettingIfValueMatches: (...a: unknown[]) => mockIfMatches(...a),
    setSettingIfAbsent: (...a: unknown[]) => mockIfAbsent(...a),
  },
}));

// Real isAdmin runs; auth stub sets req.user from test headers (none = unauthenticated).
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: Request, res: Response, next: NextFunction) => {
    if (!req.headers['x-test-user']) return res.status(401).json({ message: 'Unauthorized' });
    (req as unknown as { user: unknown }).user = {
      userId: String(req.headers['x-test-user']),
      isAdmin: req.headers['x-test-admin'] === '1',
    };
    next();
  },
}));

import router from '../routes/adminVendorRates';
import {
  VENDOR_RATE_CARD_VERSION,
  getAllocatedRate,
  setVendorRateOverridesForTests,
} from '../utils/vendorRateCard';

const app = express();
app.use(express.json());
app.use('/api/admin', router);
const URL = '/api/admin/vendor-rates';
const as = (r: request.Test) => r.set('x-test-user', 'admin-7').set('x-test-admin', '1');
const row = (overrides: unknown, updatedAt = '2026-11-01T00:00:00.000Z') => ({
  settingName: 'vendor_rate_overrides',
  settingValue: JSON.stringify({ overrides, updatedAt, updatedBy: 'admin-1' }),
});

beforeEach(() => {
  jest.clearAllMocks();
  setVendorRateOverridesForTests(null);
  mockGet.mockResolvedValue(null);
  mockIfAbsent.mockResolvedValue(true);
  mockIfMatches.mockResolvedValue(undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('auth', () => {
  it.each(['get', 'put'] as const)('%s: unauthenticated gets 401, non-admin 403, and nothing is touched', async (m) => {
    expect((await request(app)[m](URL).send({})).status).toBe(401);
    expect((await request(app)[m](URL).set('x-test-user', 'u1').send({})).status).toBe(403);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockIfAbsent).not.toHaveBeenCalled();
    expect(mockIfMatches).not.toHaveBeenCalled();
  });
});

describe('GET /vendor-rates', () => {
  it('returns defaults and the plain version when nothing is stored', async () => {
    const res = await as(request(app).get(URL));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      version: VENDOR_RATE_CARD_VERSION,
      editableProviders: ['twilio'],
      rates: [
        { provider: 'twilio', key: 'voice_minute_outbound', unit: 'minute', defaultUsdPerUnit: 0.014, overrideUsdPerUnit: null, effectiveUsdPerUnit: 0.014 },
        { provider: 'twilio', key: 'number_monthly_rent', unit: 'number_month', defaultUsdPerUnit: 1.15, overrideUsdPerUnit: null, effectiveUsdPerUnit: 1.15 },
      ],
      updatedAt: null,
      updatedBy: null,
    });
  });

  it('shows the stored override, its audit fields and the suffixed version', async () => {
    mockGet.mockResolvedValue(row({ twilio: { voice_minute_outbound: 0.02 } }));
    const res = await as(request(app).get(URL));
    expect(res.body.version).toBe(`${VENDOR_RATE_CARD_VERSION}+ovr:2026-11-01T00:00:00.000Z`);
    expect(res.body.updatedBy).toBe('admin-1');
    expect(res.body.rates[0]).toMatchObject({ overrideUsdPerUnit: 0.02, effectiveUsdPerUnit: 0.02, defaultUsdPerUnit: 0.014 });
  });

  it('GET after the last override was removed still shows who and when', async () => {
    mockGet.mockResolvedValue(row({}, '2026-11-03T00:00:00.000Z'));
    const res = await as(request(app).get(URL));
    expect(res.body).toMatchObject({ version: VENDOR_RATE_CARD_VERSION, updatedAt: '2026-11-03T00:00:00.000Z', updatedBy: 'admin-1' });
    expect(res.body.rates[0].overrideUsdPerUnit).toBeNull();
  });

  it('500s with { error } when the read fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockGet.mockRejectedValue(new Error('boom'));
    const res = await as(request(app).get(URL));
    expect(res.status).toBe(500);
    expect(typeof res.body.error).toBe('string');
  });
});

describe('PUT /vendor-rates validation', () => {
  const ok = { provider: 'twilio', key: 'voice_minute_outbound', usdPerUnit: 0.02 };
  it.each([
    ['unknown provider', { provider: 'nope' }],
    ['non-editable provider', { provider: 'v0', key: 'landing_page_generation' }],
    ['unknown key', { key: 'made_up' }],
    ['prototype key', { key: 'toString' }],
    ['zero', { usdPerUnit: 0 }],
    ['7 decimal places', { usdPerUnit: 0.0000001 }],
    ['exponent below 1e-6', { usdPerUnit: 1e-7 }],
    ['denormal', { usdPerUnit: 5e-324 }],
    ['sub-micro tail', { usdPerUnit: 0.0140004 }],
    ['just above the cap', { usdPerUnit: 10.000001 }],
    ['negative', { usdPerUnit: -0.01 }],
    ['above 10', { usdPerUnit: 10.5 }],
    ['a typo of 0.014', { usdPerUnit: 14 }],
    ['string rate', { usdPerUnit: '0.02' }],
    ['missing rate', { usdPerUnit: undefined }],
    ['non-string provider', { provider: 5 }],
    ['extra key', { extra: true }],
  ])('rejects %s with 400 { error } and writes nothing', async (_n, patch) => {
    const res = await as(request(app).put(URL)).send({ ...ok, ...patch });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
    expect(mockIfAbsent).not.toHaveBeenCalled();
    expect(mockIfMatches).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range exponent (1e999)', async () => {
    const res = await as(request(app).put(URL).set('Content-Type', 'application/json'))
      .send('{"provider":"twilio","key":"voice_minute_outbound","usdPerUnit":1e999}');
    expect(res.status).toBe(400);
    expect(mockIfAbsent).not.toHaveBeenCalled();
  });

  it('rejects an array body', async () => {
    expect((await as(request(app).put(URL)).send([ok])).status).toBe(400);
  });

  it.each([10, 0.000001, 0.014])('accepts %s', async (v) => {
    expect((await as(request(app).put(URL)).send({ ...ok, usdPerUnit: v })).status).toBe(200);
  });
});

describe('PUT /vendor-rates writes', () => {
  const set = { provider: 'twilio', key: 'voice_minute_outbound', usdPerUnit: 0.02 };

  it('creates the item when absent, with audit fields, and applies it to this instance at once', async () => {
    const res = await as(request(app).put(URL)).send(set);
    expect(res.status).toBe(200);
    const [name, value, , by] = mockIfAbsent.mock.calls[0];
    expect(name).toBe('vendor_rate_overrides');
    expect(by).toBe('admin-7');
    const stored = JSON.parse(value);
    expect(stored).toMatchObject({ overrides: { twilio: { voice_minute_outbound: 0.02 } }, updatedBy: 'admin-7' });
    expect(Number.isNaN(Date.parse(stored.updatedAt))).toBe(false);
    expect(res.body.version).toBe(`${VENDOR_RATE_CARD_VERSION}+ovr:${stored.updatedAt}`);
    expect(res.body.updatedBy).toBe('admin-7');
    expect(res.body.rates[0]).toMatchObject({ overrideUsdPerUnit: 0.02, effectiveUsdPerUnit: 0.02 });
    expect(getAllocatedRate('twilio', 'voice_minute_outbound')).toBe(0.02);
  });

  it('merges into the existing item conditioned on the raw value it read', async () => {
    const existing = row({ twilio: { number_monthly_rent: 2 } });
    mockGet.mockResolvedValue(existing);
    const res = await as(request(app).put(URL)).send(set);
    expect(res.status).toBe(200);
    const [, value, expected] = mockIfMatches.mock.calls[0];
    expect(expected).toBe(existing.settingValue);
    expect(JSON.parse(value).overrides).toEqual({ twilio: { number_monthly_rent: 2, voice_minute_outbound: 0.02 } });
  });

  it('null removes only that override; emptying the item stores an empty object, not a delete', async () => {
    mockGet.mockResolvedValue(row({ twilio: { voice_minute_outbound: 0.02 } }));
    const res = await as(request(app).put(URL)).send({ ...set, usdPerUnit: null });
    expect(res.status).toBe(200);
    expect(JSON.parse(mockIfMatches.mock.calls[0][1]).overrides).toEqual({});
    expect(res.body.version).toBe(VENDOR_RATE_CARD_VERSION);
    expect(res.body.rates[0]).toMatchObject({ overrideUsdPerUnit: null, effectiveUsdPerUnit: 0.014 });
    expect(getAllocatedRate('twilio', 'voice_minute_outbound')).toBe(0.014);
  });

  it('pauses briefly between attempts so quick successive PUTs do not collide again', async () => {
    mockGet.mockResolvedValue(row({}));
    mockIfMatches
      .mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ConditionalCheckFailedException' }))
      .mockResolvedValueOnce(undefined);
    const timeouts = jest.spyOn(global, 'setTimeout');
    const res = await as(request(app).put(URL)).send(set);
    expect(res.status).toBe(200);
    const delays = timeouts.mock.calls.map((c) => c[1]).filter((d): d is number => typeof d === 'number' && d >= 20 && d <= 80);
    expect(delays).toHaveLength(1);
  });

  it('retries on a lost race and re-merges from the fresh read', async () => {
    mockGet
      .mockResolvedValueOnce(row({}))
      .mockResolvedValueOnce(row({ twilio: { number_monthly_rent: 3 } }));
    mockIfMatches
      .mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ConditionalCheckFailedException' }))
      .mockResolvedValueOnce(undefined);
    const res = await as(request(app).put(URL)).send(set);
    expect(res.status).toBe(200);
    expect(JSON.parse(mockIfMatches.mock.calls[1][1]).overrides.twilio).toEqual({ number_monthly_rent: 3, voice_minute_outbound: 0.02 });
  });

  it('409s after repeated conflicts and does not apply anything locally', async () => {
    mockGet.mockResolvedValue(row({}));
    mockIfMatches.mockRejectedValue(Object.assign(new Error('x'), { code: 'ConditionalCheckFailedException' }));
    const res = await as(request(app).put(URL)).send(set);
    expect(res.status).toBe(409);
    expect(getAllocatedRate('twilio', 'voice_minute_outbound')).toBe(0.014);
  });

  it('500s with { error } on a write failure and applies nothing', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockIfAbsent.mockRejectedValue(new Error('dynamo'));
    const res = await as(request(app).put(URL)).send(set);
    expect(res.status).toBe(500);
    expect(typeof res.body.error).toBe('string');
    expect(getAllocatedRate('twilio', 'voice_minute_outbound')).toBe(0.014);
  });

  it('logs admin id, provider:key and old/new values only', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    mockGet.mockResolvedValue(row({ twilio: { voice_minute_outbound: 0.02 } }));
    await as(request(app).put(URL)).send({ ...set, usdPerUnit: 0.03 });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('admin=admin-7 twilio:voice_minute_outbound 0.02 -> 0.03'));
  });
});
