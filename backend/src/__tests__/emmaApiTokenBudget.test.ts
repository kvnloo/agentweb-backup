/**
 * ENG-973 — the /api/emma/* family is MCP's self-call surface and never checked
 * token quota.
 *
 * The same user doing the same paid work is gated on the web (checkTokenUsage in
 * agentModeController / chatbot) and ungated through MCP, because the gate lives
 * in the controller layer while these routes delegate straight to the service.
 *
 * These assertions are written against the HTTP contract already established by
 * controllers/chatbot.ts:156-159 (429 + a `tokenUsage` body), so a blocked MCP
 * caller is indistinguishable from a blocked web caller.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', email: 'u@example.com', isAdmin: false };
    next();
  },
}));

const mockCheckTokenUsage = jest.fn();
jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: (...args: any[]) => mockCheckTokenUsage(...args),
}));

const mockGenerateImage = jest.fn();
const mockGetBookContent = jest.fn();
const mockGenerateBookContent = jest.fn();
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    generateImage: (...args: any[]) => mockGenerateImage(...args),
    getBookContent: (...args: any[]) => mockGetBookContent(...args),
    generateBookContent: (...args: any[]) => mockGenerateBookContent(...args),
  },
}));

const mockScanPromise = jest.fn();
jest.mock('../config/aws', () => ({
  dynamodb: { scan: () => ({ promise: () => mockScanPromise() }) },
}));

import emmaApiRoutes from '../routes/emmaApi';
import { EMMA_ROUTE_BUDGET, classifyEmmaRoute } from '../middleware/emmaTokenBudget';

const app = express();
app.use(express.json());
app.use('/api/emma', emmaApiRoutes);

const OVER_QUOTA = {
  allowed: false,
  warning: false,
  used: 1_000_000,
  allowance: 1_000_000,
  bonus: 0,
  effectiveAllowance: 1_000_000,
  percentUsed: 100,
  month: '2026-08',
};
const UNDER_QUOTA = { ...OVER_QUOTA, allowed: true, warning: false, used: 10, percentUsed: 1 };

describe('ENG-973: /api/emma/* enforces the monthly token quota', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockScanPromise.mockResolvedValue({ Items: [] });
    mockGenerateImage.mockResolvedValue({ url: 'https://example.com/i.png' });
    mockGetBookContent.mockResolvedValue({ content: 'chapter one' });
    mockGenerateBookContent.mockResolvedValue({ content: 'generated' });
  });

  it('AC1: refuses a spending route when the user is over allowance, and never reaches the handler', async () => {
    mockCheckTokenUsage.mockResolvedValue(OVER_QUOTA);

    const res = await request(app).post('/api/emma/generate-image').send({ prompt: 'a cat' });

    expect(res.status).toBe(429);
    expect(res.body.tokenUsage).toMatchObject({ allowed: false, percentUsed: 100 });
    // The point of the fix: the paid call must not happen.
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it('AC2: lets a spending route through when the user is under allowance', async () => {
    mockCheckTokenUsage.mockResolvedValue(UNDER_QUOTA);

    const res = await request(app).post('/api/emma/generate-image').send({ prompt: 'a cat' });

    expect(res.status).toBe(200);
    expect(mockGenerateImage).toHaveBeenCalled();
  });

  it('AC3: still serves the read the portal depends on when the user is over allowance', async () => {
    mockCheckTokenUsage.mockResolvedValue(OVER_QUOTA);

    const res = await request(app).get('/api/emma/actions');

    expect(res.status).toBe(200);
  });

  it('AC3: exempts a parameterised read route (GET /books/:bookId/content)', async () => {
    mockCheckTokenUsage.mockResolvedValue(OVER_QUOTA);

    const res = await request(app).get('/api/emma/books/book-123/content');

    expect(res.status).toBe(200);
    expect(mockGetBookContent).toHaveBeenCalled();
  });

  it('AC1: gates a parameterised spending route (POST /books/:bookId/generate-content)', async () => {
    mockCheckTokenUsage.mockResolvedValue(OVER_QUOTA);

    const res = await request(app)
      .post('/api/emma/books/book-123/generate-content')
      .send({ chapter: 1 });

    expect(res.status).toBe(429);
    expect(mockGenerateBookContent).not.toHaveBeenCalled();
  });

  it('AC6: bills through checkTokenUsage, which resolves org members to the org owner', async () => {
    mockCheckTokenUsage.mockResolvedValue(UNDER_QUOTA);

    await request(app).post('/api/emma/generate-image').send({ prompt: 'a cat' });

    // No second, divergent quota rule — enforcement calls the one existing gate
    // with the authenticated user, and resolveBillingUserId does the rest.
    expect(mockCheckTokenUsage).toHaveBeenCalledWith('user-1');
  });
});

describe('ENG-973: the classification cannot silently fall behind the router', () => {
  /** Every `${METHOD} ${declared path}` the router actually serves. */
  function registeredRoutes(): string[] {
    const keys: string[] = [];
    for (const layer of (emmaApiRoutes as any).stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        if (layer.route.methods[method]) keys.push(`${method.toUpperCase()} ${layer.route.path}`);
      }
    }
    return keys;
  }

  it('AC5: every registered route has an explicit budget classification', () => {
    const registered = registeredRoutes();
    // Guard the guard — if introspection breaks, an empty list would pass vacuously.
    expect(registered.length).toBeGreaterThan(50);

    const unclassified = registered.filter(key => !(key in EMMA_ROUTE_BUDGET));
    expect(unclassified).toEqual([]);
  });

  it('AC5: the classification has no entries for routes that no longer exist', () => {
    const registered = new Set(registeredRoutes());
    const stale = Object.keys(EMMA_ROUTE_BUDGET).filter(key => !registered.has(key));
    expect(stale).toEqual([]);
  });

  it('AC4: an unclassified path is metered, not free', () => {
    expect(classifyEmmaRoute('POST', '/some-route-added-tomorrow')).toBe('metered');
    // Method matters: a declared GET exemption must not exempt a POST to the same path.
    expect(classifyEmmaRoute('POST', '/actions')).toBe('metered');
    expect(classifyEmmaRoute('GET', '/actions')).toBe('exempt');
  });
});
