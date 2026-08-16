import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import subscriptionRoutes from '../subscription';
import { authenticateToken } from '../../middleware/auth';
import { resolveBillingUserId } from '../../services/tokenUsageService';
import { listLlmChargeEvents } from '../../services/llmChargeAuditDb';
import { usageRecordDb } from '../../services/usageRecordDb';

// Mock the middleware
jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    next();
    return undefined;
  }),
}));

// Mock customerPortalPages service
jest.mock('../../services/customerPortalPages', () => ({
  getCustomerPortalPages: jest.fn(() => [
    { path: '/brand-guidelines', label: 'Brand Guidelines', description: 'Manage brand data and assets' },
    { path: '/market-strategy', label: 'Market Strategy', description: 'Manage business overview, competitors, and ICPs' },
    { path: '/paid-social', label: 'Paid Social', description: 'View paid social media campaign performance' },
    { path: '/newsletter', label: 'Newsletter', description: 'View newsletter campaign performance' },
    { path: '/seo', label: 'SEO/GEO', description: 'SEO and analytics management' },
    { path: '/research-reports', label: 'Reports', description: 'View market research reports' },
    { path: '/images', label: 'Ad Images', description: 'Image generation and management' },
    { path: '/videos', label: 'Ad Videos', description: 'Video generation and management' },
  ]),
}));

jest.mock('../../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn(),
  resolveBillingUserId: jest.fn(),
}));

jest.mock('../../services/llmChargeAuditDb', () => ({
  listLlmChargeEvents: jest.fn(),
}));

jest.mock('../../services/usageRecordDb', () => ({
  usageRecordDb: { queryByUserDateRange: jest.fn() },
}));

// @jest/globals' bare `jest.Mock` defaults its return type to `unknown`, so
// mockResolvedValueOnce's argument infers as `never`. Tying the mock to the
// real function's type gives it a real Promise<T> return to infer against.
const mockResolveBillingUserId = resolveBillingUserId as jest.MockedFunction<typeof resolveBillingUserId>;
const mockListLlmChargeEvents = listLlmChargeEvents as jest.MockedFunction<typeof listLlmChargeEvents>;
const mockQueryByUserDateRange = usageRecordDb.queryByUserDateRange as jest.MockedFunction<typeof usageRecordDb.queryByUserDateRange>;

let app: express.Application;

describe('GET /api/subscription/customer-portal-pages', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/subscription', subscriptionRoutes);
  });

  it('should return all customer portal pages including Paid Social and Newsletter', async () => {
    const res = await request(app)
      .get('/api/subscription/customer-portal-pages')
      .expect(200);

    expect(res.body).toHaveProperty('pages');
    expect(Array.isArray(res.body.pages)).toBe(true);
    
    const pagePaths = res.body.pages.map((page: any) => page.path);
    
    // Verify new Performance Hub pages are included
    expect(pagePaths).toContain('/paid-social');
    expect(pagePaths).toContain('/newsletter');
    expect(pagePaths).toContain('/seo');
    
    // Verify other pages are included
    expect(pagePaths).toContain('/brand-guidelines');
    expect(pagePaths).toContain('/market-strategy');
    expect(pagePaths).toContain('/research-reports');
    expect(pagePaths).toContain('/images');
    expect(pagePaths).toContain('/videos');
  });

  it('should return Paid Social page with correct structure', async () => {
    const res = await request(app)
      .get('/api/subscription/customer-portal-pages')
      .expect(200);

    const paidSocialPage = res.body.pages.find((page: any) => page.path === '/paid-social');
    
    expect(paidSocialPage).toBeDefined();
    expect(paidSocialPage.path).toBe('/paid-social');
    expect(paidSocialPage.label).toBe('Paid Social');
    expect(paidSocialPage.description).toBe('View paid social media campaign performance');
  });

  it('should return Newsletter page with correct structure', async () => {
    const res = await request(app)
      .get('/api/subscription/customer-portal-pages')
      .expect(200);

    const newsletterPage = res.body.pages.find((page: any) => page.path === '/newsletter');
    
    expect(newsletterPage).toBeDefined();
    expect(newsletterPage.path).toBe('/newsletter');
    expect(newsletterPage.label).toBe('Newsletter');
    expect(newsletterPage.description).toBe('View newsletter campaign performance');
  });

  it('should return Reports page (renamed from Research Reports)', async () => {
    const res = await request(app)
      .get('/api/subscription/customer-portal-pages')
      .expect(200);

    const reportsPage = res.body.pages.find((page: any) => page.path === '/research-reports');
    
    expect(reportsPage).toBeDefined();
    expect(reportsPage.path).toBe('/research-reports');
    expect(reportsPage.label).toBe('Reports');
    expect(reportsPage.description).toBe('View market research reports');
  });
});

