/**
 * ENG-1328 AC1 — the generation route must be able to supply the conversion pair.
 *
 * Found by attempting the AC1 end-to-end: the parameter was threaded through
 * GenerateLandingPageOptions, generateFirstPage, the record and the push seam — and no
 * caller ever built it. AC1 ("ships the base gtag on its FIRST commit") was unreachable,
 * and every generated lander shipped untagged. 111 unit tests passed throughout, because
 * they all verified the layers BELOW the gap.
 */
import request from 'supertest';
import express, { Application } from 'express';

process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

const mockGenerate = jest.fn();
const mockOwnedAccounts = jest.fn();
const mockBrand = jest.fn();
const mockLeadLists = jest.fn();
const mockCreateLeadList = jest.fn();

jest.mock('../services/v0Service', () => {
  const actual = jest.requireActual('../services/v0Service');
  return {
    ...actual,
    generateLandingPage: (...a: any[]) => mockGenerate(...a),
    // ENG-326 gates generation on a persisted brand logo. Called synchronously, so it
    // must RETURN the context rather than a promise — and its value is re-established in
    // beforeEach because clearAllMocks() wipes implementations set at module-mock time,
    // which made every test after the first one 422 while passing in isolation.
    buildBrandContextFromUser: (...a: any[]) => mockBrand(...a),
  };
});
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsWithOwnerIncludingOrgShared: (...a: any[]) => mockOwnedAccounts(...a),
}));
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn().mockResolvedValue({ userId: 'u1', email: 'a@b.c' }),
    setLandingSiteMode: jest.fn().mockResolvedValue(undefined),
  },
  orgDb: { getOrgById: jest.fn() },
  // Implementations live in beforeEach, not here: clearAllMocks() wipes anything set at
  // module-mock time, which made these pass alone and fail in sequence.
  crmDb: {
    getLeadListsForUser: (...a: any[]) => mockLeadLists(...a),
    createLeadList: (...a: any[]) => mockCreateLeadList(...a),
  },
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _r: any, n: any) => { req.user = { userId: 'u1' }; n(); },
}));

import router, { _resetRateLimitState } from '../routes/landingPageGeneration';
const app: Application = express();
app.use(express.json());
app.use('/api/landing-pages/v0', router);

const AW = 'AW-18192751758';
const LABEL = 'qAnwCOLmx-McEI65_eJD';
const post = (body: any) =>
  request(app).post('/api/landing-pages/v0/generate').send({ prompt: 'p', name: 'n', ...body });

beforeEach(() => {
  jest.clearAllMocks();
  // The route allows 10 generations per hour per user, and this suite makes more than
  // that. Without the reset the later tests 429 — which looks like a routing bug and is
  // actually the limiter working correctly.
  _resetRateLimitState();
  mockBrand.mockReturnValue({ brandName: 'Acme', logoUrl: 'https://x/logo.png' });
  mockLeadLists.mockResolvedValue([]);
  mockCreateLeadList.mockResolvedValue({ id: 'list1', listId: 'list1' });
  mockGenerate.mockResolvedValue({ id: 'p1', status: 'deployed' });
  mockOwnedAccounts.mockResolvedValue([{ platform: 'google_ads', config: { customer_id: '2883029950' } }]);
});

const optsOf = () => mockGenerate.mock.calls[0]?.[6];

describe('google_ads is rejected before it can reach generation', () => {
  it('400s a pair missing its label — half a pair attributes nothing', async () => {
    const res = await post({ google_ads: { conversionId: AW } });
    expect(res.status).toBe(400);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('400s a pair missing its id', async () => {
    expect((await post({ google_ads: { conversionLabel: LABEL } })).status).toBe(400);
  });

  it('400s a non-object', async () => {
    expect((await post({ google_ads: 'AW-1' })).status).toBe(400);
  });

  it('400s an id that RULE 7.5 would not recognise', async () => {
    for (const bad of ['AW-123', 'GTM-ABCD123', '18192751758']) {
      expect((await post({ google_ads: { conversionId: bad, conversionLabel: LABEL } })).status).toBe(400);
    }
  });

  it('400s a customer id the caller does not own', async () => {
    // Otherwise a request could point a lander's conversions at someone else's account.
    mockOwnedAccounts.mockResolvedValue([{ platform: 'google_ads', config: { customer_id: '1111111111' } }]);
    const res = await post({ google_ads: { conversionId: AW, conversionLabel: LABEL, customerId: '2883029950' } });
    expect(res.status).toBe(400);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('400s a non-string customer id rather than coercing it', async () => {
    expect((await post({ google_ads: { conversionId: AW, conversionLabel: LABEL, customerId: 42 } })).status).toBe(400);
  });
});

describe('a valid pair reaches generation', () => {
  it('passes the trimmed pair through to generateLandingPage', async () => {
    const res = await post({ google_ads: { conversionId: ` ${AW} `, conversionLabel: ` ${LABEL} `, customerId: '2883029950' } });
    expect(res.status).toBe(201);
    expect(optsOf().googleAds).toEqual({ conversionId: AW, conversionLabel: LABEL, customerId: '2883029950' });
  });

  it('accepts a pair with no customer id — ENG-1325 needs it, the tag does not', async () => {
    await post({ google_ads: { conversionId: AW, conversionLabel: LABEL } });
    expect(optsOf().googleAds).toMatchObject({ conversionId: AW, conversionLabel: LABEL });
    expect(mockOwnedAccounts).not.toHaveBeenCalled();
  });

  it('leaves googleAds undefined when the field is absent', async () => {
    await post({});
    expect(optsOf().googleAds).toBeUndefined();
  });

  it('does not disturb metaPixelOverride handling', async () => {
    await post({});
    expect(optsOf()).toHaveProperty('metaPixelOverride');
  });
});
