/**
 * forward-lead: unknown top-level fields must reach customFields.
 *
 * The handler destructures a FIXED field list rather than `...req.body`, and its own
 * comment concedes the consequence: "these must be listed explicitly or they're silently
 * dropped." Every time a lander needs to store a new field, someone has to remember to add
 * a name here. Nobody does, and the failure is invisible: the POST returns 201 and a lead
 * row appears, just without the data.
 *
 * Real incident 2026-08-07: the healthcare vertical lander posted a qualification payload
 * (qualified / qualification_reason / annual_revenue / total_funding / can_start_tomorrow)
 * as top-level keys. `POST /api/capture` returned 200, the lead landed in the CRM, and all
 * five fields were gone. The stored payload was `{ forwardedAt, source }`. A page whose
 * qualification gate silently discards its answers is worse than no page, because it feeds
 * Meta unqualified conversions while looking like it worked.
 *
 * Passthrough is deliberately BOUNDED. This endpoint is public, CORS-open and
 * unauthenticated, so an unbounded spread into storage is an abuse surface. Caps below.
 */

import request from 'supertest';
import express from 'express';
import webhookRouter from '../routes/webhooks';
import { crmDb, userDb } from '../services/db';

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadByEmail: jest.fn(),
    createLead: jest.fn(),
    updateLead: jest.fn(),
    getLeadById: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
}));
jest.mock('../services/metaAccountCredentials', () => ({ getMetaAccountCredentials: jest.fn() }));
jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: { getSequencesByAutoEnrollList: jest.fn().mockResolvedValue([]), bulkEnroll: jest.fn() },
}));
jest.mock('../services/externalCrmSyncService', () => ({
  externalCrmSyncService: { autoSyncLead: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: { notifyLeadListOwnerIfConfigured: jest.fn() },
}));
jest.mock('../services/leadCaptureFailureService', () => ({ recordLeadCaptureFailure: jest.fn() }));
jest.mock('../services/agentModeService', () => ({
  agentModeService: { updateEmailDraftForLead: jest.fn(), getCrmSenders: jest.fn() },
}));
jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn(), sendSystemEmail: jest.fn().mockResolvedValue({ id: 'email_1' }) },
}));
jest.mock('../services/webhookService', () => ({
  webhookService: {
    initialize: jest.fn(), verifyWebhook: jest.fn(),
    extractEmailDomain: jest.fn(), generateEventId: jest.fn(),
  },
}));
jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: { eventExists: jest.fn(), addEmailEvent: jest.fn() },
}));

const app = express();
app.use(express.json());
app.use('/api/webhooks', webhookRouter);

const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

const storedCustomFields = () => (crmDb.createLead as jest.Mock).mock.calls[0][1].customFields;

describe('forward-lead — unknown top-level fields reach customFields', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
      listId: 'list_123', userId: 'user_123', name: 'Test List',
      publicAccessEnabled: true, autoDraftEnabled: false,
    });
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
    (crmDb.createLead as jest.Mock).mockResolvedValue({ leadId: 'lead_1', listId: 'list_123', email: 'test@example.com' });
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user_123', connected_accounts: [] });
  });

  it('stores a landing-page qualification payload sent as top-level keys', async () => {
    const res = await request(app).post('/api/webhooks/forward-lead').send({
      listId: 'list_123',
      email: 'smoketest@example.com',
      firstName: 'Smoketest',
      company: 'Smoketest Health Systems',
      // The gate answers, exactly as the healthcare lander sends them.
      qualified: true,
      qualification_reason: 'Qualified: annual_revenue 5000000 meets threshold and can start tomorrow.',
      annual_revenue: 5000000,
      total_funding: 1000000,
      can_start_tomorrow: true,
      vertical: 'healthcare',
    });
    await flush();

    expect(res.status).toBe(201);
    const cf = storedCustomFields();
    expect(cf.qualified).toBe(true);
    expect(cf.qualification_reason).toContain('meets threshold');
    expect(cf.annual_revenue).toBe(5000000);
    expect(cf.total_funding).toBe(1000000);
    expect(cf.can_start_tomorrow).toBe(true);
    expect(cf.vertical).toBe('healthcare');
  });

  it('does not duplicate known standard fields into customFields', async () => {
    await request(app).post('/api/webhooks/forward-lead').send({
      listId: 'list_123', email: 'a@example.com', firstName: 'A', lastName: 'B',
      phone: '123', company: 'C', title: 'T', notes: 'N', linkedin: 'L',
      qualified: true,
    });
    await flush();

    const cf = storedCustomFields();
    // Standard fields live on the lead itself; mirroring them into customFields would
    // double-store and let the two copies drift.
    for (const k of ['email', 'firstName', 'lastName', 'phone', 'company', 'title', 'notes', 'linkedin']) {
      expect(cf).not.toHaveProperty(k);
    }
    // Transport/plumbing fields are not customer data either.
    for (const k of ['listId', 'pixelId', 'metaAccountId', 'eventId', 'fbp', 'fbc', 'capturedAtMs', 'attribution', 'utm']) {
      expect(cf).not.toHaveProperty(k);
    }
    expect(cf.qualified).toBe(true);
  });

  it('bounds passthrough — this endpoint is public, CORS-open and unauthenticated', async () => {
    // Express already 413s an oversized body, so this payload deliberately stays UNDER
    // that limit (~40KB). Total-size limiting is not key-count limiting: a compact body
    // can still carry hundreds of keys, and without a cap every one of them lands in
    // storage on a public unauthenticated endpoint.
    const flood: Record<string, unknown> = { listId: 'list_123', email: 'flood@example.com' };
    for (let i = 0; i < 200; i++) flood[`junk_${i}`] = 'x'.repeat(200);

    const res = await request(app).post('/api/webhooks/forward-lead').send(flood);
    await flush();

    // Still accepted — the lead must never be lost over a payload-shape concern.
    expect(res.status).toBe(201);
    const cf = storedCustomFields();
    const passthrough = Object.keys(cf).filter((k) => k.startsWith('junk_'));
    // Asserts BOTH halves. Without the first line this test passes vacuously when no
    // passthrough exists at all, which is exactly the pre-fix state — a green bar proving
    // nothing.
    expect(passthrough.length).toBeGreaterThan(0);
    expect(passthrough.length).toBeLessThanOrEqual(50);
    for (const k of passthrough) {
      expect(String(cf[k]).length).toBeLessThanOrEqual(1000);
    }
  });

  // ---- control cases: these already pass, and must keep passing ----

  it('still accepts the nested customFields shape (backward compatible)', async () => {
    await request(app).post('/api/webhooks/forward-lead').send({
      listId: 'list_123', email: 'nested@example.com',
      customFields: { q1: 'yes', revenue: '5M' },
    });
    await flush();

    const cf = storedCustomFields();
    expect(cf.q1).toBe('yes');
    expect(cf.revenue).toBe('5M');
  });

  it("still defaults source to 'api' when the caller sends none", async () => {
    await request(app).post('/api/webhooks/forward-lead').send({
      listId: 'list_123', email: 'nosource@example.com',
    });
    await flush();

    expect(storedCustomFields().source).toBe('api');
  });
});