describe('GET /api/subscription/usage/itemized (ENG-1251)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (authenticateToken as jest.Mock).mockImplementation((req: any, _res: any, next: any) => {
      req.user = { userId: 'u1' };
      next();
    });
    mockResolveBillingUserId.mockResolvedValue('u1');
    app = express();
    app.use(express.json());
    app.use('/api/subscription', subscriptionRoutes);
  });

  it('returns per_charge precision when every call this month has audit-event coverage', async () => {
    mockListLlmChargeEvents.mockResolvedValue([
      { billingUserId: 'u1', eventId: '2026-08-10T12:00:00.000Z#a', actingUserId: 'u1', occurredAt: '2026-08-10T12:00:00.000Z', model: 'sonnet', provider: 'bedrock', feature: 'chat', tokens: 100, costMicroUsd: 500, sessionId: 's1' },
    ]);
    mockQueryByUserDateRange.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/subscription/usage/itemized?month=2026-08')
      .expect(200);

    expect(res.body.precision).toBe('per_charge');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].source).toBe('charge_event');
    // No aggregate query result should leak in when every day is charge-event covered.
    expect(mockQueryByUserDateRange).toHaveBeenCalled();
  });

  it('returns daily_aggregate precision when no charge events exist yet this month', async () => {
    mockListLlmChargeEvents.mockResolvedValue([]);
    mockQueryByUserDateRange.mockResolvedValue([
      { userId: 'u1', sk: '2026-08-05#sonnet#chat', billingUserId: 'u1', updatedAt: '2026-08-05T00:00:00.000Z', ttl: 0, date: '2026-08-05', model: 'sonnet', provider: 'bedrock', feature: 'chat', totalTokens: 200, callCount: 3, costMicroUsd: 900 },
    ]);

    const res = await request(app)
      .get('/api/subscription/usage/itemized?month=2026-08')
      .expect(200);

    expect(res.body.precision).toBe('daily_aggregate');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].source).toBe('daily_aggregate');
  });

  it('merges both sources on a partial-rollout month WITHOUT dropping pre-event charges (Greptile P1)', async () => {
    // The rollout landed mid-month: 08-10 onward has charge-event coverage,
    // 08-01..08-09 only has the legacy daily aggregate. Both halves of the
    // month must appear — the pre-fix code early-returned on events.length
    // and silently dropped every pre-rollout day.
    mockListLlmChargeEvents.mockResolvedValue([
      { billingUserId: 'u1', eventId: '2026-08-10T12:00:00.000Z#a', actingUserId: 'u1', occurredAt: '2026-08-10T12:00:00.000Z', model: 'sonnet', provider: 'bedrock', feature: 'chat', tokens: 100, costMicroUsd: 500, sessionId: 's1' },
    ]);
    mockQueryByUserDateRange.mockResolvedValue([
      { userId: 'u1', sk: '2026-08-01#sonnet#chat', billingUserId: 'u1', updatedAt: '2026-08-01T00:00:00.000Z', ttl: 0, date: '2026-08-01', model: 'sonnet', provider: 'bedrock', feature: 'chat', totalTokens: 50, callCount: 1, costMicroUsd: 200 },
      // Same (date, model, feature) as the charge event above, and its
      // dollar total is FULLY covered by it (500 <= 500) — must be EXCLUDED
      // to avoid double-counting the same underlying call the shadow table
      // also recorded.
      { userId: 'u1', sk: '2026-08-10#sonnet#chat', billingUserId: 'u1', updatedAt: '2026-08-10T00:00:00.000Z', ttl: 0, date: '2026-08-10', model: 'sonnet', provider: 'bedrock', feature: 'chat', totalTokens: 100, callCount: 1, costMicroUsd: 500 },
    ]);

    const res = await request(app)
      .get('/api/subscription/usage/itemized?month=2026-08')
      .expect(200);

    expect(res.body.precision).toBe('mixed');
    expect(res.body.items).toHaveLength(2);
    const sources = res.body.items.map((item: any) => item.source).sort();
    expect(sources).toEqual(['charge_event', 'daily_aggregate']);
    // The 08-01 aggregate row survives...
    expect(res.body.items.some((item: any) => item.date === '2026-08-01' && item.source === 'daily_aggregate')).toBe(true);
    // ...but the 08-10 aggregate row (shadowing the charge event) does not.
    expect(res.body.items.some((item: any) => item.date === '2026-08-10' && item.source === 'daily_aggregate')).toBe(false);
  });

  it('shows only the UNCOVERED REMAINDER when a day has an applied event but MORE aggregate-only spend, not the full row (Greptile P1: one event hides whole day / mixed itemization double-counts)', async () => {
    // A charge event covers only $0.0005 of this (date, model, feature), but
    // the aggregate row for the exact same combination totals $0.009999 —
    // most of that day's usage predates or otherwise falls outside the
    // event's coverage. Date-only suppression would drop ALL of it just
    // because SOME charge-event coverage exists that day; showing the row's
    // FULL total instead would double-count the $500 already covered by the
    // charge event. Only the $9499 remainder should appear — and, per the
    // usageItemization.ts rewrite, tokens/calls are each subtracted exactly
    // (row total minus the event's own tokens/calls), not estimated by
    // scaling the row's totals by the dollar remainder's fraction. The one
    // charge event carries 100 tokens across 1 call, so the remainder is
    // exactly 1000-100=900 tokens and 10-1=9 calls, regardless of dollar
    // proportions.
    mockListLlmChargeEvents.mockResolvedValue([
      { billingUserId: 'u1', eventId: 'chatcmpl-partial', actingUserId: 'u1', occurredAt: '2026-08-10T12:00:00.000Z', model: 'sonnet', provider: 'bedrock', feature: 'chat', tokens: 100, costMicroUsd: 500, sessionId: 's1' },
    ]);
    mockQueryByUserDateRange.mockResolvedValue([
      { userId: 'u1', sk: '2026-08-10#sonnet#chat', billingUserId: 'u1', updatedAt: '2026-08-10T00:00:00.000Z', ttl: 0, date: '2026-08-10', model: 'sonnet', provider: 'bedrock', feature: 'chat', totalTokens: 1000, callCount: 10, costMicroUsd: 9999 },
    ]);

    const res = await request(app)
      .get('/api/subscription/usage/itemized?month=2026-08')
      .expect(200);

    expect(res.body.items).toHaveLength(2);
    const aggregateRow = res.body.items.find((item: any) => item.source === 'daily_aggregate');
    expect(aggregateRow).toBeDefined();
    expect(aggregateRow.date).toBe('2026-08-10');
    // Remainder, not the full row total — the covered $500 must not appear twice.
    expect(aggregateRow.costMicroUsd).toBe(9499);
    // Total across both items reconciles to the true aggregate total, not more.
    const total = res.body.items.reduce((sum: number, item: any) => sum + item.costMicroUsd, 0);
    expect(total).toBe(9999);
    // Exact per-dimension remainder: 1000 total tokens - 100 covered by the
    // one charge event = 900; 10 total calls - 1 covered call = 9.
    expect(aggregateRow.tokens).toBe(900);
    expect(aggregateRow.calls).toBe(9);
  });

  it('suppresses only the exact (date, model, feature) covered by a charge event, not other models/features on the same day', async () => {
    mockListLlmChargeEvents.mockResolvedValue([
      { billingUserId: 'u1', eventId: 'chatcmpl-a', actingUserId: 'u1', occurredAt: '2026-08-10T12:00:00.000Z', model: 'sonnet', provider: 'bedrock', feature: 'chat', tokens: 100, costMicroUsd: 500, sessionId: 's1' },
    ]);
    mockQueryByUserDateRange.mockResolvedValue([
      // Fully covered — same date, model, feature, dollar amount.
      { userId: 'u1', sk: '2026-08-10#sonnet#chat', billingUserId: 'u1', updatedAt: '2026-08-10T00:00:00.000Z', ttl: 0, date: '2026-08-10', model: 'sonnet', provider: 'bedrock', feature: 'chat', totalTokens: 100, callCount: 1, costMicroUsd: 500 },
      // Same day, different model — never touched by the sonnet/chat event.
      { userId: 'u1', sk: '2026-08-10#opus#chat', billingUserId: 'u1', updatedAt: '2026-08-10T00:00:00.000Z', ttl: 0, date: '2026-08-10', model: 'opus', provider: 'bedrock', feature: 'chat', totalTokens: 50, callCount: 1, costMicroUsd: 300 },
    ]);

    const res = await request(app)
      .get('/api/subscription/usage/itemized?month=2026-08')
      .expect(200);

    const aggregateRows = res.body.items.filter((item: any) => item.source === 'daily_aggregate');
    expect(aggregateRows).toHaveLength(1);
    expect(aggregateRows[0].model).toBe('opus');
  });

  it('shows a $0 aggregate row (unpriced model) that has no charge-event coverage at all, not just a covered remainder (Greptile P1)', async () => {
    // An unpriced model prices at $0 on both sides, so `covered` for this
    // (date, model, feature) is 0 too. The remainder check (row - covered)
    // would read 0 - 0 = 0 and wrongly treat that as "fully covered by
    // charge events", silently dropping real, positive token/call usage
    // that no charge event actually represents.
    mockListLlmChargeEvents.mockResolvedValue([]);
    mockQueryByUserDateRange.mockResolvedValue([
      { userId: 'u1', sk: '2026-08-05#unpriced-model#chat', billingUserId: 'u1', updatedAt: '2026-08-05T00:00:00.000Z', ttl: 0, date: '2026-08-05', model: 'unpriced-model', provider: 'bedrock', feature: 'chat', totalTokens: 5000, callCount: 3, costMicroUsd: 0 },
    ]);

    const res = await request(app)
      .get('/api/subscription/usage/itemized?month=2026-08')
      .expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ tokens: 5000, calls: 3, costMicroUsd: 0, source: 'daily_aggregate' });
  });

  it('does NOT double-show a $0 aggregate row that IS already represented by a matching $0 charge event (Greptile P1)', async () => {
    // Distinct from the previous test: here a charge event for this exact
    // (date, model, feature) DOES exist -- it just happens to be $0
    // (unpriced model, captured by the audit-event system). That event is
    // already in perChargeItems with its own tokens/calls; showing the
    // aggregate row too would double them.
    mockListLlmChargeEvents.mockResolvedValue([
      { billingUserId: 'u1', eventId: 'chatcmpl-unpriced', actingUserId: 'u1', occurredAt: '2026-08-05T12:00:00.000Z', model: 'unpriced-model', provider: 'bedrock', feature: 'chat', tokens: 5000, costMicroUsd: 0, sessionId: 's1' },
    ]);
    mockQueryByUserDateRange.mockResolvedValue([
      { userId: 'u1', sk: '2026-08-05#unpriced-model#chat', billingUserId: 'u1', updatedAt: '2026-08-05T00:00:00.000Z', ttl: 0, date: '2026-08-05', model: 'unpriced-model', provider: 'bedrock', feature: 'chat', totalTokens: 5000, callCount: 1, costMicroUsd: 0 },
    ]);

    const res = await request(app)
      .get('/api/subscription/usage/itemized?month=2026-08')
      .expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].source).toBe('charge_event');
  });

  it('returns 401 when unauthenticated', async () => {
    (authenticateToken as jest.Mock).mockImplementation((req: any, _res: any, next: any) => {
      req.user = undefined;
      next();
    });
    app = express();
    app.use(express.json());
    app.use('/api/subscription', subscriptionRoutes);

    await request(app).get('/api/subscription/usage/itemized?month=2026-08').expect(401);
  });

  it('returns 400 for a malformed month', async () => {
    await request(app).get('/api/subscription/usage/itemized?month=not-a-month').expect(400);
  });
});
